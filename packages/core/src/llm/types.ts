// 规范消息/工具/请求/响应类型（协议中立，架构 §3.4）。冻结契约见 docs/implement-plan/p2/01 §2-§3。

import { LLMProtocolViolationError } from "./errors.js";

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
export type ChatMessage = UserMessage | AssistantMessage | ToolResultMessage;

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
  /**
   * gemini thinking 模型（2.5/3 系）functionCall part 携带的 thoughtSignature：
   * 官方要求后续回合随 functionCall part 原样回传，缺失即 400 INVALID_ARGUMENT。
   * 仅 gemini 适配器读写（canonical 层透传不消费）；其余协议恒缺省
   */
  signature?: string;
}

/** 工具选择：auto（模型自决）或 forced（agent_response 强制） */
export type ToolChoice = { kind: "auto" } | { kind: "forced"; name: string };

export interface ChatRequest {
  systemPrompt: string | null;
  messages: ChatMessage[];
  tools: ToolDefinition[] | null; // null = 不带工具（纯文本调用）
  toolChoice?: ToolChoice; // 缺省 = auto；tools 为 null 时忽略
  maxTokens?: number; // 缺省用 ProviderConfig.maxTokens
  temperature?: number; // 缺省不发（Python 同款；见 03 偏离 8）
  timeoutMs?: number; // 单次 HTTP 超时（AbortController）
  signal?: AbortSignal; // 外部取消（step 停止/窗口 deadline）
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

/**
 * canonical 消息序列不变量裁决（01 §2.1）。getAction 与各适配器入口调用；
 * 违例抛 LLMProtocolViolationError——把"什么消息序列合法"提前到 canonical 层
 * 一次性裁决，三适配器不再各自猜（Python 端无独立校验，靠 Anthropic 形状隐式成立）。
 *
 * 不变量：
 * - 首条消息必须 user（Anthropic 要求；统一最严约束简化适配器）；
 * - toolResult 必须紧跟带 toolCalls 的 assistant，且每个 toolCall 恰有一条结果
 *   （顺序可乱，适配器按 id/name 配对）；
 * - user.blocks 非空；assistant 的 blocks 与 toolCalls 不同时为空。
 */
export function assertValidMessages(messages: ChatMessage[], providerName = "canonical"): void {
  const violation = (reason: string): LLMProtocolViolationError =>
    new LLMProtocolViolationError(`消息序列不变量被破坏：${reason}`, { provider: providerName });

  if (messages.length === 0) {
    throw violation("消息为空");
  }
  if (messages[0].role !== "user") {
    throw violation(`首条消息必须 user，实际 ${messages[0].role}`);
  }

  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === "user") {
      if (msg.blocks.length === 0) {
        throw violation("user.blocks 为空");
      }
      i += 1;
      continue;
    }
    if (msg.role === "assistant") {
      const calls = msg.toolCalls ?? [];
      if (msg.blocks.length === 0 && calls.length === 0) {
        throw violation("assistant 的 blocks 与 toolCalls 同时为空");
      }
      if (calls.length > 0) {
        // id→name 映射：配对校验同时要求 toolName 与 toolCall.name 一致——
        // gemini 的 functionResponse 按 name 关联，失配发到端点才 400（canonical 层拦截）
        const callsById = new Map(calls.map((c) => [c.id, c.name]));
        // Map 按 id 去重会让重复 id 的 toolCalls 一条结果即"恰好配对"假性通过，
        // 而适配器折叠同样按 id 建 Map——重复 id 下校验结论与 wire 输出会不一致
        if (callsById.size !== calls.length) {
          throw violation("assistant 的 toolCalls 存在重复 id");
        }
        const seen = new Set<string>();
        let j = i + 1;
        while (j < messages.length) {
          const cur = messages[j];
          if (cur.role !== "toolResult") {
            break;
          }
          const pairedName = callsById.get(cur.toolCallId);
          if (pairedName === undefined) {
            throw violation(
              `孤儿 toolResult（toolCallId=${cur.toolCallId} 不在紧邻 assistant 的 toolCalls 中）`,
            );
          }
          if (pairedName !== cur.toolName) {
            throw violation(
              `toolResult（toolCallId=${cur.toolCallId}）的 toolName=${cur.toolName} 与配对 toolCall 的 name=${pairedName} 不一致`,
            );
          }
          if (seen.has(cur.toolCallId)) {
            throw violation(`toolCall ${cur.toolCallId} 有重复结果`);
          }
          seen.add(cur.toolCallId);
          j += 1;
        }
        if (seen.size !== callsById.size) {
          throw violation(`assistant 的 ${callsById.size} 个 toolCall 仅收到 ${seen.size} 条结果`);
        }
        i = j;
      } else {
        i += 1;
      }
      continue;
    }
    // toolResult 不在带 toolCalls 的 assistant 之后
    throw violation(`孤儿 toolResult（toolCallId=${msg.toolCallId}，位置 ${i}）`);
  }
}
