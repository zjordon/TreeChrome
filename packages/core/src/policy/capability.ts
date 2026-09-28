// 权限门 capability 解析（p4/04 §1.1；架构 §5.1-5.2）：动作+参数 → 门控行为 +
// host 计费。TreeChrome 净新增（Python 侧无 deny 概念），设计取 webbrain
// permission-gate.js（normalizeHost/host 解析同款语义，代码重写）。

import { normalizeKey } from "../browser/keyboard.js";
import { ACTION_DEFINITIONS, type Capability } from "../tools/models.js";

export type { Capability };

/** 过门 capability（READ=只读标记，不进门——resolveCapability 映射为 "none"） */
export type GatedCapability = Exclude<Capability, "READ">;

/** 拒绝文案里的动词（架构 §5.1「用户拒绝在 <host> 上 <动词>」；FS/DOWNLOAD 分立动词） */
export const CAPABILITY_LABEL: Readonly<Record<GatedCapability, string>> = {
  CLICK: "点击",
  TYPE: "输入",
  NAVIGATE: "导航",
  UPLOAD: "上传文件",
  EXECUTE_JS: "执行 JavaScript",
  FS: "写入文件",
  DOWNLOAD: "下载文件",
};

/**
 * 动作 → 门控行为（04 §1.1 决策面；READ/未注册动作/空 capability → "none" 直过）。
 * send_keys 键型分流（04 §1.1）：含 '+' 组合键 / Enter 提交键 → CLICK，纯文本与
 * 其余命名键 → TYPE——判型规则与 browser/keyboard.ts sendKeys 的路由同源
 * （'+' 判组合在前；normalizeKey 后等值 "Enter" 判提交，别名 return 同归）。
 */
export function resolveCapability(
  actionName: string,
  params: Record<string, unknown>,
): GatedCapability | "none" {
  const def = ACTION_DEFINITIONS[actionName];
  if (def === undefined || def.capability.length === 0) return "none";
  if (actionName === "send_keys" && def.capability.length > 1) {
    const keys = typeof params.keys === "string" ? params.keys : "";
    if (keys.includes("+")) return "CLICK";
    if (normalizeKey(keys) === "Enter") return "CLICK";
    return "TYPE";
  }
  const cap = def.capability[0];
  return cap === "READ" ? "none" : cap;
}

/** URL/bare host → 可比 host（webbrain normalizeHost 同款：小写、去 www.、非 IPv6 去端口） */
export function normalizeHost(input: string): string {
  if (typeof input !== "string" || input === "") return "";
  let s = input.trim();
  if (s.startsWith("//")) s = `https:${s}`; // 协议相对 → 可解析 URL
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      return new URL(s).hostname.toLowerCase().replace(/^www\./, "");
    }
  } catch {
    // 落到 bare-host 解析
  }
  let h = s
    .toLowerCase()
    .replace(/^www\./, "")
    .split("/")[0];
  // 去端口（IPv6 方括号形态保留）
  if (!h.startsWith("[")) {
    const c = h.indexOf(":");
    if (c > -1 && c === h.lastIndexOf(":")) h = h.slice(0, c);
  }
  return h;
}

/** 相对/协议相对/绝对 URL 对当前页解析出 host（与浏览器 new URL(raw, base) 同口径） */
function resolveHostAgainst(url: string, base: string): string {
  try {
    const b = typeof base === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(base) ? base : undefined;
    return new URL(url, b).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return normalizeHost(url);
  }
}

/**
 * host 计费（架构 §5.1）：navigate 按目标 URL（相对 URL 对当前页解析）；click/
 * type/send_keys/go_back/switch_tab 等按当前页 host。识别不出返回 ""——调用方
 * fail-closed 拒绝。
 */
export function hostForAction(
  actionName: string,
  params: Record<string, unknown>,
  currentUrl: string,
): string {
  if (actionName === "navigate" && typeof params.url === "string" && params.url !== "") {
    return resolveHostAgainst(params.url, currentUrl);
  }
  return normalizeHost(currentUrl);
}
