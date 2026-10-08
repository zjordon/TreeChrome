// 根会话标记（方案 S，探针定案 2026-10-08：协议 Target.attachToTarget 经
// chrome.debugger 被拒 "Not allowed"——真 targetId 亦然）：chrome.debugger 的
// attach({tabId}) 本身即 page target 会话，Debuggee 省略 sessionId 即路由到它；
// core connectSession/switchTab 的 attachToTarget 握手被 transport 拦截并返回本
// 标记，send 侧据此省略 sessionId。

export type { CdpEventListener, CdpTransport } from "@tw/core";

export const ROOT_SESSION_ID = "__tc_root__";

/** sessionId 是否根会话（undefined/null——bindSend 的 sessionId ?? undefined 形态——也算根） */
export function isRootSessionId(sessionId: string | undefined | null): boolean {
  return sessionId === undefined || sessionId === null || sessionId === ROOT_SESSION_ID;
}
