// 文本输入：逐字符键事件、三层清空、原生 setter 强写、框架事件派发、直接赋值判定
// 与键码映射。移植自 TreeWalker session.py:2749-2862（type_text 族）、:3193-3429
// （清空/单字符/框架事件）、:720-902（键码表与 _requires_direct_value_assignment）
// @640d52a。防线纪律：clear 静默失败→拼接守卫→force_set_value；框架事件永不派发 blur。

import type { SessionInternals } from "./transport.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * 逐字符输入当前聚焦元素（:2749-2791）：clear 时先三层清空，尾部拼接守卫——
 * 字段出现 OLD+NEW（清空被静默吞掉）时用原生 setter 强写。
 */
export async function typeText(
  s: SessionInternals,
  text: string,
  options: { clear?: boolean } = {},
): Promise<void> {
  if (options.clear) await clearTextField(s);
  for (const char of text) {
    await typeChar(s, char);
    await s.sleep(1);
  }
  await s.sleep(50);
  await triggerFrameworkEvents(s);
  if (options.clear) {
    const actual = await readActiveText(s);
    if (
      typeof actual === "string" &&
      actual !== text &&
      actual.length > text.length &&
      (actual.endsWith(text) || actual.startsWith(text))
    ) {
      s.log(`Concatenation detected (${actual}), force-overwriting via native setter`);
      await forceSetValue(s, text);
    }
  }
}

/** 读 activeElement.value（input/textarea）或 textContent（contenteditable） */
export async function readActiveText(s: SessionInternals): Promise<string> {
  try {
    const result = await s.send<Record<string, unknown>>("Runtime.evaluate", {
      expression:
        "(function() {\n" +
        "    var el = document.activeElement;\n" +
        "    if (!el || el === document.body) return '';\n" +
        "    if (el.value !== undefined) return el.value;\n" +
        "    return el.textContent || '';\n" +
        "})()",
      returnByValue: true,
    });
    const inner = isRecord(result.result) ? result.result : {};
    return typeof inner.value === "string" ? inner.value : "";
  } catch (e) {
    s.log(`_read_active_text failed: ${String(e)}`);
    return "";
  }
}

/**
 * 原生 setter 强写（:2814-2862）：绕过 React/Vue 追踪；此路径派发 change（元素
 * 仍聚焦，无 blur 副作用——与打字路径的策略差异见 Python 原注释）。
 */
export async function forceSetValue(s: SessionInternals, text: string): Promise<void> {
  try {
    const escaped = JSON.stringify(text);
    await s.send("Runtime.evaluate", {
      expression:
        "(function() {\n" +
        "    var el = document.activeElement;\n" +
        "    if (!el || el === document.body) return;\n" +
        "    var tag = el.tagName.toLowerCase();\n" +
        "    if (tag === 'input' || tag === 'textarea') {\n" +
        "        var proto = tag === 'input'\n" +
        "            ? HTMLInputElement.prototype\n" +
        "            : HTMLTextAreaElement.prototype;\n" +
        "        var desc = Object.getOwnPropertyDescriptor(proto, 'value');\n" +
        "        if (desc && desc.set) {\n" +
        `            desc.set.call(el, ${escaped});\n` +
        "        } else {\n" +
        `            el.value = ${escaped};\n` +
        "        }\n" +
        "        el.dispatchEvent(new Event('input', {bubbles: true}));\n" +
        "        el.dispatchEvent(new Event('change', {bubbles: true}));\n" +
        "    } else if (el.isContentEditable) {\n" +
        `        el.textContent = ${escaped};\n` +
        "        el.dispatchEvent(new InputEvent('input', {\n" +
        "            bubbles: true, inputType: 'insertText'\n" +
        "        }));\n" +
        "        el.dispatchEvent(new Event('change', {bubbles: true}));\n" +
        "    }\n" +
        "})()",
      returnByValue: true,
    });
  } catch (e) {
    s.log(`_force_set_value failed: ${String(e)}`);
  }
}

/**
 * 三层清空（:3193-3317）：① JS select()+value=''（含 contenteditable）→
 * ② 三击 + Delete → ③ Ctrl+A + Backspace。某层后为空即成功。
 */
export async function clearTextField(s: SessionInternals): Promise<boolean> {
  // Strategy 1: JS select() + value=''
  try {
    const result = await s.send<Record<string, unknown>>("Runtime.evaluate", {
      expression:
        "(function() {\n" +
        "    var el = document.activeElement;\n" +
        "    if (!el || el === document.body) return {cleared: false, error: 'no active'};\n" +
        "    el.focus();\n" +
        "    if (el.isContentEditable) {\n" +
        "        var sel = window.getSelection();\n" +
        "        var range = document.createRange();\n" +
        "        range.selectNodeContents(el);\n" +
        "        sel.removeAllRanges();\n" +
        "        sel.addRange(range);\n" +
        "        el.textContent = '';\n" +
        "        el.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'deleteContent'}));\n" +
        "        el.dispatchEvent(new Event('change', {bubbles: true}));\n" +
        "        return {cleared: true, method: 'contenteditable', final: el.textContent};\n" +
        "    }\n" +
        "    if (el.value !== undefined) {\n" +
        "        try { el.select(); } catch(e) {}\n" +
        "        el.value = '';\n" +
        "        el.dispatchEvent(new Event('input', {bubbles: true}));\n" +
        "        el.dispatchEvent(new Event('change', {bubbles: true}));\n" +
        "        return {cleared: true, method: 'value', final: el.value};\n" +
        "    }\n" +
        "    return {cleared: false, error: 'unsupported element'};\n" +
        "})()",
      returnByValue: true,
    });
    const inner = isRecord(result.result) ? result.result : {};
    const info = isRecord(inner.value) ? inner.value : {};
    const finalRaw = info.final;
    const finalStr = typeof finalRaw === "string" ? finalRaw.trim() : "";
    if (info.cleared && !finalStr) return true;
  } catch (e) {
    s.log(`_clear_text_field strategy 1 failed: ${String(e)}`);
  }
  // Strategy 2: 三击 + Delete
  try {
    const coordResult = await s.send<Record<string, unknown>>("Runtime.evaluate", {
      expression:
        "(function() {\n" +
        "    var el = document.activeElement;\n" +
        "    if (!el || el === document.body) return null;\n" +
        "    var r = el.getBoundingClientRect();\n" +
        "    return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});\n" +
        "})()",
      returnByValue: true,
    });
    const inner = isRecord(coordResult.result) ? coordResult.result : {};
    if (typeof inner.value === "string" && inner.value) {
      const c = JSON.parse(inner.value) as { x: number; y: number };
      await s.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: c.x,
        y: c.y,
        button: "left",
        clickCount: 3,
      });
      await s.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: c.x,
        y: c.y,
        button: "left",
        clickCount: 3,
      });
      await s.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete" });
      await s.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete" });
      if ((await readActiveText(s)) === "") return true;
    }
  } catch (e) {
    s.log(`_clear_text_field strategy 2 failed: ${String(e)}`);
  }
  // Strategy 3: Ctrl+A + Backspace
  try {
    await s.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      modifiers: 2,
    });
    await s.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      modifiers: 2,
    });
    await s.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Backspace",
      code: "Backspace",
    });
    await s.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
    });
    return (await readActiveText(s)) === "";
  } catch (e) {
    s.log(`_clear_text_field strategy 3 failed: ${String(e)}`);
    return false;
  }
}

/**
 * 单字符键事件（:3319-3358）：ASCII 走 keyDown→5ms→char→keyUp；非 ASCII（CJK）
 * 只发 insertText 型 char 事件。
 */
export async function typeChar(s: SessionInternals, char: string): Promise<void> {
  const [modifiers, vkCode, baseKey] = getCharModifiersAndVk(char);
  const keyCode = getKeyCodeForChar(baseKey);
  const isAscii = char.charCodeAt(0) < 128;
  if (isAscii) {
    await s.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: baseKey,
      code: keyCode,
      modifiers,
      windowsVirtualKeyCode: vkCode,
    });
    await s.sleep(5);
  }
  await s.send("Input.dispatchKeyEvent", { type: "char", text: char, key: char });
  if (isAscii) {
    await s.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: baseKey,
      code: keyCode,
      modifiers,
      windowsVirtualKeyCode: vkCode,
    });
  }
}

/**
 * 框架事件派发（:3360-3429）：InputEvent(input) + change（KO value 绑定听 change——
 * 漏发提交空值）+ Vue 检测祖先链后延迟 input。**永不派发 blur**（下拉收起/tag-input
 * 清值等副作用）。best-effort。
 */
export async function triggerFrameworkEvents(s: SessionInternals): Promise<void> {
  try {
    await s.send("Runtime.evaluate", {
      expression:
        "(function() {\n" +
        "    var el = document.activeElement;\n" +
        "    if (!el || el === document.body) return false;\n" +
        "    el.focus();\n" +
        "    try {\n" +
        "        el.dispatchEvent(new InputEvent('input', {\n" +
        "            bubbles: true,\n" +
        "            cancelable: true,\n" +
        "            data: el.value,\n" +
        "            inputType: 'insertText'\n" +
        "        }));\n" +
        "    } catch(e) {}\n" +
        "    try {\n" +
        "        el.dispatchEvent(new Event('change', {bubbles: true}));\n" +
        "    } catch(e) {}\n" +
        "    var hasVue = el.__vue__ || el._vnode || el.__vueParentComponent__;\n" +
        "    if (!hasVue) {\n" +
        "        var p = el.parentElement;\n" +
        "        while (p && p !== document.body) {\n" +
        "            if (p.__vue__ || p._vnode || p.__vueParentComponent__) {\n" +
        "                hasVue = true;\n" +
        "                break;\n" +
        "            }\n" +
        "            p = p.parentElement;\n" +
        "        }\n" +
        "    }\n" +
        "    if (hasVue) {\n" +
        "        try {\n" +
        "            setTimeout(function() {\n" +
        "                el.dispatchEvent(new Event('input', {bubbles: true}));\n" +
        "            }, 0);\n" +
        "        } catch(e) {}\n" +
        "    }\n" +
        "    return true;\n" +
        "})()",
      returnByValue: true,
    });
  } catch (e) {
    s.log(`Framework event trigger failed (non-critical): ${String(e)}`);
  }
}

// ── 键码映射（:795-843）────────────────────────────────────────────────

const SHIFT_CHARS: Record<string, [string, number]> = {
  "!": ["1", 49],
  "@": ["2", 50],
  "#": ["3", 51],
  $: ["4", 52],
  "%": ["5", 53],
  "^": ["6", 54],
  "&": ["7", 55],
  "*": ["8", 56],
  "(": ["9", 57],
  ")": ["0", 48],
  _: ["-", 189],
  "+": ["=", 187],
  "{": ["[", 219],
  "}": ["]", 221],
  "|": ["\\", 220],
  ":": [";", 186],
  '"': ["'", 222],
  "<": [",", 188],
  ">": [".", 190],
  "?": ["/", 191],
  "~": ["`", 192],
};

const NO_SHIFT: Record<string, number> = {
  " ": 32,
  "-": 189,
  "=": 187,
  "[": 219,
  "]": 221,
  "\\": 220,
  ";": 186,
  "'": 222,
  ",": 188,
  ".": 190,
  "/": 191,
  "`": 192,
};

function isUpper(c: string): boolean {
  return c !== c.toLowerCase() && c === c.toUpperCase();
}
function isLower(c: string): boolean {
  return c !== c.toUpperCase() && c === c.toLowerCase();
}
function isAlpha(c: string): boolean {
  return c.toLowerCase() !== c.toUpperCase();
}
function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

/** (modifiers, windowsVirtualKeyCode, base_key)——Python isupper/islower 的 Unicode 感知等价 */
export function getCharModifiersAndVk(char: string): [number, number, string] {
  const shift = SHIFT_CHARS[char];
  if (shift) return [8, shift[1], shift[0]];
  if (isUpper(char)) return [8, char.charCodeAt(0), char.toLowerCase()];
  if (isLower(char)) return [0, char.toUpperCase().charCodeAt(0), char];
  if (isDigit(char)) return [0, char.charCodeAt(0), char];
  const noShift = NO_SHIFT[char];
  if (noShift !== undefined) return [0, noShift, char];
  return [0, isAlpha(char) ? char.toUpperCase().charCodeAt(0) : char.charCodeAt(0), char];
}

const KEY_CODE_TABLE: Record<string, string> = {
  " ": "Space",
  ".": "Period",
  ",": "Comma",
  "-": "Minus",
  "@": "Digit2",
  "!": "Digit1",
  "?": "Slash",
  ":": "Semicolon",
  ";": "Semicolon",
  "(": "Digit9",
  ")": "Digit0",
  "[": "BracketLeft",
  "]": "BracketRight",
  "/": "Slash",
  "\\": "Backslash",
  "=": "Equal",
  "+": "Equal",
  "*": "Digit8",
  "&": "Digit7",
  "%": "Digit5",
  $: "Digit4",
  "#": "Digit3",
  "^": "Digit6",
  "~": "Backquote",
  "`": "Backquote",
  "'": "Quote",
  '"': "Quote",
  _: "Minus",
  "{": "BracketLeft",
  "}": "BracketRight",
  "|": "Backslash",
  "<": "Comma",
  ">": "Period",
};

/** DOM code 字符串（数字 Digit{n}、字母 Key{X}、符号查表） */
export function getKeyCodeForChar(char: string): string {
  if (isDigit(char)) return `Digit${char}`;
  if (/[a-zA-Z]/.test(char)) return `Key${char.toUpperCase()}`;
  return KEY_CODE_TABLE[char] ?? `Key${char.toUpperCase()}`;
}

// ── 直接赋值判定（:846-894）：date/time 等复合输入拒绝逐字符键事件 ──────────

const DIRECT_VALUE_INPUT_TYPES: ReadonlySet<string> = new Set([
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
  "color",
  "range",
]);
const DATEPICKER_CLASS_MARKERS = [
  "datepicker",
  "daterangepicker",
  "datetimepicker",
  "bootstrap-datepicker",
];
const DATEPICKER_DATA_ATTRS = ["data-datepicker", "data-date-format", "data-provide"];

export interface DirectValueEntry {
  tagName?: unknown;
  attributes?: unknown;
}

/**
 * date/time/special 输入必须走原生 setter（逐字符键事件会被拒绝）。输入是
 * selector_map 节点形态（tagName/attributes）。
 */
export function requiresDirectValueAssignment(entry: DirectValueEntry): boolean {
  const tag = String(entry.tagName ?? "").toLowerCase();
  if (tag !== "input") return false;
  const attrs = (isRecord(entry.attributes) ? entry.attributes : {}) as Record<string, unknown>;
  const itype = String(attrs.type ?? "").toLowerCase();
  if (DIRECT_VALUE_INPUT_TYPES.has(itype)) return true;
  if (itype === "" || itype === "text") {
    const cls = String(attrs.class ?? "").toLowerCase();
    if (DATEPICKER_CLASS_MARKERS.some((marker) => cls.includes(marker))) return true;
    if (DATEPICKER_DATA_ATTRS.some((attr) => attrs[attr])) return true;
  }
  return false;
}
