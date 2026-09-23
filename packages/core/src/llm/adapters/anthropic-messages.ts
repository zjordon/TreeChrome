// anthropic-messages 协议适配器（02 §2；parity 主通道——TreeWalker 现役默认智谱兼容端点）。
// 请求：canonical → wire 映射 + 连续 toolResult/同角色折叠（400 地雷）；响应：content 块解析。

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
  ToolResultMessage,
} from "../types.js";
import { assertValidMessages } from "../types.js";
import { defaultTestConnection, isRecord, stripTrailingSlash } from "./common.js";
import { postJson } from "./http.js";

/** canonical 内容块 → anthropic content 块 */
function blocksToContent(blocks: ContentBlock[]): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  for (const b of blocks) {
    if (b.kind === "text") {
      content.push({ type: "text", text: b.text });
    } else {
      content.push({
        type: "image",
        source: { type: "base64", media_type: b.mimeType, data: b.base64 },
      });
    }
  }
  return content;
}

/**
 * canonical → wire 消息。硬规则：
 * - 连续 toolResult 折叠进**一条** user 消息（Anthropic 对分散的多条 user 报 400，
 *   webbrain 已踩），块序按前置 assistant.toolCalls 顺序重排；
 * - 连续同角色消息折叠（canonical 不校验交替，Anthropic 要求角色交替——同族 400
 *   地雷；也覆盖 [toolResult 折叠出的 user 消息] 与紧随的 user 观察消息相邻）；
 * - 纯工具调用回合的 assistant 发空 content 数组 + tool_use 块。
 */
function toWireMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const pushMerged = (role: "user" | "assistant", content: Array<Record<string, unknown>>) => {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.role === role) {
      (prev.content as Array<Record<string, unknown>>).push(...content);
    } else {
      out.push({ role, content });
    }
  };
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === "user") {
      pushMerged("user", blocksToContent(msg.blocks));
      i += 1;
      continue;
    }
    if (msg.role === "assistant") {
      const content = blocksToContent(msg.blocks);
      for (const call of msg.toolCalls ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
      }
      pushMerged("assistant", content);
      // 折叠紧随的 toolResult 段（乱序到达，按 toolCalls 顺序重排）
      const results = new Map<string, ToolResultMessage>();
      let j = i + 1;
      while (j < messages.length) {
        const cur = messages[j];
        if (cur.role !== "toolResult") {
          break;
        }
        results.set(cur.toolCallId, cur);
        j += 1;
      }
      if (results.size > 0) {
        const resultBlocks: Array<Record<string, unknown>> = [];
        for (const call of msg.toolCalls ?? []) {
          const tr = results.get(call.id);
          if (tr !== undefined) {
            resultBlocks.push({
              type: "tool_result",
              tool_use_id: tr.toolCallId,
              content: tr.text,
              ...(tr.isError ? { is_error: true } : {}),
            });
          }
        }
        pushMerged("user", resultBlocks);
      }
      i = j;
      continue;
    }
    // toolResult 不在 assistant 之后：assertValidMessages 已拦，兜底跳过
    i += 1;
  }
  return out;
}

function mapStopReason(raw: unknown): StopReason {
  if (raw === "tool_use") {
    return "tool_call";
  }
  if (raw === "end_turn" || raw === "stop_sequence") {
    return "stop";
  }
  if (raw === "max_tokens") {
    return "length";
  }
  return "other";
}

function mapUsage(raw: unknown): TokenUsage | null {
  if (!isRecord(raw)) {
    return null;
  }
  return {
    inputTokens: typeof raw.input_tokens === "number" ? raw.input_tokens : 0,
    outputTokens: typeof raw.output_tokens === "number" ? raw.output_tokens : 0,
    ...(typeof raw.cache_read_input_tokens === "number"
      ? { cacheReadTokens: raw.cache_read_input_tokens }
      : {}),
    ...(typeof raw.cache_creation_input_tokens === "number"
      ? { cacheWriteTokens: raw.cache_creation_input_tokens }
      : {}),
  };
}

/** wire 响应 → canonical。thinking 块跳过进 reasoningText；忽略非请求工具名的 tool_use（warn） */
function parseResponse(
  json: unknown,
  requestedNames: ReadonlySet<string>,
  log: (message: string) => void,
): ChatResponse {
  if (!isRecord(json)) {
    throw new LLMProtocolViolationError(
      `anthropic 响应不是对象：${JSON.stringify(json).slice(0, 200)}`,
      {
        provider: "anthropic-messages",
      },
    );
  }
  const content = Array.isArray(json.content) ? json.content : [];
  let text = "";
  let reasoningText = "";
  const toolCalls: ToolCall[] = [];
  for (const item of content) {
    if (!isRecord(item)) {
      continue;
    }
    if (item.type === "text" && typeof item.text === "string") {
      text += item.text;
    } else if (item.type === "thinking" && typeof item.thinking === "string") {
      reasoningText += item.thinking;
    } else if (item.type === "tool_use") {
      if (typeof item.name === "string" && requestedNames.has(item.name)) {
        toolCalls.push({
          id: typeof item.id === "string" ? item.id : "",
          name: item.name,
          args: isRecord(item.input) ? item.input : {},
        });
      } else {
        log(`[llm] anthropic 忽略非请求工具名的 tool_use：${JSON.stringify(item.name)}`);
      }
    }
  }
  const response: ChatResponse = {
    text,
    toolCalls,
    stopReason: mapStopReason(json.stop_reason),
    usage: mapUsage(json.usage),
  };
  if (reasoningText.length > 0) {
    response.reasoningText = reasoningText;
  }
  return response;
}

export function createAnthropicProvider(
  config: ProviderConfig,
  deps: Required<LlmDeps>,
): LLMProvider {
  const capabilities = resolveCapabilities(config);
  const chat = async (req: ChatRequest): Promise<ChatResponse> => {
    assertValidMessages(req.messages, config.name);
    const url = `${stripTrailingSlash(config.baseUrl)}/v1/messages`;
    // dangerous-direct-browser-access 恒发：扩展宿主从 SW 直连时是官方 CORS 逃生门
    //（webbrain 同款；对兼容端点多发无害）。extraHeaders 最后合并（可覆盖）。
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      ...config.extraHeaders,
    };
    const toolChoice =
      req.toolChoice?.kind === "forced" ? { type: "tool", name: req.toolChoice.name } : undefined;
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: req.maxTokens ?? config.maxTokens,
      ...(req.systemPrompt !== null ? { system: req.systemPrompt } : {}),
      messages: toWireMessages(req.messages),
      ...(req.tools !== null
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }
        : {}),
      ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
      // 回退链与 maxTokens 同款：请求级 ?? 卡片级；两级都缺省则不发
      ...((req.temperature ?? config.temperature) !== undefined
        ? { temperature: req.temperature ?? config.temperature }
        : {}),
    };
    const json = await postJson(deps.fetch, url, headers, body, {
      provider: config.name,
      signal: req.signal,
      timeoutMs: req.timeoutMs,
    });
    const requestedNames = new Set((req.tools ?? []).map((t) => t.name));
    return parseResponse(json, requestedNames, deps.log);
  };

  return {
    protocol: "anthropic-messages",
    model: config.model,
    capabilities,
    chat,
    testConnection: () => defaultTestConnection(chat, config.model),
  };
}
