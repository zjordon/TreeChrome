// chrome API 注入面（m5/04 §1）：host/ 各件的 chrome.* 依赖在此收口为窄接口 +
// 真绑定（globalThis.chrome 结构化收窄——cdp-chrome/adapter.ts 同款）；单测注入
// fake 即可全覆盖，runtime/ 层零 chrome 依赖。本目录（src/host/）与 entrypoints/
// 是扩展内合法使用 chrome.* 的区域。

/** chrome.storage.local 同形（settings/grant/journal 落盘共用）。remove 标注可选
 *  （既有 fake 兼容）；需要删除面的消费方（issue #35 会话 LRU/删除）用 WithRemove 形 */
export interface StorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove?(keys: string | string[]): Promise<void>;
}

/** 带删除面的 storage（chrome.storage.local 原生恒有 remove——chromeStorageLocal
 *  真绑定即此形；SessionRepository 等消费方以此收窄） */
export type StorageAreaWithRemove = StorageArea & {
  remove(keys: string | string[]): Promise<void>;
};

/** chrome.alarms 同形（keepalive） */
export interface AlarmsApi {
  create(name: string, info: { periodInMinutes: number }): void;
  clear(name: string): Promise<boolean>;
  /** issue #5 S4：蒸馏兜底唤醒（tc_distill 周期 alarm 触发 drain）；issue #31：bridge 兜底 */
  onAlarm?: {
    addListener(callback: (alarm: { name: string }) => void): void;
    removeListener?(callback: (alarm: { name: string }) => void): void;
  };
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

/** chrome.tabs.query 同形（start 绑定活动 tab；url 需 "tabs" 权限——manifest 已声明） */
export interface TabsQueryApi {
  query(info: {
    /** 过滤器语义：true/false 都只匹配对应子集，省略才匹配全部——扫描别乱传 */
    active?: boolean;
    currentWindow?: boolean;
    lastFocusedWindow?: boolean;
    /** issue #31：SW 冷启动后扫描仍开着的配对页（URL 前缀匹配） */
    url?: string | string[];
  }): Promise<Array<{ id: number | undefined; url?: string }>>;
}

/** chrome.storage.onChanged 同形（issue #31：bridge 配置热更新） */
export interface StorageOnChangedApi {
  addListener(
    callback: (
      changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
      areaName: string,
    ) => void,
  ): void;
  removeListener(
    callback: (
      changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
      areaName: string,
    ) => void,
  ): void;
}

/** chrome.tabs.onUpdated 同形（issue #31：捕获用户打开的配对 URL——t 只经 URL 传递） */
export interface TabsOnUpdatedApi {
  addListener(callback: (tabId: number, changeInfo: { url?: string }) => void): void;
  removeListener(callback: (tabId: number, changeInfo: { url?: string }) => void): void;
}

/** chrome.runtime.onInstalled/onMessage 同形（message-router 消费） */
export interface RuntimeEventApi {
  addListener(callback: (...args: never[]) => void): void;
}

interface ChromeLike {
  storage?: { local?: StorageArea; onChanged?: StorageOnChangedApi };
  alarms?: AlarmsApi;
  runtime?: {
    onConnect?: OnConnectApi;
    onInstalled?: RuntimeEventApi;
    onMessage?: unknown;
    id?: string;
  };
  // query 是方法（receiver 敏感——绑定须返回原生对象）；onRemoved/onUpdated 是事件对象
  tabs?: { onRemoved?: TabsOnRemovedApi; onUpdated?: TabsOnUpdatedApi } & TabsQueryApi;
}

function chromeLike(): ChromeLike | null {
  const g = globalThis as { chrome?: unknown };
  return typeof g.chrome === "object" && g.chrome !== null ? (g.chrome as ChromeLike) : null;
}

/** 真绑定访问器（缺失时抛——调用方在扩展上下文内必有；测试不触真绑定）。
 *  返回带 remove 面（chrome.storage.local 原生恒有——issue #35 会话层依赖） */
export function chromeStorageLocal(): StorageAreaWithRemove {
  const area = chromeLike()?.storage?.local;
  if (area === undefined) throw new Error("chrome.storage.local unavailable");
  if (typeof area.remove !== "function") throw new Error("chrome.storage.local.remove unavailable");
  return area as StorageAreaWithRemove;
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

/** 扩展自身 ID（bridge 配对身份上报；扩展上下文内必有） */
export function chromeRuntimeId(): string {
  const id = chromeLike()?.runtime?.id;
  if (typeof id !== "string" || id === "") throw new Error("chrome.runtime.id unavailable");
  return id;
}

export function chromeStorageOnChanged(): StorageOnChangedApi {
  const api = chromeLike()?.storage?.onChanged;
  if (api === undefined) throw new Error("chrome.storage.onChanged unavailable");
  return api;
}

export function chromeTabsOnUpdated(): TabsOnUpdatedApi {
  const api = chromeLike()?.tabs?.onUpdated;
  if (api === undefined) throw new Error("chrome.tabs.onUpdated unavailable");
  return api;
}
