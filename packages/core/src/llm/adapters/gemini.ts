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
import { postJson } from "./http.js";
import { sanitizeGeminiSchema } from "./schema-sanitize.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function blocksToParts(blocks: ContentBlock[]): Array<Record<string, unknown>> {
  return blocks.map((b) =>
    b.kind === "text" ? { text: b.text } : { inlineData: { mimeType: b.mimeType, data: b.base64 } },
  );
}

/**
 * canonical → wire contents。角色只有 user/model；连续 toolResult 折叠为一条 user
 * turn 的 functionResponse part 并置（同 anthropic 逻辑），按前置 assistant.toolCalls
 * 顺序重排，response 包装为官方推荐的 {"result": text} 形状（按 name 关联）。
 */
function toWireContents(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === "user") {
      out.push({ role: "user", parts: blocksToParts(msg.blocks) });
      i += 1;
      continue;
    }
    if (msg.role === "assistant") {
      // 角色名是 model 不是 assistant；functionCall 与文本同 turn 并置（args 原生对象）
      const parts = blocksToParts(msg.blocks);
      for (const call of msg.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: call.args } });
      }
      out.push({ role: "model", parts });
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
        out.push({ role: "user", parts: resultParts });
      }
      i = j;
      continue;
    }
    // toolResult 不在 assistant 之后：assertValidMessages 已拦，兜底跳过
    i += 1;
  }
  return out;
}

function mapFinishReason(raw: unknown, sawFunctionCall: boolean): StopReason {
  if (sawFunctionCall) {
    return "tool_call"; // finishReason 仍为 STOP——从 parts 推导优先（02 §4.3）
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
  };
}

function parseResponse(json: unknown, requestedNames: ReadonlySet<string>): ChatResponse {
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
  let sawFunctionCall = false;
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
      sawFunctionCall = true;
      const name = part.functionCall.name;
      if (
        typeof name === "string" &&
        requestedNames.has(name) &&
        isRecord(part.functionCall.args)
      ) {
        // 无调用 id——合成，保证 canonical 不变量；同回合多 functionCall 即并行调用
        toolCalls.push({
          id: `gemini-call-${toolCalls.length}`,
          name,
          args: part.functionCall.args,
        });
      }
    }
  }
  const response: ChatResponse = {
    text,
    toolCalls,
    stopReason: mapFinishReason(isRecord(first) ? first.finishReason : undefined, sawFunctionCall),
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
    // key 走头不走 URL query——避免 key 进日志/Referer（query ?key= 同样合法，不用）
    const url = `${stripTrailingSlash(config.baseUrl)}/v1beta/models/${config.model}:generateContent`;
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
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      },
    };
    const json = await postJson(deps.fetch, url, headers, body, {
      provider: config.name,
      signal: req.signal,
      timeoutMs: req.timeoutMs,
    });
    const requestedNames = new Set((req.tools ?? []).map((t) => t.name));
    return parseResponse(json, requestedNames);
  };

  return {
    protocol: "gemini",
    model: config.model,
    capabilities,
    chat,
    async testConnection() {
      try {
        await chat({
          systemPrompt: null,
          messages: [{ role: "user", blocks: [{ kind: "text", text: "Hi" }] }],
          tools: null,
          maxTokens: 5,
        });
        return { ok: true, model: config.model };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
