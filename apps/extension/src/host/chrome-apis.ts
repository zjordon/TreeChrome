// chrome API 注入面（m5/04 §1）：host/ 各件的 chrome.* 依赖在此收口为窄接口 +
// 真绑定（globalThis.chrome 结构化收窄——cdp-chrome/adapter.ts 同款）；单测注入
// fake 即可全覆盖，runtime/ 层零 chrome 依赖。本目录（src/host/）与 entrypoints/
// 是扩展内合法使用 chrome.* 的区域。

/** chrome.storage.local 同形（settings/grant/journal 落盘共用） */
export interface StorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** chrome.alarms 同形（keepalive） */
export interface AlarmsApi {
  create(name: string, info: { periodInMinutes: number }): void;
  clear(name: string): Promise<boolean>;
}

/** chrome.runtime.Port 同形（port-server 广播与双向消息） */
export interface RuntimePort {
  postMessage(message: unknown): void;
  onMessage: {
    addListener(callback: (message: unknown) => void): void;
    removeListener(callback: (message: unknown) => void): void;
  };
  onDisconnect: {
    addListener(callback: (port: RuntimePort) => void): void;
    removeListener(callback: (port: RuntimePort) => void): void;
  };
}

/** chrome.runtime.onConnect 同形 */
export interface OnConnectApi {
  addListener(callback: (port: RuntimePort) => void): void;
}

/** chrome.tabs.onRemoved 同形（run 绑定 tab 被关 → abort） */
export interface TabsOnRemovedApi {
  addListener(callback: (tabId: number) => void): void;
  removeListener(callback: (tabId: number) => void): void;
}

/** chrome.tabs.query 同形（start 绑定活动 tab） */
export interface TabsQueryApi {
  query(info: {
    active: boolean;
    currentWindow?: boolean;
    lastFocusedWindow?: boolean;
  }): Promise<Array<{ id: number | undefined }>>;
}

/** chrome.runtime.onInstalled/onMessage 同形（message-router 消费） */
export interface RuntimeEventApi {
  addListener(callback: (...args: never[]) => void): void;
}

interface ChromeLike {
  storage?: { local?: StorageArea };
  alarms?: AlarmsApi;
  runtime?: {
    onConnect?: OnConnectApi;
    onInstalled?: RuntimeEventApi;
    onMessage?: unknown;
  };
  // query 是方法（receiver 敏感——绑定须返回原生对象）；onRemoved 是事件对象
  tabs?: { onRemoved?: TabsOnRemovedApi } & TabsQueryApi;
}

function chromeLike(): ChromeLike | null {
  const g = globalThis as { chrome?: unknown };
  return typeof g.chrome === "object" && g.chrome !== null ? (g.chrome as ChromeLike) : null;
}

/** 真绑定访问器（缺失时抛——调用方在扩展上下文内必有；测试不触真绑定） */
export function chromeStorageLocal(): StorageArea {
  const area = chromeLike()?.storage?.local;
  if (area === undefined) throw new Error("chrome.storage.local unavailable");
  return area;
}

export function chromeAlarms(): AlarmsApi {
  const api = chromeLike()?.alarms;
  if (api === undefined) throw new Error("chrome.alarms unavailable");
  return api;
}

export function chromeOnConnect(): OnConnectApi {
  const api = chromeLike()?.runtime?.onConnect;
  if (api === undefined) throw new Error("chrome.runtime.onConnect unavailable");
  return api;
}

export function chromeTabsOnRemoved(): TabsOnRemovedApi {
  const api = chromeLike()?.tabs?.onRemoved;
  if (api === undefined) throw new Error("chrome.tabs.onRemoved unavailable");
  return api;
}

export function chromeTabsQuery(): TabsQueryApi {
  const api = chromeLike()?.tabs;
  if (api === undefined) throw new Error("chrome.tabs.query unavailable");
  // 返回原生 chrome.tabs 对象（不解构方法——Chrome API 有 receiver 检查，
  // 裸方法换 this 调用抛 Illegal invocation）
  return api as TabsQueryApi;
}

export function chromeOnInstalled(): RuntimeEventApi {
  const api = chromeLike()?.runtime?.onInstalled;
  if (api === undefined) throw new Error("chrome.runtime.onInstalled unavailable");
  return api;
}
