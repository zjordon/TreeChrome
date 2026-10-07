// @tw/node-host 公共导出面：Node 宿主共享件（NodeFs / env→配置 / 控制台观测 / Agent 装配）。
// 散脚本经包根 boot.mjs 打包消费（boot-entry.ts 把本面与 @tw/core/@tw/cdp-ws 合并导出）。

export {
  type AssembleAgentOptions,
  type AssembledAgent,
  assembleAgent,
  autoAllowSummaryLine,
  buildProviderCard,
  finalizeAssembled,
  type RunAgentOptions,
  runAgent,
  type TransportFactory,
} from "./agent-boot.js";
export { type AttachConsoleOptions, attachConsole, clip, describeEvent } from "./console.js";
export { NodeFs } from "./node-fs.js";
export {
  applyDotEnv,
  checkReady,
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  type HostSettings,
  type HostSettingsOverrides,
  type LoadSettingsOptions,
  loadHostSettings,
  mergeHostSettings,
  type ReadyCheck,
  type ResolveWsUrlDeps,
  resolveWsUrl,
} from "./settings.js";
