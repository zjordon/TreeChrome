// 元素定位族 + 回显族：_get_element_by_index/_find_node_by_backend_id/
// _is_autocomplete_field/_is_file_input_node + _describe_click/_describe_input/
// _describe_dropdown。移植自 TreeWalker tools/actions.py @640d52a（行锚点见各函数）。

import { ActionResult } from "../../../agent/views.js";
import type {
  BrowserStateSummary,
  EnhancedDOMTreeNode,
  SerializedDOMState,
} from "../../../browser/views.js";
import type { ToolsBrowser } from "../../types.js";
import type { ToolsContext } from "../context.js";

/** :75-76 <input type=file> 判定 */
export function isFileInputNode(node: EnhancedDOMTreeNode): boolean {
  return (
    node.tagName.toUpperCase() === "INPUT" && (node.attributes.type ?? "").toLowerCase() === "file"
  );
}

/**
 * :1378-1400 combobox/autocomplete 判定。返回 [isCombo, needsJsWait]：
 * isCombo 对任意 combobox 形字段为真（驱动 LLM 提示）；needsJsWait 仅对 JS 驱动
 * 子集（role=combobox 或 aria-autocomplete 非 none）为真——下拉异步填充需 ~0.4s。
 */
export function isAutocompleteField(entry: EnhancedDOMTreeNode): [boolean, boolean] {
  const attrs = entry.attributes ?? {};
  if (attrs.role === "combobox") return [true, true];
  const ariaAc = attrs["aria-autocomplete"] ?? "";
  if (ariaAc && ariaAc !== "none") return [true, true];
  if (attrs.list) return [true, false]; // native <datalist>：即时，不等待
  const haspopup = attrs["aria-haspopup"] ?? "";
  if (haspopup && haspopup !== "false" && (attrs["aria-controls"] || attrs["aria-owns"])) {
    return [true, false];
  }
  return [false, false];
}

/**
 * :797-812 按 index 查交互元素：优先 execute 缓存的 browserState.selectorMap，
 * miss 则 get_state 刷新。返回 [entry, error]。
 */
export async function getElementByIndex(
  index: number,
  browser: ToolsBrowser,
  ctx: ToolsContext,
): Promise<[EnhancedDOMTreeNode | null, ActionResult | null]> {
  const cached = ctx.cachedBrowserState;
  if (cached?.domState) {
    const entry = cached.domState.selectorMap.get(index);
    if (entry) return [entry, null];
  }
  const state = await browser.getState({ includeScreenshot: false });
  if (!state.domState) {
    return [null, new ActionResult({ error: "No DOM state available" })];
  }
  const entry = state.domState.selectorMap.get(index);
  if (!entry) {
    return [null, new ActionResult({ error: `Element ${index} not found in DOM state` })];
  }
  return [entry, null];
}

/** :1283-1299 按 backend_node_id 在 selector_map 反查节点（upload 软校验用；batch2） */
export function findNodeByBackendId(
  backendNodeId: number | null,
  domState: SerializedDOMState | null,
): EnhancedDOMTreeNode | null {
  if (!domState || backendNodeId === null) return null;
  for (const node of domState.selectorMap.values()) {
    if (node.backendNodeId === backendNodeId) return node;
  }
  return null;
}

/** Python repr() 的字符串形态（回显族 {v!r} 用；单引号优先，含 ' 切双引号） */
export function pyRepr(s: string): string {
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  if (!escaped.includes("'")) return `'${escaped}'`;
  if (!escaped.includes('"')) return `"${escaped}"`;
  return `'${escaped.replace(/'/g, "\\'")}'`;
}

const bounded = (v: string): string => {
  const t = v.trim();
  return t.length > 60 ? `${t.slice(0, 60)}...` : t;
};

const attrValue = (entry: EnhancedDOMTreeNode, key: string): string | null => {
  const v = entry.attributes?.[key];
  if (v !== undefined && v !== null && String(v).trim() !== "") return bounded(String(v));
  return null;
};

const nodeValue = (entry: EnhancedDOMTreeNode): string | null => {
  const v = (entry.nodeValue ?? "").trim();
  if (v === "") return null;
  return bounded(v);
};

/** :1119-1141 click 回显：可识别属性 → node_value → 裸 tag */
export function describeClick(entry: EnhancedDOMTreeNode, index: number): string {
  const tag = entry.tagName.toUpperCase();
  for (const key of ["aria-label", "placeholder", "title", "alt", "value"]) {
    const v = attrValue(entry, key);
    if (v !== null) return `Clicked [${tag}] ${pyRepr(v)} at index ${index}`;
  }
  const nv = nodeValue(entry);
  if (nv !== null) return `Clicked [${tag}] ${pyRepr(nv)} at index ${index}`;
  return `Clicked [${tag}] at index ${index}`;
}

/** :1170-1196 input 回显（跳过 value/alt——输入的文本本身才是重点） */
export function describeInput(entry: EnhancedDOMTreeNode, index: number, text: string): string {
  const shown = text.length <= 60 ? text : `${text.slice(0, 60)}...`;
  const tag = entry.tagName.toUpperCase();
  for (const key of ["aria-label", "placeholder", "title"]) {
    const v = attrValue(entry, key);
    if (v !== null) return `Typed ${pyRepr(shown)} into [${tag}] ${pyRepr(v)} at index ${index}`;
  }
  const nv = nodeValue(entry);
  if (nv !== null) return `Typed ${pyRepr(shown)} into [${tag}] ${pyRepr(nv)} at index ${index}`;
  return `Typed ${pyRepr(shown)} into [${tag}] at index ${index}`;
}

/** :1229-1251 dropdown 回显（select 常无 placeholder/value；aria-label/title/name/id 链） */
export function describeDropdown(entry: EnhancedDOMTreeNode, index: number): string {
  const tag = entry.tagName.toUpperCase() || "SELECT";
  for (const key of ["aria-label", "title", "name", "id"]) {
    const v = attrValue(entry, key);
    if (v !== null) return `[${tag}] ${pyRepr(v)} at index ${index}`;
  }
  const nv = nodeValue(entry);
  if (nv !== null) return `[${tag}] ${pyRepr(nv)} at index ${index}`;
  return `[${tag}] at index ${index}`;
}

/** tab 摘要串（switch_tab/close_tab 的 error/回显复用，:1647-1655） */
export function summarizeTabs(
  tabs: ReadonlyArray<{ targetId: string; url: string; title: string }>,
): string {
  const items = tabs.map((t) => {
    const title = (t.title ?? "").trim().slice(0, 40);
    const url = (t.url ?? "").trim().slice(0, 60);
    return `[${t.targetId.slice(-4)}] ${title} - ${url}`;
  });
  return items.join("; ");
}

/** state 类型守卫便利（内部使用） */
export type { BrowserStateSummary };
