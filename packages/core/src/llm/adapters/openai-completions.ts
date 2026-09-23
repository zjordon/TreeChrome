// openai-completions 协议适配器（02 §3）。覆盖 OpenAI 官方与 GLM/DeepSeek/Kimi/Qwen/Groq/
// OpenRouter/vLLM/Ollama 等兼容端点。兼容地雷：输出上限字段双轨（新契约模型拒
// max_tokens）、新契约 temperature 400（TS 侧缺省不发）、tool_calls arguments 是
// JSON 字符串且可能被 length 截断（guard-parse 失败丢弃，不带病 args 进 canonical）。

import { type ProviderConfig, resolveCapabilities } from "../config.js";
import type { LlmDeps } from "../deps.js";
import { LLMProtocolViolationError } from "../errors.js";
import type { LLMProvider } from "../provider.js";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ContentBlock,
  StopReason,
  TokenUsage,
  ToolCall,
} from "../types.js";
import { assertValidMessages } from "../types.js";
import { defaultTestConnection, isRecord, stripTrailingSlash, temperatureEntry } from "./common.js";
import { postJson } from "./http.js";

/**
 * OpenAI 新契约模型前缀（gpt-5 / gpt-4.1 / o1 / o3 / o4 系，借 webbrain
 * _isNewOpenAIContract）：拒收 max_tokens 要 max_completion_tokens，且只接受默认
 * temperature。本地/网关端点（lmstudio 等）即使模型名相似也多用旧契约——由卡片
 * maxTokensField 显式声明覆盖。
 *
 * 维护提示：前缀清单随 OpenAI 新模型发布**必然漂移**（gpt-6/o5 等不在此列的新
 * 契约模型会被误判走 max_tokens → 端点 400，纠正手段是卡片 maxTokensField）；
 * `o1|o3|o4` 也会误匹配同前缀的自定义模型名（如 o1-finetune）。新增模型时同步
 * 此正则。
 */
const NEW_CONTRACT_PREFIX = /^(gpt-5|gpt-4\.1|o1|o3|o4)/;

/** 纯文本 user → content 字符串（最大化兼容）；含图 → 数组形态（data-URL image_url） */
function userContent(blocks: ContentBlock[]): string | Array<Record<string, unknown>> {
  if (!blocks.some((b) => b.kind === "image")) {
    return blocks.map((b) => (b.kind === "text" ? b.text : "")).join("");
  }
  return blocks.map((b) =>
    b.kind === "text"
      ? { type: "text", text: b.text }
      : {
          type: "image_url",
          image_url: { url: `data:${b.mimeType};base64,${b.base64}` },
        },
  );
}

/** canonical → wire 消息。toolResult 每条独立 tool 消息（与 anthropic 相反，不合并） */
function toWireMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      out.push({ role: "user", content: userContent(msg.blocks) });
      continue;
    }
    if (msg.role === "assistant") {
      const text = msg.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("");
      const wire: Record<string, unknown> = {
        role: "assistant",
        content: msg.blocks.length === 0 ? null : text, // 纯工具调用回合 content 置 null（官方形态）
      };
      if (msg.toolCalls !== undefined && msg.toolCalls.length > 0) {
        wire.tool_calls = msg.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) }, // args 字符串化是 openai 独有
        }));
      }
      out.push(wire);
      continue;
    }
    out.push({
      role: "tool",
      tool_call_id: msg.toolCallId,
      // isError 无原生字段：true 时 [error] 前缀约定（写死在适配器，02 §3.2 映射表）
      content: msg.isError ? `[error] ${msg.text}` : msg.text,
    });
  }
  return out;
}

function mapFinishReason(raw: unknown, hasKeptToolCall: boolean): StopReason {
  if (hasKeptToolCall) {
    return "tool_call"; // 从保留的调用推导（与 anthropic/gemini 口径一致）
  }
  if (raw === "tool_calls") {
    return "other"; // 调用全部被丢弃：不置 tool_call，避免 toolCalls 空却报 tool_call 误导排障
  }
  if (raw === "stop") {
    return "stop";
  }
  if (raw === "length") {
    return "length";
  }
  // content_filter：choices 通常仍有文本，按 other 正常返回让梯子处理——
  // LLMBlockedError 只用于 gemini promptFeedback 全局拦截形态（02 §3.3）
  return "other";
}

function mapUsage(raw: unknown): TokenUsage | null {
  if (!isRecord(raw)) {
    return null;
  }
  const details = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {};
  return {
    inputTokens: typeof raw.prompt_tokens === "number" ? raw.prompt_tokens : 0,
    outputTokens: typeof raw.completion_tokens === "number" ? raw.completion_tokens : 0,
    ...(typeof details.cached_tokens === "number"
      ? { cacheReadTokens: details.cached_tokens }
      : {}),
  };
}

/** arguments guard-parse：字符串失败/非对象 → undefined（调用方丢弃该 toolCall 并 warn） */
function parseArguments(raw: unknown): Record<string, unknown> | undefined {
  if (isRecord(raw)) {
    return raw; // 个别端点返回对象形态——直收
  }
  // 缺失/null/空串兜底 {}：兼容端点（vLLM/Ollama/自建网关等）对无参工具的合法
  // 形态——null 与缺失语义相同；与 anthropic input / gemini args 的口径对齐；
  // 仅「有内容但解析失败/非对象」才丢弃
  if (raw === undefined || raw === null || raw === "") {
    return {};
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseResponse(
  json: unknown,
  requestedNames: ReadonlySet<string>,
  log: (message: string) => void,
  providerName: string,
): ChatResponse {
  if (!isRecord(json)) {
    throw new LLMProtocolViolationError(
      `openai 响应不是对象：${JSON.stringify(json).slice(0, 200)}`,
      {
        provider: providerName,
      },
    );
  }
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const first = choices.length > 0 ? choices[0] : undefined;
  const message = isRecord(first) && isRecord(first.message) ? first.message : {};
  const text = typeof message.content === "string" ? message.content : "";
  const rawReasoning = message.reasoning_content ?? message.reasoning; // GLM/DeepSeek 思考字段
  const reasoningText = typeof rawReasoning === "string" ? rawReasoning : "";

  const toolCalls: ToolCall[] = [];
  if (Array.isArray(message.tool_calls)) {
    for (const item of message.tool_calls) {
      if (!isRecord(item) || !isRecord(item.function)) {
        continue;
      }
      const fn = item.function;
      if (typeof fn.name !== "string" || !requestedNames.has(fn.name)) {
        continue; // 忽略非请求工具名的调用（02 §2.3 泛化规则）
      }
      const args = parseArguments(fn.arguments);
      if (args === undefined) {
        log(`[llm] openai tool_call arguments 解析失败，丢弃调用：${fn.name}`);
        continue; // 截断容错：不带病 args 进 canonical，消费侧自然落入文本兜底
      }
      // 缺失/空 id 直接丢弃：回传历史时 tool_call_id="" 会被官方端点 400 且难定位
      if (typeof item.id !== "string" || item.id === "") {
        log(`[llm] openai tool_call 缺失 id，丢弃调用：${fn.name}`);
        continue;
      }
      toolCalls.push({ id: item.id, name: fn.name, args });
    }
  }

  const response: ChatResponse = {
    text,
    toolCalls,
    stopReason: mapFinishReason(
      isRecord(first) ? first.finish_reason : undefined,
      toolCalls.length > 0,
    ),
    usage: mapUsage(json.usage),
  };
  if (reasoningText.length > 0) {
    response.reasoningText = reasoningText;
  }
  return response;
}

export function createOpenAICompletionsProvider(
  config: ProviderConfig,
  deps: Required<LlmDeps>,
): LLMProvider {
  const capabilities = resolveCapabilities(config);
  const chat = async (req: ChatRequest): Promise<ChatResponse> => {
    assertValidMessages(req.messages, config.name);
    const url = `${stripTrailingSlash(config.baseUrl)}/chat/completions`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
      ...config.extraHeaders,
    };
    const maxTokensField =
      config.maxTokensField ??
      (NEW_CONTRACT_PREFIX.test(config.model) ? "max_completion_tokens" : "max_tokens");
    const wireMessages: Array<Record<string, unknown>> = [];
    if (req.systemPrompt !== null) {
      wireMessages.push({ role: "system", content: req.systemPrompt });
    }
    wireMessages.push(...toWireMessages(req.messages));
    const body: Record<string, unknown> = {
      model: config.model,
      messages: wireMessages,
      [maxTokensField]: req.maxTokens ?? config.maxTokens,
      ...(req.tools !== null && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
      // ChatRequest 契约：tools 为 null/空数组时忽略 toolChoice 且不发 tools——
      // 孤立 tool_choice 会被官方端点 400；空 tools 列表在部分兼容端点（vLLM/Ollama
      // 等）同样拒收
      ...(req.toolChoice?.kind === "forced" && req.tools !== null && req.tools.length > 0
        ? { tool_choice: { type: "function", function: { name: req.toolChoice.name } } }
        : {}),
      // temperature 回退链（common.temperatureEntry）；两级缺省不发。新契约模型
      //（NEW_CONTRACT_PREFIX）只接受默认温度——卡片显式配置属宿主自担的选择
      ...temperatureEntry(req, config),
    };
    const json = await postJson(deps.fetch, url, headers, body, {
      provider: config.name,
      signal: req.signal,
      timeoutMs: req.timeoutMs,
    });
    const requestedNames = new Set((req.tools ?? []).map((t) => t.name));
    return parseResponse(json, requestedNames, deps.log, config.name);
  };

  return {
    protocol: "openai-completions",
    model: config.model,
    capabilities,
    chat,
    testConnection: () => defaultTestConnection(chat, config.model),
  };
}
