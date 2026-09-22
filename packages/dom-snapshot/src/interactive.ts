/**
 * 可交互元素检测 —— Python dom-snapshot interactive.py 的忠实移植。
 *
 * 14 条规则决策瀑布（ClickableElementDetector.is_interactive），综合 JS 点击
 * 监听器 / AX 角色 / HTML 标签 / cursor:pointer / 搜索关键词等信号，命中即短路
 * 返回。isInteractive 是序列化 Step 5 编号使用的公开入口。
 */
import { type EnhancedDOMTreeNode, NodeType } from "./types.js";

const FORM_CONTROL_TAGS: ReadonlySet<string> = new Set(["input", "select", "textarea"]);

const SEARCH_INDICATORS: ReadonlySet<string> = new Set([
  "search",
  "magnify",
  "glass",
  "lookup",
  "find",
  "query",
  // 以下 4 个条目均含子串 "search"（首位匹配即短路），逻辑上已被覆盖；
  // 为与 Python SEARCH_INDICATORS 常量一致原样保留，勿据此推断独立语义
  "search-icon",
  "search-btn",
  "search-button",
  "searchbox",
]);

const INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  "button",
  "input",
  "select",
  "textarea",
  "a",
  "details",
  "summary",
  "option",
  "optgroup",
]);

const INTERACTIVE_ATTRIBUTES: ReadonlySet<string> = new Set([
  "onclick",
  "onmousedown",
  "onmouseup",
  "onkeydown",
  "onkeyup",
  "tabindex",
]);

const INTERACTIVE_HTML_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "menuitem",
  "option",
  "radio",
  "checkbox",
  "tab",
  "textbox",
  "combobox",
  "slider",
  "spinbutton",
  "search",
  "searchbox",
  "row",
  "cell",
  "gridcell",
]);

const INTERACTIVE_AX_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "menuitem",
  "option",
  "radio",
  "checkbox",
  "tab",
  "textbox",
  "combobox",
  "slider",
  "spinbutton",
  "listbox",
  "search",
  "searchbox",
  "row",
  "cell",
  "gridcell",
]);

const ICON_ATTRIBUTES: ReadonlySet<string> = new Set([
  // "class" 属有意为之（Python 同口径）：任意 10-50px 带 class 的元素均判为可交互，
  // 误报面宽但换取消码率；改动会破坏 golden 逐字节对拍，需同步评估
  "class",
  "role",
  "onclick",
  "data-action",
  "aria-label",
]);

/** 规则 8：需真值才命中的 AX 属性名 */
const FOCUSABLE_AX_PROPS: ReadonlySet<string> = new Set(["focusable", "editable", "settable"]);

/** 规则 8：只看属性名、不看值的 AX 属性名（Python 同口径） */
const STATE_AX_PROPS: ReadonlySet<string> = new Set(["checked", "expanded", "pressed", "selected"]);

/** 规则 8：需真值才命中的 AX 属性名（第二组） */
const REQUIRED_AX_PROPS: ReadonlySet<string> = new Set(["required", "autocomplete"]);

/** 规则 5/6：元素在 maxDepth 层内是否包裹表单控件（input/select/textarea） */
function hasFormControlDescendant(element: EnhancedDOMTreeNode, maxDepth: number): boolean {
  if (maxDepth <= 0) return false;
  for (const child of element.childrenAndShadowRoots) {
    if (child.nodeType !== NodeType.ELEMENT_NODE) continue;
    if (FORM_CONTROL_TAGS.has(child.tagName)) return true;
    if (hasFormControlDescendant(child, maxDepth - 1)) return true;
  }
  return false;
}

/**
 * 公开的交互检测函数，供 DOMTreeSerializer 使用。
 *
 * 规则按信号强度排序，命中即短路返回（Python 端 try/except 守卫的 prop.value
 * 访问在 TS 类型收敛后不会抛错，不再复刻）。
 */
export function isInteractive(node: EnhancedDOMTreeNode): boolean {
  // 规则 1: 节点类型守卫 — 只有 ELEMENT_NODE 才可能交互
  if (node.nodeType !== NodeType.ELEMENT_NODE) return false;

  // 规则 2: html/body 排除 — 文档结构元素不是交互目标
  if (node.tagName === "html" || node.tagName === "body") return false;

  // 规则 3: JS 点击监听器 — 最强信号（Vue @click, React onClick, 原生 addEventListener）
  if (node.hasJsClickListener) return true;

  // 规则 4: IFRAME/FRAME — 大尺寸 iframe 可能有可滚动内容
  if (node.tagName === "iframe" || node.tagName === "frame") {
    const b = node.snapshotNode?.bounds;
    if (b && b.width > 100 && b.height > 100) return true;
  }

  // 规则 5: Label 处理 — 避免双重激活
  if (node.tagName === "label") {
    if (node.attributes.for !== undefined) return false;
    if (hasFormControlDescendant(node, 2)) return true;
    // 其他 label 继续后续规则
  }

  // 规则 6: Span 包装器 — 检测包裹表单控件的 span
  if (node.tagName === "span") {
    if (hasFormControlDescendant(node, 2)) return true;
    // 其他 span 继续后续规则
  }

  // 规则 7: 搜索元素检测 — class/id/data-* 含搜索关键词（子串匹配）
  const classList = (node.attributes.class ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((c) => c !== "");
  const joinedClass = classList.join(" ");
  const elementId = (node.attributes.id ?? "").toLowerCase();
  for (const indicator of SEARCH_INDICATORS) {
    if (joinedClass.includes(indicator)) return true;
    if (elementId.includes(indicator)) return true;
  }
  for (const [attrName, attrValue] of Object.entries(node.attributes)) {
    if (!attrName.startsWith("data-")) continue;
    const lower = attrValue.toLowerCase();
    for (const indicator of SEARCH_INDICATORS) {
      if (lower.includes(indicator)) return true;
    }
  }

  // 规则 8: AX 属性检查 — 可访问性树属性
  if (node.axNode?.properties) {
    for (const prop of node.axNode.properties) {
      if (prop.name === "disabled" && prop.value) return false;
      if (prop.name === "hidden" && prop.value) return false;
      if (FOCUSABLE_AX_PROPS.has(prop.name) && prop.value) return true;
      // checked/expanded/pressed/selected 只看属性名，不看值（Python 同口径）
      if (STATE_AX_PROPS.has(prop.name)) return true;
      if (REQUIRED_AX_PROPS.has(prop.name) && prop.value) return true;
      if (prop.name === "keyshortcuts" && prop.value) return true;
    }
  }

  // 规则 9: 交互标签 — 原生 HTML 交互元素
  if (INTERACTIVE_TAGS.has(node.tagName)) return true;

  if (Object.keys(node.attributes).length > 0) {
    // 规则 10: 交互 HTML 属性 — 内联事件处理器和 tabindex
    for (const attr of INTERACTIVE_ATTRIBUTES) {
      if (node.attributes[attr] !== undefined) return true;
    }

    // 规则 11: ARIA role（HTML 属性，精确匹配）
    const role = node.attributes.role;
    if (role !== undefined && INTERACTIVE_HTML_ROLES.has(role)) return true;
  }

  // 规则 12: AX 树 role
  if (node.axNode?.role && INTERACTIVE_AX_ROLES.has(node.axNode.role)) return true;

  // 规则 13: 图标尺寸元素 — 10-50px + 有交互属性
  const b = node.snapshotNode?.bounds;
  if (b && b.width >= 10 && b.width <= 50 && b.height >= 10 && b.height <= 50) {
    for (const attr of ICON_ATTRIBUTES) {
      if (node.attributes[attr] !== undefined) return true;
    }
  }

  // 规则 14: cursor: pointer — 最终兜底
  if (node.snapshotNode?.cursor_style === "pointer") return true;

  return false;
}
