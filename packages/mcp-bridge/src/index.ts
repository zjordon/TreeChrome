// @tw/mcp-bridge 公共出口（issue #31 M1）：P0/P1 面——桥服务端（安全门禁 + 私线路由
// + 配对页）、状态机（配对/队列/租约）、cli（serve/connect/status）。MCP tools 面
// 与 watch 循环在 P2 加入。

export {
  defaultPairingPath,
  FsPairingStore,
  newPairingToken,
  resolveBridgePort,
  runBridgeCli,
  serveBridge,
} from "./cli.js";

export { CONNECT_PAGE, CONNECT_PAGE_CSP } from "./connect-page.js";
export {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SERVICE,
  type BridgeServer,
  type BridgeServerOptions,
  DEFAULT_BRIDGE_PORT,
  isExtensionBridgeOrigin,
  listeningPort,
  startBridge,
} from "./server.js";
export {
  type BridgePairingStore,
  BridgeState,
  type BridgeStateDeps,
  BridgeStateError,
  type BridgeStatus,
  clampPollTimeoutMs,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_POLL_TIMEOUT_MS,
  PAIRING_TTL_MS,
  type PairingRecord,
} from "./state.js";
export {
  BRIDGE_TOOLS,
  type BridgeToolDeps,
  createMcpServer,
  toolErrorPayload,
} from "./tools.js";
export {
  buildDriveTools,
  camelOf,
  DRIVE_TOOLS,
  type DriveToolSpec,
  snakeOf,
} from "./verbs.js";
export {
  DEFAULT_WATCH_POLL_INTERVAL_MS,
  type WatchOptions,
  WatchTimeoutError,
  type WatchUpdate,
  watchTask,
} from "./watch.js";
