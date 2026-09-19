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

/**
 * layout.bounds 为 quad 数组展平：每节点 8 个数（x1,y1,x2,y2,x3,y3,x4,y4）。
 * strings 是全快照共享的字符串表，文本/样式值经索引引用。
 */
export interface CdpSnapshotLayout {
  nodeIndex: number[];
  bounds: number[];
  text: number[];
  stackingContexts: { index: number[] };
  paintOrder: number[];
  cursor: number[];
  /** layoutTextInputs 等其余字段按需补充 */
}

export interface CdpSnapshotDocument {
  documentIndex?: number;
  layout: CdpSnapshotLayout;
  textBoxes?: { layoutIndex: number[]; bounds: number[]; start: number[]; length: number[] };
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
  axNodeId: string;
  /** 与 DOM 树交叉引用的关键字段 */
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
