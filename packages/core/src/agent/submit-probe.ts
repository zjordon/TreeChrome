// submit 预确认探针（M5 段 C，架构 §5.3）：判定 click 目标是否 submit 特征 +
// 采集变更字段摘要（≤8，password 值打码）。TreeChrome 净新增（Python 无扩展形态）。
// 两段式：快照侧 tag/type 预筛（语言无关确定性、零 CDP 开销——矩阵外不触页面）→
// 页面内一步 JS probe（submit 复核 + form 祖先 + defaultValue/defaultChecked/defaultSelected
// 变更比对）。探针 best-effort fail-open：异常/非 submit/无变更字段 → null 放行点击
// （检测不阻塞动作；交互侧 submitGate 才 fail-closed）。

import type { EnhancedDOMTreeNode } from "../browser/views.js";
import type { SubmitFieldSummary } from "../policy/policy.js";

/** evalFunctionOnNode 消费面（BrowserSession 结构满足；单测注入轻量 fake） */
export interface SubmitProbeBrowser {
  evalFunctionOnNode(backendNodeId: number, functionDeclaration: string): Promise<unknown>;
}

/** 摘要上限与值截断（架构 §5.3：变更字段 ≤8；值 40 字符） */
export const SUBMIT_SUMMARY_MAX_FIELDS = 8;
export const SUBMIT_SUMMARY_VALUE_MAX_CHARS = 40;

/**
 * 快照侧预筛（tag/type 矩阵）：input[type=submit] / button[type=submit] /
 * button（无 type——HTML 默认 submit 语义）。form 归属快照不可知 → 判定与摘要
 * 延到 JS probe 一步完成（SUBMIT_PROBE_JS 内复核，页面真值优先）。
 */
export function isSubmitCandidateNode(node: EnhancedDOMTreeNode): boolean {
  const tag = node.tagName.toUpperCase();
  const type = (node.attributes.type ?? "").toLowerCase();
  if (tag === "INPUT") return type === "submit";
  if (tag === "BUTTON") return type === "" || type === "submit";
  return false;
}

/**
 * 页面内一步 probe（this = click 目标）：submit 特征复核 + closest("form") +
 * 变更字段摘要。checkbox/radio 用 defaultChecked、select 用 defaultSelected
 * （无标记则首 option——HTML 默认选中语义）、其余用 defaultValue；password 值
 * 恒 "***"（字段名可见值打码）；字段名 name → id → aria-label → placeholder →
 * tag 兜底；前 8 项、值截断 40；无 form / 无变更字段 → null。
 */
export const SUBMIT_PROBE_JS =
  "function () {  try {    if (!(this instanceof Element)) return null;    var tag = this.tagName;    var type = (this.getAttribute('type') || '').toLowerCase();    var submitish = tag === 'INPUT' ? type === 'submit' : (tag === 'BUTTON' ? (type === '' || type === 'submit') : false);    if (!submitish) return null;    var form = this.closest('form');    if (form === null) return null;    var fields = [];    var els = form.querySelectorAll('input, select, textarea');    for (var i = 0; i < els.length && fields.length < 8; i++) {      var el = els[i];      var tn = el.tagName;      var etype = (el.getAttribute('type') || '').toLowerCase();      var changed = false;      var value = '';      if (tn === 'INPUT' && (etype === 'checkbox' || etype === 'radio')) {        changed = el.checked !== el.defaultChecked;        value = el.checked ? 'checked' : 'unchecked';      } else if (tn === 'SELECT') {        var def = null;        for (var j = 0; j < el.options.length; j++) {          if (el.options[j].defaultSelected) { def = el.options[j].value; break; }        }        if (def === null && el.options.length > 0) def = el.options[0].value;        changed = def === null ? el.value !== '' : el.value !== def;        value = el.value;      } else if (tn === 'TEXTAREA') {        changed = el.value !== el.defaultValue;        value = el.value;      } else {        changed = el.value !== el.defaultValue;        value = etype === 'password' ? '***' : el.value;      }      if (!changed) continue;      var name = el.name || el.id || el.getAttribute('aria-label') || el.getAttribute('placeholder') || tn.toLowerCase();      if (value.length > 40) value = value.slice(0, 40) + '...';      fields.push({ name: name, value: value });    }    return fields.length > 0 ? fields : null;  } catch (e) {    return null;  }}";

/** probe 返回解析：合法数组 → 摘要（形态校验 + 8 项/40 字符契约在 TS 侧强制——
 *  页面返回不可信）；空数组/非数组/全非法 → null */
export function parseSubmitProbeResult(raw: unknown): SubmitFieldSummary[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: SubmitFieldSummary[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.name !== "string" || typeof rec.value !== "string") continue;
    if (out.length >= SUBMIT_SUMMARY_MAX_FIELDS) break;
    out.push({
      name: rec.name,
      value:
        rec.value.length > SUBMIT_SUMMARY_VALUE_MAX_CHARS
          ? `${rec.value.slice(0, SUBMIT_SUMMARY_VALUE_MAX_CHARS)}...`
          : rec.value,
    });
  }
  return out.length > 0 ? out : null;
}

/** act 挂点消费端：index → selectorMap 预筛 → JS probe。绝不抛（异常 → null） */
export async function probeSubmitForClick(
  browser: SubmitProbeBrowser,
  domState: { selectorMap: Map<number, EnhancedDOMTreeNode> } | null,
  params: Record<string, unknown>,
): Promise<SubmitFieldSummary[] | null> {
  const idx = params.index;
  if (typeof idx !== "number") return null;
  const node = domState?.selectorMap.get(idx) ?? null;
  if (node === null || !isSubmitCandidateNode(node)) return null;
  try {
    return parseSubmitProbeResult(
      await browser.evalFunctionOnNode(node.backendNodeId, SUBMIT_PROBE_JS),
    );
  } catch {
    return null; // 检测 best-effort（fail-open）；交互侧 submitGate 才 fail-closed
  }
}
