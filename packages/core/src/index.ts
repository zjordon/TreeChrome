// @tw/core 公共导出面（docs/implement-plan/p2/01 §7）。P2 阶段逐步扩面。

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
