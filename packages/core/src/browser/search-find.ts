// 页内搜索/查找族：find_text（3 查询 XPath 链 + 可见性优先 + 高亮三模式）/
// search_page（TreeWalker 文本缓冲 + 正则匹配窗）/ find_elements（CSS 查询穿透
// shadow/iframe）+ find_elements_node_ids（performSearch→backendNodeId）。
// 移植自 TreeWalker session.py :60-105（XPath 工具）/:105-279（search_page JS 体）/
// :290-427（find_elements JS 体与 builder）/:3941-4343（四方法族）@640d52a。
// 两个 JS 体逐字节照搬（含注释；锚点 batch2.json searchPageJs/findElementsJs）。

import { pyJsonDumps } from "../tools/py-json.js";
import { executeJs } from "./evaluate-basic.js";
import type { SessionInternals } from "./transport.js";

// ── XPath 工具（:50-99）───────────────────────────────────────────────

/**
 * XPath 1.0 字符串字面量：双引号内不能转义双引号——无双引号包 "..."；无单引号包
 * '...'；双引号都在时 splice concat(..., '"', ...)（修复 browser-use f-string 注入）。
 */
export function xpathStringLiteral(text: string): string {
  if (!text.includes('"')) return `"${text}"`;
  if (!text.includes("'")) return `'${text}'`;
  const parts = text.split('"');
  return `concat(${parts.map((p) => `"${p}"`).join(", '\"', ")})`;
}

const XPATH_LOWER = "'abcdefghijklmnopqrstuvwxyz'";
const XPATH_UPPER = "'ABCDEFGHIJKLMNOPQRSTUVWXYZ'";

/** find_text 批量上限（G9 可见性探测与 G8 nth 选择在此批次上进行；真总数仍上报） */
export const FIND_TEXT_CAP = 50;

export type TextQuery = [method: string, query: string];

/** 3 查询 XPath 链（G10：case-insensitive 经 translate() 双侧大写化） */
export function textQueries(text: string, caseSensitive: boolean): TextQuery[] {
  const lit = xpathStringLiteral(text);
  const needle = caseSensitive ? lit : `translate(${lit}, ${XPATH_LOWER}, ${XPATH_UPPER})`;
  const wrap = (e: string) =>
    caseSensitive ? e : `translate(${e}, ${XPATH_LOWER}, ${XPATH_UPPER})`;
  return [
    ["xpath-text", `//*[contains(${wrap("text()")}, ${needle})]`],
    ["xpath-content", `//*[contains(${wrap(".")}, ${needle})]`],
    ["xpath-attr", `//*[@*[contains(${wrap(".")}, ${needle})]]`],
  ];
}

// ── search_page JS 体（:111-279 逐字节；用户值经 json 序列化为 var 注入，绝不内插）──

const SEARCH_PAGE_JS_BODY = String.raw`
    function _getPath(el) {
        if (!el || el === document.body) return '';
        var parts = [];
        while (el && el !== document.body) {
            var tag = (el.tagName || '').toLowerCase();
            if (!tag) break;
            var part = tag;
            if (el.id) {
                part += '#' + el.id;
            } else if (el.className && typeof el.className === 'string') {
                var cls = el.className.trim().split(/\s+/).slice(0, 2).join('.');
                if (cls) part += '.' + cls;
            }
            parts.unshift(part);
            el = el.parentElement;
        }
        return parts.join(' > ');
    }
    function _origin(node) {
        // 标记非顶层文档来源：ShadowRoot(nodeType=11) → shadow DOM；其它(getRootNode≠document) → iframe
        try {
            var r = node.getRootNode ? node.getRootNode() : null;
            if (r && r !== document) {
                return r.nodeType === 11 ? ' (in shadow DOM)' : ' (in iframe)';
            }
        } catch (_) {}
        return '';
    }
    function _collectText(root) {
        var wt = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        var n;
        while ((n = wt.nextNode())) {
            var t = n.textContent;
            if (t && t.trim()) {
                nodeOffsets.push({offset: fullText.length, length: t.length, node: n});
                fullText += t;
            }
        }
        // 穿透：开放 shadow root + 同源 iframe contentDocument（TreeWalker 不跨 shadow / 文档边界，需手动递归）
        var we = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        var el;
        while ((el = we.nextNode())) {
            if (el.shadowRoot) {
                try { _collectText(el.shadowRoot); } catch (_) {}      // closed shadow: shadowRoot=null，自然跳过
            }
            if (el.tagName === 'IFRAME') {
                try {
                    var cd = el.contentDocument;                       // 同源可读；跨源抛 SecurityError → catch 跳过（阶段三）
                    if (cd && cd.body) _collectText(cd.body);
                } catch (_) {}
            }
        }
    }
    try {
        var scope = CSS_SCOPE ? document.querySelector(CSS_SCOPE) : document.body;
        if (!scope) {
            return {error: 'CSS scope selector not found: ' + CSS_SCOPE, matches: [], total: 0};
        }
        var fullText = '';
        var nodeOffsets = [];
        _collectText(scope);
        var flags = CASE_SENSITIVE ? 'g' : 'gi';
        var re;
        try {
            if (IS_REGEX) {
                re = new RegExp(PATTERN, flags);
            } else {
                re = new RegExp(PATTERN.replace(/[.*+?^${"$"}{}()|[\]\\]/g, '\\$&'), flags);
            }
        } catch (e) {
            return {error: 'Invalid regex pattern: ' + (e && e.message ? e.message : e), matches: [], total: 0};
        }
        var matches = [];
        var total = 0;
        var match;
        while ((match = re.exec(fullText)) !== null) {
            total++;
            // offset 窗口：累计全部 total，只存 [OFFSET, OFFSET+MAX_RESULTS) 区间（保持 early-bail 性能）
            if (total - 1 >= OFFSET && matches.length < MAX_RESULTS) {
                var start = Math.max(0, match.index - CONTEXT_CHARS);
                var end = Math.min(fullText.length, match.index + match[0].length + CONTEXT_CHARS);
                var context = fullText.slice(start, end);
                var elementPath = '';
                for (var i = 0; i < nodeOffsets.length; i++) {
                    var no = nodeOffsets[i];
                    if (no.offset <= match.index && no.offset + no.length > match.index) {
                        elementPath = _getPath(no.node.parentElement) + _origin(no.node);
                        break;
                    }
                }
                matches.push({
                    match_text: match[0],
                    context: (start > 0 ? '...' : '') + context + (end < fullText.length ? '...' : ''),
                    element_path: elementPath,
                    char_position: match.index
                });
            }
            if (match[0].length === 0) re.lastIndex++;
        }
        var attribute_matches = [];
        var attribute_total = 0;
        if (SEARCH_ATTRIBUTES) {
            // 非全局 RegExp 副本做 .test，规避全局正则 lastIndex 漂移
            var reAttr = new RegExp(re.source, CASE_SENSITIVE ? '' : 'i');
            var we = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
            var el;
            while ((el = we.nextNode())) {
                var attrs = el.attributes;
                if (!attrs) continue;
                for (var a = 0; a < attrs.length; a++) {
                    var av = attrs[a].value;
                    if (av && reAttr.test(av)) {
                        attribute_total++;
                        if (attribute_matches.length < MAX_RESULTS) {
                            attribute_matches.push({
                                attribute: attrs[a].name,
                                value: av,
                                element_path: _getPath(el) + _origin(el)
                            });
                        }
                    }
                }
            }
        }
        return {
            matches: matches,
            total: total,
            offset: OFFSET,
            has_more: (OFFSET + matches.length) < total,
            attribute_matches: attribute_matches,
            attribute_total: attribute_total
        };
    } catch (e) {
        return {error: String((e && e.message) || e), matches: [], total: 0};
    }
`;

/** json.dumps 等价（默认分隔符 ", "/": "——数组元素逗号后带空格；ensure_ascii 原文） */
const jsLiteral = (v: unknown): string => pyJsonDumps(v);

export interface SearchPageOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  contextChars?: number;
  cssScope?: string | null;
  maxResults?: number;
  offset?: number;
  searchAttributes?: boolean;
}

export function buildSearchPageJs(
  pattern: string,
  regex: boolean,
  caseSensitive: boolean,
  contextChars: number,
  cssScope: string | null,
  maxResults: number,
  offset: number,
  searchAttributes: boolean,
): string {
  const paramsJs =
    `var PATTERN = ${jsLiteral(pattern)};\n` +
    `var IS_REGEX = ${jsLiteral(regex)};\n` +
    `var CASE_SENSITIVE = ${jsLiteral(caseSensitive)};\n` +
    `var CONTEXT_CHARS = ${jsLiteral(contextChars)};\n` +
    `var CSS_SCOPE = ${jsLiteral(cssScope)};\n` +
    `var MAX_RESULTS = ${jsLiteral(maxResults)};\n` +
    `var OFFSET = ${jsLiteral(offset)};\n` +
    `var SEARCH_ATTRIBUTES = ${jsLiteral(searchAttributes)};\n`;
  return `(function() {\n${paramsJs}${SEARCH_PAGE_JS_BODY}\n})()`;
}

// ── find_elements JS 体（:291-389 逐字节）─────────────────────────────

const FIND_ELEMENTS_JS_BODY = `
    function _origin(node) {
        // 标记非顶层文档来源：ShadowRoot(nodeType=11) → shadow DOM；其它(getRootNode≠document) → iframe
        try {
            var r = node.getRootNode ? node.getRootNode() : null;
            if (r && r !== document) {
                return r.nodeType === 11 ? ' (in shadow DOM)' : ' (in iframe)';
            }
        } catch (_) {}
        return '';
    }
    function _collectAll(root, out) {
        // 穿透：开放 shadow root + 同源 iframe contentDocument
        // （TreeWalker 不跨 shadow / 文档边界，需手动递归；镜像 _SEARCH_PAGE_JS_BODY._collectText）
        var we = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        var el;
        while ((el = we.nextNode())) {
            out.push(el);
            if (el.shadowRoot) {
                try { _collectAll(el.shadowRoot, out); } catch (_) {}      // closed shadow: shadowRoot=null，自然跳过
            }
            if (el.tagName === 'IFRAME') {
                try {
                    var cd = el.contentDocument;                           // 同源可读；跨源抛 SecurityError → catch 跳过
                    if (cd && cd.body) _collectAll(cd.body, out);
                } catch (_) {}
            }
        }
    }
    function _isVisible(el) {
        // 可信可见性：祖先链 display/visibility/opacity + 自身非零尺寸
        // （修复阶段一 offsetParent !== null 的浅检测）
        var node = el;
        while (node && node.nodeType === 1) {
            var cs = document.defaultView.getComputedStyle(node);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') {
                return false;
            }
            node = node.parentElement;
        }
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }
    try {
        try {
            // 选择器合法性先校验一次（invalid selector 会让下面的 matches() 抛 SyntaxError）
            document.querySelector(SELECTOR);
        } catch (e) {
            return {error: 'Invalid CSS selector: ' + (e && e.message ? e.message : e), elements: [], total: 0};
        }
        // 收集顶层文档 + 所有开放 shadow / 同源 iframe 内的元素
        var all = [];
        _collectAll(document.documentElement, all);
        var total = 0;
        var limit = FIRST_ONLY ? 1 : MAX_RESULTS;
        var results = [];
        for (var k = 0; k < all.length; k++) {
            if (all[k].matches(SELECTOR)) {
                // offset 窗口：累计全部 total，只存 [OFFSET, OFFSET+limit) 区间（保持 early-bail 性能）
                if (total >= OFFSET && results.length < limit) {
                    var el = all[k];
                    var item = {index: total, tag: el.tagName.toLowerCase(), origin: _origin(el)};
                    if (INCLUDE_TEXT) {
                        var text = (el.textContent || '').trim();
                        item.text = text.length > 300 ? text.slice(0, 300) + '...' : text;
                    }
                    if (ATTRIBUTES && ATTRIBUTES.length > 0) {
                        item.attrs = {};
                        for (var j = 0; j < ATTRIBUTES.length; j++) {
                            var attrName = ATTRIBUTES[j];
                            var val;
                            // src/href: use the resolved DOM property (absolute URL),
                            // not getAttribute (raw authored value, often relative).
                            if ((attrName === 'src' || attrName === 'href')
                                && typeof el[attrName] === 'string' && el[attrName] !== '') {
                                val = el[attrName];
                            } else {
                                val = el.getAttribute(attrName);
                            }
                            if (val !== null) {
                                item.attrs[attrName] = val.length > 500 ? val.slice(0, 500) + '...' : val;
                            }
                        }
                    }
                    item.children_count = el.children.length;
                    if (INCLUDE_GEOMETRY) {
                        var rect = el.getBoundingClientRect();
                        item.rect = {x: rect.left, y: rect.top, w: rect.width, h: rect.height};
                        item.visible = _isVisible(el);
                    }
                    results.push(item);
                }
                total++;
            }
        }
        return {
            elements: results,
            total: total,
            showing: results.length,
            offset: OFFSET,
            has_more: (OFFSET + results.length) < total
        };
    } catch (e) {
        return {error: 'find_elements error: ' + (e && e.message ? e.message : e), elements: [], total: 0};
    }
`;

export interface FindElementsOptions {
  attributes?: string[] | null;
  maxResults?: number;
  offset?: number;
  includeText?: boolean;
  firstOnly?: boolean;
  includeGeometry?: boolean;
}

export function buildFindElementsJs(
  selector: string,
  attributes: string[] | null,
  maxResults: number,
  includeText: boolean,
  firstOnly: boolean,
  offset: number,
  includeGeometry: boolean,
): string {
  const paramsJs =
    `var SELECTOR = ${jsLiteral(selector)};\n` +
    `var ATTRIBUTES = ${jsLiteral(attributes)};\n` +
    `var MAX_RESULTS = ${jsLiteral(maxResults)};\n` +
    `var OFFSET = ${jsLiteral(offset)};\n` +
    `var INCLUDE_TEXT = ${jsLiteral(includeText)};\n` +
    `var FIRST_ONLY = ${jsLiteral(firstOnly)};\n` +
    `var INCLUDE_GEOMETRY = ${jsLiteral(includeGeometry)};\n`;
  return `(function() {\n${paramsJs}${FIND_ELEMENTS_JS_BODY}\n})()`;
}

// ── 数据形态（snake_case 键原样——与 Python 输出及 formatter 契约一致）──

export interface FindElementsElement {
  index: number;
  tag: string;
  origin?: string;
  text?: string;
  attrs?: Record<string, string>;
  children_count?: number;
  rect?: { x: number; y: number; w: number; h: number };
  visible?: boolean;
}

export interface FindElementsData {
  elements: FindElementsElement[];
  total: number;
  showing: number;
  offset: number;
  has_more: boolean;
}

export interface NodeIdEntry {
  backend_id: number;
  tag: string;
}

export interface FindElementsNodeIdsData {
  node_ids: NodeIdEntry[];
  total: number;
  showing: number;
  offset: number;
  has_more: boolean;
}

export interface SearchPageMatch {
  match_text: string;
  context: string;
  element_path: string;
  char_position: number;
}

export interface SearchPageAttributeMatch {
  attribute: string;
  value: string;
  element_path: string;
}

export interface SearchPageData {
  matches: SearchPageMatch[];
  total: number;
  offset: number;
  has_more: boolean;
  attribute_matches: SearchPageAttributeMatch[];
  attribute_total: number;
}

export interface FindTextResult {
  found: boolean;
  method: string;
  tag: string | null;
  reason?: "nth_exceeds";
  requested_nth?: number;
  visible_total?: number;
  total?: number;
  match_index?: number;
  highlight?: string;
}

/** 单发 JS 取 dict（:4225-4237 同款：空返回/{error} 抛——动作层映射硬 error） */
async function evalJsData(
  s: SessionInternals,
  js: string,
  what: string,
): Promise<Record<string, unknown>> {
  const data = await executeJs(s, js);
  if (data === null || typeof data !== "object") {
    throw new Error(`${what} returned no result`);
  }
  const rec = data as Record<string, unknown>;
  if (typeof rec.error === "string" && rec.error !== "") {
    throw new Error(`${what}: ${rec.error}`);
  }
  return rec;
}

/** grep 式页内搜索（:4192-4238）：异常/空返回/{error} 一律抛，干净 miss 返回 total=0 */
export async function searchPage(
  s: SessionInternals,
  pattern: string,
  opts: SearchPageOptions = {},
): Promise<SearchPageData> {
  const js = buildSearchPageJs(
    pattern,
    opts.regex ?? false,
    opts.caseSensitive ?? false,
    opts.contextChars ?? 150,
    opts.cssScope ?? null,
    opts.maxResults ?? 25,
    opts.offset ?? 0,
    opts.searchAttributes ?? false,
  );
  return (await evalJsData(s, js, "search_page")) as unknown as SearchPageData;
}

/** CSS 元素查询（:4239-4277） */
export async function findElements(
  s: SessionInternals,
  selector: string,
  opts: FindElementsOptions = {},
): Promise<FindElementsData> {
  const js = buildFindElementsJs(
    selector,
    opts.attributes ?? null,
    opts.maxResults ?? 50,
    opts.includeText ?? true,
    opts.firstOnly ?? false,
    opts.offset ?? 0,
    opts.includeGeometry ?? false,
  );
  return (await evalJsData(s, js, "find_elements")) as unknown as FindElementsData;
}

/** CSS → backendNodeId（:4278-4343）：performSearch 直收 CSS；窗口 [offset, offset+max) */
export async function findElementsNodeIds(
  s: SessionInternals,
  selector: string,
  opts: { maxResults?: number; offset?: number; includeUserAgentShadow?: boolean } = {},
): Promise<FindElementsNodeIdsData> {
  const offset = opts.offset ?? 0;
  const maxResults = opts.maxResults ?? 50;
  const search = await s.send<{ searchId?: string; resultCount?: number }>("DOM.performSearch", {
    query: selector,
    includeUserAgentShadowDOM: opts.includeUserAgentShadow ?? true,
  });
  const searchId = search.searchId ?? null;
  const total = search.resultCount ?? 0;
  try {
    if (total <= 0) {
      return { node_ids: [], total: 0, showing: 0, offset, has_more: false };
    }
    const toIndex = Math.min(total, offset + maxResults);
    const results = await s.send<{ nodeIds?: number[] }>("DOM.getSearchResults", {
      searchId,
      fromIndex: offset,
      toIndex,
    });
    const out: NodeIdEntry[] = [];
    for (const nid of results.nodeIds ?? []) {
      const desc = await s.send<{ node?: Record<string, unknown> }>("DOM.describeNode", {
        nodeId: nid,
      });
      const node = desc.node ?? {};
      const bid = node.backendNodeId;
      if (typeof bid !== "number") continue;
      const tag = String(node.nodeName ?? node.localName ?? "?").toLowerCase();
      out.push({ backend_id: bid, tag });
    }
    return {
      node_ids: out,
      total,
      showing: out.length,
      offset,
      has_more: offset + out.length < total,
    };
  } finally {
    if (searchId !== null) {
      try {
        await s.send("DOM.discardSearchResults", { searchId });
      } catch {
        // 清理失败不阻断
      }
    }
  }
}

/** find_text 主链（:3941-4032）：3 查询链→cap 批→可见性过滤→nth→滚入→高亮 */
export async function findText(
  s: SessionInternals,
  text: string,
  opts: { nth?: number; caseSensitive?: boolean; highlight?: "box" | "selection" | "none" } = {},
): Promise<FindTextResult> {
  const nth = opts.nth ?? 1;
  const caseSensitive = opts.caseSensitive ?? false;
  const highlight = opts.highlight ?? "box";
  for (const [method, query] of textQueries(text, caseSensitive)) {
    let searchId: string | null = null;
    try {
      const search = await s.send<{ searchId?: string; resultCount?: number }>(
        "DOM.performSearch",
        { query, includeUserAgentShadowDOM: true },
      );
      searchId = search.searchId ?? null;
      const total = search.resultCount ?? 0;
      if (total <= 0) continue;
      const results = await s.send<{ nodeIds?: number[] }>("DOM.getSearchResults", {
        searchId,
        fromIndex: 0,
        toIndex: Math.min(total, FIND_TEXT_CAP),
      });
      const nodeIds = results.nodeIds ?? [];
      if (nodeIds.length === 0) continue;
      const visibleIds = await visibleNodeIds(s, nodeIds);
      if (nth > visibleIds.length) {
        return {
          found: false,
          reason: "nth_exceeds",
          method,
          tag: null,
          requested_nth: nth,
          visible_total: visibleIds.length,
          total,
        };
      }
      // Python visible_ids[nth - 1] 含负索引回绕（session.py :3999）：nth=0 → 末元素、
      // nth=-1 → 倒数第二；越界负值在 Python 抛 IndexError 被逐查询 except 吞掉后落
      // JS 回退——此处 undefined nodeId 走 scrollIntoViewIfNeeded 抛错 → catch → 回退，
      // 行为同构（非整数 nth 两边同样落回退，不加 ge=1 校验——Python 无此校验）
      const idx = nth - 1;
      const nodeId = idx >= 0 ? visibleIds[idx] : visibleIds[visibleIds.length + idx];
      await s.send("DOM.scrollIntoViewIfNeeded", { nodeId });
      const tag = await highlightSearchNode(s, nodeId, text, nth, caseSensitive, highlight);
      return {
        found: true,
        method,
        tag,
        match_index: nth,
        visible_total: visibleIds.length,
        total,
        highlight,
      };
    } catch (e) {
      s.log(`find_text query ${query} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (searchId !== null) {
        try {
          await s.send("DOM.discardSearchResults", { searchId });
        } catch {
          // 中断路径也清 searchId（Python finally 同款——防泄漏）
        }
      }
    }
  }
  if (await findTextJsFallback(s, text, caseSensitive)) {
    return { found: true, method: "js-treewalker", tag: null };
  }
  return { found: false, method: "none", tag: null };
}

/** TreeWalker 文本节点回退（:4033-4068）：三查询全 miss 才跑；json 序列化注入 */
async function findTextJsFallback(
  s: SessionInternals,
  text: string,
  caseSensitive: boolean,
): Promise<boolean> {
  const needleJs = JSON.stringify(text);
  const cond = caseSensitive
    ? "t.includes(needle)"
    : "t.toLowerCase().includes(needle.toLowerCase())";
  const js =
    "(() => {" +
    `  const needle = ${needleJs};` +
    "  const walker = document.createTreeWalker(" +
    "    document.body, NodeFilter.SHOW_TEXT, null, false);" +
    "  let node;" +
    "  while ((node = walker.nextNode())) {" +
    "    const t = node.nodeValue || '';" +
    `    if (${cond} && t.trim()) {` +
    "      if (node.parentElement) {" +
    "        node.parentElement.scrollIntoView(" +
    "          { behavior: 'smooth', block: 'center' });" +
    "      }" +
    "      return true;" +
    "    }" +
    "  }" +
    "  return false;" +
    "})()";
  try {
    return (await executeJs(s, js)) === true;
  } catch (e) {
    s.log(`find_text JS fallback failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** 高亮三模式（:4069-4102）：先 describeNode 取 tag；box=Overlay/selection=window.find/none */
async function highlightSearchNode(
  s: SessionInternals,
  nodeId: number,
  text: string,
  nth: number,
  caseSensitive: boolean,
  highlight: "box" | "selection" | "none",
): Promise<string | null> {
  let backendId: number | null = null;
  let tag: string | null = null;
  try {
    const desc = await s.send<{ node?: Record<string, unknown> }>("DOM.describeNode", {
      nodeId,
    });
    const node = desc.node ?? {};
    const bid = node.backendNodeId;
    if (typeof bid === "number") backendId = bid;
    const name = typeof node.nodeName === "string" ? node.nodeName.toLowerCase() : "";
    tag = name !== "" ? name : null;
  } catch {
    // tag 尽力而为
  }
  if (highlight === "box") {
    if (backendId !== null) {
      try {
        await s.highlight.highlightElement(backendId);
      } catch {
        // 高亮失败不阻断
      }
    }
  } else if (highlight === "selection") {
    await selectTextViaWindowFind(s, text, nth, caseSensitive);
  }
  return tag;
}

/** window.find 原生选区（:4103-4131）：循环 nth 次到达第 n 个匹配；失败静默 */
async function selectTextViaWindowFind(
  s: SessionInternals,
  text: string,
  nth: number,
  caseSensitive: boolean,
): Promise<void> {
  const needleJs = JSON.stringify(text);
  const caseSensitiveJs = caseSensitive ? "true" : "false";
  const js =
    "(() => {" +
    `  const needle = ${needleJs};` +
    `  const caseSensitive = ${caseSensitiveJs};` +
    `  const n = ${Math.trunc(nth)};` +
    "  let ok = false;" +
    "  for (let i = 0; i < n; i++) {" +
    "    ok = window.find(needle, caseSensitive, false, false, false, false, false);" +
    "    if (!ok) break;" +
    "  }" +
    "  return ok;" +
    "})()";
  try {
    await executeJs(s, js);
  } catch (e) {
    s.log(`find_text window.find selection failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 可见性优先过滤（:4132-4157）：单节点跳过探测；全隐退化首个；异常按全可见 */
async function visibleNodeIds(s: SessionInternals, nodeIds: number[]): Promise<number[]> {
  if (nodeIds.length <= 1) return [...nodeIds];
  let flags: boolean[];
  try {
    flags = await probeVisibility(s, nodeIds);
  } catch (e) {
    s.log(`find_text visibility probe failed: ${e instanceof Error ? e.message : String(e)}`);
    return [...nodeIds];
  }
  const visible = nodeIds.filter((_, i) => flags[i]);
  if (visible.length === 0) return [nodeIds[0]];
  return visible;
}

/** 批量可见性探测（:4158-4191）：resolveNode→一次 callFunctionOn 返回 bool[] */
async function probeVisibility(s: SessionInternals, nodeIds: number[]): Promise<boolean[]> {
  const objectIds: string[] = [];
  for (const nid of nodeIds) {
    const resolved = await s.send<{ object?: { objectId?: string } }>("DOM.resolveNode", {
      nodeId: nid,
    });
    objectIds.push(resolved.object?.objectId ?? "");
  }
  const decl =
    "function(...rest) {" +
    "  const els = [this].concat(rest);" +
    "  const vis = (el) => {" +
    "    if (!el) return false;" +
    "    const r = el.getBoundingClientRect();" +
    "    const s = getComputedStyle(el);" +
    "    return r.width > 0 && r.height > 0" +
    "      && s.visibility !== 'hidden' && s.display !== 'none';" +
    "  };" +
    "  return els.map(vis);" +
    "}";
  const res = await s.send<{ result?: { value?: unknown } }>("Runtime.callFunctionOn", {
    functionDeclaration: decl,
    objectId: objectIds[0],
    arguments: objectIds.slice(1).map((oid) => ({ objectId: oid })),
    returnByValue: true,
  });
  const value = res.result?.value;
  if (!Array.isArray(value) || value.length !== nodeIds.length) {
    throw new Error(`visibility probe unexpected shape: ${JSON.stringify(value)}`);
  }
  return value.map((v) => v === true);
}
