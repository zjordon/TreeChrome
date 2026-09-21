/**
 * DOM 数据模型 —— dom-snapshot 库 models.py 的忠实 TS 移植。
 *
 * 移植保真约定：
 * - toJson() 的键名保持 Python __json__ 的 snake_case，golden fixture 逐字节对拍依赖这一点。
 * - elementHash / computeStableHash 返回 bigint：Python 端是 64 位无符号整数
 *   （sha256 前 16 hex），超出 JS Number.MAX_SAFE_INTEGER，跨端 JSON 序列化统一用字符串。
 * - 数值舍入对齐 Python round() 的银行家舍入（roundHalfEven）。
 */
import { sha256Hex } from "./sha256.js";

// ── 常量（models.py:22-153） ────────────────────────────────────────────

export const DEFAULT_INCLUDE_ATTRIBUTES: readonly string[] = [
  "title",
  "type",
  "checked",
  "id",
  "name",
  "role",
  "value",
  "placeholder",
  "data-date-format",
  "alt",
  "aria-label",
  "aria-expanded",
  "data-state",
  "aria-checked",
  "aria-valuemin",
  "aria-valuemax",
  "aria-valuenow",
  "aria-placeholder",
  "pattern",
  "min",
  "max",
  "minlength",
  "maxlength",
  "step",
  "accept",
  "multiple",
  "inputmode",
  "autocomplete",
  "aria-autocomplete",
  "list",
  "data-mask",
  "data-inputmask",
  "data-datepicker",
  "format",
  "expected_format",
  "contenteditable",
  "pseudo",
  "selected",
  "expanded",
  "pressed",
  "disabled",
  "invalid",
  "valuemin",
  "valuemax",
  "valuenow",
  "keyshortcuts",
  "haspopup",
  "multiselectable",
  "required",
  "valuetext",
  "level",
  "busy",
  "live",
  "ax_name",
];

export const STATIC_ATTRIBUTES: ReadonlySet<string> = new Set([
  "class",
  "id",
  "name",
  "type",
  "placeholder",
  "aria-label",
  "title",
  "role",
  "data-testid",
  "data-test",
  "data-cy",
  "data-selenium",
  "for",
  "required",
  "disabled",
  "readonly",
  "checked",
  "selected",
  "multiple",
  "accept",
  "href",
  "target",
  "rel",
  "aria-describedby",
  "aria-labelledby",
  "aria-controls",
  "aria-owns",
  "aria-live",
  "aria-atomic",
  "aria-busy",
  "aria-hidden",
  "aria-pressed",
  "aria-autocomplete",
  "aria-checked",
  "aria-selected",
  "list",
  "tabindex",
  "alt",
  "src",
  "lang",
  "itemscope",
  "itemtype",
  "itemprop",
  "pseudo",
  "aria-valuemin",
  "aria-valuemax",
  "aria-valuenow",
  "aria-placeholder",
]);

const DYNAMIC_CLASS_PATTERNS: ReadonlySet<string> = new Set([
  "focus",
  "hover",
  "active",
  "selected",
  "disabled",
  "animation",
  "transition",
  "loading",
  "open",
  "closed",
  "expanded",
  "collapsed",
  "visible",
  "hidden",
  "pressed",
  "checked",
  "highlighted",
  "current",
  "entering",
  "leaving",
]);

/** 去掉动态状态类，保留语义/识别类；结果按字典序排序（对齐 Python sorted）。 */
export function filterDynamicClasses(classStr: string | null): string {
  if (!classStr) return "";
  const stable = classStr
    .split(/\s+/)
    .filter((c) => c !== "")
    .filter((c) => {
      const lower = c.toLowerCase();
      // 热路径（computeStableHash 每元素调用）：直接迭代 Set，不为每个 token 展开新数组
      for (const p of DYNAMIC_CLASS_PATTERNS) {
        if (lower.includes(p)) return false;
      }
      return true;
    });
  stable.sort();
  return stable.join(" ");
}

// ── 枚举 ───────────────────────────────────────────────────────────────

export enum NodeType {
  ELEMENT_NODE = 1,
  ATTRIBUTE_NODE = 2,
  TEXT_NODE = 3,
  CDATA_SECTION_NODE = 4,
  ENTITY_REFERENCE_NODE = 5,
  ENTITY_NODE = 6,
  PROCESSING_INSTRUCTION_NODE = 7,
  COMMENT_NODE = 8,
  DOCUMENT_NODE = 9,
  DOCUMENT_TYPE_NODE = 10,
  DOCUMENT_FRAGMENT_NODE = 11,
  NOTATION_NODE = 12,
}

// ── 舍入工具（对齐 Python round 的银行家舍入） ──────────────────────────

/**
 * 对齐 Python round() 的精确十进制舍入（银行家舍入）。
 *
 * 不能用「n × 10^d 再看小数部分」的实现：乘法自身的舍入会把 1.05×10 恰好
 * 舍到 10.5，制造假平局（Python round(1.05,1)=1.1，假平局会给 1.0）。
 * 这里的做法是把浮点的精确值 m·2^e（BigInt 整数域）放大到目标位数后整除取余，
 * 余数×2 与除数比较判平局——与 Python 基于 dtoa 精确十进制展开的舍入等价。
 */
export function roundHalfEven(n: number, digits: number): number {
  if (!Number.isFinite(n) || digits < 0) return n;
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, n);
  const bits = buf.getBigUint64(0);
  const negative = bits >> 63n === 1n;
  const expBits = Number((bits >> 52n) & 0x7ffn);
  const mant = bits & 0xfffffffffffffn;
  let m: bigint;
  let e: number;
  if (expBits === 0) {
    m = mant;
    e = -1074;
  } else {
    m = mant | (1n << 52n);
    e = expBits - 1075;
  }
  if (m === 0n) return n;

  // 精确值 |n| = m·2^e；放大 10^digits 后整除：num/den
  const ten = 10n ** BigInt(digits);
  let num: bigint;
  let den: bigint = 1n;
  if (e >= 0) {
    num = (m << BigInt(e)) * ten;
  } else {
    den = 1n << BigInt(-e);
    num = m * ten;
  }

  const q = num / den; // num, den 恒正，截断即向零取整
  const twice = (num % den) * 2n;
  let k = q;
  if (twice > den || (twice === den && q % 2n === 1n)) k = q + 1n;

  const result = Number(k) / 10 ** digits;
  return negative ? -result : result;
}

// ── 几何 ───────────────────────────────────────────────────────────────

export class DOMRect {
  constructor(
    public x: number,
    public y: number,
    public width: number,
    public height: number,
  ) {}

  toDict(): Record<string, number> {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }
}

// ── AX 树 ──────────────────────────────────────────────────────────────

export interface EnhancedAXProperty {
  name: string;
  value: string | boolean | null;
}

export interface EnhancedAXNode {
  ax_node_id: string;
  ignored: boolean;
  role: string | null;
  name: string | null;
  description: string | null;
  properties: EnhancedAXProperty[] | null;
  child_ids: string[] | null;
}

// ── Snapshot 布局数据（DOMSnapshot.captureSnapshot） ───────────────────

export interface EnhancedSnapshotNode {
  is_clickable: boolean | null;
  cursor_style: string | null;
  bounds: DOMRect | null;
  clientRects: DOMRect | null;
  scrollRects: DOMRect | null;
  computed_styles: Record<string, string> | null;
  paint_order: number | null;
  stacking_contexts: number | null;
}

// ── 滚动信息（models.py scroll_info 的字典形态） ───────────────────────

export interface ScrollInfo {
  scroll_top: number;
  scroll_left: number;
  scrollable_height: number;
  scrollable_width: number;
  visible_height: number;
  visible_width: number;
  content_above: number;
  content_below: number;
  content_left: number;
  content_right: number;
  vertical_scroll_percentage: number;
  horizontal_scroll_percentage: number;
  pages_above: number;
  pages_below: number;
  total_pages: number;
  can_scroll_up: boolean;
  can_scroll_down: boolean;
  can_scroll_left: boolean;
  can_scroll_right: boolean;
}

// ── 核心融合节点 ───────────────────────────────────────────────────────

export class EnhancedDOMTreeNode {
  // DOM 节点数据
  nodeId: number;
  backendNodeId: number;
  nodeType: NodeType;
  nodeName: string;
  nodeValue: string;
  attributes: Record<string, string>;
  isScrollable: boolean | null = null;
  isVisible: boolean | null = null;
  /** paint_order 静态遮挡标志（serializer 侧算好后回填，供 selector_map 判定 receives-events） */
  ignoredByPaintOrder = false;
  absolutePosition: DOMRect | null = null;

  // Frame 管理
  targetId = "";
  frameId: string | null = null;
  sessionId: string | null = null;
  contentDocument: EnhancedDOMTreeNode | null = null;

  // Shadow DOM
  shadowRootType: string | null = null;
  shadowRoots: EnhancedDOMTreeNode[] | null = null;

  // 树导航
  parentNode: EnhancedDOMTreeNode | null = null;
  childrenNodes: EnhancedDOMTreeNode[] | null = null;

  // AX / Snapshot 数据
  axNode: EnhancedAXNode | null = null;
  snapshotNode: EnhancedSnapshotNode | null = null;

  // 附加字段
  hasJsClickListener = false;
  compoundChildren: Record<string, unknown>[] = [];
  hiddenElementsInfo: Record<string, unknown>[] = [];
  hasHiddenContent = false;
  /** 移植注意：Python 端 uuid4 无跨端可比性，仅进程内使用；fixture 比较时跳过 */
  uuid = cryptoUuid();

  constructor(init: {
    nodeId: number;
    backendNodeId: number;
    nodeType: NodeType;
    nodeName: string;
    nodeValue: string;
    attributes: Record<string, string>;
    parentNode?: EnhancedDOMTreeNode | null;
    childrenNodes?: EnhancedDOMTreeNode[] | null;
    axNode?: EnhancedAXNode | null;
    snapshotNode?: EnhancedSnapshotNode | null;
  }) {
    this.nodeId = init.nodeId;
    this.backendNodeId = init.backendNodeId;
    this.nodeType = init.nodeType;
    this.nodeName = init.nodeName;
    this.nodeValue = init.nodeValue;
    this.attributes = init.attributes;
    this.parentNode = init.parentNode ?? null;
    this.childrenNodes = init.childrenNodes ?? null;
    this.axNode = init.axNode ?? null;
    this.snapshotNode = init.snapshotNode ?? null;
  }

  // ── 便捷属性 ────────────────────────────────────────────────────────

  get parent(): EnhancedDOMTreeNode | null {
    return this.parentNode;
  }

  get children(): EnhancedDOMTreeNode[] {
    return this.childrenNodes ?? [];
  }

  get childrenAndShadowRoots(): EnhancedDOMTreeNode[] {
    const children = this.childrenNodes ? [...this.childrenNodes] : [];
    if (this.shadowRoots) children.push(...this.shadowRoots);
    return children;
  }

  get tagName(): string {
    return this.nodeName.toLowerCase();
  }

  /** 点击中心 X（对齐 Python int() 的截断语义） */
  get x(): number {
    if (this.snapshotNode) {
      const r = this.snapshotNode.bounds ?? this.snapshotNode.clientRects;
      if (r) return Math.trunc(r.x + r.width / 2);
    }
    return 0;
  }

  get y(): number {
    if (this.snapshotNode) {
      const r = this.snapshotNode.bounds ?? this.snapshotNode.clientRects;
      if (r) return Math.trunc(r.y + r.height / 2);
    }
    return 0;
  }

  get width(): number {
    if (this.snapshotNode?.bounds) return Math.trunc(this.snapshotNode.bounds.width);
    return 0;
  }

  get height(): number {
    if (this.snapshotNode?.bounds) return Math.trunc(this.snapshotNode.bounds.height);
    return 0;
  }

  // ── XPath ──────────────────────────────────────────────────────────

  /** 生成 XPath，在 shadow 边界或 iframe 处停止 */
  get xpath(): string {
    const segments: string[] = [];
    let current: EnhancedDOMTreeNode | null = this;
    while (
      current !== null &&
      (current.nodeType === NodeType.ELEMENT_NODE ||
        current.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE)
    ) {
      if (current.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE) {
        current = current.parentNode;
        continue;
      }
      if (current.parentNode && current.parentNode.nodeName.toLowerCase() === "iframe") break;
      const pos = this.getElementPosition(current);
      const tag = current.nodeName.toLowerCase();
      const idx = pos > 0 ? `[${pos}]` : "";
      segments.unshift(`${tag}${idx}`);
      current = current.parentNode;
    }
    return segments.join("/");
  }

  private getElementPosition(element: EnhancedDOMTreeNode): number {
    const siblings = element.parentNode?.childrenNodes;
    if (!siblings) return 0;
    const sameTag = siblings.filter(
      (c) =>
        c.nodeType === NodeType.ELEMENT_NODE &&
        c.nodeName.toLowerCase() === element.nodeName.toLowerCase(),
    );
    if (sameTag.length <= 1) return 0;
    const i = sameTag.indexOf(element);
    return i >= 0 ? i + 1 : 0;
  }

  // ── 文本收集 ───────────────────────────────────────────────────────

  getAllChildrenText(maxDepth = -1): string {
    const parts: string[] = [];
    const collect = (node: EnhancedDOMTreeNode, depth: number): void => {
      if (maxDepth !== -1 && depth > maxDepth) return;
      if (node.nodeType === NodeType.TEXT_NODE) parts.push(node.nodeValue);
      else if (node.nodeType === NodeType.ELEMENT_NODE) {
        for (const child of node.children) collect(child, depth + 1);
      }
    };
    collect(this, 0);
    return parts.join("\n").trim();
  }

  llmRepresentation(maxTextLength = 100): string {
    let text = this.getAllChildrenText();
    if (text && text.length > maxTextLength) text = text.slice(0, maxTextLength);
    return `<${this.tagName}>${text}`;
  }

  getMeaningfulTextForLlm(): string {
    for (const attr of ["value", "aria-label", "title", "placeholder", "alt"]) {
      const v = this.attributes[attr];
      if (v) return v;
    }
    return this.getAllChildrenText().trim();
  }

  // ── 滚动检测 ───────────────────────────────────────────────────────

  get isActuallyScrollable(): boolean {
    if (this.isScrollable) return true;
    if (!this.snapshotNode) return false;
    const scroll = this.snapshotNode.scrollRects;
    const client = this.snapshotNode.clientRects;
    if (scroll && client) {
      const v = scroll.height > client.height + 1;
      const h = scroll.width > client.width + 1;
      if (v || h) {
        const styles = this.snapshotNode.computed_styles;
        if (styles) {
          const overflow = (styles.overflow ?? "visible").toLowerCase();
          const ox = (styles["overflow-x"] ?? overflow).toLowerCase();
          const oy = (styles["overflow-y"] ?? overflow).toLowerCase();
          return (
            ["auto", "scroll", "overlay"].includes(overflow) ||
            ["auto", "scroll", "overlay"].includes(ox) ||
            ["auto", "scroll", "overlay"].includes(oy)
          );
        }
        return ["div", "main", "section", "article", "aside", "body", "html"].includes(
          this.tagName,
        );
      }
    }
    return false;
  }

  get scrollInfo(): ScrollInfo | null {
    if (!this.isActuallyScrollable || !this.snapshotNode) return null;
    const scroll = this.snapshotNode.scrollRects;
    const client = this.snapshotNode.clientRects;
    if (!scroll || !client) return null;

    const scrollTop = scroll.y;
    const scrollLeft = scroll.x;
    const contentAbove = Math.max(0, scrollTop);
    const contentBelow = Math.max(0, scroll.height - client.height - scrollTop);
    const contentLeft = Math.max(0, scrollLeft);
    const contentRight = Math.max(0, scroll.width - client.width - scrollLeft);

    let vPct = 0;
    let hPct = 0;
    if (scroll.height > client.height) {
      // 进入本分支即保证 maxTop > 0（Python 原文的三元 else 在此恒不可达，直算）
      const maxTop = scroll.height - client.height;
      vPct = (scrollTop / maxTop) * 100;
    }
    if (scroll.width > client.width) {
      const maxLeft = scroll.width - client.width;
      hPct = (scrollLeft / maxLeft) * 100;
    }

    const pagesAbove = client.height > 0 ? contentAbove / client.height : 0;
    const pagesBelow = client.height > 0 ? contentBelow / client.height : 0;
    const totalPages = client.height > 0 ? scroll.height / client.height : 1;

    return {
      scroll_top: scrollTop,
      scroll_left: scrollLeft,
      scrollable_height: scroll.height,
      scrollable_width: scroll.width,
      visible_height: client.height,
      visible_width: client.width,
      content_above: contentAbove,
      content_below: contentBelow,
      content_left: contentLeft,
      content_right: contentRight,
      vertical_scroll_percentage: roundHalfEven(vPct, 1),
      horizontal_scroll_percentage: roundHalfEven(hPct, 1),
      pages_above: roundHalfEven(pagesAbove, 1),
      pages_below: roundHalfEven(pagesBelow, 1),
      total_pages: roundHalfEven(totalPages, 1),
      can_scroll_up: contentAbove > 0,
      can_scroll_down: contentBelow > 0,
      can_scroll_left: contentLeft > 0,
      can_scroll_right: contentRight > 0,
    };
  }

  get shouldShowScrollInfo(): boolean {
    if (!this.isActuallyScrollable) return false;
    const info = this.scrollInfo;
    if (!info) return false;
    return (
      info.can_scroll_up || info.can_scroll_down || info.can_scroll_left || info.can_scroll_right
    );
  }

  getScrollInfoText(): string | null {
    const info = this.scrollInfo;
    if (!info) return null;
    const parts: string[] = [];
    const vPct = info.vertical_scroll_percentage;
    const pagesBelow = info.pages_below;
    const pagesAbove = info.pages_above;
    const totalPages = info.total_pages;

    if (info.can_scroll_up || info.can_scroll_down) {
      parts.push(`scroll: ${roundHalfEven(vPct, 0)}%`);
      if (pagesBelow > 0) parts.push(`${roundHalfEven(pagesBelow, 1).toFixed(1)} pages below`);
      if (pagesAbove > 0) parts.push(`${roundHalfEven(pagesAbove, 1).toFixed(1)} pages above`);
      parts.push(`total: ${roundHalfEven(totalPages, 1).toFixed(1)} pages`);
    }
    return parts.length > 0 ? parts.join(", ") : null;
  }

  // ── 哈希 ───────────────────────────────────────────────────────────

  private hashHex(filteredClass: boolean): bigint {
    const path = this.getParentBranchPath();
    const pathStr = path.join("/");
    const entries = Object.entries(this.attributes).filter(([k]) => STATIC_ATTRIBUTES.has(k));
    // 三态比较固化不变量：属性名唯一时 0 分支不可达；若未来属性来源重构为可重复
    // （如多 frame 合并），静默返回 1 会与 Python sorted() 产生不同顺序 → 哈希漂移
    const sorted = entries.sort(([a], [b]) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    });
    let attrsStr = "";
    if (filteredClass) {
      // compute_stable_hash：class 过滤动态类，过滤后为空则跳过
      for (const [k, v] of sorted) {
        let val = v;
        if (k === "class") {
          val = filterDynamicClasses(v);
          if (!val) continue;
        }
        attrsStr += `${k}=${val}`;
      }
    } else {
      // __hash__：静态属性原样（class 不过滤）
      for (const [k, v] of sorted) attrsStr += `${k}=${v}`;
    }
    const axName = this.axNode?.name ? `|ax_name=${this.axNode.name}` : "";
    const combined = `${pathStr}|${attrsStr}${axName}`;
    return BigInt(`0x${sha256Hex(combined).slice(0, 16)}`);
  }

  /**
   * Python __hash__ 的值经内建 hash() 折叠：__hash__ 返回 64 位原始值（可达 ~1.8e19），
   * 超出 Python 哈希域 2^61-1 时按模折叠。持久化轨迹用的是这个折叠值
   * （TreeWalker browser/views.py:100 `element_hash=hash(node)`，rerun EXACT 层比对它），
   * 故 TS 复刻折叠。模命中 0 的天文概率边界不处理。
   */
  get elementHash(): bigint {
    const raw = this.hashHex(false);
    const MOD = 2305843009213693951n; // 2^61 - 1
    return raw < MOD ? raw : raw % MOD;
  }

  /** Python compute_stable_hash：class 经动态类过滤的稳定哈希 */
  computeStableHash(): bigint {
    return this.hashHex(true);
  }

  private getParentBranchPath(): string[] {
    const parents: EnhancedDOMTreeNode[] = [];
    let current: EnhancedDOMTreeNode | null = this;
    while (current !== null) {
      if (current.nodeType === NodeType.ELEMENT_NODE) parents.push(current);
      current = current.parentNode;
    }
    parents.reverse();
    return parents.map((p) => p.tagName);
  }

  // ── 序列化（snake_case 对齐 Python __json__，供 fixture 对拍） ───────

  /**
   * snake_case 对齐 Python __json__，供 fixture 对拍。
   *
   * @param serializeChildren false 时跳过 children_nodes/shadow_roots 的递归序列化
   *   （SimplifiedNode.toJson 会把这两个键删掉，浅模式把整树开销从 O(N×depth) 降到 O(N)）；
   *   content_document 链仍序列化（浅模式同样跳过其 children）。
   * 返回值为只读快照：attributes/ax_node.properties 等嵌套结构按引用共享，调用方不得修改。
   */
  toJson(serializeChildren = true): Record<string, unknown> {
    const json: Record<string, unknown> = {
      node_id: this.nodeId,
      backend_node_id: this.backendNodeId,
      // 枚举外的脏值兜底为数字串，避免 JSON.stringify 丢弃键破坏对拍契约
      node_type: NodeType[this.nodeType] ?? String(this.nodeType),
      node_name: this.nodeName,
      node_value: this.nodeValue,
      is_visible: this.isVisible,
      attributes: this.attributes,
      is_scrollable: this.isScrollable,
      session_id: this.sessionId,
      target_id: this.targetId,
      frame_id: this.frameId,
      content_document: this.contentDocument
        ? this.contentDocument.toJson(serializeChildren)
        : null,
      shadow_root_type: this.shadowRootType,
      ax_node: this.axNode ? { ...this.axNode } : null,
      snapshot_node: this.snapshotNode
        ? {
            is_clickable: this.snapshotNode.is_clickable,
            cursor_style: this.snapshotNode.cursor_style,
            bounds: this.snapshotNode.bounds?.toDict() ?? null,
            clientRects: this.snapshotNode.clientRects?.toDict() ?? null,
            scrollRects: this.snapshotNode.scrollRects?.toDict() ?? null,
            computed_styles: this.snapshotNode.computed_styles,
            paint_order: this.snapshotNode.paint_order,
            stacking_contexts: this.snapshotNode.stacking_contexts,
          }
        : null,
    };
    if (serializeChildren) {
      json.shadow_roots = this.shadowRoots ? this.shadowRoots.map((r) => r.toJson()) : [];
      json.children_nodes = this.childrenNodes ? this.childrenNodes.map((c) => c.toJson()) : [];
    }
    return json;
  }
}

/** 进程内 uuid；不保证跨平台与 Python uuid4 一致（对拍时跳过该字段） */
function cryptoUuid(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID().replace(/-/g, "");
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

// ── 类型别名 ───────────────────────────────────────────────────────────

/** Python: dict[int, EnhancedDOMTreeNode]；跨端 JSON 序列化时键为字符串 */
export type DOMSelectorMap = Map<number, EnhancedDOMTreeNode>;

// ── 序列化树 ───────────────────────────────────────────────────────────

export class SimplifiedNode {
  shouldDisplay = true;
  isInteractive = false;
  isNew = false;
  ignoredByPaintOrder = false;
  excludedByParent = false;
  isShadowHost = false;
  isCompoundComponent = false;
  highlightIndex: number | null = null;

  constructor(
    public originalNode: EnhancedDOMTreeNode,
    public children: SimplifiedNode[],
  ) {}

  private cleanOriginalNodeJson(nodeJson: Record<string, unknown>): Record<string, unknown> {
    delete nodeJson.children_nodes;
    delete nodeJson.shadow_roots;
    const cd = nodeJson.content_document;
    if (cd && typeof cd === "object") {
      nodeJson.content_document = this.cleanOriginalNodeJson(cd as Record<string, unknown>);
    }
    return nodeJson;
  }

  toJson(): Record<string, unknown> {
    // 浅模式：跳过 children_nodes/shadow_roots 的深序列化（本就会被 cleanOriginalNodeJson 删除）
    const cleaned = this.cleanOriginalNodeJson(this.originalNode.toJson(false));
    return {
      should_display: this.shouldDisplay,
      is_interactive: this.isInteractive,
      ignored_by_paint_order: this.ignoredByPaintOrder,
      excluded_by_parent: this.excludedByParent,
      highlight_index: this.highlightIndex,
      original_node: cleaned,
      children: this.children.map((c) => c.toJson()),
    };
  }
}

export interface PropagatingBounds {
  tag: string;
  bounds: DOMRect;
  nodeId: number;
  depth: number;
}

// ── 最终产物 ───────────────────────────────────────────────────────────

export interface FileInputInfo {
  backend_node_id: number;
  accept: string;
  visible: boolean;
  upload_ancestor: boolean;
  class_name: string;
}

export class SerializedDOMState {
  constructor(
    public root: SimplifiedNode | null,
    public selectorMap: DOMSelectorMap,
    public elementTreeText: string,
    public fileInputBackendIds: number[] = [],
    public fileInputsMeta: FileInputInfo[] = [],
    public pageStats: Record<string, unknown> = {},
  ) {}

  llmRepresentation(_includeAttributes?: string[]): string {
    if (!this.root) {
      return "Empty DOM tree (you might have to wait for the page to load)";
    }
    return this.elementTreeText;
  }
}

// ── 采集稳健性类型 ─────────────────────────────────────────────────────

export enum DOMDegradationLevel {
  FULL = "full",
  PARTIAL = "partial",
  MINIMAL = "minimal",
  FAILED = "failed",
}

export interface DOMCollectionConfig {
  cdpFirstTimeout: number;
  cdpRetryTimeout: number;
  maxIframes: number;
  heavyPageElementThreshold: number;
}

/** Python DOMCollectionConfig dataclass 默认值（models.py:732-738） */
export const DEFAULT_DOM_COLLECTION_CONFIG: DOMCollectionConfig = {
  cdpFirstTimeout: 10.0,
  cdpRetryTimeout: 2.0,
  maxIframes: 100,
  heavyPageElementThreshold: 10000,
};

export interface DOMCollectionMetrics {
  degradationLevel: DOMDegradationLevel;
  sourceStatuses: Record<string, string>;
  totalMs: number;
  iframeCount: number;
  elementCount: number;
}

/** Python DOMCollectionMetrics dataclass 默认值（models.py:742-749） */
export function createDomCollectionMetrics(): DOMCollectionMetrics {
  return {
    degradationLevel: DOMDegradationLevel.FULL,
    sourceStatuses: {},
    totalMs: 0,
    iframeCount: 0,
    elementCount: 0,
  };
}
