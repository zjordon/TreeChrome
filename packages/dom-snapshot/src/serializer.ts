/**
 * DOM 序列化管线 —— Python dom-snapshot serializer.py 的忠实移植。
 *
 * 五步管线：
 *   Step 1: 创建简化树（createSimplifiedTree）— 过滤无用节点
 *   Step 2: 绘制顺序过滤（PaintOrderRemover）— 遮挡元素标记
 *   Step 3: 树优化（optimizeTree）— 后序遍历剪枝
 *   Step 4: 包围盒过滤（applyBoundingBoxFiltering）— 传播型元素子元素排除
 *   Step 5: 分配交互索引（assignInteractiveIndicesAndMarkNewNodes）
 *
 * element_tree_text 的输出格式是与 LLM prompt 的契约，必须与 Python 端逐字节
 * 一致 —— golden fixture（test/fixtures/*.json）为验收标准。
 */
import { isInteractive } from "./interactive.js";
import { PaintOrderRemover } from "./paint-order.js";
import {
  DEFAULT_INCLUDE_ATTRIBUTES,
  type DOMRect,
  type DOMSelectorMap,
  type EnhancedDOMTreeNode,
  NodeType,
  type PropagatingBounds,
  SerializedDOMState,
  SimplifiedNode,
} from "./types.js";

/** 纯元数据/脚本标签，在简化树创建阶段直接丢弃 */
const DISABLED_ELEMENTS: ReadonlySet<string> = new Set([
  "style",
  "script",
  "head",
  "meta",
  "link",
  "title",
]);

/** SVG 装饰性子元素（<svg> 本身保留，以折叠形式显示） */
const SVG_ELEMENTS: ReadonlySet<string> = new Set([
  "path",
  "rect",
  "g",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "use",
  "defs",
  "clipPath",
  "mask",
  "pattern",
  "image",
  "text",
  "tspan",
]);

/** 会将自身包围盒"传播"给所有后代的元素；role=null 表示不检查 role，仅匹配标签名 */
interface PropagatingPattern {
  tag: string;
  role: string | null;
}

/**
 * Python _compound_children 元素的形状。
 * 数值字段（valuemin/valuemax）已在构造时按 Python str() 语义预格式化为字符串：
 * Python 端 float 与 int 的 str() 输出不同（str(0.0)="0.0" vs str(0)="0"），
 * JS number 无法区分，range 输入（float）与 audio/video（int 字面量）必须在此定型。
 */
export interface CompoundChildInfo {
  role?: string;
  name?: string;
  valuemin?: string | null;
  valuemax?: string | null;
  valuenow?: string | null;
  options_count?: number;
  first_options?: string[];
  format_hint?: string;
}

/** 页面统计（Python serializer _collect_page_stats 的 dict 形状） */
export interface PageStats {
  links: number;
  interactive: number;
  iframes: number;
  skeleton: boolean;
}

/** DOMTreeSerializer 构造可选项（对齐 Python 构造器的关键字参数） */
export interface DOMTreeSerializerOptions {
  previousCachedState?: SerializedDOMState | null;
  enableBboxFiltering?: boolean;
  containmentThreshold?: number | null;
  paintOrderFiltering?: boolean;
  sessionId?: string | null;
}

function nowSec(): number {
  return Date.now() / 1000;
}

/** Python str() 对 AX 属性值域（str|bool|number）的复刻：True/False 大写，数值十进制 */
function pyStr(v: string | boolean | number): string {
  if (typeof v === "string") return v;
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

/** Python str(float)：整数值浮点带 .0（range min=0 → "0.0"，与 fixture 对拍锚定） */
function pyFloatStr(f: number): string {
  return Number.isInteger(f) && Math.abs(f) < 1e16 ? `${f}.0` : String(f);
}

/**
 * Python float()+except 回退的等价物：全串合法才采纳。
 * 消费域是页面作者可写任意串的 HTML 属性（attrs.min/max，如 "12px"、"50%"），
 * parseFloat 的前缀解析会采纳 "12px"→12 而 Python float() 抛异常回退默认值，
 * 破坏 element_tree_text 对拍——须全串严格校验。
 * 已知罕见分叉（注释存档）：Python float 接受 "1_000"（TS 回退）、"inf"（TS 回退）。
 */
const PY_FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function safeParseNumber(valueStr: string, defaultValue: number): number {
  const t = valueStr.trim();
  if (!PY_FLOAT_RE.test(t)) return defaultValue;
  return Number(t);
}

function safeParseOptionalNumberStr(valueStr: string | undefined): string | null {
  if (!valueStr) return null;
  const t = valueStr.trim();
  if (!PY_FLOAT_RE.test(t)) return null;
  return pyFloatStr(Number(t));
}

function codePointLength(s: string): number {
  // 热路径快进：BMP 内 length 即码点数（含代理对时走慢路径）
  let i = 0;
  let n = 0;
  while (i < s.length) {
    const code = s.charCodeAt(i);
    i += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
    n += 1;
  }
  return n;
}

/** 按码点数截断（Python 切片语义），避免代理对被切成半个 */
function truncateCodePoints(s: string, max: number): string {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join("");
}

/** Python v.isupper() 近似：含大小写字符且全部为大写 */
function pyIsUpper(v: string): boolean {
  return v !== v.toLowerCase() && v === v.toUpperCase();
}

/** Python v.isdigit() 近似：十进制/其他数字类（Nd|No） */
function pyIsDigit(v: string): boolean {
  return /^[\p{Nd}\p{No}]+$/u.test(v);
}

/**
 * 文本节点是否值得进入文本树。
 *
 * 单字符噪声过滤：多字符一律保留；单字符仅保留字母/数字（含 CJK），
 * 装饰符（•、|、· 等）仍滤。Python isalnum ≈ \p{L}|\p{N}（未覆盖的
 * Numeric_Type-So 字符为罕见古文字数字，对拍页面上不出现）。
 */
export function isMeaningfulText(value: string): boolean {
  const text = value.trim();
  return codePointLength(text) > 1 || /^[\p{L}\p{N}]$/u.test(text);
}

/** 为 shadow 宿主节点生成前缀标识 */
function shadowPrefix(node: SimplifiedNode): string {
  if (!node.isShadowHost) return "";
  const hasClosed = node.children.some(
    (c) =>
      c.originalNode.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE &&
      c.originalNode.shadowRootType !== null &&
      c.originalNode.shadowRootType.toLowerCase() === "closed",
  );
  return hasClosed ? "|SHADOW(closed)|" : "|SHADOW(open)|";
}

// ── _build_attributes_string 的 Step 2 常量 ─────────────────────────────

const DATE_TIME_INPUT_TYPES = ["date", "time", "datetime-local", "month", "week"] as const;

const COMPOUND_INPUT_TYPES = [
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
  "range",
  "number",
  "color",
  "file",
] as const;

const DATE_FORMAT_MAP: Record<string, string> = {
  date: "YYYY-MM-DD",
  time: "HH:MM",
  "datetime-local": "YYYY-MM-DDTHH:MM",
  month: "YYYY-MM",
  week: "YYYY-W##",
};

const DATE_PLACEHOLDER_MAP: Record<string, string> = { ...DATE_FORMAT_MAP };

const DATEPICKER_CLASS_INDICATORS = ["datepicker", "datetimepicker", "daterangepicker"] as const;

/**
 * 构建元素的属性字符串，用于 LLM 文本输出（Python _build_attributes_string）。
 *
 * 8 步处理：白名单过滤 → input type 特殊处理 → 密码保护 → AX 合并 →
 * 表单当前值 → 值去重 → 冗余移除 → 格式化输出。
 */
export function buildAttributesString(
  node: EnhancedDOMTreeNode,
  includeAttributes: readonly string[],
  text = "",
): string {
  const attrsToInclude = new Map<string, string>();

  // ── Step 1: HTML 属性白名单过滤 ──
  for (const key of includeAttributes) {
    const raw = node.attributes[key];
    if (raw === undefined) continue;
    const val = raw.trim();
    if (val) attrsToInclude.set(key, val);
  }

  // includeAttributes 的局部副本：file input 分支可能追加 class（issue #96），
  // Step 6/8 的键序驱动须用扩展后的副本
  let includeAttrs: readonly string[] = includeAttributes;

  // ── Step 2: 日期/时间输入格式提示 ──
  if (node.tagName === "input") {
    const inputType = (node.attributes.type ?? "").toLowerCase();

    if (DATE_TIME_INPUT_TYPES.includes(inputType as (typeof DATE_TIME_INPUT_TYPES)[number])) {
      attrsToInclude.set("format", DATE_FORMAT_MAP[inputType]);
      if (includeAttrs.includes("placeholder") && !attrsToInclude.has("placeholder")) {
        attrsToInclude.set("placeholder", DATE_PLACEHOLDER_MAP[inputType]);
      }
    } else if (inputType === "tel" && !attrsToInclude.has("pattern")) {
      if (includeAttrs.includes("placeholder") && !attrsToInclude.has("placeholder")) {
        attrsToInclude.set("placeholder", "123-456-7890");
      }
    } else if (inputType === "text" || inputType === "") {
      const classAttr = (node.attributes.class ?? "").toLowerCase();
      // AngularJS UI Bootstrap datepicker
      if (node.attributes["uib-datepicker-popup"] !== undefined) {
        const dateFormat = node.attributes["uib-datepicker-popup"] ?? "";
        if (dateFormat) {
          attrsToInclude.set("expected_format", dateFormat);
          attrsToInclude.set("format", dateFormat);
        }
      } else if (DATEPICKER_CLASS_INDICATORS.some((ind) => classAttr.includes(ind))) {
        // jQuery/Bootstrap datepickers
        const dateFormat = node.attributes["data-date-format"] ?? "";
        if (dateFormat) {
          attrsToInclude.set("placeholder", dateFormat);
          attrsToInclude.set("format", dateFormat);
        } else {
          attrsToInclude.set("placeholder", "mm/dd/yyyy");
          attrsToInclude.set("format", "mm/dd/yyyy");
        }
      } else if (node.attributes["data-datepicker"] !== undefined) {
        const dateFormat = node.attributes["data-date-format"] ?? "";
        if (dateFormat) {
          attrsToInclude.set("placeholder", dateFormat);
          attrsToInclude.set("format", dateFormat);
        } else {
          attrsToInclude.set("placeholder", "mm/dd/yyyy");
          attrsToInclude.set("format", "mm/dd/yyyy");
        }
      }
    } else if (inputType === "file") {
      // file input：保留 class —— 抖音封面有多个 accept 完全相同的 file input，
      // 唯一区分信号是 class。class 不在白名单，需同时加入本次调用的
      // include_attributes 局部副本，否则 Step 6/8 会跳过它（issue #96）
      const cls = (node.attributes.class ?? "").trim();
      if (cls) {
        if (!includeAttrs.includes("class")) includeAttrs = [...includeAttrs, "class"];
        attrsToInclude.set("class", cls);
      }
    }
  }

  // ── Step 3: 密码字段保护 ──
  const isPassword =
    node.tagName === "input" && (node.attributes.type ?? "").toLowerCase() === "password";
  const valueProps = new Set(["value", "valuetext"]);

  // ── Step 4: AX 属性合并 ──
  if (node.axNode?.properties) {
    for (const prop of node.axNode.properties) {
      if (!includeAttrs.includes(prop.name) || prop.value === null || prop.value === undefined) {
        continue;
      }
      if (isPassword && valueProps.has(prop.name)) continue;
      if (typeof prop.value === "boolean") {
        attrsToInclude.set(prop.name, prop.value ? "true" : "false");
      } else {
        const val = pyStr(prop.value).trim();
        if (val) attrsToInclude.set(prop.name, val);
      }
    }
  }

  // ── Step 5: 表单当前值（AX 树优先） ──
  if (node.tagName === "input" || node.tagName === "textarea" || node.tagName === "select") {
    if (isPassword) {
      attrsToInclude.delete("value");
    } else if (node.axNode?.properties) {
      for (const prop of node.axNode.properties) {
        if (prop.name === "valuetext" && prop.value) {
          attrsToInclude.set("value", pyStr(prop.value).trim());
          break;
        }
        if (prop.name === "value" && prop.value) {
          attrsToInclude.set("value", pyStr(prop.value).trim());
          break;
        }
      }
    }
  }

  if (attrsToInclude.size === 0) return "";

  // ── Step 6: 值去重 ──
  const orderedKeys = includeAttrs.filter((k) => attrsToInclude.has(k));
  if (orderedKeys.length > 1) {
    const keysToRemove = new Set<string>();
    const seenValues = new Map<string, string>();
    const protectedAttrs = new Set([
      "format",
      "expected_format",
      "placeholder",
      "value",
      "aria-label",
      "title",
    ]);
    for (const key of orderedKeys) {
      const val = attrsToInclude.get(key);
      if (val === undefined || val.length <= 5) continue;
      if (seenValues.has(val) && !protectedAttrs.has(key)) {
        keysToRemove.add(key);
      } else {
        seenValues.set(val, key);
      }
    }
    for (const key of keysToRemove) attrsToInclude.delete(key);
  }

  // ── Step 7: 冗余移除 ──
  // role 与标签名相同
  if (node.axNode?.role && node.nodeName === node.axNode.role) {
    attrsToInclude.delete("role");
  }
  // type 与标签名相同
  const typeVal = attrsToInclude.get("type");
  if (typeVal !== undefined && typeVal.toLowerCase() === node.nodeName.toLowerCase()) {
    attrsToInclude.delete("type");
  }
  // invalid=false 不显示
  const invalidVal = attrsToInclude.get("invalid");
  if (invalidVal !== undefined && invalidVal.toLowerCase() === "false") {
    attrsToInclude.delete("invalid");
  }
  // 布尔属性为假值不显示
  const requiredVal = attrsToInclude.get("required");
  if (requiredVal !== undefined && ["false", "0", "no"].includes(requiredVal.toLowerCase())) {
    attrsToInclude.delete("required");
  }
  // aria-expanded 与 expanded 重复（优先保留 AX 树的 expanded）
  if (attrsToInclude.has("expanded") && attrsToInclude.has("aria-expanded")) {
    attrsToInclude.delete("aria-expanded");
  }
  // aria-label/placeholder/title 与文本内容相同则移除（serialize_tree 未传 text，
  // 恒为 ""，即仅当属性值为空白时移除——与 Python 同为事实死分支）
  for (const attr of ["aria-label", "placeholder", "title"]) {
    const v = attrsToInclude.get(attr) ?? "";
    if (v.trim().toLowerCase() === text.trim().toLowerCase()) {
      attrsToInclude.delete(attr);
    }
  }

  // ── Step 8: 格式化输出 ──
  const formatted: string[] = [];
  for (const key of includeAttrs) {
    const raw = attrsToInclude.get(key);
    if (raw === undefined) continue;
    const val = truncateCodePoints(raw, 100);
    if (!val) formatted.push(`${key}=''`);
    else formatted.push(`${key}=${val}`);
  }
  return formatted.join(" ");
}

/** 将 EnhancedDOMTreeNode 树序列化为 SimplifiedNode 树供 LLM 消费。 */
export class DOMTreeSerializer {
  /** 会将自身包围盒"传播"给所有后代的元素列表 */
  private static readonly PROPAGATING_ELEMENTS: readonly PropagatingPattern[] = [
    { tag: "a", role: null },
    { tag: "button", role: null },
    { tag: "div", role: "button" },
    { tag: "div", role: "combobox" },
    { tag: "span", role: "button" },
    { tag: "span", role: "combobox" },
    { tag: "input", role: "combobox" },
  ];

  private static readonly DEFAULT_CONTAINMENT_THRESHOLD = 0.99;
  private static readonly SKELETON_CLASS_PATTERNS = [
    "skeleton",
    "placeholder",
    "spinner",
    "loading",
  ];
  private static readonly SKELETON_LOW_INTERACTIVE_THRESHOLD = 3;

  readonly rootNode: EnhancedDOMTreeNode;
  private selectorMap: DOMSelectorMap = new Map();
  private readonly previousCachedSelectorMap: DOMSelectorMap | null;
  timingInfo: Record<string, number> = {};
  private clickableCache = new Map<number, boolean>();
  /** 子树级"有交互后代"结论缓存（按 nodeId；Python 无此缓存，输出等价——见 hasInteractiveDescendants） */
  private interactiveDescendantsCache = new Map<number, boolean>();
  readonly enableBboxFiltering: boolean;
  readonly containmentThreshold: number;
  readonly paintOrderFiltering: boolean;
  readonly sessionId: string | null;

  constructor(rootNode: EnhancedDOMTreeNode, options: DOMTreeSerializerOptions = {}) {
    this.rootNode = rootNode;
    this.previousCachedSelectorMap = options.previousCachedState?.selectorMap ?? null;
    // Python `containment_threshold or DEFAULT`：0 视同未设置（falsy），同口径用 ||
    this.containmentThreshold =
      options.containmentThreshold || DOMTreeSerializer.DEFAULT_CONTAINMENT_THRESHOLD;
    this.enableBboxFiltering = options.enableBboxFiltering ?? true;
    this.paintOrderFiltering = options.paintOrderFiltering ?? true;
    this.sessionId = options.sessionId ?? null;
  }

  // ── 管线入口 ─────────────────────────────────────────────────────

  /** 五步管线入口，返回 (SerializedDOMState, timing_info)。 */
  serializeAccessibleElements(): { state: SerializedDOMState; timingInfo: Record<string, number> } {
    const startTotal = nowSec();

    // 重置状态（timingInfo 一并重置——有意偏离 Python：clickable_detection_time 为
    // 累加口径，跨调用残留会失真；timingInfo 不参与对拍，重置无输出影响）
    this.selectorMap = new Map();
    this.clickableCache = new Map();
    this.interactiveDescendantsCache = new Map();
    this.timingInfo = {};

    // Step 1: 创建简化树
    let start = nowSec();
    const simplifiedTree = this.createSimplifiedTree(this.rootNode, 0);
    this.timingInfo["create_simplified_tree"] = nowSec() - start;

    // Step 2: 绘制顺序过滤
    if (this.paintOrderFiltering && simplifiedTree) {
      start = nowSec();
      new PaintOrderRemover(simplifiedTree).calculatePaintOrder();
      this.timingInfo["paint_order_filtering"] = nowSec() - start;
    }

    // Step 3: 树优化
    start = nowSec();
    const optimizedTree = this.optimizeTree(simplifiedTree);
    this.timingInfo["optimize_tree"] = nowSec() - start;

    // Step 4: 包围盒过滤
    let filteredTree = optimizedTree;
    if (this.enableBboxFiltering && optimizedTree) {
      start = nowSec();
      filteredTree = this.applyBoundingBoxFiltering(optimizedTree);
      this.timingInfo["bbox_filtering"] = nowSec() - start;
    }

    // Step 5: 分配交互索引
    start = nowSec();
    this.assignInteractiveIndicesAndMarkNewNodes(filteredTree);
    this.timingInfo["assign_interactive_indices"] = nowSec() - start;

    // 生成文本输出
    const elementTreeText = DOMTreeSerializer.serializeTree(
      filteredTree,
      DEFAULT_INCLUDE_ATTRIBUTES,
    );

    // 页面统计（links/interactive/iframes/skeleton）：serializer 持有 filtered_tree
    // + selector_map，是唯一能可靠统计的位置
    start = nowSec();
    const pageStats = this.collectPageStats(filteredTree);
    this.timingInfo["page_stats"] = nowSec() - start;

    this.timingInfo["serialize_accessible_elements_total"] = nowSec() - startTotal;

    const state = new SerializedDOMState(
      filteredTree,
      this.selectorMap,
      elementTreeText,
      [],
      [],
      // 展开为普通 record：SerializedDOMState.pageStats 与 Python dict[str, Any] 同口径
      {
        links: pageStats.links,
        interactive: pageStats.interactive,
        iframes: pageStats.iframes,
        skeleton: pageStats.skeleton,
      },
    );
    return { state, timingInfo: this.timingInfo };
  }

  // ── 页面统计 ─────────────────────────────────────────────────────

  private collectPageStats(root: SimplifiedNode | null): PageStats {
    const interactive = this.selectorMap.size;
    let links = 0;
    for (const n of this.selectorMap.values()) {
      if (n.tagName === "a") links += 1;
    }

    let iframes = 0;
    let skeletonHits = 0;
    const stack: (SimplifiedNode | null)[] = [root];
    while (stack.length > 0) {
      const sn = stack.pop();
      if (sn === null || sn === undefined) continue;
      const on = sn.originalNode;
      const nameUpper = on.nodeName.toUpperCase();
      if (nameUpper === "IFRAME" || nameUpper === "FRAME") iframes += 1;
      const cls = (on.attributes.class ?? "").toLowerCase();
      if (cls && DOMTreeSerializer.SKELETON_CLASS_PATTERNS.some((p) => cls.includes(p))) {
        skeletonHits += 1;
      }
      for (const child of sn.children) stack.push(child);
    }

    const skeleton =
      skeletonHits > 0 && interactive < DOMTreeSerializer.SKELETON_LOW_INTERACTIVE_THRESHOLD;
    return { links, interactive, iframes, skeleton };
  }

  // ── Step 1: 创建简化树 ──────────────────────────────────────────

  /**
   * 将 EnhancedDOMTreeNode 递归转换为 SimplifiedNode 树。
   *
   * - DOCUMENT_NODE → 取第一个有效子节点作为根
   * - DOCUMENT_FRAGMENT_NODE → 始终保留（Shadow DOM）
   * - ELEMENT_NODE → 过滤禁用/SVG/排除标记后，按可见性保留
   * - TEXT_NODE → 可见 + 非空 + 满足 isMeaningfulText 时保留
   */
  private createSimplifiedTree(node: EnhancedDOMTreeNode, depth: number): SimplifiedNode | null {
    // DOCUMENT_NODE: 透传，取第一个有效子节点
    if (node.nodeType === NodeType.DOCUMENT_NODE) {
      for (const child of node.childrenAndShadowRoots) {
        const simplifiedChild = this.createSimplifiedTree(child, depth + 1);
        if (simplifiedChild) return simplifiedChild;
      }
      return null;
    }

    // DOCUMENT_FRAGMENT_NODE: Shadow DOM 片段始终保留
    if (node.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE) {
      const simplified = new SimplifiedNode(node, []);
      for (const child of node.childrenAndShadowRoots) {
        const simplifiedChild = this.createSimplifiedTree(child, depth + 1);
        if (simplifiedChild) simplified.children.push(simplifiedChild);
      }
      // Python 无子时也返回新空节点（与 simplified 等价的空片段）
      return simplified;
    }

    // ELEMENT_NODE: 主要过滤逻辑
    if (node.nodeType === NodeType.ELEMENT_NODE) {
      return this.processElementNode(node, depth);
    }

    // TEXT_NODE: 条件保留
    if (node.nodeType === NodeType.TEXT_NODE) {
      const isVisible = node.snapshotNode !== null && node.isVisible === true;
      if (isVisible && node.nodeValue && isMeaningfulText(node.nodeValue)) {
        return new SimplifiedNode(node, []);
      }
      return null;
    }

    return null;
  }

  private processElementNode(node: EnhancedDOMTreeNode, depth: number): SimplifiedNode | null {
    const tagLower = node.tagName;

    // 跳过禁用元素 (script/style/head/meta/link/title) 与 SVG 子元素 (path/rect/g/...)
    if (DISABLED_ELEMENTS.has(tagLower) || SVG_ELEMENTS.has(tagLower)) return null;

    // 排除标记检查
    if (this.isExcluded(node.attributes)) return null;

    // IFRAME/FRAME 特殊处理
    const nameUpper = node.nodeName.toUpperCase();
    if (nameUpper === "IFRAME" || nameUpper === "FRAME") {
      return this.processIframe(node, depth);
    }

    // ── 可见性判定 ──
    let isVisible = node.isVisible === true;
    const isScrollable = node.isActuallyScrollable;
    const hasShadowContent = node.childrenAndShadowRoots.length > 0;
    // shadow 宿主判定只排除 "user-agent"（null 型片段也计入），与 isInsideShadowDom
    // 的非 null 前提口径不同——两处不一致在 Python 原样存在（serializer.py:272-274
    // vs 843-845），忠实移植，勿"修正"引发对拍漂移
    const isShadowHost = node.childrenAndShadowRoots.some(
      (child) =>
        child.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE && child.shadowRootType !== "user-agent",
    );

    // 强制可见：带 aria-* 或 pseudo 属性的元素
    if (!isVisible && Object.keys(node.attributes).length > 0) {
      for (const attr of Object.keys(node.attributes)) {
        if (attr.startsWith("aria-") || attr.startsWith("pseudo")) {
          isVisible = true;
          break;
        }
      }
    }

    // 强制可见：隐藏的 file input (Bootstrap opacity:0 模式)
    const isFileInput = tagLower === "input" && node.attributes.type === "file";
    if (!isVisible && isFileInput) isVisible = true;

    // 保留条件：可见 / 可滚动 / 有子内容 / shadow 宿主
    if (isVisible || isScrollable || hasShadowContent || isShadowHost) {
      const simplified = new SimplifiedNode(node, []);
      simplified.isShadowHost = isShadowHost;

      // 递归处理所有子节点（包括 shadow roots，跳过 UA 内部 shadow）
      for (const child of node.childrenAndShadowRoots) {
        if (
          child.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE &&
          child.shadowRootType === "user-agent"
        ) {
          continue;
        }
        const simplifiedChild = this.createSimplifiedTree(child, depth + 1);
        if (simplifiedChild) simplified.children.push(simplifiedChild);
      }

      // 复合控件处理
      this.addCompoundComponents(simplified, node);

      // Shadow 宿主始终保留
      if (isShadowHost && simplified.children.length > 0) return simplified;

      // 有意义的节点保留
      if (isVisible || isScrollable || simplified.children.length > 0) return simplified;
    }

    return null;
  }

  /** 检查元素是否被排除标记 (data-browser-use-exclude)。 */
  private isExcluded(attributes: Record<string, string>): boolean {
    let excludeAttr: string | undefined;
    if (this.sessionId) {
      excludeAttr = attributes[`data-browser-use-exclude-${this.sessionId}`];
    }
    if (!excludeAttr) excludeAttr = attributes["data-browser-use-exclude"];
    return typeof excludeAttr === "string" && excludeAttr.toLowerCase() === "true";
  }

  /** 处理 IFRAME/FRAME 节点，递归处理其 contentDocument。 */
  private processIframe(node: EnhancedDOMTreeNode, depth: number): SimplifiedNode | null {
    if (!node.contentDocument) return null;
    const simplified = new SimplifiedNode(node, []);
    for (const child of node.contentDocument.childrenNodes ?? []) {
      const simplifiedChild = this.createSimplifiedTree(child, depth + 1);
      if (simplifiedChild !== null) simplified.children.push(simplifiedChild);
    }
    return simplified;
  }

  // ── 复合控件处理 ──────────────────────────────────────────────────

  /** 为复合控件添加虚拟子组件信息，帮助 LLM 理解控件结构。 */
  private addCompoundComponents(simplified: SimplifiedNode, node: EnhancedDOMTreeNode): void {
    if (!["input", "select", "details", "audio", "video"].includes(node.tagName)) return;
    // 幂等保护（有意增强，Python 未清空）：compoundChildren 挂在跨 serialize 调用
    // 持久的 originalNode 上且为 push 追加，重复调用会翻倍并重复渲染 compound_components；
    // 常规路径每次采集重建融合树，清空对首跑无影响
    node.compoundChildren.length = 0;

    if (node.tagName === "input") {
      const inputType = node.attributes.type ?? "";
      if (!COMPOUND_INPUT_TYPES.includes(inputType as (typeof COMPOUND_INPUT_TYPES)[number])) {
        return;
      }
      // 日期/时间输入通过 placeholder/format 属性展示格式，不需要虚拟子组件
      if (DATE_TIME_INPUT_TYPES.includes(inputType as (typeof DATE_TIME_INPUT_TYPES)[number])) {
        return;
      }
    } else {
      const childIds = node.axNode?.child_ids;
      if (!node.axNode || !childIds || childIds.length === 0) return;
    }

    const elementType = node.tagName;
    const inputType = node.attributes.type ?? "";

    if (elementType === "input") {
      this.addInputCompound(simplified, node, inputType);
    } else if (elementType === "select") {
      this.addSelectCompound(simplified, node);
    } else if (elementType === "details") {
      node.compoundChildren.push(
        {
          role: "button",
          name: "Toggle Disclosure",
          valuemin: null,
          valuemax: null,
          valuenow: null,
        },
        { role: "region", name: "Content Area", valuemin: null, valuemax: null, valuenow: null },
      );
      simplified.isCompoundComponent = true;
    } else {
      // audio / video
      const components: Record<string, unknown>[] = [
        { role: "button", name: "Play/Pause", valuemin: null, valuemax: null, valuenow: null },
        // Python 字面量 0/100 是 int（渲染 "0"/"100"，与 range 的 float "0.0" 不同）
        { role: "slider", name: "Progress", valuemin: "0", valuemax: "100", valuenow: null },
        { role: "button", name: "Mute", valuemin: null, valuemax: null, valuenow: null },
        { role: "slider", name: "Volume", valuemin: "0", valuemax: "100", valuenow: null },
      ];
      if (elementType === "video") {
        components.push({
          role: "button",
          name: "Fullscreen",
          valuemin: null,
          valuemax: null,
          valuenow: null,
        });
      }
      for (const c of components) node.compoundChildren.push(c);
      simplified.isCompoundComponent = true;
    }
  }

  /** 处理 input 类型的复合控件。 */
  private addInputCompound(
    simplified: SimplifiedNode,
    node: EnhancedDOMTreeNode,
    inputType: string,
  ): void {
    const attrs = node.attributes;

    if (inputType === "range") {
      const minVal = attrs.min ?? "0";
      const maxVal = attrs.max ?? "100";
      node.compoundChildren.push({
        role: "slider",
        name: "Value",
        valuemin: pyFloatStr(safeParseNumber(minVal, 0)),
        valuemax: pyFloatStr(safeParseNumber(maxVal, 100)),
        valuenow: null,
      });
      simplified.isCompoundComponent = true;
    } else if (inputType === "number") {
      node.compoundChildren.push(
        { role: "button", name: "Increment", valuemin: null, valuemax: null, valuenow: null },
        { role: "button", name: "Decrement", valuemin: null, valuemax: null, valuenow: null },
        {
          role: "textbox",
          name: "Value",
          valuemin: safeParseOptionalNumberStr(attrs.min),
          valuemax: safeParseOptionalNumberStr(attrs.max),
          valuenow: null,
        },
      );
      simplified.isCompoundComponent = true;
    } else if (inputType === "color") {
      node.compoundChildren.push(
        { role: "textbox", name: "Hex Value", valuemin: null, valuemax: null, valuenow: null },
        { role: "button", name: "Color Picker", valuemin: null, valuemax: null, valuenow: null },
      );
      simplified.isCompoundComponent = true;
    } else if (inputType === "file") {
      let currentValue = "None";
      if (node.axNode?.properties) {
        for (const prop of node.axNode.properties) {
          if (prop.name === "valuetext" && prop.value) {
            const val = pyStr(prop.value).trim();
            if (val && !["", "no file chosen", "no file selected"].includes(val.toLowerCase())) {
              currentValue = val;
            }
            break;
          }
          if (prop.name === "value" && prop.value) {
            const val = pyStr(prop.value).trim();
            if (val) {
              if (val.includes("\\")) currentValue = val.split("\\").pop() ?? val;
              else if (val.includes("/")) currentValue = val.split("/").pop() ?? val;
              else currentValue = val;
            }
            break;
          }
        }
      }

      const multiple = attrs.multiple !== undefined;
      node.compoundChildren.push(
        { role: "button", name: "Browse Files", valuemin: null, valuemax: null, valuenow: null },
        {
          role: "textbox",
          name: `${multiple ? "Files" : "File"} Selected`,
          valuemin: null,
          valuemax: null,
          valuenow: currentValue,
        },
      );
      simplified.isCompoundComponent = true;
    }
  }

  /** 处理 select 复合控件。 */
  private addSelectCompound(simplified: SimplifiedNode, node: EnhancedDOMTreeNode): void {
    const components: Record<string, unknown>[] = [
      { role: "button", name: "Dropdown Toggle", valuemin: null, valuemax: null, valuenow: null },
    ];
    const optionsInfo = this.extractSelectOptions(node);
    if (optionsInfo) {
      // compoundChildren 是 Python dict[str, Any] 的移植（Record<string, unknown>）
      const optComponent: Record<string, unknown> = {
        role: "listbox",
        name: "Options",
        valuemin: null,
        valuemax: null,
        valuenow: null,
        options_count: optionsInfo.count,
        first_options: optionsInfo.first_options,
      };
      if (optionsInfo.format_hint) optComponent.format_hint = optionsInfo.format_hint;
      components.push(optComponent);
    } else {
      components.push({
        role: "listbox",
        name: "Options",
        valuemin: null,
        valuemax: null,
        valuenow: null,
      });
    }

    for (const c of components) node.compoundChildren.push(c);
    simplified.isCompoundComponent = true;
  }

  /** 提取 select 元素的选项信息。 */
  private extractSelectOptions(
    selectNode: EnhancedDOMTreeNode,
  ): { count: number; first_options: string[]; format_hint: string | null } | null {
    if (!selectNode.childrenNodes || selectNode.childrenNodes.length === 0) return null;

    const options: { text: string; value: string }[] = [];
    const optionValues: string[] = [];

    const extractRecursive = (n: EnhancedDOMTreeNode): void => {
      if (n.tagName === "option") {
        let text = "";
        let value = "";
        const rawValue = n.attributes.value;
        if (rawValue !== undefined) value = rawValue.trim();
        for (const child of n.children) {
          if (child.nodeType === NodeType.TEXT_NODE && child.nodeValue) {
            text += `${child.nodeValue.trim()} `;
          }
        }
        text = text.trim();
        if (!value && text) value = text;
        if (text || value) {
          options.push({ text, value });
          optionValues.push(value);
        }
      } else {
        // optgroup 与其他容器：仅向子节点递归（Python 两分支同构，保留结构）
        for (const child of n.children) extractRecursive(child);
      }
    };

    for (const child of selectNode.children) extractRecursive(child);

    if (options.length === 0) return null;

    const firstOptions: string[] = [];
    for (const opt of options.slice(0, 4)) {
      const display = opt.text || opt.value;
      if (display) {
        firstOptions.push(
          truncateCodePoints(display, 30) + (codePointLength(display) > 30 ? "..." : ""),
        );
      }
    }
    if (options.length > 4) firstOptions.push(`... ${options.length - 4} more options...`);

    let formatHint: string | null = null;
    if (optionValues.length >= 2) {
      const vals = optionValues.slice(0, 5).filter((v) => v);
      if (vals.length > 0) {
        if (vals.every((v) => pyIsDigit(v))) formatHint = "numeric";
        else if (vals.every((v) => codePointLength(v) === 2 && pyIsUpper(v))) {
          formatHint = "country/state codes";
        } else if (vals.every((v) => v.includes("/") || v.includes("-"))) {
          formatHint = "date/path format";
        } else if (vals.some((v) => v.includes("@"))) formatHint = "email addresses";
      }
    }

    return { count: options.length, first_options: firstOptions, format_hint: formatHint };
  }

  // ── Step 3: 树优化 ──────────────────────────────────────────────

  /** 后序遍历剪枝：清除子节点被剪除后变成无意义叶节点的中间容器。 */
  private optimizeTree(node: SimplifiedNode | null): SimplifiedNode | null {
    if (!node) return null;

    const optimizedChildren: SimplifiedNode[] = [];
    for (const child of node.children) {
      const optimized = this.optimizeTree(child);
      if (optimized) optimizedChildren.push(optimized);
    }
    node.children = optimizedChildren;

    const on = node.originalNode;
    const isVisible = on.snapshotNode !== null && on.isVisible === true;
    const isFileInput = on.tagName === "input" && on.attributes.type === "file";

    if (
      isVisible ||
      on.isActuallyScrollable ||
      on.nodeType === NodeType.TEXT_NODE ||
      node.children.length > 0 ||
      isFileInput
    ) {
      return node;
    }
    return null;
  }

  // ── Step 4: 包围盒过滤 ──────────────────────────────────────────

  /**
   * 过滤被交互父元素包围盒完全包含的子元素。
   *
   * 传播型元素（<a>、<button> 等）会将自身包围盒传播给所有后代。
   * 当后代的包围盒 ≥99% 位于传播型祖先内部时，标记为 excluded_by_parent。
   */
  private applyBoundingBoxFiltering(node: SimplifiedNode | null): SimplifiedNode | null {
    if (!node) return null;
    this.filterTreeRecursive(node, null, 0);
    // Python 此处统计排除数仅用于 debug 日志，无对外可观察行为
    return node;
  }

  /** 递归过滤：包围盒从传播型祖先向所有后代传播，直到被新的传播型元素覆盖。 */
  private filterTreeRecursive(
    node: SimplifiedNode,
    activeBounds: PropagatingBounds | null,
    depth: number,
  ): void {
    // 排除判定：如果当前节点被活跃包围盒包含
    if (activeBounds && this.shouldExcludeChild(node, activeBounds)) {
      node.excludedByParent = true;
    }

    // 传播检测：当前节点是否启动新的包围盒传播（即使已被排除也检测）
    let newBounds: PropagatingBounds | null = null;
    const tag = node.originalNode.tagName;
    const role = node.originalNode.attributes.role ?? null;
    if (this.isPropagatingElement({ tag, role })) {
      const bounds = node.originalNode.snapshotNode?.bounds;
      if (bounds) {
        newBounds = { tag, bounds, nodeId: node.originalNode.nodeId, depth };
      }
    }

    // 向子节点传播：使用新的包围盒（如果有），否则继承父级的
    const propagateBounds = newBounds ?? activeBounds;
    for (const child of node.children) {
      this.filterTreeRecursive(child, propagateBounds, depth + 1);
    }
  }

  /** 判定子节点是否应被排除。采用"先检查包含，再检查例外"的两段式逻辑。 */
  private shouldExcludeChild(node: SimplifiedNode, activeBounds: PropagatingBounds): boolean {
    const on = node.originalNode;

    // 文本节点永不排除
    if (on.nodeType === NodeType.TEXT_NODE) return false;

    // 无 bounds 数据，无法判定空间关系
    const childBounds = on.snapshotNode?.bounds;
    if (!childBounds) return false;

    // 空间包含检查：99% 阈值
    if (!this.isContained(childBounds, activeBounds.bounds, this.containmentThreshold)) {
      return false;
    }

    // ── 例外规则：以下情况即使满足包含条件也不排除 ──
    const childTag = on.tagName;
    const childRole = on.attributes.role ?? null;

    // 1. 表单元素需要独立交互
    if (["input", "select", "textarea", "label"].includes(childTag)) return false;

    // 2. 传播型元素本身（如嵌套按钮）
    if (this.isPropagatingElement({ tag: childTag, role: childRole })) return false;

    // 3. 显式 onclick 处理器
    if (on.attributes.onclick !== undefined) return false;

    // 4. 非空 aria-label（语义上标注为独立交互目标）
    const ariaLabel = on.attributes["aria-label"];
    if (ariaLabel !== undefined && ariaLabel.trim()) return false;

    // 5. 交互 role
    const role = on.attributes.role;
    if (
      role !== undefined &&
      ["button", "link", "checkbox", "radio", "tab", "menuitem", "option"].includes(role)
    ) {
      return false;
    }

    return true;
  }

  /** 检查子元素包围盒被父元素包含的比例是否 ≥ threshold。 */
  private isContained(child: DOMRect, parent: DOMRect, threshold: number): boolean {
    const xOverlap = Math.max(
      0,
      Math.min(child.x + child.width, parent.x + parent.width) - Math.max(child.x, parent.x),
    );
    const yOverlap = Math.max(
      0,
      Math.min(child.y + child.height, parent.y + parent.height) - Math.max(child.y, parent.y),
    );
    const intersectionArea = xOverlap * yOverlap;
    const childArea = child.width * child.height;
    if (childArea === 0) return false;
    return intersectionArea / childArea >= threshold;
  }

  /** 检查元素是否匹配传播型元素列表。role=null 表示不检查 role。 */
  private isPropagatingElement(attributes: { tag: string; role: string | null }): boolean {
    for (const pattern of DOMTreeSerializer.PROPAGATING_ELEMENTS) {
      let match = true;
      for (const key of ["tag", "role"] as const) {
        const patternVal = pattern[key];
        if (patternVal !== null && patternVal !== attributes[key]) {
          match = false;
          break;
        }
      }
      if (match) return true;
    }
    return false;
  }

  // ── Step 5: 分配交互索引 ────────────────────────────────────────

  /** 带缓存的 is_interactive 检测，避免重复计算。 */
  private isInteractiveCached(node: EnhancedDOMTreeNode): boolean {
    const cached = this.clickableCache.get(node.nodeId);
    if (cached !== undefined) return cached;
    const start = nowSec();
    const result = isInteractive(node);
    this.timingInfo["clickable_detection_time"] =
      (this.timingInfo["clickable_detection_time"] ?? 0) + (nowSec() - start);
    this.clickableCache.set(node.nodeId, result);
    return result;
  }

  /** 向上遍历父节点链判断是否在 shadow DOM 内。 */
  private isInsideShadowDom(node: SimplifiedNode): boolean {
    let current = node.originalNode.parentNode;
    while (current !== null) {
      if (current.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE && current.shadowRootType !== null) {
        return true;
      }
      current = current.parentNode;
    }
    return false;
  }

  /**
   * 检查节点是否有交互后代（不含自身）。
   *
   * 子树结论按 nodeId 记忆化（Python 无此缓存）：children 在 Step 3/4 已定型、
   * Step 5 不改树结构，结论稳定且输出与 Python 逐位一致；嵌套滚动容器场景
   * 避免外层重复扫描内层子树（最坏 O(n·depth)）。
   */
  private hasInteractiveDescendants(node: SimplifiedNode): boolean {
    const nodeId = node.originalNode.nodeId;
    const cached = this.interactiveDescendantsCache.get(nodeId);
    if (cached !== undefined) return cached;
    let result = false;
    for (const child of node.children) {
      if (this.isInteractiveCached(child.originalNode) || this.hasInteractiveDescendants(child)) {
        result = true;
        break;
      }
    }
    this.interactiveDescendantsCache.set(nodeId, result);
    return result;
  }

  /** 遍历简化树，为交互元素分配索引并标记新元素。 */
  private assignInteractiveIndicesAndMarkNewNodes(node: SimplifiedNode | null): void {
    if (!node) return;

    if (!node.excludedByParent) {
      const on = node.originalNode;
      const isInteractiveAssign = this.isInteractiveCached(on);
      const isVisible = on.snapshotNode !== null && on.isVisible === true;
      const isScrollable = on.isActuallyScrollable;
      const isFileInput = on.tagName === "input" && on.attributes.type === "file";

      const isShadowDomElement =
        isInteractiveAssign &&
        on.snapshotNode === null &&
        ["input", "button", "select", "textarea", "a"].includes(on.tagName) &&
        this.isInsideShadowDom(node);

      // 有 JS click listener 的元素绕过 paint order 过滤
      // 因为点击基于 DOM 坐标，不依赖视觉层叠
      const bypassPaintOrder = on.hasJsClickListener;

      let shouldMakeInteractive = false;

      if (isScrollable && !node.ignoredByPaintOrder) {
        // 下拉容器始终可交互
        const role = (on.attributes.role ?? "").toLowerCase();
        const tag = on.tagName;
        const classAttr = (on.attributes.class ?? "").toLowerCase();
        const classList = classAttr ? classAttr.split(/\s+/).filter((c) => c !== "") : [];

        const isDropdown =
          ["listbox", "menu", "combobox", "menubar", "tree", "grid"].includes(role) ||
          tag === "select" ||
          classList.includes("dropdown") ||
          classList.includes("dropdown-menu") ||
          classList.includes("select-menu");
        if (isDropdown) shouldMakeInteractive = true;
        else if (!this.hasInteractiveDescendants(node)) shouldMakeInteractive = true;
      } else if (isInteractiveAssign && (isVisible || isFileInput || isShadowDomElement)) {
        if (bypassPaintOrder || !node.ignoredByPaintOrder) shouldMakeInteractive = true;
      }

      if (shouldMakeInteractive) {
        node.isInteractive = true;
        node.highlightIndex = on.backendNodeId;
        this.selectorMap.set(node.highlightIndex, on);

        if (node.isCompoundComponent) {
          node.isNew = true;
        } else if (this.previousCachedSelectorMap && this.previousCachedSelectorMap.size > 0) {
          if (!this.previousCachedSelectorMap.has(on.backendNodeId)) node.isNew = true;
        }
      }
    }

    for (const child of node.children) {
      this.assignInteractiveIndicesAndMarkNewNodes(child);
    }
  }

  // ── 文本输出 ─────────────────────────────────────────────────────

  /** 将 SimplifiedNode 树序列化为 LLM 可读的缩进文本。 */
  static serializeTree(
    node: SimplifiedNode | null,
    includeAttributes: readonly string[],
    depth = 0,
  ): string {
    if (!node) return "";

    const on = node.originalNode;

    // 被排除的节点：跳过自身，但处理子节点
    if (node.excludedByParent) {
      const parts: string[] = [];
      for (const child of node.children) {
        const text = DOMTreeSerializer.serializeTree(child, includeAttributes, depth);
        if (text) parts.push(text);
      }
      return parts.join("\n");
    }

    const parts: string[] = [];
    const indent = "\t".repeat(depth);
    let nextDepth = depth;
    const nameUpper = on.nodeName.toUpperCase();
    const isFrame = nameUpper === "IFRAME" || nameUpper === "FRAME";

    if (on.nodeType === NodeType.ELEMENT_NODE) {
      if (!node.shouldDisplay) {
        for (const child of node.children) {
          const text = DOMTreeSerializer.serializeTree(child, includeAttributes, depth);
          if (text) parts.push(text);
        }
        return parts.join("\n");
      }

      const tag = on.tagName;

      // SVG: 折叠显示
      if (tag === "svg") {
        const shadowPf = shadowPrefix(node);
        let line = `${indent}${shadowPf}`;
        if (node.isInteractive) {
          line += `${node.isNew ? "*" : ""}[${node.highlightIndex}]`;
        }
        line += "<svg";
        const svgAttrs = buildAttributesString(on, includeAttributes);
        if (svgAttrs) line += ` ${svgAttrs}`;
        line += " /> <!-- SVG content collapsed -->";
        return line;
      }

      // 交互 / 可滚动 / iframe 元素
      const isAnyScrollable = on.isActuallyScrollable || on.isScrollable === true;
      const shouldShowScroll = on.shouldShowScrollInfo;
      if (node.isInteractive || isAnyScrollable || isFrame) {
        nextDepth += 1;
        let attrStr = buildAttributesString(on, includeAttributes);

        // 复合组件信息
        if (on.compoundChildren.length > 0) {
          const compoundParts: string[] = [];
          for (const ci of on.compoundChildren as CompoundChildInfo[]) {
            const items: string[] = [];
            if (ci.name) items.push(`name=${ci.name}`);
            if (ci.role) items.push(`role=${ci.role}`);
            if (ci.valuemin !== null && ci.valuemin !== undefined) items.push(`min=${ci.valuemin}`);
            if (ci.valuemax !== null && ci.valuemax !== undefined) items.push(`max=${ci.valuemax}`);
            if (ci.valuenow !== null && ci.valuenow !== undefined) {
              items.push(`current=${ci.valuenow}`);
            }
            if (ci.options_count !== null && ci.options_count !== undefined) {
              items.push(`count=${ci.options_count}`);
            }
            if (ci.first_options && ci.first_options.length > 0) {
              items.push(`options=${ci.first_options.slice(0, 4).join("|")}`);
            }
            if (ci.format_hint) items.push(`format=${ci.format_hint}`);
            if (items.length > 0) compoundParts.push(`(${items.join(",")})`);
          }
          if (compoundParts.length > 0) {
            const compoundAttr = `compound_components=${compoundParts.join(",")}`;
            attrStr = attrStr ? `${attrStr} ${compoundAttr}` : compoundAttr;
          }
        }

        const shadowPf = shadowPrefix(node);

        let line: string;
        if (shouldShowScroll && !node.isInteractive) {
          // 可滚动但不可交互
          line = `${indent}${shadowPf}|scroll element|<${tag}`;
        } else if (node.isInteractive) {
          // 可交互（可能同时可滚动）
          const newPf = node.isNew ? "*" : "";
          const scrollPf = shouldShowScroll ? "|scroll element[" : "[";
          line = `${indent}${shadowPf}${newPf}${scrollPf}${node.highlightIndex}]<${tag}`;
        } else if (isFrame) {
          line = `${indent}${shadowPf}|${on.nodeName}|<${tag}`;
        } else {
          line = `${indent}${shadowPf}<${tag}`;
        }

        if (attrStr) line += ` ${attrStr}`;
        line += " />";

        // 滚动信息文本
        if (shouldShowScroll) {
          const scrollInfoText = on.getScrollInfoText();
          if (scrollInfoText) line += ` (${scrollInfoText})`;
        }

        parts.push(line);
      }
    } else if (on.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE) {
      // Shadow DOM 边界
      const srType = on.shadowRootType;
      parts.push(
        srType && srType.toLowerCase() === "closed"
          ? `${indent}Closed Shadow`
          : `${indent}Open Shadow`,
      );
      nextDepth += 1;
      for (const child of node.children) {
        const text = DOMTreeSerializer.serializeTree(child, includeAttributes, nextDepth);
        if (text) parts.push(text);
      }
      if (node.children.length > 0) parts.push(`${indent}Shadow End`);
    } else if (on.nodeType === NodeType.TEXT_NODE) {
      const isVisible = on.snapshotNode !== null && on.isVisible === true;
      if (isVisible && on.nodeValue && isMeaningfulText(on.nodeValue)) {
        parts.push(indent + on.nodeValue.trim());
      }
    }

    // 非 DOCUMENT_FRAGMENT_NODE 的子节点
    if (on.nodeType !== NodeType.DOCUMENT_FRAGMENT_NODE) {
      for (const child of node.children) {
        const text = DOMTreeSerializer.serializeTree(child, includeAttributes, nextDepth);
        if (text) parts.push(text);
      }

      // iframe 隐藏内容提示（当前采集管线不填充这两个字段，保留分支与 Python 对齐）
      if (on.nodeType === NodeType.ELEMENT_NODE && on.tagName && isFrame) {
        if (on.hiddenElementsInfo.length > 0) {
          parts.push(
            `${indent}... (${on.hiddenElementsInfo.length} more elements below - scroll to reveal):`,
          );
          for (const elem of on.hiddenElementsInfo) {
            parts.push(
              `${indent}    <${String(elem.tag)}> "${String(elem.text)}" ~${String(elem.pages)} pages down`,
            );
          }
        } else if (on.hasHiddenContent) {
          parts.push(`${indent}... (more content below viewport - scroll to reveal)`);
        }
      }
    }

    return parts.join("\n");
  }
}
