// chrome.debugger CDP transport（架构 §2/§4：CdpTransport 双实现的扩展侧；m5/02 细案）。
// 探针定案（2026-10-08 两轮真机探针，apps/extension/e2e/probe-debugger*.mjs）：
// 协议 Target.getTargets / Target.attachToTarget 经 debugger 会话被拒 "Not allowed"→
// transport 层拦截合成（方案 S）；API getTargets() 可用（targetId 字段名是 id）；
// Target.createTarget 原生可用（透传）；setAutoAttach 拦截为 no-op（子会话结构性不可达）。
// 本包不直接引用全局 chrome——签名面收口为注入接口（adapter.ts 是唯一例外）。

export type { CdpEventListener, CdpTransport } from "@tw/core";
export { chromeDebuggerApi, chromeTabsApi } from "./adapter.js";
export { isRootSessionId, ROOT_SESSION_ID } from "./root-session.js";
export type { ChromeDebuggerTransportOptions, TabsApi } from "./transport.js";
export { ChromeDebuggerTransport, createChromeDebuggerTransport } from "./transport.js";
export type { Debuggee, DebuggerApi, TargetInfoDto } from "./types.js";
