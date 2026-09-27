// CDP DOM.getDocument 树 → 干净 HTML 重建（extract 的 markdown 路径前置）。
// 纯函数、零 CDP：全量移植自 TreeWalker browser/html_source.py @640d52a。
// Python html.escape（quote=True 转义 & < > " '）逐字符等价实现。

const SKIP_TAGS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "template",
  "noscript",
  "svg",
  "canvas",
  "link",
  "meta",
  "head",
]);
const VOID_TAGS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** html.escape(s, quote=True)：& < > " ' */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** CDP attributes 交错数组 [name, val, ...] → dict；值截断 200 字符 */
function parseAttrs(raw: unknown): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!Array.isArray(raw)) return attrs;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i];
    const val = raw[i + 1];
    if (typeof name === "string" && typeof val === "string") {
      attrs[name] = val.slice(0, 200);
    }
  }
  return attrs;
}

/** 主文档树（不进 contentDocument）里找首个 <body> */
function findBody(node: unknown): Record<string, unknown> | null {
  if (!isRecord(node)) return null;
  if (String(node.nodeName ?? "").toLowerCase() === "body") return node;
  for (const key of ["children", "shadowRoots"] as const) {
    for (const child of Array.isArray(node[key]) ? node[key] : []) {
      const found = findBody(child);
      if (found !== null) return found;
    }
  }
  return null;
}

export interface HtmlSourceOptions {
  extractLinks?: boolean;
  extractImages?: boolean;
}

/**
 * 递归 children/shadowRoots/contentDocument 重建干净 HTML（nodeType 1/3 以外丢弃）。
 * CDP 伪节点壳（#document=9 / #shadow-root=11）解壳拼接 children——评审轮 1 #11/#12：
 * contentDocument 与 shadowRoots 条目都是壳节点，直落「非元素即丢弃」恒返空
 * （Python html_source.py @640d52a 同款缺陷；TS 修复对齐其头注承诺的递归带出语义）。
 */
export function nodeToHtml(node: unknown, options: HtmlSourceOptions = {}): string {
  const extractLinks = options.extractLinks ?? true;
  const extractImages = options.extractImages ?? true;
  if (!isRecord(node)) return "";
  const nodeType = typeof node.nodeType === "number" ? node.nodeType : 0;
  if (nodeType === 3) {
    const val = typeof node.nodeValue === "string" ? node.nodeValue : "";
    return val ? escapeHtml(val) : "";
  }
  if (nodeType === 9 || nodeType === 11) {
    const parts: string[] = [];
    for (const child of Array.isArray(node.children) ? node.children : []) {
      parts.push(nodeToHtml(child, options));
    }
    return parts.join("");
  }
  if (nodeType !== 1) return "";

  const tag = String(node.nodeName ?? "").toLowerCase();
  // iframe：丢标签本身，经 contentDocument 递归带出同源内容（跨源为 null → ""）
  if (tag === "iframe") {
    const contentDoc = node.contentDocument;
    return contentDoc ? nodeToHtml(contentDoc, options) : "";
  }
  if (SKIP_TAGS.has(tag)) return "";

  const attrs = parseAttrs(node.attributes);
  if (tag === "a" && !extractLinks) delete attrs.href;
  if (tag === "img" && !extractImages) delete attrs.src;

  let attrStr = "";
  for (const [k, v] of Object.entries(attrs)) {
    if (v) attrStr += ` ${k}="${escapeHtml(String(v))}"`;
  }
  const out = [`<${tag}${attrStr}>`];
  if (!VOID_TAGS.has(tag)) {
    for (const child of Array.isArray(node.children) ? node.children : []) {
      out.push(nodeToHtml(child, options));
    }
    for (const shadow of Array.isArray(node.shadowRoots) ? node.shadowRoots : []) {
      out.push(nodeToHtml(shadow, options));
    }
    if (node.contentDocument) out.push(nodeToHtml(node.contentDocument, options));
    out.push(`</${tag}>`);
  }
  return out.join("");
}

/** 从 DOM.getDocument 根定位 <body>（缺失则从根）返回其 HTML；root 空返回 "" */
export function documentBodyToHtml(root: unknown, options: HtmlSourceOptions = {}): string {
  if (!root) return "";
  const body = findBody(root);
  const target = body ?? root;
  return nodeToHtml(target, options);
}
