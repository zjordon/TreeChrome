// chrome.debugger CDP transport（架构 §2/§4：CdpTransport 双实现的扩展侧；m5/02 细案）。
// 段 A 骨架：只冻结 DebuggerApi 注入接口与根会话标记——transport 本体在段 B 落地
// （探针定案「原生直通/拦截合成」后实现）。本包不直接引用全局 chrome——chrome.debugger
// 的最小签名面收口为注入接口（Node 单测 fake，SW 侧传 chrome.debugger 适配件）。
// 参照 webbrain cdp-client.js 的用法面（设计取用，代码重写）。

export type { CdpEventListener, CdpTransport } from "@tw/core";

/** chrome.debugger.Debuggee 的最小签名面（sessionId 在场即 flat 子会话路由——webbrain 实证） */
export interface Debuggee {
  tabId?: number;
  targetId?: string;
  sessionId?: string;
}

/** chrome.debugger.TargetInfo 的最小投影（targetId↔tabId 映射与 tabs 重映射用） */
export interface TargetInfoDto {
  targetId: string;
  type: string;
  title?: string;
  url?: string;
  attached?: boolean;
  tabId?: number;
}

/**
 * chrome.debugger 的注入接口（MV3 API Promise 形态；Chrome 116+ 原生 Promise 化）。
 * 本包唯一宿主边界——transport 只依赖此形状，测试注入 fake，SW 装配传真实适配件。
 */
export interface DebuggerApi {
  attach(debuggee: Debuggee, version: string): Promise<void>;
  detach(debuggee: Debuggee): Promise<void>;
  sendCommand(debuggee: Debuggee, method: string, params?: object): Promise<unknown>;
  /** 全局单播事件源（transport 内部多播给 CdpTransport.on 订阅者） */
  onEvent: {
    addListener(cb: (source: Debuggee, method: string, params: unknown) => void): void;
    removeListener(cb: (source: Debuggee, method: string, params: unknown) => void): void;
  };
  /** 用户手点横幅「取消」/tab 关闭/策略剥离——transport 转 run 中止信号 */
  onDetach: {
    addListener(cb: (source: Debuggee, reason?: string) => void): void;
    removeListener(cb: (source: Debuggee, reason?: string) => void): void;
  };
  getTargets(): Promise<TargetInfoDto[]>;
}

/**
 * 根会话标记（方案 S——拦截合成的合成 sessionId）：chrome.debugger 的 attach({tabId})
 * 本身即 page target 会话，Debuggee 省略 sessionId 即路由到它；core connectSession 的
 * Target.attachToTarget 握手在 transport 层被拦截并返回本标记，send 侧据此省略
 * sessionId。真机探针（m5/02 §2.2）若判「原生直通」可行，本标记退化为未用路径。
 */
export const ROOT_SESSION_ID = "__tc_root__";

/** sessionId 是否根会话（undefined/null——bindSend 的 sessionId ?? undefined 形态——也算根） */
export function isRootSessionId(sessionId: string | undefined | null): boolean {
  return sessionId === undefined || sessionId === null || sessionId === ROOT_SESSION_ID;
}
