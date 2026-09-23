// gemini 协议适配器（02 §4）。无内部参考（webbrain 无 gemini provider），纯按官方规格
// 设计——三家中风险最高，验收以 mock 为准，真机差异等有 key 实测后修订（README 风险 3）。
// 关键差异：key 走 x-goog-api-key 头不走 URL；contents 只有 user/model 两种角色（无
// system/assistant/tool）；functionResponse 按 name 关联（无调用 id——canonical 双携带
// 的原因）；forced = toolConfig.functionCallingConfig mode=ANY。

import { type ProviderConfig, resolveCapabilities } from "../config.js";
import type { LlmDeps } from "../deps.js";
import { LLMBlockedError, LLMProtocolViolationError } from "../errors.js";
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
import { defaultTestConnection, isRecord, stripTrailingSlash, temperatureEntry } from "./common.js";
import { postJson } from "./http.js";
import { sanitizeGeminiSchema } from "./schema-sanitize.js";

function blocksToParts(blocks: ContentBlock[]): Array<Record<string, unknown>> {
  return blocks.map((b) =>
    b.kind === "text" ? { text: b.text } : { inlineData: { mimeType: b.mimeType, data: b.base64 } },
  );
}

/**
 * canonical → wire contents。角色只有 user/model。硬规则：
 * - 连续 toolResult 折叠为一条 user turn 的 functionResponse part 并置（同 anthropic
 *   逻辑），按前置 assistant.toolCalls 顺序重排，response 包装为官方推荐的
 *   {"result": text} 形状（按 name 关联）；
 * - 连续同角色 turn 折叠（Gemini 要求 user/model 交替，400 地雷——canonical 不校验
 *   交替；也覆盖 [toolResult 折叠出的 user turn] 与紧随的 user 观察消息相邻）。
 */
function toWireContents(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const pushMerged = (role: "user" | "model", parts: Array<Record<string, unknown>>) => {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.role === role) {
      (prev.parts as Array<Record<string, unknown>>).push(...parts);
    } else {
      out.push({ role, parts });
    }
  };
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === "user") {
      pushMerged("user", blocksToParts(msg.blocks));
      i += 1;
      continue;
    }
    if (msg.role === "assistant") {
      // 角色名是 model 不是 assistant；functionCall 与文本同 turn 并置（args 原生对象）
      const parts = blocksToParts(msg.blocks);
      for (const call of msg.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: call.args } });
      }
      pushMerged("model", parts);
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
        const resultParts: Array<Record<string, unknown>> = [];
        for (const call of msg.toolCalls ?? []) {
          const tr = results.get(call.id);
          if (tr !== undefined) {
            resultParts.push({
              functionResponse: {
                name: tr.toolName,
                // isError 无原生字段：[error] 前缀约定（与 openai 同款）
                response: { result: tr.isError ? `[error] ${tr.text}` : tr.text },
              },
            });
          }
        }
        pushMerged("user", resultParts);
      }
      i = j;
      continue;
    }
    // toolResult 不在 assistant 之后：assertValidMessages 已拦，兜底跳过
    i += 1;
  }
  return out;
}

function mapFinishReason(raw: unknown, hasKeptToolCall: boolean): StopReason {
  if (hasKeptToolCall) {
    return "tool_call"; // finishReason 仍为 STOP——从保留的调用推导优先（02 §4.3）
  }
  if (raw === "STOP") {
    return "stop";
  }
  if (raw === "MAX_TOKENS") {
    return "length";
  }
  // SAFETY/RECITATION 等候选级拦截：有 candidates 时不全局抛，按 other 让梯子处理
  return "other";
}

function mapUsage(raw: unknown): TokenUsage | null {
  if (!isRecord(raw)) {
    return null;
  }
  return {
    inputTokens: typeof raw.promptTokenCount === "number" ? raw.promptTokenCount : 0,
    outputTokens: typeof raw.candidatesTokenCount === "number" ? raw.candidatesTokenCount : 0,
    ...(typeof raw.cachedContentTokenCount === "number"
      ? { cacheReadTokens: raw.cachedContentTokenCount }
      : {}),
  };
}

function parseResponse(
  json: unknown,
  requestedNames: ReadonlySet<string>,
  log: (message: string) => void,
): ChatResponse {
  if (!isRecord(json)) {
    throw new LLMProtocolViolationError(
      `gemini 响应不是对象：${JSON.stringify(json).slice(0, 200)}`,
      {
        provider: "gemini",
      },
    );
  }
  // promptFeedback.blockReason = 全局拦截（无候选内容，梯子无从处理）→ LLMBlockedError
  const feedback = isRecord(json.promptFeedback) ? json.promptFeedback : undefined;
  if (feedback !== undefined && feedback.blockReason !== undefined) {
    throw new LLMBlockedError(`gemini promptFeedback 拦截：${String(feedback.blockReason)}`, {
      provider: "gemini",
    });
  }
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  const first = candidates.length > 0 ? candidates[0] : undefined;
  const content =
    isRecord(first) && isRecord(first.content) && Array.isArray(first.content.parts)
      ? first.content.parts
      : [];
  let text = "";
  let reasoningText = "";
  const toolCalls: ToolCall[] = [];
  for (const part of content) {
    if (!isRecord(part)) {
      continue;
    }
    if (typeof part.text === "string") {
      if (part.thought === true) {
        reasoningText += part.text; // 思考片段（可选字段）
      } else {
        text += part.text;
      }
      continue;
    }
    if (isRecord(part.functionCall)) {
      const name = part.functionCall.name;
      if (typeof name !== "string") {
        log(`[llm] gemini 丢弃形态异常的 functionCall：${JSON.stringify(name)}`);
        continue;
      }
      if (!requestedNames.has(name)) {
        log(`[llm] gemini 忽略非请求工具名的 functionCall：${name}`);
        continue;
      }
      const rawArgs: unknown = part.functionCall.args;
      if (rawArgs !== undefined && !isRecord(rawArgs)) {
        log(`[llm] gemini 丢弃 args 非对象的 functionCall：${name}`);
        continue;
      }
      // 无调用 id——合成，保证 canonical 不变量；同回合多 functionCall 即并行调用。
      // args 缺失兜底 {}：proto3 JSON 会省略空 Struct，无参工具的合法形态是 {name}（与
      // anthropic 的 input 口径对齐）
      toolCalls.push({
        id: `gemini-call-${toolCalls.length}`,
        name,
        args: (rawArgs as Record<string, unknown>) ?? {},
      });
    }
  }
  const response: ChatResponse = {
    text,
    toolCalls,
    // 从保留的调用推导（丢弃的幻觉调用不置位，否则 toolCalls 空却报 tool_call 误导排障）
    stopReason: mapFinishReason(
      isRecord(first) ? first.finishReason : undefined,
      toolCalls.length > 0,
    ),
    usage: mapUsage(json.usageMetadata),
  };
  if (reasoningText.length > 0) {
    response.reasoningText = reasoningText;
  }
  return response;
}

export function createGeminiProvider(config: ProviderConfig, deps: Required<LlmDeps>): LLMProvider {
  const capabilities = resolveCapabilities(config);
  const chat = async (req: ChatRequest): Promise<ChatResponse> => {
    assertValidMessages(req.messages, config.name);
    // key 走头不走 URL query——避免 key 进日志/Referer（query ?key= 同样合法，不用）；
    // model 段编码：含空格/#/? 等字符时避免 URL 截断把配置问题变形为 Invalid URL/404
    const url = `${stripTrailingSlash(config.baseUrl)}/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-goog-api-key": config.apiKey,
      ...config.extraHeaders,
    };
    const body: Record<string, unknown> = {
      ...(req.systemPrompt !== null
        ? { systemInstruction: { parts: [{ text: req.systemPrompt }] } }
        : {}),
      contents: toWireContents(req.messages),
      ...(req.tools !== null
        ? {
            tools: [
              {
                functionDeclarations: req.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parameters: sanitizeGeminiSchema(t.parameters),
                })),
              },
            ],
          }
        : {}),
      ...(req.toolChoice?.kind === "forced" && req.tools !== null
        ? {
            toolConfig: {
              functionCallingConfig: { mode: "ANY", allowedFunctionNames: [req.toolChoice.name] },
            },
          }
        : {}),
      generationConfig: {
        maxOutputTokens: req.maxTokens ?? config.maxTokens,
        // temperature 回退链（common.temperatureEntry）；两级缺省不发
        ...temperatureEntry(req, config),
      },
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
    protocol: "gemini",
    model: config.model,
    capabilities,
    chat,
    testConnection: () => defaultTestConnection(chat, config.model),
  };
}
