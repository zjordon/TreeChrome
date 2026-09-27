/**
 * @tw/cdp-ws 公共入口（docs/implement-plan/p3/01 §7 导出面）。
 *
 * transport（CdpWsClient / discoverWebSocketUrl / 错误家族）实现 CdpLikeClient
 * （@tw/dom-snapshot protocol.ts）与架构 §4 CdpTransport 的 ws 形态——零 workspace
 * 运行时依赖，契约由 test/contract.test.ts 的类型断言锁定。
 * 会话原语（CdpPageSession：attach/navigate/tabs/cookie）见 02 文档。
 */
export type { DiscoveryDeps } from "./discovery.js";
export { discoverWebSocketUrl } from "./discovery.js";
export {
  CdpCommandError,
  CdpConnectionClosedError,
  CdpError,
  CdpNavigationError,
  CdpTimeoutError,
  describeError,
} from "./errors.js";
export type { AttachedSession, CdpPageSessionOptions } from "./session-primitives.js";
export { CdpPageSession } from "./session-primitives.js";
export type { CdpClosedListener, CdpEventListener } from "./transport.js";
export { CdpWsClient } from "./transport.js";
export type { CdpCloseEvent, CdpWsOptions, SocketLike, TabInfo } from "./types.js";
