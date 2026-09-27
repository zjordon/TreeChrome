// @tw/core browser 层公共入口（p4/01 §7 导出面）。Batch2 槽位（search-find/
// dropdown/upload/grid-read/evaluate-enhanced）P4b 落地时并入。

export { CircuitBreaker } from "./circuit-breaker.js";
export { bestQuadRect } from "./element-pointer.js";
export {
  closeOpenDelims,
  delimiterScan,
  formatEvalException,
  normalizeEvalResult,
  syntaxRepairCandidates,
  validateAndFixJavascript,
} from "./evaluate-basic.js";
export { HighlightManager } from "./highlight.js";
export { documentBodyToHtml, nodeToHtml } from "./html-source.js";
export type { PageSettleResult, ScrollResult } from "./navigation.js";
export { NetworkIdleTracker } from "./network-idle.js";
export type { BrowserSessionOptions, GetStateOptions } from "./session.js";
export { BrowserSession } from "./session.js";
export { requiresDirectValueAssignment } from "./text-input.js";
export type {
  BoundSend,
  CdpEventListener,
  CdpTransport,
  DownloadRecord,
  FileChooserRecord,
  SessionInternals,
} from "./transport.js";
export { bindSend } from "./transport.js";
export type {
  BrowserEvent,
  BrowserSessionSettings,
  BrowserStateSummary,
  CookieSpec,
  HighlightSettings,
  StorageState,
  TabInfo,
} from "./views.js";
export { DEFAULT_BROWSER_SESSION_SETTINGS, DEFAULT_HIGHLIGHT_SETTINGS } from "./views.js";
