/**
 * 三源并行 CDP 采集与融合 —— dom-snapshot collector.py 的 TS 移植（P1.2）。
 *
 * 三源（以 backendNodeId 交叉引用融合为 EnhancedDOMTreeNode 树）：
 *   1. DOM.getDocument(depth=-1, pierce=true) —— 权威树 + shadow DOM
 *   2. DOMSnapshot.captureSnapshot            —— 布局/可见性/坐标/paintOrder
 *   3. Accessibility.getFullAXTree            —— 语义角色/名称/状态（逐 frame 合并）
 * 额外采集：JS 点击监听器探测（Runtime.evaluate + getEventListeners）、设备像素比
 * （Page.getLayoutMetrics）。跨源 iframe 经 Target API 附加独立 session 递归构建。
 *
 * 与 Python 的有意差异（其余逐行为对齐）：
 * - client 用 protocol.ts 的扁平 CdpLikeClient（send(method, params, sessionId)），
 *   Python 端为属性链式；传输适配（cdp-ws / cdp-chrome）各自实现同一接口。
 * - Python _build_enhanced_dom_tree 的 FAILED 分支返回 3 元组而调用方按 4 元组
 *   解包（上游签名漂移 bug），TS 统一返回 4 字段对象：FAILED → root=null。
 * - 日志调用省略（Python logger.debug/warning 在库内无消费方）。
 */
import { runCdpBatch, withTimeoutMs } from "./cdp-batch.js";
import type {
  CdpAttachResult,
  CdpAxTreeNode,
  CdpCaptureSnapshotResult,
  CdpDescribeNodeResult,
  CdpEvaluateResult,
  CdpFrameTreeResult,
  CdpFullAxTreeResult,
  CdpGetDocumentResult,
  CdpGetPropertiesResult,
  CdpGetTargetsResult,
  CdpLayoutMetrics,
  CdpLikeClient,
  CdpRectangle,
} from "./protocol.js";
import {
  createDomCollectionMetrics,
  DEFAULT_DOM_COLLECTION_CONFIG,
  type DOMCollectionConfig,
  type DOMCollectionMetrics,
  DOMDegradationLevel,
  DOMRect,
  type EnhancedAXNode,
  EnhancedDOMTreeNode,
  type EnhancedSnapshotNode,
  type FileInputInfo,
  NodeType,
} from "./types.js";

/** captureSnapshot 请求的 computedStyles 列表；styles[li][si] 的 si 按此顺序解值 */
export const REQUIRED_COMPUTED_STYLES: readonly string[] = [
  "display",
  "visibility",
  "opacity",
  "cursor",
  "pointer-events",
  "overflow",
  "overflow-x",
  "overflow-y",
  "position",
  "background-color",
];

/**
 * JS 点击监听器探测表达式（Python 原文逐字符一致；getEventListeners 需命令行 API）。
 * 保真说明：10000 是 Python 原文字面量，与 DOMCollectionConfig.heavyPageElementThreshold
 * 默认值同值但未接线——该配置项在 Python/TS 采集层都不生效，保留仅为对齐 dataclass 形状
 */
const JS_CLICK_LISTENER_EXPRESSION = `
(() => {
    if (typeof getEventListeners !== 'function') return null;
    const all = document.querySelectorAll('*');
    if (all.length > 10000) return null;
    const matched = [];
    for (const el of all) {
        try {
            const ls = getEventListeners(el);
            if (ls.click || ls.mousedown || ls.mouseup || ls.pointerdown || ls.pointerup) {
                matched.push(el);
            }
        } catch (e) {}
    }
    return matched;
})()
`;

// ── 纯函数工具 ──────────────────────────────────────────────────────────

/** CDP 交替数组 [k1,v1,k2,v2,...] → dict；值截 200 字符（码点语义，对齐 Python [:200]） */
export function parseAttrs(raw: string[] | undefined): Record<string, string> {
  // null 原型：`__proto__` 等键名不受 Object.prototype setter 干扰（字符串赋值会被
  // 静默吞掉致属性消失），与 Python dict 同口径（评审 P1.2 三轮 #2）
  const attrs = Object.create(null) as Record<string, string>;
  if (!raw) return attrs;
  // 步进 2 且上界 len-1：奇数个元素时最后一个悬空键被丢弃（Python range 同口径）
  for (let i = 0; i < raw.length - 1; i += 2) {
    const v = raw[i + 1];
    attrs[raw[i]] = v.length > 200 ? Array.from(v).slice(0, 200).join("") : v;
  }
  return attrs;
}

/** AX 原始节点 → EnhancedAXNode（对齐 Python _build_enhanced_ax_node） */
export function buildEnhancedAxNode(axNode: CdpAxTreeNode): EnhancedAXNode {
  let properties: EnhancedAXNode["properties"] = null;
  if (axNode.properties) {
    properties = [];
    for (const prop of axNode.properties) {
      // Python try/except KeyError：name 缺失的属性跳过
      if (prop.name === undefined) continue;
      properties.push({
        name: prop.name,
        value: (prop.value?.value ?? null) as string | boolean | number | null,
      });
    }
  }
  return {
    ax_node_id: axNode.nodeId,
    ignored: axNode.ignored ?? false,
    // CdpAxValue.value 为 unknown：Python 注解 str|None 与 wire 实际可出 bool/数值，原样透传
    role: (axNode.role?.value ?? null) as string | null,
    name: (axNode.name?.value ?? null) as string | null,
    description: (axNode.description?.value ?? null) as string | null,
    properties,
    child_ids: axNode.childIds ?? null,
  };
}

/** AX 树 → backendDOMNodeId 查找表；同 backendNodeId 后到者覆盖（Python dict 语义） */
export function buildAxLookup(axTree: CdpFullAxTreeResult): Map<number, CdpAxTreeNode> {
  const lookup = new Map<number, CdpAxTreeNode>();
  for (const node of axTree.nodes ?? []) {
    if (node.backendDOMNodeId !== undefined) lookup.set(node.backendDOMNodeId, node);
  }
  return lookup;
}

function rectOf(r: CdpRectangle | undefined): DOMRect | null {
  if (r && r.length >= 4) return new DOMRect(r[0], r[1], r[2], r[3]);
  return null;
}

/**
 * 跨源 iframe 匹配的 URL 归一化（去查询串 + 去全部尾部斜杠，Python rstrip("/") 口径）。
 * target 侧（buildFrameTargetMap）与 iframe 侧（attachCrossOriginIframe）必须同一
 * 入口，任一侧单独调整都会让匹配静默失效（评审 P1.2 一轮 #5）。
 */
function normalizeUrlForMatch(url: string): string {
  return url.split("?")[0].replace(/\/+$/, "");
}

/** DOMSnapshot → backendNodeId → EnhancedSnapshotNode 查找表（对齐 Python _build_snapshot_lookup） */
export function buildSnapshotLookup(
  snapshot: CdpCaptureSnapshotResult | null,
  devicePixelRatio = 1.0,
): Map<number, EnhancedSnapshotNode> {
  const lookup = new Map<number, EnhancedSnapshotNode>();
  if (!snapshot?.documents) return lookup;
  const strings = snapshot.strings ?? [];
  for (const doc of snapshot.documents) {
    // doc 级 nodes/layout 也容缺失（Python doc.get("nodes", {}) 同口径，评审 P1.2 一轮 #1）：
    // wire 正常有值；异常/截断响应缺键时按空数据继续，不击穿 buildEnhancedDomTree
    const nodes = doc.nodes;
    const layout = doc.layout;
    const backendIds = nodes?.backendNodeId ?? [];
    const layoutBounds = layout?.bounds ?? [];
    const layoutStyles = layout?.styles ?? [];
    const layoutPaintOrders = layout?.paintOrders ?? [];
    const layoutClientRects = layout?.clientRects ?? [];
    const layoutScrollRects = layout?.scrollRects ?? [];

    // isClickable RareBooleanData 稀疏化（O(1) 查找）
    const clickableSet = new Set<number>(nodes?.isClickable?.index ?? []);

    // 布局索引映射（nodeIndex → layout 下标），首次出现优先
    const layoutMap = new Map<number, number>();
    (layout?.nodeIndex ?? []).forEach((ni, li) => {
      if (!layoutMap.has(ni)) layoutMap.set(ni, li);
    });

    backendIds.forEach((bid, i) => {
      let isClickable: boolean | null = null;
      let bounds: DOMRect | null = null;
      let clientRects: DOMRect | null = null;
      let scrollRects: DOMRect | null = null;
      const computedStyles: Record<string, string> = {};
      let paintOrder: number | null = null;

      if (clickableSet.has(i)) isClickable = true;
      const li = layoutMap.get(i);
      if (li !== undefined) {
        if (li < layoutBounds.length) {
          const b = layoutBounds[li];
          if (b && b.length >= 4) {
            // bounds 是物理像素，除以 dpr 归一到 CSS 像素；client/scroll rects 不除
            bounds = new DOMRect(
              b[0] / devicePixelRatio,
              b[1] / devicePixelRatio,
              b[2] / devicePixelRatio,
              b[3] / devicePixelRatio,
            );
          }
        }
        if (li < layoutClientRects.length) clientRects = rectOf(layoutClientRects[li]);
        if (li < layoutScrollRects.length) scrollRects = rectOf(layoutScrollRects[li]);
        const sidxList = layoutStyles[li];
        if (sidxList) {
          for (let si = 0; si < sidxList.length; si++) {
            const sidx = sidxList[si];
            if (si < REQUIRED_COMPUTED_STYLES.length && sidx >= 0 && sidx < strings.length) {
              computedStyles[REQUIRED_COMPUTED_STYLES[si]] = strings[sidx];
            }
          }
        }
        if (li < layoutPaintOrders.length) paintOrder = layoutPaintOrders[li];
      }

      const hasStyles = Object.keys(computedStyles).length > 0;
      lookup.set(bid, {
        is_clickable: isClickable,
        cursor_style: hasStyles ? (computedStyles.cursor ?? null) : null,
        bounds,
        clientRects,
        scrollRects,
        computed_styles: hasStyles ? computedStyles : null,
        paint_order: paintOrder,
        stacking_contexts: null,
      });
    });
  }
  return lookup;
}

// ── file input 扫描（纯递归，含 shadow DOM / iframe） ───────────────────

/**
 * class 是否含 upload 容器标识。`||` 右侧恒被左侧覆盖（"semi-upload" 必含
 * "upload"）——Python 原文 collector.py:347 即如此冗余，保真保留不简化。
 */
function nodeHasUploadClass(attrs: Record<string, string>): boolean {
  const cls = (attrs.class ?? "").toLowerCase();
  return cls.includes("upload") || cls.includes("semi-upload");
}

/**
 * display/visibility/opacity 的 CSS 隐藏判定。fileInputVisible 与
 * isVisibleAccordingToAllParents 共用——Python 两处内联但口径等同
 * （_file_input_visible docstring 自述"判定口径等同前 6 行"），提取为纯等价重构
 */
function isHiddenByCssStyles(styles: Record<string, string>): boolean {
  if ((styles.display ?? "").toLowerCase() === "none") return true;
  if ((styles.visibility ?? "").toLowerCase() === "hidden") return true;
  // wire 值来自 Chrome 规范化十进制输出，parseFloat 的解析域与 Python float 一致
  const opacity = parseFloat(styles.opacity ?? "1");
  return !Number.isNaN(opacity) && opacity <= 0;
}

/** 按 computed_styles 判定 file input 可见性；无 snapshot 数据时保守视为可见 */
function fileInputVisible(
  snapshotLookup: Map<number, EnhancedSnapshotNode> | null,
  backendNodeId: number,
): boolean {
  if (!snapshotLookup) return true;
  const snap = snapshotLookup.get(backendNodeId);
  if (!snap) return true;
  return !isHiddenByCssStyles(snap.computed_styles ?? {});
}

/** 遍历 DOM.getDocument 树收集 file input 元数据（对齐 Python _collect_file_inputs） */
export function collectFileInputs(
  node: CdpGetDocumentResult["root"],
  snapshotLookup: Map<number, EnhancedSnapshotNode> | null = null,
  uploadAncestor = false,
): FileInputInfo[] {
  const results: FileInputInfo[] = [];
  const nodeAttrs = parseAttrs(node.attributes);
  if (node.nodeType === 1 && (node.nodeName ?? "").toUpperCase() === "INPUT") {
    if ((nodeAttrs.type ?? "").toLowerCase() === "file") {
      const bid = node.backendNodeId;
      if (bid !== undefined) {
        results.push({
          backend_node_id: bid,
          accept: nodeAttrs.accept ?? "",
          visible: fileInputVisible(snapshotLookup, bid),
          upload_ancestor: uploadAncestor,
          class_name: nodeAttrs.class ?? "",
        });
      }
    }
  }
  // 后代继承：当前节点自身是 upload 容器则置位
  const childUploadAncestor = uploadAncestor || nodeHasUploadClass(nodeAttrs);
  // 逐个追加与 AX 合并同口径（规避 spread 实参上限；此处规模小，属统一风格）
  for (const child of node.children ?? []) {
    for (const info of collectFileInputs(child, snapshotLookup, childUploadAncestor)) {
      results.push(info);
    }
  }
  for (const shadow of node.shadowRoots ?? []) {
    for (const info of collectFileInputs(shadow, snapshotLookup, childUploadAncestor)) {
      results.push(info);
    }
  }
  if (node.contentDocument) {
    for (const info of collectFileInputs(
      node.contentDocument,
      snapshotLookup,
      childUploadAncestor,
    )) {
      results.push(info);
    }
  }
  return results;
}

// ── 采集结果类型 ────────────────────────────────────────────────────────

/** _collect_cdp_sources 的产物：三源原始数据 + 降级判定 + 度量 */
export interface CdpSourcesResult {
  snapshot: CdpCaptureSnapshotResult | null;
  domTree: CdpGetDocumentResult | null;
  axTree: CdpFullAxTreeResult | null;
  dpr: number;
  degradation: DOMDegradationLevel;
  metrics: DOMCollectionMetrics;
}

/** _build_enhanced_dom_tree 的产物（Python 返回 4 元组，FAILED 时 root=null） */
export interface EnhancedTreeResult {
  root: EnhancedDOMTreeNode | null;
  fileInputBackendIds: number[];
  fileInputInfos: FileInputInfo[];
  metrics: DOMCollectionMetrics;
}

/** frameId→targetId 与 url→targetId 映射（跨源 iframe target 解析） */
export interface FrameTargetMaps {
  frameToTarget: ReadonlyMap<string, string>;
  urlToTarget: ReadonlyMap<string, string>;
}

/** buildEnhancedDomTree 的可选项（对齐 Python _build_enhanced_dom_tree 的关键字参数） */
export interface BuildEnhancedTreeOptions {
  viewportThreshold?: number | null;
  iframeDepth?: number;
  maxIframeDepth?: number;
  frameTargetMaps?: FrameTargetMaps;
  initialFrameOffset?: DOMRect | null;
  config?: DOMCollectionConfig;
}

// ── 融合构造器：单次树构建的闭包状态类化 ────────────────────────────────

/**
 * _construct_enhanced_node 递归的载体：memo + 三源查找表 + 可见性判定。
 * Python 中这些是 _build_enhanced_dom_tree 的闭包变量；跨源 iframe 递归会
 * 创建全新的本实例（memo / 查找表均不跨树共享）。
 */
class NodeFusion {
  readonly memo = new Map<number, EnhancedDOMTreeNode>();

  constructor(
    private readonly collector: DomCollector,
    private readonly sessionId: string | null,
    private readonly snapshotLookup: Map<number, EnhancedSnapshotNode>,
    private readonly axLookup: Map<number, CdpAxTreeNode>,
    private readonly jsClickIds: ReadonlySet<number>,
    private readonly degradation: DOMDegradationLevel,
    private readonly viewportThreshold: number | null,
    private readonly iframeDepth: number,
    private readonly maxIframeDepth: number,
    private readonly frameTargetMaps: FrameTargetMaps,
    private readonly config: DOMCollectionConfig,
  ) {}

  /** 递归构建融合节点（对齐 Python _construct_enhanced_node，逐分支移植） */
  async construct(
    node: CdpGetDocumentResult["root"],
    htmlFrames: EnhancedDOMTreeNode[],
    totalFrameOffset: DOMRect,
  ): Promise<EnhancedDOMTreeNode> {
    // nodeId 缺省兜底 0 是 Python 同口径（collector.py:707 node.get("nodeId", 0)）：
    // 异常 wire 下多个缺 nodeId 的节点会共用 0 键串树——保真保留（评审 P1.2 一轮 #11 驳回）
    const nid = node.nodeId ?? 0;
    const memoized = this.memo.get(nid);
    if (memoized) return memoized;

    // 深拷贝偏移量，防止分支间共享可变状态（Python 注释同源）
    const frameOffset = new DOMRect(
      totalFrameOffset.x,
      totalFrameOffset.y,
      totalFrameOffset.width,
      totalFrameOffset.height,
    );

    const backendId = node.backendNodeId ?? 0;
    const nodeTypeVal = node.nodeType ?? 1;

    // 三源查询：snapshot 布局 + AX 语义
    const snapshotData = this.snapshotLookup.get(backendId) ?? null;
    const axRaw = this.axLookup.get(backendId);
    const enhancedAx = axRaw ? buildEnhancedAxNode(axRaw) : null;

    const attributes = parseAttrs(node.attributes);
    const shadowRootType = node.shadowRootType ?? null;

    // absolute_position = snapshot bounds + 累计 iframe 偏移
    let absolutePosition: DOMRect | null = null;
    if (snapshotData?.bounds) {
      absolutePosition = new DOMRect(
        snapshotData.bounds.x + frameOffset.x,
        snapshotData.bounds.y + frameOffset.y,
        snapshotData.bounds.width,
        snapshotData.bounds.height,
      );
    }

    const domTreeNode = new EnhancedDOMTreeNode({
      nodeId: nid,
      backendNodeId: backendId,
      // 未知 nodeType 原样透传（Python NodeType() 会抛错；toJson 有数字串兜底）
      nodeType: nodeTypeVal as NodeType,
      nodeName: node.nodeName ?? "",
      nodeValue: node.nodeValue ?? "",
      attributes,
    });
    domTreeNode.isScrollable = node.isScrollable ?? null;
    domTreeNode.frameId = node.frameId ?? null;
    domTreeNode.sessionId = this.sessionId;
    domTreeNode.shadowRootType = shadowRootType;
    domTreeNode.snapshotNode = snapshotData;
    domTreeNode.axNode = enhancedAx;
    domTreeNode.hasJsClickListener = this.jsClickIds.has(backendId);
    domTreeNode.absolutePosition = absolutePosition;
    domTreeNode.isVisible = null; // 子树构建后计算

    this.memo.set(nid, domTreeNode);

    // parent 从缓存按 parentId 查找（Python 的 if parent_id 真值判断：0 视为无父）
    const parentId = node.parentId;
    if (parentId) {
      const parent = this.memo.get(parentId);
      if (parent) domTreeNode.parentNode = parent;
    }

    // html_frames 追踪与 iframe 偏移累积
    const updatedFrames = [...htmlFrames];
    if (
      nodeTypeVal === NodeType.ELEMENT_NODE &&
      node.nodeName === "HTML" &&
      node.frameId !== undefined
    ) {
      updatedFrames.push(domTreeNode);
      if (snapshotData?.scrollRects) {
        frameOffset.x -= snapshotData.scrollRects.x;
        frameOffset.y -= snapshotData.scrollRects.y;
      }
    }
    const upperName = (node.nodeName ?? "").toUpperCase();
    if ((upperName === "IFRAME" || upperName === "FRAME") && snapshotData?.bounds) {
      updatedFrames.push(domTreeNode);
      frameOffset.x += snapshotData.bounds.x;
      frameOffset.y += snapshotData.bounds.y;
    }

    // contentDocument（同源 iframe 内部文档）
    if (node.contentDocument) {
      domTreeNode.contentDocument = await this.construct(
        node.contentDocument,
        updatedFrames,
        frameOffset,
      );
      domTreeNode.contentDocument.parentNode = domTreeNode;
    } else if (
      (upperName === "IFRAME" || upperName === "FRAME") &&
      this.iframeDepth < this.maxIframeDepth
    ) {
      await this.attachCrossOriginIframe(domTreeNode, node, attributes, snapshotData, frameOffset);
    }

    // shadowRoots（Shadow DOM 子树）
    if (node.shadowRoots) {
      domTreeNode.shadowRoots = [];
      for (const shadowRoot of node.shadowRoots) {
        const srNode = await this.construct(shadowRoot, updatedFrames, frameOffset);
        srNode.parentNode = domTreeNode;
        domTreeNode.shadowRoots.push(srNode);
      }
    }

    // children（过滤已作为 shadow root 处理的节点）
    if (node.children) {
      domTreeNode.childrenNodes = [];
      const shadowRootNodeIds = new Set((node.shadowRoots ?? []).map((sr) => sr.nodeId ?? 0));
      for (const child of node.children) {
        if (shadowRootNodeIds.has(child.nodeId ?? 0)) continue;
        const childNode = await this.construct(child, updatedFrames, frameOffset);
        domTreeNode.childrenNodes.push(childNode);
      }
    }

    // 可见性在子树构建完成后计算（后序）
    domTreeNode.isVisible = this.isVisibleAccordingToAllParents(domTreeNode, updatedFrames);
    return domTreeNode;
  }

  /** 跨源 iframe：contentDocument 缺失时经 Target API 附加独立 session 递归构建 */
  private async attachCrossOriginIframe(
    domTreeNode: EnhancedDOMTreeNode,
    node: CdpGetDocumentResult["root"],
    attributes: Record<string, string>,
    snapshotData: EnhancedSnapshotNode | null,
    frameOffset: DOMRect,
  ): Promise<void> {
    // 尺寸门槛：≥ 50x50 像素
    let shouldProcess = false;
    if (snapshotData?.bounds) {
      shouldProcess = snapshotData.bounds.width >= 50 && snapshotData.bounds.height >= 50;
    }
    if (!shouldProcess) return;

    const maps = this.frameTargetMaps;
    // 解析 target：优先 frameId，回退 src URL 匹配
    let iframeTargetId: string | undefined;
    if (maps) {
      const frameId = node.frameId;
      if (frameId && maps.frameToTarget.has(frameId)) {
        iframeTargetId = maps.frameToTarget.get(frameId);
      }
      if (!iframeTargetId && attributes.src) {
        const srcBase = normalizeUrlForMatch(attributes.src);
        iframeTargetId = maps.urlToTarget.get(srcBase);
      }
    }
    if (!iframeTargetId) return;

    const iframeSessionId = await this.collector.attachToIframeTarget(iframeTargetId);
    if (!iframeSessionId) return;
    try {
      const sub = await this.collector.buildEnhancedDomTree(iframeSessionId, {
        viewportThreshold: this.viewportThreshold,
        iframeDepth: this.iframeDepth + 1,
        maxIframeDepth: this.maxIframeDepth,
        frameTargetMaps: maps,
        initialFrameOffset: frameOffset,
        config: this.config,
      });
      if (sub.root) {
        domTreeNode.contentDocument = sub.root;
        sub.root.parentNode = domTreeNode;
        domTreeNode.targetId = iframeTargetId;
      }
    } finally {
      try {
        await this.collector.client.send("Target.detachFromTarget", {
          sessionId: iframeSessionId,
        });
      } catch {
        // 分离失败不掩盖主流程（Python 同口径）
      }
    }
  }

  /**
   * CSS 可见性 + 逐帧视口交集检查（对齐 Python _is_element_visible_according_to_all_parents）。
   *
   * 保真注意：currentBounds 是节点 snapshot bounds 的引用，本方法会原位修改
   * （加 iframe 偏移、减滚动偏移）——Python 同样写回，序列化阶段读取的是
   * 调整后的 bounds；iframe 节点自身在 frames 内会出现自叠加，同样忠实保留。
   */
  private isVisibleAccordingToAllParents(
    enode: EnhancedDOMTreeNode,
    frames: EnhancedDOMTreeNode[],
  ): boolean {
    if (!enode.snapshotNode) {
      // MINIMAL 降级：无 snapshot 数据，假设可见
      if (this.degradation === DOMDegradationLevel.MINIMAL) return true;
      // Shadow DOM 元素可能缺少 snapshot 数据，不判定为不可见
      return enode.shadowRootType !== null;
    }
    if (isHiddenByCssStyles(enode.snapshotNode.computed_styles ?? {})) return false;

    const currentBounds = enode.snapshotNode.bounds;
    if (!currentBounds) return false;

    // viewportThreshold=null 时跳过视口检查
    if (this.viewportThreshold === null) return true;

    // 反向遍历 html_frames（从最内层到最外层）
    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = frames[i];
      const frameSnap = frame.snapshotNode;
      // IFRAME/FRAME 帧：加上 iframe 位置偏移
      if (
        frame.nodeType === NodeType.ELEMENT_NODE &&
        ["IFRAME", "FRAME"].includes(frame.nodeName.toUpperCase()) &&
        frameSnap?.bounds
      ) {
        currentBounds.x += frameSnap.bounds.x;
        currentBounds.y += frameSnap.bounds.y;
      }
      // HTML 帧：检查视口交叉
      if (
        frame.nodeType === NodeType.ELEMENT_NODE &&
        frame.nodeName === "HTML" &&
        frameSnap?.scrollRects &&
        frameSnap?.clientRects
      ) {
        const viewportRight = frameSnap.clientRects.width;
        const viewportBottom = frameSnap.clientRects.height;
        const adjustedX = currentBounds.x - frameSnap.scrollRects.x;
        const adjustedY = currentBounds.y - frameSnap.scrollRects.y;
        const intersects =
          adjustedX < viewportRight &&
          adjustedX + currentBounds.width > 0 &&
          adjustedY < viewportBottom + this.viewportThreshold &&
          adjustedY + currentBounds.height > -this.viewportThreshold;
        if (!intersects) return false;
        currentBounds.x -= frameSnap.scrollRects.x;
        currentBounds.y -= frameSnap.scrollRects.y;
      }
    }
    return true;
  }
}

// ── 主入口 ──────────────────────────────────────────────────────────────

/** 三源采集融合器（对齐 Python collector 模块函数族；client 经构造注入） */
export class DomCollector {
  constructor(readonly client: CdpLikeClient) {}

  /** frameId→targetId 与 url→targetId 映射；失败返回空映射（对齐 build_frame_target_map） */
  async buildFrameTargetMap(): Promise<FrameTargetMaps> {
    const frameToTarget = new Map<string, string>();
    const urlToTarget = new Map<string, string>();
    try {
      const targets = await this.client.send<CdpGetTargetsResult>("Target.getTargets", {});
      for (const t of targets.targetInfos ?? []) {
        if (t.type !== "iframe") continue;
        if (t.parentFrameId) frameToTarget.set(t.parentFrameId, t.targetId);
        const url = t.url ?? "";
        if (url) {
          const urlBase = normalizeUrlForMatch(url);
          if (urlBase) urlToTarget.set(urlBase, t.targetId);
        }
      }
    } catch {
      // Python logger.debug；映射为空即跨源 iframe 不处理
    }
    return { frameToTarget, urlToTarget };
  }

  /** 附加到 iframe target；失败返回 null（对齐 attach_to_iframe_target） */
  async attachToIframeTarget(targetId: string): Promise<string | null> {
    try {
      const result = await this.client.send<CdpAttachResult>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      return result.sessionId ?? null;
    } catch {
      return null;
    }
  }

  /** Page.getLayoutMetrics 算设备像素比；失败按 1.0（对齐 _get_viewport_ratio） */
  async getViewportRatio(sessionId: string | null = null): Promise<number> {
    try {
      const metrics = await this.client.send<CdpLayoutMetrics>(
        "Page.getLayoutMetrics",
        {},
        sessionId,
      );
      const cssWidth = metrics.cssVisualViewport?.clientWidth ?? 0;
      const deviceWidth = metrics.visualViewport?.clientWidth ?? cssWidth;
      // deviceWidth=0（窗口最小化/页面隐藏）时 JS 会产出 Infinity/NaN 坐标静默污染
      // 整树；Python 此形态在下游 b/dpr 处 ZeroDivisionError 直接抛出（无兜底）。
      // TS 按探测失败回退 1.0，优于复刻崩溃（评审 P1.2 一轮 #2）
      if (cssWidth > 0 && deviceWidth > 0) return deviceWidth / cssWidth;
    } catch {
      // Python logger.debug
    }
    return 1.0;
  }

  /** 逐 frame 采集 AX 树并合并（对齐 _get_ax_tree_for_all_frames） */
  async getAxTreeForAllFrames(sessionId: string | null = null): Promise<CdpFullAxTreeResult> {
    const frameTree = await this.client.send<CdpFrameTreeResult>(
      "Page.getFrameTree",
      {},
      sessionId,
    );
    const allFrameIds: string[] = [];
    const collectFrameIds = (n: CdpFrameTreeResult["frameTree"]): void => {
      allFrameIds.push(n.frame.id);
      for (const child of n.childFrames ?? []) collectFrameIds(child);
    };
    collectFrameIds(frameTree.frameTree);

    // 裸 Promise.all 无逐项容错，是 Python asyncio.gather 同口径（collector.py:162）：
    // 单 frame 消亡即整个 ax_tree 源失败 → 批级重试 → 仍失败降级 PARTIAL，
    // 不做"逐 frame 吞错保留其余"的改进以保融合语义与 Python 一致（评审 P1.2 一轮 #3 驳回）
    const axTrees = await Promise.all(
      allFrameIds.map((fid) =>
        this.client.send<CdpFullAxTreeResult>(
          "Accessibility.getFullAXTree",
          { frameId: fid },
          sessionId,
        ),
      ),
    );
    // 逐个追加而非 push(...nodes)：spread 展开受引擎实参上限约束（约 6.5 万~12.4 万），
    // 重型页面单 frame AX 节点可超限抛 RangeError；Python list.extend 无此限制（评审 P1.2 二轮 #1）
    const merged: CdpAxTreeNode[] = [];
    for (const tree of axTrees) {
      for (const n of tree.nodes ?? []) merged.push(n);
    }
    return { nodes: merged };
  }

  /** getEventListeners 探测 JS 点击监听器元素，返回 backendNodeId 集（对齐 _detect_js_click_listeners） */
  async detectJsClickListeners(sessionId: string | null = null): Promise<Set<number>> {
    try {
      const jsResult = await this.client.send<CdpEvaluateResult>(
        "Runtime.evaluate",
        {
          expression: JS_CLICK_LISTENER_EXPRESSION,
          includeCommandLineAPI: true,
          returnByValue: false,
        },
        sessionId,
      );
      const objectId = jsResult.result?.objectId;
      if (!objectId) return new Set();

      const arrayProps = await this.client.send<CdpGetPropertiesResult>(
        "Runtime.getProperties",
        { objectId, ownProperties: true },
        sessionId,
      );
      const elementObjectIds: string[] = [];
      for (const prop of arrayProps.result ?? []) {
        if (/^\d+$/.test(prop.name)) {
          const oid = prop.value?.objectId;
          if (oid) elementObjectIds.push(oid);
        }
      }

      const ids = await Promise.all(
        elementObjectIds.map(async (oid) => {
          try {
            const info = await this.client.send<CdpDescribeNodeResult>(
              "DOM.describeNode",
              { objectId: oid },
              sessionId,
            );
            return info.node?.backendNodeId ?? null;
          } catch {
            return null;
          }
        }),
      );
      const result = new Set<number>();
      for (const bid of ids) if (bid !== null) result.add(bid);

      // 数组句柄与逐元素句柄都释放（有意增强：Python 只释放数组句柄，collector.py:241）。
      // 远程对象句柄在 debuggee 存活至上下文销毁，扩展形态长驻页面反复采集，
      // 全监听器页每轮至多 1 万句柄会持续累积（评审 P1.2 四轮 #1）
      await Promise.all(
        [objectId, ...elementObjectIds].map(async (oidToRelease) => {
          try {
            await this.client.send("Runtime.releaseObject", { objectId: oidToRelease }, sessionId);
          } catch {
            // 释放失败不影响结果
          }
        }),
      );
      return result;
    } catch {
      return new Set();
    }
  }

  /** 三源 CDP 采集 + 两阶段超时重试 + 降级决策（对齐 _collect_cdp_sources） */
  async collectCdpSources(
    sessionId: string | null = null,
    config: DOMCollectionConfig = DEFAULT_DOM_COLLECTION_CONFIG,
  ): Promise<CdpSourcesResult> {
    const metrics = createDomCollectionMetrics();

    const batch = await runCdpBatch(
      new Map<string, () => Promise<unknown>>([
        [
          "snapshot",
          () =>
            this.client.send<CdpCaptureSnapshotResult>(
              "DOMSnapshot.captureSnapshot",
              {
                computedStyles: [...REQUIRED_COMPUTED_STYLES],
                includeDOMRects: true,
                includePaintOrder: true,
              },
              sessionId,
            ),
        ],
        [
          "dom_tree",
          () =>
            this.client.send<CdpGetDocumentResult>(
              "DOM.getDocument",
              { depth: -1, pierce: true },
              sessionId,
            ),
        ],
        ["ax_tree", () => this.getAxTreeForAllFrames(sessionId)],
        ["dpr", () => this.getViewportRatio(sessionId)],
      ]),
      { firstTimeout: config.cdpFirstTimeout, retryTimeout: config.cdpRetryTimeout },
    );
    metrics.totalMs = batch.totalMs;

    for (const [name, r] of batch.sources) metrics.sourceStatuses[name] = r.status;

    const snapshot = batch.get("snapshot") as CdpCaptureSnapshotResult | null;
    const domTree = batch.get("dom_tree") as CdpGetDocumentResult | null;
    const axTree = batch.get("ax_tree") as CdpFullAxTreeResult | null;
    const dpr = batch.get("dpr", 1.0) as number;

    // 降级决策：dom_tree 失败即整体失败；其次 snapshot；再次 ax_tree
    let degradation: DOMDegradationLevel;
    if (!domTree) degradation = DOMDegradationLevel.FAILED;
    else if (!snapshot) degradation = DOMDegradationLevel.MINIMAL;
    else if (!axTree) degradation = DOMDegradationLevel.PARTIAL;
    else degradation = DOMDegradationLevel.FULL;
    metrics.degradationLevel = degradation;

    // iframe 数量限制（原地截断，Python 同样改写 snapshot["documents"]）。
    // iframeCount 仅在触发截断时记录是 Python 同口径（collector.py:539-549）——
    // "未超限"与"无 iframe"同为 0；改动会破坏与 Python 的 metrics parity（评审 P1.2 一轮 #7 驳回）
    if (snapshot?.documents && snapshot.documents.length > config.maxIframes) {
      metrics.iframeCount = snapshot.documents.length;
      snapshot.documents = snapshot.documents.slice(0, config.maxIframes);
    }

    return { snapshot, domTree, axTree, dpr, degradation, metrics };
  }

  /**
   * 构建增强 DOM 树（不含序列化；序列化在 P1.3 buildDomState 接入）。
   *
   * 对齐 Python _build_enhanced_dom_tree；frameTargetMaps 缺省时自行构建
   * （Python 由 build_dom_state 组合传入，本入口独立可用）。
   */
  async buildEnhancedDomTree(
    sessionId: string | null = null,
    opts: BuildEnhancedTreeOptions = {},
  ): Promise<EnhancedTreeResult> {
    const config = opts.config ?? DEFAULT_DOM_COLLECTION_CONFIG;
    // 显式 null 合法（跳过视口检查），?? 会误吞，须用 undefined 区分缺省
    const viewportThreshold = opts.viewportThreshold === undefined ? 1000 : opts.viewportThreshold;
    const maps = opts.frameTargetMaps ?? (await this.buildFrameTargetMap());

    // Phase 1：JS 点击监听器探测，5s 截止防挂起（Python asyncio.wait_for 同口径）
    let jsClickIds = new Set<number>();
    try {
      jsClickIds = await withTimeoutMs(this.detectJsClickListeners(sessionId), 5000);
    } catch {
      // 超时或失败 → 空集（探测结果丢弃，底层调用无副作用）
    }

    // Phase 2：两阶段超时 + 降级 CDP 采集
    const { snapshot, domTree, axTree, dpr, degradation, metrics } = await this.collectCdpSources(
      sessionId,
      config,
    );

    if (degradation === DOMDegradationLevel.FAILED || !domTree) {
      // Python 此处返回 3 元组致上层解包崩溃（上游签名漂移）；TS 统一 4 字段
      return { root: null, fileInputBackendIds: [], fileInputInfos: [], metrics };
    }

    const snapshotLookup = snapshot
      ? buildSnapshotLookup(snapshot, dpr)
      : new Map<number, EnhancedSnapshotNode>();
    const axLookup = axTree ? buildAxLookup(axTree) : new Map<number, CdpAxTreeNode>();

    // root 缺失时以空对象继续建树是 Python 同口径（collector.py:602 dom_tree.get("root", {})，
    // nodeType 随后兜底 1）——不按 FAILED 显式失败，保真保留（评审 P1.2 一轮 #6 驳回）
    const root = domTree.root ?? ({} as CdpGetDocumentResult["root"]);
    const fileInputInfos = collectFileInputs(root, snapshotLookup);
    const fileInputBackendIds = fileInputInfos.map((fi) => fi.backend_node_id);

    const fusion = new NodeFusion(
      this,
      sessionId,
      snapshotLookup,
      axLookup,
      jsClickIds,
      degradation,
      viewportThreshold,
      opts.iframeDepth ?? 0,
      opts.maxIframeDepth ?? 5,
      maps,
      config,
    );
    const initialOffset = opts.initialFrameOffset ?? new DOMRect(0.0, 0.0, 0.0, 0.0);
    const treeRoot = await fusion.construct(root, [], initialOffset);

    return { root: treeRoot, fileInputBackendIds, fileInputInfos, metrics };
  }
}
