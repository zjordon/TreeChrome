// @tw/core 公共导出面（docs/implement-plan/p2/01 §7）。P2 阶段逐步扩面；P4 各段继续并入。

export type { ActionEntry, ModelOutput, NormalizeOptions } from "./agent/action-shape.js";
// —— P4.0 类型基座（agent 数据模型 + 动作形态叶子模块，p4/03 §1/§5）——
export {
  actionsOf,
  coerceNamedAction,
  describeActionEntry,
  honestDoneAction,
  isHonestFailureAction,
  isRecord,
  nameOf,
  normalizeActionsList,
  normalizeModelOutput,
  paramsOf,
  typeName,
} from "./agent/action-shape.js";
export {
  ACTIONABILITY_ACTIONS,
  isActionable,
  waitForActionability,
} from "./agent/actionability.js";
export type { AgentOptions } from "./agent/agent.js";
// —— P4.4 agent 层（p4/03 §1 公共 API + 五阶段）——
export { Agent, extractUrl, summarizeStepResult } from "./agent/agent.js";
export {
  formatStepError,
  InterruptedError,
  invalidActionFeedback,
  isConnectionError,
  scanUncertaintyKeywords,
  scanUncertaintyMarkers,
} from "./agent/constants.js";
export type { JudgeLLM, JudgementResult } from "./agent/judge.js";
export { JudgeEvaluator } from "./agent/judge.js";
export {
  ActionLoopDetector,
  computeActionHash,
  FailureStreakTracker,
  ZeroResultStreakTracker,
} from "./agent/loop-detector.js";
export type { CompactorLLM } from "./agent/message-compactor.js";
export { MessageCompactor } from "./agent/message-compactor.js";
export { PlanManager } from "./agent/plan-manager.js";
export type { StateMessageOptions } from "./agent/prompts/system-prompt.js";
export {
  buildStateBlocks,
  buildStateMessage,
  buildSystemPrompt,
} from "./agent/prompts/system-prompt.js";
export type {
  AgentSettings,
  JudgeSettings,
  MessageCompactionSettings,
  SensitiveDataSpec,
} from "./agent/settings.js";
export {
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_JUDGE_SETTINGS,
  DEFAULT_MESSAGE_COMPACTION_SETTINGS,
  resolveAgentSettings,
} from "./agent/settings.js";
export type { MatcherLLM, TaskSkillMatch } from "./agent/skills/task-matcher.js";
export { buildTaskSkillText, matchTaskSkill } from "./agent/skills/task-matcher.js";
export type { HostSkill, SkillSource, TaskCardMeta } from "./agent/skills/types.js";
export { catalogLine, newestDistilledAt, renderTaskCard } from "./agent/skills/types.js";
export { extractHost, extractHostWithPort } from "./agent/url-utils.js";
export type {
  ActionResultInit,
  AgentHistoryInit,
  AgentHistoryListInit,
  DownloadInfo,
  PlanItem,
} from "./agent/views.js";
export {
  ActionResult,
  AgentHistory,
  AgentHistoryList,
  AgentState,
  redactSensitiveString,
  SENSITIVE_ACTION_FIELDS,
  StepMetadata,
} from "./agent/views.js";
// —— P4.2 browser 层（p4/01 §7 导出面）——
export * from "./browser/index.js";
export type { EventBusOptions } from "./events/event-bus.js";
// —— P4.1 观测事件（p4/04 §4）——
export { EventBus } from "./events/event-bus.js";
export type {
  AnomalyEvent,
  ElementBbox,
  EventBase,
  ModelCallEvent,
  ModelResultEvent,
  SessionEndEvent,
  SkillActiveEvent,
  StepEndEvent,
  StepStartEvent,
  ToolCallEvent,
  ToolResultEvent,
  TwEvent,
  TwEventType,
} from "./events/events.js";
export {
  anomalyEvent,
  modelCallEvent,
  modelResultEvent,
  sessionEndEvent,
  skillActiveEvent,
  stepEndEvent,
  stepStartEvent,
  toolCallEvent,
  toolResultEvent,
} from "./events/events.js";
export type { GetActionOptions, GetActionResult } from "./llm/client.js";
// resolveChatHttpTimeoutMs 为内部决策函数不进公共导出面（防签名调整成 breaking
// change）；测试锚定直接从 ./llm/client.js 深层导入（同 config/types 测试惯例）
export { createLLMClient, createProvider, LLMClient } from "./llm/client.js";
export { DEFAULT_MAX_TOKENS, modelSupportsVision, resolveCapabilities } from "./llm/config.js";
export type { LLMDeps } from "./llm/deps.js";
export {
  isInfraError,
  LLMAuthError,
  LLMBlockedError,
  LLMCallTimeoutError,
  LLMConnectionError,
  LLMError,
  LLMInvalidRequestError,
  LLMProtocolViolationError,
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
} from "./llm/errors.js";
export type {
  LLMProtocol,
  LLMProvider,
  ProviderCapabilities,
  ProviderConfig,
} from "./llm/index.js";
export type {
  AssistantMessage,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ContentBlock,
  ImageBlock,
  StopReason,
  TextBlock,
  TokenUsage,
  ToolCall,
  ToolChoice,
  ToolDefinition,
  ToolResultMessage,
  UserMessage,
} from "./llm/types.js";
export { assertValidMessages } from "./llm/types.js";
// —— P4.5 权限门（p4/04 §1.2 五模块）——
export * from "./policy/index.js";
export type { ExtractClientFace, ToolsContext } from "./tools/actions/context.js";
// —— P4.3 tools 层（p4/02 §3 导出面）——
export { Tools } from "./tools/actions/index.js";
export type { MarkdownChunk } from "./tools/extract-markdown.js";
export {
  chunkMarkdownByStructure,
  extractCleanMarkdown,
} from "./tools/extract-markdown.js";
export type { FileSystemProvider } from "./tools/fs.js";
export type {
  ActionDefinition,
  Capability,
  FieldSpec,
  ParamModel,
  ValidateFail,
  ValidateOk,
  ValidateResult,
} from "./tools/models.js";
export {
  ACTION_DEFINITIONS,
  fieldTitle,
  makeStructuredDoneParams,
  paramJsonSchema,
  validateParams,
} from "./tools/models.js";
export { pyJsonDumps } from "./tools/py-json.js";
export type {
  AgentResponseToolSchema,
  GetToolSchemaOptions,
  RegisteredAction,
} from "./tools/registry.js";
export {
  ActionRegistry,
  fnmatchLike,
  hideFieldsFromSchema,
} from "./tools/registry.js";
export type { ToolsOptions, ToolsTruncationSettings } from "./tools/settings.js";
export { DEFAULT_TRUNCATION_SETTINGS } from "./tools/settings.js";
export type { ActionHandler, ToolsBrowser } from "./tools/types.js";
