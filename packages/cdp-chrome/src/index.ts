// chrome.debugger CDP transport（架构 §2/§4：CdpTransport 双实现的扩展侧；m5/02 细案）。
// 探针定案（2026-10-08 三轮真机探针，apps/extension/e2e/probe-debugger*.mjs）：
// 协议 Target.getTargets / Target.attachToTarget 经 debugger 会话被拒 "Not allowed"→
// transport 层拦截合成（方案 S）；API getTargets() 可用（targetId 字段名是 id）；
// Target.createTarget 与 Target.setAutoAttach 均原生可用（透传）——autoAttach 产生
// flat 子会话且 Debuggee {tabId, sessionId} 可路由（Worker 实证，评审轮 1 [2] 修正）。
// 本包不直接引用全局 chrome——签名面收口为注入接口（adapter.ts 是唯一例外）。

export type { CdpEventListener, CdpTransport } from "@tw/core";
export { chromeDebuggerApi, chromeTabsApi } from "./adapter.js";
export { isRootSessionId, ROOT_SESSION_ID } from "./root-session.js";
export type { ChromeDebuggerTransportOptions, TabsApi } from "./transport.js";
export { ChromeDebuggerTransport, createChromeDebuggerTransport } from "./transport.js";
export type { Debuggee, DebuggerApi, TargetInfoDto } from "./types.js";
