# 01 · 规范类型与公共 API（契约冻结稿）

> 对应工作项 2.1。本文冻结三适配器共守的类型契约；实现与本文偏差即缺陷。TS 草案代码是**形状规范**（字段名/可选性/判别键），非逐字符最终稿——实现时可调注释与组织，不可改契约。

## 1. 设计原则

1. **中立**：不采用任何一家的协议形状（架构 §3.4）。最接近的妥协点也标注意图（如 toolResult 的 `toolCallId`+`toolName` 双携带是为了 gemini 按 name 匹配，见 §2.3）。
2. **最小**：P2 只做 `getAction` 需要的面。webbrain base.js 的 `chatStream`/`supportsDocuments`/`promptTier`/`contextWindow` 推断等一概不进（流式后置、卡片管理 M5）。
3. **显式**：无隐藏实例状态（Python `self._sensitive_map` 的教训）；一切可变参数走调用参数（AGENTS.md「配置是显式传入的类型化对象」）。
4. **类型严格**：`strict` 全开，`unknown` + 收窄，不写 `any`。JSON Schema 用宽松的 `Record<string, unknown>` 透传（我们不校验 schema，宿主/P4 的 registry 负责）。

## 2. 规范消息格式（`types.ts`）

### 2.1 内容块与消息

```ts
/** 规范内容块。P2 只有文本与图片（截图）；PDF 等块后置 */
export type ContentBlock = TextBlock | ImageBlock;

export interface TextBlock {
  kind: "text";
  text: string;
}

/** 图片块：base64 裸数据（不带 data: 前缀）。截图管线产物即 PNG base64 */
export interface ImageBlock {
  kind: "image";
  mimeType: string; // "image/png"
  base64: string;
}

/**
 * 规范消息。system 不在其中——它是 chat() 的独立参数
 * （Python get_action(system_prompt, messages) 同形；Anthropic/Gemini
 * 也都是独立字段）。三种角色覆盖 agent loop 的全部用法。
 */
export type ChatMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

export interface UserMessage {
  role: "user";
  blocks: ContentBlock[]; // 恒非空（空块消息在入口校验拒绝）
}

export interface AssistantMessage {
  role: "assistant";
  blocks: ContentBlock[]; // 可为空数组（纯工具调用回合）
  /** 模型上一步发起的工具调用；无则为 undefined */
  toolCalls?: ToolCall[];
}

/**
 * 工具结果。同时携带 toolCallId 与 toolName：
 * - openai/anthropic 按 id 关联（tool_call_id / tool_use_id）；
 * - gemini 的 functionResponse 按 name 关联（无 id 匹配语义）。
 * isError 供动作层回灌"拒绝/失败"信号（anthropic 的 is_error 直译；
 * openai/gemini 无对应字段，映射策略见 02 各协议小节）。
 */
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  text: string;
  isError?: boolean;
}
```

入口不变量（`types.ts` 提供 `assertValidMessages()`，getAction/各适配器调用，violation 抛 `LLMProtocolViolationError`）：

- 首条消息必须 `user`（Anthropic 要求；openai/gemini 不介意，统一最严约束简化适配器）；
- `toolResult` 必须紧跟在带 `toolCalls` 的 `assistant` 消息之后，且每个 toolCall 恰有一条结果（顺序可乱，适配器按 id/name 配对）；
- `user.blocks` 非空；`assistant` 的 `blocks` 与 `toolCalls` 不同时为空。

> 交错规则说明：Python 端消息由 step 层以 Anthropic 形状直接组装，无独立校验；TS 把"什么消息序列合法"提前到 canonical 层一次性裁决，三适配器不再各自猜。

### 2.2 工具

```ts
/** 工具定义。parameters 为 JSON Schema 透传（P4 registry 产出） */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 工具调用。args 恒为已解析对象——openai 的 JSON 字符串形态在适配器内消化 */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** 工具选择：auto（模型自决）或 forced（agent_response 强制） */
export type ToolChoice =
  | { kind: "auto" }
  | { kind: "forced"; name: string };
```

## 3. 请求与响应（`types.ts`）

```ts
export interface ChatRequest {
  systemPrompt: string | null;
  messages: ChatMessage[];
  tools: ToolDefinition[] | null;   // null = 不带工具（纯文本调用）
  toolChoice?: ToolChoice;          // 缺省 = auto；tools 为 null 时忽略
  maxTokens?: number;               // 缺省用 ProviderConfig.maxTokens
  temperature?: number;             // 缺省不发（Python 同款；见 03 偏离 8）
  timeoutMs?: number;               // 单次 HTTP 超时（AbortController）
  signal?: AbortSignal;             // 外部取消（step 停止/窗口 deadline）
}

/** 归一化停止原因。观测用（getAction 不分支，仅 warning 日志携带） */
export type StopReason = "tool_call" | "stop" | "length" | "other";

export interface ChatResponse {
  /** 全部文本块拼接（anthropic text / openai content / gemini text part） */
  text: string;
  /** 思考内容（GLM reasoning_content / anthropic thinking / gemini thought part）。
   *  观测用，getAction 不消费——thinking-only 响应自然落入空响应梯子 */
  reasoningText?: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: TokenUsage | null;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
```

## 4. Provider 接口与能力声明（`provider.ts` / `config.ts`）

```ts
export type LlmProtocol = "openai-completions" | "anthropic-messages" | "gemini";

/** 能力声明（架构 §3.4：provider 卡片声明，TreeWalker 视觉白名单的泛化） */
export interface ProviderCapabilities {
  supportsTools: boolean;
  supportsVision: boolean;
  /** false = 端点不支持 forced tool_choice（vLLM 旧版等），走 prompt 约束 + JSON 兜底 */
  supportsForcedTool: boolean;
}

export interface LLMProvider {
  readonly protocol: LlmProtocol;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** 最小连通性检查（webbrain 形状）：chat("Hi", maxTokens=5) 的成败包装 */
  testConnection(): Promise<{ ok: boolean; error?: string; model?: string }>;
}
```

### ProviderConfig（provider 卡片，架构 §3.4 的 TS 形态）

```ts
export interface ProviderConfig {
  name: string;                    // 卡片名（展示/日志用，如 "glm-anthropic"）
  protocol: LlmProtocol;
  baseUrl: string;                 // 无尾斜杠；openai 形态含 /v1 前缀
  apiKey: string;
  model: string;
  /** 缺省 16384——TreeWalker 教训：4096 时 thinking 可写满额度只剩空响应
   *  （config.py:279-283 注释原样保留语义）。anthropic 协议必填 */
  maxTokens: number;
  temperature?: number;
  capabilities?: Partial<ProviderCapabilities>; // 缺省走启发式（见下）
  contextWindow?: number;          // 观测用（P4 消息裁剪消费），本阶段透传
  /** openai 专属：输出上限字段名。缺省 "max_tokens"；
   *  OpenAI 新契约模型（gpt-5/4.1/o 系）须声明 "max_completion_tokens" */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  extraHeaders?: Record<string, string>;  // 宿主注入（代理/网关）
  /** fallback 卡片：完整独立 ProviderConfig（可跨协议），单向切换，至多一档 */
  fallback?: ProviderConfig | null;
}
```

能力缺省启发式（`resolveCapabilities(config)`）：

- `supportsTools` / `supportsForcedTool`：缺省 `true`（主流端点均支持；不支持由卡片显式关闭——声明优于猜测）。
- `supportsVision`：缺省调 `modelSupportsVision(model)`——**移植 TreeWalker 白名单**（`config.py:25-43`：`claude-*` 前缀、`glm-\d+(\.\d+)*v` 家族、`glm-5.3-flash`），卡片声明可覆盖。保留白名单的理由：智谱端点对"文本模型+图"静默致盲不报错（client.py `_strip_image_blocks` 注释的 P0 实测），能力判定不能依赖 API 报错。

## 5. 错误分类（`errors.ts`）

分罪服务的对象：P2 内部（退避谓词 + fallback 触发）与 P4 step 层（Branch 2.5 按类型分罪）。HTTP 状态 → 类型的映射矩阵在 02（各协议响应体形状不同），类层级在此冻结：

```ts
export class LLMError extends Error {
  constructor(message: string, opts: {
    provider: string;        // 卡片 name
    status?: number;         // HTTP 状态（网络层错误无）
    retryAfterMs?: number;   // 可解析的 Retry-After（毫秒，已封顶）
    cause?: unknown;
  }) { /* ... */ }
}

export class LLMConnectionError extends LLMError {}   // fetch 网络层失败（TypeError 等）
export class LLMTimeoutError extends LLMError {}      // AbortController 超时/窗口 deadline
export class LLMRateLimitError extends LLMError {}    // 429
export class LLMAuthError extends LLMError {}         // 401 / 403
export class LLMInvalidRequestError extends LLMError {} // 其余 4xx（含 gemini 400）
export class LLMServerError extends LLMError {}       // 5xx
export class LLMBlockedError extends LLMError {}      // gemini promptFeedback.blockReason / openai content_filter
export class LLMProtocolViolationError extends LLMError {} // canonical 消息不变量被破坏/响应形状不可解析

/** 退避谓词：仅 429 与连接类（对齐 Python is_llm_infra_error——
 *  auth/5xx 不退避，重试无益，维持 fallback-切换-否则-抛）。 */
export function isInfraError(e: unknown): e is LLMRateLimitError | LLMConnectionError;
```

外部取消（`AbortSignal` 触发的 `AbortError`）**不是** `LLMTimeoutError` 就是 `LLMError` 带原始 cause 原样上抛——取消必须穿透不被吞（Python #186 教训），调用方（P4 step 的停止逻辑）靠 signal 自识别，不靠异常类型区分。

## 6. 依赖注入（`deps.ts`）

```ts
export interface LlmDeps {
  /** 缺省全局 fetch。MV3 SW 与 Node 18+ 均原生；测试注入 mock */
  fetch?: typeof fetch;
  /** 单调时钟，缺省 performance.now()——退避预算单测冻结用（Python _mono 同动机） */
  now?: () => number;
  /** 可中止睡眠，缺省 AbortSignal-aware setTimeout 包装 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
```

核心包纪律：不 import `node:*`、不碰 `chrome.*`/`process.*`（biome 已拦 `packages/core/src/**`）。`performance`/`fetch`/`AbortController` 是 Web 标准 + Node 全局，双宿主可用。

## 7. 公共导出面（`src/index.ts`，P2 阶段）

```ts
export { createLLMClient, LLMClient } from "./llm/client.js";
export { LLMError, LLMConnectionError, LLMTimeoutError, LLMRateLimitError,
         LLMAuthError, LLMInvalidRequestError, LLMServerError, LLMBlockedError,
         LLMProtocolViolationError, isInfraError } from "./llm/errors.js";
export { modelSupportsVision, resolveCapabilities } from "./llm/config.js";
export type { ChatMessage, UserMessage, AssistantMessage, ToolResultMessage,
             ContentBlock, TextBlock, ImageBlock, ToolDefinition, ToolCall,
             ToolChoice, ChatRequest, ChatResponse, StopReason, TokenUsage } from "./llm/types.js";
export type { LLMProvider, LlmProtocol, ProviderConfig, ProviderCapabilities } from "./llm/index.js";
export type { LlmDeps } from "./llm/deps.js";
export type { GetActionResult, GetActionOptions } from "./llm/client.js"; // 见 03 §2
```

`createLLMClient(config: ProviderConfig, deps?: LlmDeps): LLMClient`——架构 §3.2 契约的第一个函数。

## 8. 目录结构

```
packages/core/
  package.json            # @tw/core，private，形态对齐 dom-snapshot
  tsconfig.json           # extends ../../tsconfig.base.json
  vitest.config.ts        # 阈值 85%；src/llm/types.ts 等纯类型文件排除覆盖率
  tools/llm-smoke.mjs     # 2.5 真机 smoke（宿主侧，可读 env，不受核心包边界约束）
  src/
    index.ts              # §7 导出面
    llm/
      types.ts            # §2 §3 规范类型 + assertValidMessages
      config.ts           # ProviderConfig + modelSupportsVision + resolveCapabilities
      errors.ts           # §5
      provider.ts         # LLMProvider 接口
      deps.ts             # LlmDeps
      client.ts           # LLMClient（getAction 行为层）+ createLLMClient（03）
      transforms.ts       # URL 缩写/还原、敏感值占位/还原、tryParseJson（03 §3）
      adapters/
        http.ts           # 共享：POST JSON + 状态→错误 + Retry-After + 超时（02 §1）
        openai-completions.ts
        anthropic-messages.ts
        gemini.ts
        schema-sanitize.ts # gemini 专用 OpenAPI 子集清洗（02 §5.3）
  test/
    llm/
      mock-fetch.ts       # MockFetch + 假时钟夹具（04 §2）
      fixtures/           # wire fixtures（04 §3）
      types.test.ts
      anthropic.test.ts
      openai.test.ts
      gemini.test.ts
      client.test.ts      # 行为层（梯子/退避/fallback）
      transforms.test.ts  # Python 锚定值（04 §4）
```

体量预估：单文件最大 `client.ts` ~350 行，适配器各 200~280 行——远低于 1000 行软提醒线。
