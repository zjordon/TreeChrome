/**
 * CDP 三源采集的线格式（wire format）类型。
 *
 * 定义为「消费子集」：CDP 实际响应包含更多字段，采集与融合代码必须容忍
 * 未知字段（不要用 exhaustive 校验）。字段名保持 CDP 协议原文。
 *
 * 三源（对齐 dom-snapshot collector._collect_cdp_sources）：
 *   1. DOM.getDocument(depth=-1, pierce=true)          —— 权威树 + shadow DOM
 *   2. DOMSnapshot.captureSnapshot                      —— 布局/可见性/坐标/paintOrder
 *   3. Accessibility.getFullAXTree                      —— 语义角色/名称/状态
 * 三源以 backendNodeId 交叉引用融合。
 */

/** CDP 客户端抽象：cdp-ws（Node）与 cdp-chrome（扩展）各自的 transport 都实现它 */
export interface CdpLikeClient {
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T>;
}

// ── 源 1：DOM.getDocument ─────────────────────────────────────────────

export interface CdpDomNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  nodeValue: string;
  /** CDP 原生形态：扁平 [name1, value1, name2, value2, ...]，融合阶段转 dict */
  attributes?: string[];
  children?: CdpDomNode[];
  contentDocument?: CdpDomNode;
  shadowRoots?: CdpDomNode[];
  pseudoElements?: CdpDomNode[];
  /** 模板内容 */
  templateContent?: CdpDomNode;
  frameId?: string;
  documentURL?: string;
  baseURL?: string;
}

export interface DomGetDocumentParams {
  depth: number;
  pierce: boolean;
}

// ── 源 2：DOMSnapshot.captureSnapshot ─────────────────────────────────

/** CDP Rectangle：[x, y, width, height] 共 4 个数，宽高可含亚像素值（fixture wire 实证） */
export type CdpRectangle = [number, number, number, number];

/**
 * layout.bounds 为 Rectangle[]：与 nodeIndex 平行，每节点一项。
 * strings 是全快照共享的字符串表，文本/样式值经索引引用。
 */
export interface CdpSnapshotLayout {
  nodeIndex: number[];
  bounds: CdpRectangle[];
  text: number[];
  /** CDP RareBooleanData：稀疏包装，index 为命中该属性的 nodeIndex 列表 */
  stackingContexts: { index: number[] };
  /**
   * 仅 includePaintOrder=true 时返回，采集层必须开启该开关。
   * 键名对齐 wire 实际（fixture 实证）：CDP 返回 paintOrders（复数）。
   */
  paintOrders?: number[];
  /** CDP RareIntegerData：稀疏双平行数组，value 为 strings 表索引（光标名） */
  cursor?: { index: number[]; value: number[] };
  /** layoutTextInputs 等其余字段按需补充 */
}

/** 与 layout.nodeIndex 平行的扁平节点表；backendNodeId 为三源融合键 */
export interface CdpSnapshotNodeTree {
  backendNodeId: number[];
}

export interface CdpSnapshotDocument {
  documentIndex?: number;
  /** layout.nodeIndex / paintOrders 等数组的下标指向本表的平行数组 */
  nodes: CdpSnapshotNodeTree;
  layout: CdpSnapshotLayout;
  textBoxes?: {
    layoutIndex: number[];
    bounds: CdpRectangle[];
    start: number[];
    length: number[];
  };
}

export interface CaptureSnapshotParams {
  computedStyles: string[];
  includeDOMRects?: boolean;
  includePaintOrder?: boolean;
}

export interface CdpCaptureSnapshotResult {
  documents: CdpSnapshotDocument[];
  strings: string[];
}

// ── 源 3：Accessibility.getFullAXTree ─────────────────────────────────

export interface CdpAxValue {
  type: string;
  value: unknown;
}

export interface CdpAxTreeNode {
  /** CDP 协议原名为 nodeId（AXNodeId），此处改名以避免与 CdpDomNode.nodeId 语义混淆 */
  axNodeId: string;
  /** 与 DOM 树交叉引用的关键字段；ignored 节点通常缺失，融合需容忍缺失与一对多 */
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: CdpAxValue;
  name?: CdpAxValue;
  value?: CdpAxValue;
  description?: CdpAxValue;
  properties?: { name: string; value: CdpAxValue }[];
  childIds?: string[];
  parentId?: string;
  frameId?: string;
}

export interface CdpFullAxTreeResult {
  nodes: CdpAxTreeNode[];
}
