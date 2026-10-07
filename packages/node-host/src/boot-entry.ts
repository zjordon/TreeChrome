// 散脚本打包入口（boot.mjs 消费）：本包 kit + @tw/core/@tw/cdp-ws 的 example 常用导出面
// 合并导出。core 与 cdp-ws 用显式名单（双 `export *` 有 CdpEventListener 等重名歧义）；
// 名单随 example 需要扩面。

export { CdpWsClient, discoverWebSocketUrl } from "@tw/cdp-ws";
export {
  ActionResult,
  Agent,
  type AgentHistoryList,
  AutoAllowPolicy,
  BrowserSession,
  DEFAULT_MAX_TOKENS,
  EventBus,
  LLMClient,
  matchTaskSkill,
  modelSupportsVision,
  PolicyGate,
  Tools,
} from "@tw/core";
export * from "./index.js";
