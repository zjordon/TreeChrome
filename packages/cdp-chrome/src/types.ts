// chrome.debugger 注入接口（探针实证的最小签名面）。本包不直接引用全局 chrome——
// Node 单测注入 fake，SW 装配传 adapter（adapter.ts 是唯一接触全局 chrome 的文件）。

/** chrome.debugger.Debuggee 的最小签名面（sessionId 在场即 flat 子会话路由——webbrain 实证） */
export interface Debuggee {
  tabId?: number;
  targetId?: string;
  sessionId?: string;
}

/** chrome.debugger.TargetInfo 的最小投影。探针实证：条目键为 attached,id,tabId,title,type,url——target 标识的字段名是 id（无 targetId 键） */
export interface TargetInfoDto {
  id: string;
  type: string;
  title?: string;
  url?: string;
  attached?: boolean;
  tabId?: number;
}

/**
 * chrome.debugger 的注入接口（MV3 API Promise 形态；Chrome 116+ 原生 Promise 化）。
 * 本包唯一宿主边界——transport 只依赖此形状。
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
