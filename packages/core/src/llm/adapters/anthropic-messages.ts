// anthropic-messages 协议适配器（02 §2；parity 主通道——TreeWalker 现役默认智谱兼容端点）。
// 请求：canonical → wire 映射 + 连续 toolResult/同角色折叠（400 地雷）；响应：content 块解析。

import { type ProviderConfig, resolveCapabilities } from "../config.js";
import type { LlmDeps } from "../deps.js";
import { LLMProtocolViolationError } from "../errors.js";
import type { LLMProvider } from "../provider.js";
import { IMAGE_OMITTED_PLACEHOLDER } from "../transforms.js";
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
import {
  defaultTestConnection,
  isRecord,
  makeOnceWarn,
  resolveMaxTokens,
  stringifyForLog,
  stripTrailingSlash,
  temperatureEntry,
} from "./common.js";
import { postJson } from "./http.js";

/** canonical 内容块 → anthropic content 块 */
function blocksToContent(blocks: ContentBlock[]): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  for (const b of blocks) {
    if (b.kind === "text") {
      content.push({ type: "text", text: b.text });
    } else if (b.kind === "image") {
      // anthropic 官方 media_type 是封闭枚举（jpeg/png/gif/webp）：image/jpg 等
      // 常见别名裸透传即 400（不可重试且烧 fallback 切换）——别名归一收口
      //（轮 27 #1；白名单外 mime 的丢弃留证据口径待后续按需收口）
      const mediaType = b.mimeType === "image/jpg" ? "image/jpeg" : b.mimeType;
      content.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: b.base64 },
      });
    } else {
      // 穷尽断言（轮 21 #6）：ContentBlock 联合扩展新成员（types.ts 注释明示
      // PDF 等后置）时编译期报错——隐式 else 会产出 undefined 字段的非法 wire 块
      const _exhaustive: never = b;
      throw new Error(`未支持的 ContentBlock kind: ${stringifyForLog(_exhaustive)}`);
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
      // assistant 角色输入只接受 text/tool_use 块（thinking 需显式开启）：image 块
      // 透传会被官方端点 400（"Input tag 'image' found where 'text' or 'tool_use'
      // was expected"）——与 openai 适配器「assistant 历史 image 块静默丢弃」口径
      // 对齐（轮 13 #13）
      const content = blocksToContent(msg.blocks.filter((b) => b.kind === "text"));
      for (const call of msg.toolCalls ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
      }
      // 仅含 image 块且无 toolCalls 的 assistant（canonical 校验放行）过滤后为空
      // content 数组——Anthropic 对空 content 硬 400，占位降级与 stripImageBlocks
      // 口径一致（轮 14 #8）
      if (content.length === 0) {
        content.push({ type: "text", text: IMAGE_OMITTED_PLACEHOLDER });
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

function mapStopReason(raw: unknown, hasKeptToolCall: boolean): StopReason {
  if (hasKeptToolCall) {
    return "tool_call"; // 从保留的调用推导（与 gemini/openai 口径一致）
  }
  if (raw === "tool_use") {
    return "other"; // 调用全部被丢弃：不置 tool_call，避免 toolCalls 空却报 tool_call 误导排障
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
  providerName: string,
): ChatResponse {
  if (!isRecord(json)) {
    throw new LLMProtocolViolationError(`anthropic 响应不是对象：${stringifyForLog(json)}`, {
      provider: providerName,
    });
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
      if (typeof item.name !== "string") {
        // 形态异常与名字失配分档留证据（轮 16 #11）：与 gemini「丢弃形态异常的
        // functionCall」口径对齐，畸形输出不得误标为非请求名；String 包装（轮 17
        // #14）：name 可能 undefined，JSON.stringify(undefined) 非 string 不能 .slice
        log(
          `[llm] anthropic 丢弃形态异常的 tool_use（name 非 string）：${stringifyForLog(item.name)}`,
        );
      } else if (requestedNames.has(item.name)) {
        // 缺失/空 id 直接丢弃：回传历史时 tool_use id="" 会被官方端点 400 且难定位
        if (typeof item.id !== "string" || item.id === "") {
          log(`[llm] anthropic tool_use 缺失 id，丢弃调用：${item.name}`);
          continue;
        }
        // 缺失/null 兜底 {}（无参工具合法形态）；其余非对象病态值与 gemini args /
        // openai arguments 同款「丢弃留证据」，避免调用以空参静默执行（轮 12 #13）
        if (item.input !== undefined && item.input !== null && !isRecord(item.input)) {
          log(`[llm] anthropic 丢弃 input 非对象的 tool_use：${item.name}`);
          continue;
        }
        toolCalls.push({
          id: item.id,
          name: item.name,
          args: isRecord(item.input) ? item.input : {},
        });
      } else {
        log(`[llm] anthropic 忽略非请求工具名的 tool_use：${item.name}`);
      }
    }
  }
  const response: ChatResponse = {
    text,
    toolCalls,
    stopReason: mapStopReason(json.stop_reason, toolCalls.length > 0),
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
  // 钳制告警实例级去重（轮 16 #4）：误配每请求都在发生，告警一次即可
  const onTemperatureClamp = makeOnceWarn(deps.log);
  // maxTokens 非法回退的实例级一次性告警（轮 18 #10）
  const onMaxTokensInvalid = makeOnceWarn(deps.log);
  // baseUrl 疑似 OpenAI 形态（/v1 结尾）的一次性告警（轮 23 #1）
  const onBaseUrlV1 = makeOnceWarn(deps.log);
  const chat = async (req: ChatRequest): Promise<ChatResponse> => {
    assertValidMessages(req.messages, config.name);
    const base = stripTrailingSlash(config.baseUrl);
    // OpenAI 卡 baseUrl 惯例带 /v1，跨协议复用卡片会拼出 /v1/v1/messages → 404
    //（错误文案不指向根因）——一次性告警留证据，与 maxTokens/temperature 误配口径一致
    if (base.endsWith("/v1")) {
      onBaseUrlV1(
        `baseUrl 以 /v1 结尾，anthropic 协议将拼接 ${base}/v1/messages——疑似 OpenAI 形态误配`,
      );
    }
    const url = `${base}/v1/messages`;
    // dangerous-direct-browser-access 恒发：扩展宿主从 SW 直连时是官方 CORS 逃生门
    //（webbrain 同款；对兼容端点多发无害）。extraHeaders 最后合并（可覆盖）。
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      ...config.extraHeaders,
    };
    // ChatRequest 契约：tools 为 null/空数组时忽略 toolChoice 且不发 tools——
    // 孤立 tool_choice 与空 tools 列表都会被官方端点 400
    const toolChoice =
      req.toolChoice?.kind === "forced" && req.tools !== null && req.tools.length > 0
        ? { type: "tool", name: req.toolChoice.name }
        : undefined;
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: resolveMaxTokens(req, config, onMaxTokensInvalid),
      ...(req.systemPrompt !== null && req.systemPrompt !== "" ? { system: req.systemPrompt } : {}),
      messages: toWireMessages(req.messages),
      ...(req.tools !== null && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }
        : {}),
      ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
      // temperature 回退链：请求级 ?? 卡片级（common.temperatureEntry）；两级缺省不发
      ...temperatureEntry(req, config, onTemperatureClamp),
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
    protocol: "anthropic-messages",
    model: config.model,
    capabilities,
    chat,
    testConnection: () => defaultTestConnection(chat, config.model),
  };
}
