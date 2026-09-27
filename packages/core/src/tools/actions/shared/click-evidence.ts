// 点击证据族：页面指纹/表单值摘要/验证标记/页面消息四个 JS 探针（JS 体逐字节照抄
// Python :374-490，含前导换行）+ _click_effect_watch_target（#205 放宽）+
// _detect_new_tab_opened（G7）。移植自 TreeWalker tools/actions.py @640d52a。

import type { TabInfo } from "../../../browser/views.js";
import type { ToolsBrowser } from "../../types.js";

// R7-1：click 无效果检测的页面指纹——URL + 元素数 + outerHTML 长度。JS 无反斜杠。
export const JS_PAGE_FINGERPRINT = `
(function(){
	return [location.href, document.querySelectorAll('*').length,
		document.documentElement.outerHTML.length].join('|');
})()`;

/** 点击后等待页面反应的秒数（DOM 更新/导航/表单回显） */
export const CLICK_EFFECT_WAIT_S = 0.6;

// #205：点击后做「无可见效果」检测的目标范围——交互特征属性命中其一即视为自定义
// 交互控件（KO/jQuery toggle、菜单、下拉）。序列化白名单不含这些属性（模型看到裸
// div），但 selector_map entry.attributes 里有，程序侧可判。
export const INTERACTIVE_ATTR_MARKERS = [
  "data-bind",
  "data-role",
  "role",
  "tabindex",
  "onclick",
  "aria-expanded",
  "aria-haspopup",
  "aria-controls",
] as const;

/** #205：该点击目标是否值得做「无可见效果」检测（BUTTON/submit·button 型 INPUT/带交互特征属性的容器；A 除外） */
export function clickEffectWatchTarget(tag: string, attrs: Record<string, string>): boolean {
  if (tag === "BUTTON") return true;
  if (tag === "INPUT") return attrs.type === "submit" || attrs.type === "button";
  if (tag === "A") return false;
  return INTERACTIVE_ATTR_MARKERS.some((k) => k in attrs);
}

// B3-2：表单字段值摘要——input.value 是 property 非 attribute，指纹检测不到
// 「值被页面部件清掉」。按表单收集前 30 个字段值的长度指纹。JS 无反斜杠。
export const JS_FORM_VALUES = `
(function(){
	var out = [];
	for (var i = 0; i < document.forms.length && i < 5; i++){
		var els = document.forms[i].elements;
		var vals = [];
		for (var j = 0; j < els.length && j < 30; j++){
			vals.push(String(els[j].value || '').length);
		}
		out.push(vals.join(','));
	}
	return out.join('|');
})()`;

// R7-2：input_text 回读页面验证标记——「值在但被验证器拒绝」时提交会被静默拦截。
export const JS_VALIDATION_STATE = `
(function(){
	var el = document.activeElement;
	if (!el || el === document.body) { return ''; }
	var marks = [];
	if (el.getAttribute && el.getAttribute('aria-invalid') === 'true'){ marks.push('aria-invalid'); }
	var cls = String(el.className || '');
	var parts = cls.split(' ');
	var bad = ['mage-error', 'error', 'invalid', 'input-error', '_error'];
	for (var i = 0; i < parts.length; i++){
		if (bad.indexOf(parts[i]) >= 0){ marks.push('class:' + parts[i]); break; }
	}
	var wrap = el.closest ? el.closest('.admin__field, .field, .form-group, .has-error') : null;
	if (wrap){
		var msgs = wrap.querySelectorAll('.mage-error, .error, .admin__field-error, .field-error, ._error');
		var selfMarked = marks.length > 0;
		for (var mi = 0; mi < msgs.length; mi++){
			var m = msgs[mi];
			var forAttr = m.getAttribute ? m.getAttribute('for') : null;
			var owned = (forAttr && el.id && forAttr === el.id) || selfMarked;
			if (owned && m.textContent && m.textContent.trim()){
				marks.push('msg:' + m.textContent.trim().slice(0, 80));
				break;
			}
		}
	}
	return marks.join('; ');
})()`;

// B3：click 后页面消息（保存成功/失败浮层）显式确认。至多 3 条、每条 160 字符。
export const JS_PAGE_MESSAGES = `
(function(){
	var sels = ['.message-success', '.message-error', '.message-warning',
		'.message-notice', '[data-ui-id="messages"] .message'];
	var seen = {}, out = [];
	for (var i = 0; i < sels.length; i++){
		var els = document.querySelectorAll(sels[i]);
		for (var j = 0; j < els.length; j++){
			var t = (els[j].textContent || '').trim();
			if (!t) { continue; }
			var cls = String(els[j].className || '');
			var tag2 = cls.indexOf('error') >= 0 ? 'ERROR: '
				: cls.indexOf('success') >= 0 ? 'SUCCESS: '
				: cls.indexOf('warning') >= 0 ? 'WARNING: ' : 'NOTICE: ';
			var line = tag2 + t.slice(0, 160);
			if (!seen[line]) { seen[line] = 1; out.push(line); }
			if (out.length >= 3) { break; }
		}
		if (out.length >= 3) { break; }
	}
	return out.join(' | ');
})()`;

const asString = (v: unknown): string =>
  typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);

/** :1079-1089 读页面消息浮层；返回 ``SUCCESS: ...`` 拼接串（至多 3 条），失败返回 "" */
export async function readPageMessages(
  browser: ToolsBrowser,
  log: (message: string) => void,
): Promise<string> {
  try {
    return asString(await browser.executeJs(JS_PAGE_MESSAGES)).trim();
  } catch (e) {
    log(`page-messages read failed: ${e instanceof Error ? e.message : String(e)}`);
    return "";
  }
}

/** :1091-1097 轻量页面指纹（URL | 元素数 | outerHTML 长度）。失败返回 null（跳过检测） */
export async function pageFingerprint(
  browser: ToolsBrowser,
  log: (message: string) => void,
): Promise<string | null> {
  try {
    const v = await browser.executeJs(JS_PAGE_FINGERPRINT);
    return v === null || v === undefined ? null : asString(v);
  } catch (e) {
    log(`page fingerprint failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** :1099-1105 表单字段值摘要（前 5 表单 × 前 30 字段值长度）。失败返回 null */
export async function formValuesDigest(
  browser: ToolsBrowser,
  log: (message: string) => void,
): Promise<string | null> {
  try {
    const v = await browser.executeJs(JS_FORM_VALUES);
    return v === null || v === undefined ? null : asString(v);
  } catch (e) {
    log(`form values digest failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** :1107-1117 读 activeElement 的页面验证标记（aria-invalid/错误 class/错误文案）。失败/无标记返回 "" */
export async function readValidationState(
  browser: ToolsBrowser,
  log: (message: string) => void,
): Promise<string> {
  try {
    return asString(await browser.executeJs(JS_VALIDATION_STATE)).trim();
  } catch (e) {
    log(`validation-state read failed: ${e instanceof Error ? e.message : String(e)}`);
    return "";
  }
}

/**
 * :1143-1168 点击若打开了新标签页，自动切过去并返回提示串（G7）。常态点击返回 ""。
 * switch 失败软降级为提示。
 */
export async function detectNewTabOpened(
  browser: ToolsBrowser,
  tabsBefore: readonly string[],
  sleep: (ms: number) => Promise<void>,
): Promise<string> {
  try {
    await sleep(50); // 等 Target.attachedToTarget 事件传播
    const tabsAfter = await browser.getTabs();
    const newTabs = tabsAfter.filter((t) => !tabsBefore.includes(t.targetId));
    if (newTabs.length === 0) return "";
    const newTab: TabInfo = newTabs[0];
    const newId = newTab.targetId.slice(-4);
    try {
      await browser.switchTab(newTab.targetId);
      return `  ℹ️ Click opened a new tab [${newId}] ${newTab.title}; auto-switched to it.`;
    } catch {
      return `  ℹ️ Click opened a new tab [${newId}] ${newTab.title}; use switch_tab to focus it.`;
    }
  } catch {
    return "";
  }
}
