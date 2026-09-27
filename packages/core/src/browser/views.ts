// browser 层聚合类型：设置面 + TabInfo/BrowserEvent/BrowserStateSummary + storage_state。
// 移植自 TreeWalker browser/views.py @640d52a 与 config.py 的 BrowserSettings/HighlightSettings
// （去 ws_url/cdp_host/cdp_port——连接方式改 transportFactory 注入，p4/01 §6 偏离 1）。
// DOM 公共类型自 @tw/dom-snapshot re-export（迁移期 shim 语义与 Python 侧一致）。

import type { SerializedDOMState } from "@tw/dom-snapshot";

export type {
  DOMCollectionConfig,
  DOMCollectionMetrics,
  DOMRect,
  DOMSelectorMap,
  EnhancedDOMTreeNode,
  SerializedDOMState,
} from "@tw/dom-snapshot";
export {
  DEFAULT_DOM_COLLECTION_CONFIG,
  DOMDegradationLevel,
  EMPTY_DOM_STATE,
} from "@tw/dom-snapshot";

/** 视觉高亮设置（config.py HighlightSettings:289-303 默认值照搬） */
export interface HighlightSettings {
  enabled: boolean;
  interactionEnabled: boolean;
  interactionDuration: number;
  /** {r,g,b,a}；null 时消费方用橙色默认（255,165,0,0.8） */
  interactionColor: { r: number; g: number; b: number; a: number } | null;
  clickFeedbackEnabled: boolean;
  clickFeedbackDuration: number;
  debugMode: boolean;
  debugHighlightColor: string;
}

export const DEFAULT_HIGHLIGHT_SETTINGS: HighlightSettings = {
  enabled: true,
  interactionEnabled: true,
  interactionDuration: 0.5,
  interactionColor: null,
  clickFeedbackEnabled: true,
  clickFeedbackDuration: 0.3,
  debugMode: false,
  debugHighlightColor: "#4a90e2",
};

/** BrowserSession 设置面（config.py BrowserSettings:307-335，去连接三字段） */
export interface BrowserSessionSettings {
  cdpFirstTimeout: number;
  cdpRetryTimeout: number;
  maxIframes: number;
  heavyPageElementThreshold: number;
  circuitBreakerThreshold: number;
  circuitBreakerRecoveryS: number;
  highlight: HighlightSettings;
  pageSettleTimeout: number;
  pageSettlePollInterval: number;
  networkIdleTimeout: number;
  networkIdleStabilityWindow: number;
  networkIdlePollInterval: number;
  waitBetweenActions: number;
  autoHandleJsDialog: boolean;
  /** 0 = 不设防（截图超时护栏关闭，旧行为） */
  screenshotTimeout: number;
}

export const DEFAULT_BROWSER_SESSION_SETTINGS: BrowserSessionSettings = {
  cdpFirstTimeout: 10.0,
  cdpRetryTimeout: 2.0,
  maxIframes: 100,
  heavyPageElementThreshold: 10000,
  circuitBreakerThreshold: 3,
  circuitBreakerRecoveryS: 30.0,
  highlight: { ...DEFAULT_HIGHLIGHT_SETTINGS },
  pageSettleTimeout: 2.0,
  pageSettlePollInterval: 0.1,
  networkIdleTimeout: 5.0,
  networkIdleStabilityWindow: 0.5,
  networkIdlePollInterval: 0.1,
  waitBetweenActions: 0.0,
  autoHandleJsDialog: true,
  screenshotTimeout: 10.0,
};

export interface TabInfo {
  targetId: string;
  url: string;
  title: string;
}

/**
 * 最近浏览器事件（首期仅 dialog）。download 不入此列表——由
 * consumeCompletedDownloads → [Downloads] 段覆盖（Python 同款取舍）。
 */
export interface BrowserEvent {
  type: "navigation" | "dialog" | "download" | "network_error" | "console_error";
  message: string;
  timestamp: number;
}

/** get_state 的产物（Python BrowserStateSummary，views.py:130-142） */
export interface BrowserStateSummary {
  url: string;
  title: string;
  tabs: TabInfo[];
  domState: SerializedDOMState | null;
  /** base64 解码后的截图字节（Python bytes；takeScreenshot 失败时 null） */
  screenshot: Uint8Array | null;
  /** UI 网格元信息；非网格页 null */
  gridMeta: Record<string, unknown> | null;
  recentEvents: BrowserEvent[];
}

/** Playwright storage_state 的 cookie 条目（injectStorageState 的入参形态） */
export interface CookieSpec {
  name: unknown;
  value: unknown;
  url?: unknown;
  domain?: unknown;
  path?: unknown;
  expires?: unknown;
  httpOnly?: unknown;
  secure?: unknown;
  sameSite?: unknown;
}

export interface StorageState {
  cookies?: unknown;
  origins?: unknown;
}
