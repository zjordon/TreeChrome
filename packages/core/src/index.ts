// @tw/core 公共导出面（docs/implement-plan/p2/01 §7）。P2 阶段逐步扩面。

export type { GetActionOptions, GetActionResult } from "./llm/client.js";
// resolveChatHttpTimeoutMs 导出仅为测试锚定（无 deadline 时单请求 600s 兜底的决策函数）
export {
  createLLMClient,
  createProvider,
  LLMClient,
  resolveChatHttpTimeoutMs,
} from "./llm/client.js";

export { DEFAULT_MAX_TOKENS, modelSupportsVision, resolveCapabilities } from "./llm/config.js";
export type { LlmDeps } from "./llm/deps.js";
export {
  isInfraError,
  LLMAuthError,
  LLMBlockedError,
  LLMConnectionError,
  LLMError,
  LLMInvalidRequestError,
  LLMProtocolViolationError,
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
} from "./llm/errors.js";
export type {
  LLMProvider,
  LlmProtocol,
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
