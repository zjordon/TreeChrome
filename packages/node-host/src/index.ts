// @tw/node-host 公共导出面：Node 宿主共享件（NodeFs / env→配置 / 控制台观测 / Agent 装配）。
// 散脚本经包根 boot.mjs 打包消费（boot-entry.ts 把本面与 @tw/core/@tw/cdp-ws 合并导出）。

export {
  type AssembleAgentOptions,
  type AssembledAgent,
  assembleAgent,
  autoAllowSummaryLine,
  buildProviderCard,
  buildTaskSkillCard,
  finalizeAssembled,
  type RunAgentOptions,
  runAgent,
  type TransportFactory,
} from "./agent-boot.js";
export {
  type AutoChromeDeps,
  chromePathCandidates,
  type LaunchedChrome,
  launchAutoChrome,
  resolveChromeBinary,
} from "./auto-chrome.js";
export {
  type CliArgs,
  exitCodeOf,
  type MainDeps,
  main,
  type ParseResult,
  parseCliArgs,
  projectRunJson,
  type RunJson,
  renderHumanResult,
  resolveTaskText,
  type TaskTextInputs,
  type TaskTextResolution,
  USAGE,
} from "./cli.js";
export { type AttachConsoleOptions, attachConsole, clip, describeEvent } from "./console.js";
export {
  type ClientDeps,
  ensureDaemonRunning,
  type FetchLike,
  probeHealth,
  requestDaemon,
  stopDaemon,
} from "./daemon/client.js";
export {
  type DoctorDeps,
  type DoctorFinding,
  type DoctorResult,
  diagnoseDaemon,
  parseDaemonInfo,
} from "./daemon/doctor.js";
export {
  buildParams,
  DAEMON_VERBS,
  type DaemonEnvelope,
  type DaemonInfo,
  DEFAULT_DAEMON_PORT,
  DEFAULT_IDLE_SECS,
  daemonErr,
  daemonOk,
  daemonPort,
  findVerb,
  idleSecs,
  type VerbFlag,
  type VerbSpec,
} from "./daemon/protocol.js";
export {
  PortInUseError,
  type RunningDaemon,
  type ServerOptions,
  startDaemonServer,
} from "./daemon/server.js";
export {
  type ActionResultOut,
  createDaemonSession,
  type DaemonSession,
  type SessionDeps,
  SessionError,
  type StateOut,
  type TabsOut,
} from "./daemon/session-holder.js";
export {
  bumpDistillStreak,
  type DistillAfterRunOptions,
  type DistillRunOptions,
  distillAfterRun,
  dominantHostOf,
  passesDistillGate,
  writeTaskCard,
} from "./distill-run.js";
export { NodeFs } from "./node-fs.js";
export {
  type ApplyDotEnvOptions,
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
  resolveEnvChain,
  resolveWsUrl,
} from "./settings.js";
export { SKILL_CARD } from "./skill-card.js";
export { FsSkillSource, type FsTaskCardMeta } from "./skill-source.js";
