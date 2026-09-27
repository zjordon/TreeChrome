// 键盘发送：组合键/命名特殊键/纯文本三路由。移植自 TreeWalker session.py:3431-3538
// 与键别名表 :720-782 @640d52a。Enter 后 0.1s 等导航（勿优化）。

import { getCharModifiersAndVk, getKeyCodeForChar, typeChar } from "./text-input.js";
import type { SessionInternals } from "./transport.js";

/** 特殊键 VK 码 */
const KEY_VK_MAP: Record<string, number> = {
  enter: 13,
  tab: 9,
  escape: 27,
  backspace: 8,
  delete: 46,
  arrowup: 38,
  arrowdown: 40,
  arrowleft: 37,
  arrowright: 39,
  pageup: 33,
  pagedown: 34,
  home: 36,
  end: 35,
};
for (let i = 1; i <= 12; i++) KEY_VK_MAP[`f${i}`] = 0x70 + (i - 1);

/** 需要 char 事件的键（React 表单提交要 Enter 的 \r） */
const KEY_CHAR_TEXT: Record<string, string> = {
  enter: "\r",
  tab: "\t",
};

/** 别名 → 规范 DOM key 名（大小写不敏感，.lower() 查表） */
const KEY_ALIASES: Record<string, string> = {
  ctrl: "Control",
  control: "Control",
  alt: "Alt",
  option: "Alt",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  shift: "Shift",
  enter: "Enter",
  return: "Enter",
  esc: "Escape",
  escape: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  tab: "Tab",
  space: " ",
  up: "ArrowUp",
  arrowup: "ArrowUp",
  down: "ArrowDown",
  arrowdown: "ArrowDown",
  left: "ArrowLeft",
  arrowleft: "ArrowLeft",
  right: "ArrowRight",
  arrowright: "ArrowRight",
  pageup: "PageUp",
  pgup: "PageUp",
  pagedown: "PageDown",
  pgdn: "PageDown",
  home: "Home",
  end: "End",
};
for (let i = 1; i <= 12; i++) KEY_ALIASES[`f${i}`] = `F${i}`;

/** 离散 keyDown/char/keyUp 的键集合（其余按纯文本逐字符） */
const SPECIAL_KEYS: ReadonlySet<string> = new Set([
  "Enter",
  "Tab",
  "Delete",
  "Backspace",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Control",
  "Alt",
  "Meta",
  "Shift",
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);

/** Input.dispatchKeyEvent.modifiers 位掩码：Alt=1, Control=2, Meta=4, Shift=8 */
const MODIFIER_VK: Record<string, number> = {
  alt: 1,
  control: 2,
  meta: 4,
  shift: 8,
};

/** 多字符特殊键的 DOM code（单字符走 getKeyCodeForChar） */
const KEY_CODE_FOR_SPECIAL: Record<string, string> = {
  enter: "Enter",
  tab: "Tab",
  escape: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  control: "ControlLeft",
  alt: "AltLeft",
  shift: "ShiftLeft",
  meta: "MetaLeft",
};
for (let i = 1; i <= 12; i++) KEY_CODE_FOR_SPECIAL[`f${i}`] = `F${i}`;

export function normalizeKey(raw: string): string {
  return KEY_ALIASES[raw.toLowerCase()] ?? raw;
}

/**
 * 发送按键（:3431-3456）：含 '+' → 组合键；命名特殊键 → keyDown/char/keyUp；
 * 否则纯文本逐字符（复用 typeChar 的 CJK insertText 路径）。
 */
export async function sendKeys(s: SessionInternals, keys: string): Promise<void> {
  if (keys.includes("+")) {
    await sendCombination(s, keys);
    return;
  }
  const normalized = normalizeKey(keys);
  if (SPECIAL_KEYS.has(normalized)) {
    await sendSingleSpecialKey(s, normalized);
    return;
  }
  // 别名可能映射到可打印字符（'space' → ' '），按规范化后的字符串逐字符
  for (const ch of normalized) {
    await typeChar(s, ch);
    await s.sleep(5);
  }
}

/** 组合键（:3458-3478）：修饰位掩码 + 主键；未知修饰软降级（warn + 跳过） */
async function sendCombination(s: SessionInternals, keys: string): Promise<void> {
  const parts = keys.split("+").map((p) => p.trim());
  let modifiers = 0;
  for (const part of parts.slice(0, -1)) {
    const norm = normalizeKey(part);
    const vk = MODIFIER_VK[norm.toLowerCase()];
    if (vk === undefined) {
      s.log(`send_keys: ignoring unknown modifier '${part}' in '${keys}'`);
      continue;
    }
    modifiers |= vk;
  }
  const main = normalizeKey(parts[parts.length - 1]);
  if (main.length === 1 && !SPECIAL_KEYS.has(main)) {
    // 单字符主键必须走携带 modifiers 的键事件路径，否则 Ctrl+A 全选会被丢弃
    await sendComboCharKey(s, main, modifiers);
  } else {
    await sendSingleSpecialKey(s, main, modifiers);
  }
}

/** 带修饰的单字符主键（:3480-3506）：键位/掩码与逐字符路径同源 */
async function sendComboCharKey(
  s: SessionInternals,
  char: string,
  modifiers: number,
): Promise<void> {
  const [charMod, charVk, base] = getCharModifiersAndVk(char);
  const code = getKeyCodeForChar(base);
  const totalMod = modifiers | charMod;
  await s.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: base,
    code,
    modifiers: totalMod,
    windowsVirtualKeyCode: charVk,
  });
  await s.send("Input.dispatchKeyEvent", { type: "char", text: char, key: char });
  await s.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: base,
    code,
    modifiers: totalMod,
    windowsVirtualKeyCode: charVk,
  });
}

/** 命名特殊键（:3508-3538）：keyDown →（Enter/Tab 补 char）→ keyUp；Enter 后 0.1s */
async function sendSingleSpecialKey(
  s: SessionInternals,
  key: string,
  modifiers = 0,
): Promise<void> {
  const keyLower = key.toLowerCase();
  const code = KEY_CODE_FOR_SPECIAL[keyLower] ?? key;
  const vk = KEY_VK_MAP[keyLower] ?? 0;
  await s.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: vk,
  });
  const charText = KEY_CHAR_TEXT[keyLower];
  if (charText !== undefined) {
    await s.send("Input.dispatchKeyEvent", { type: "char", text: charText, key });
  }
  await s.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: vk,
  });
  if (keyLower === "enter") {
    await s.sleep(100); // 等 Enter 触发的导航 settle
  }
}
