// gemini 协议适配器（02 §4）。无内部参考（webbrain 无 gemini provider），纯按官方规格
// 设计——三家中风险最高，验收以 mock 为准，真机差异等有 key 实测后修订（README 风险 3）。
// 关键差异：key 走 x-goog-api-key 头不走 URL；contents 只有 user/model 两种角色（无
// system/assistant/tool）；functionResponse 按 name 关联（无调用 id——canonical 双携带
// 的原因）；forced = toolConfig.functionCallingConfig mode=ANY。

import { type ProviderConfig, resolveCapabilities } from "../config.js";
import type { LlmDeps } from "../deps.js";
import { LLMBlockedError, LLMProtocolViolationError } from "../errors.js";
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
  normalizeImageMime,
  resolveMaxTokens,
  stringifyForLog,
  stripTrailingSlash,
  TOOL_RESULT_ERROR_PREFIX,
  temperatureEntry,
} from "./common.js";
import { postJson } from "./http.js";
import { sanitizeGeminiSchema } from "./schema-sanitize.js";

/** schema 清洗事件去重集条数上限（防动态 schema 无界增长；上限后新事件静默）。
 *  导出仅为测试锚定派生（轮 29 #5 常量单源） */
export const SCHEMA_ISSUE_DEDUP_MAX = 128;

function blocksToParts(blocks: ContentBlock[]): Array<Record<string, unknown>> {
  return blocks.map((b) => {
    if (b.kind === "text") {
      return { text: b.text };
    }
    if (b.kind === "image") {
      // mimeType 别名归一（轮 28 #3）：gemini 官方受校验的封闭枚举，image/jpg
      // 裸透传有 400 风险——normalizeImageMime 三适配器单源
      return { inlineData: { mimeType: normalizeImageMime(b.mimeType), data: b.base64 } };
    }
    // 穷尽断言（轮 21 #6）：联合扩展新成员时编译期报错（同 anthropic blocksToContent）
    const _exhaustive: never = b;
    return _exhaustive;
  });
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
      // 角色名是 model 不是 assistant；functionCall 与文本同 turn 并置（args 原生对象）。
      // thoughtSignature 随 functionCall part 原样写回（不回传即 400，见 ToolCall.signature），
      // 并同时在下方 functionResponse part 补挂——官方两处口径并存（错误文案 vs SDK
      // 组装形态），双携带待真机核验（README 风险 3，评审轮 10 #9）。
      // model 角色不接受多模态输入（inlineData 仅 user 角色合法，透传为官方端点
      // 400 形态）——与 openai「assistant 历史 image 块静默丢弃」口径对齐（轮 13 #14）
      const parts = blocksToParts(msg.blocks.filter((b) => b.kind === "text"));
      for (const call of msg.toolCalls ?? []) {
        parts.push({
          functionCall: { name: call.name, args: call.args },
          ...(call.signature !== undefined ? { thoughtSignature: call.signature } : {}),
        });
      }
      // 仅含 image 块且无 toolCalls 的 assistant（canonical 校验放行）过滤后 parts
      // 为空数组——Gemini 报 INVALID_ARGUMENT，占位降级与 stripImageBlocks 口径
      // 一致（轮 14 #9）
      if (parts.length === 0) {
        parts.push({ text: IMAGE_OMITTED_PLACEHOLDER });
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
                response: {
                  result: tr.isError ? `${TOOL_RESULT_ERROR_PREFIX}${tr.text}` : tr.text,
                },
              },
              // 官方 SDK 形态：签名随 functionResponse part 回传（评审轮 10 #9——
              // 官方文档两处口径并存：错误文案指向 functionCall part、SDK 组装
              // 指向 functionResponse，双携带待真机核验，README 风险 3）
              ...(call.signature !== undefined ? { thoughtSignature: call.signature } : {}),
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
  nextCallId: () => string,
  providerName: string,
): ChatResponse {
  if (!isRecord(json)) {
    throw new LLMProtocolViolationError(`gemini 响应不是对象：${stringifyForLog(json)}`, {
      provider: providerName,
    });
  }
  // promptFeedback.blockReason = 全局拦截（无候选内容，梯子无从处理）→ LLMBlockedError
  const feedback = isRecord(json.promptFeedback) ? json.promptFeedback : undefined;
  if (feedback !== undefined && feedback.blockReason !== undefined) {
    throw new LLMBlockedError(`gemini promptFeedback 拦截：${String(feedback.blockReason)}`, {
      provider: providerName,
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
      // 非对象 part 留证据（轮 30 #4）：网关畸形输出（如字符串 part）的静默
      // continue 是无证据丢弃路径
      log(`[llm] gemini 丢弃非对象形态的 part：${stringifyForLog(part)}`);
      continue;
    }
    if (typeof part.text === "string") {
      if (part.thought === true) {
        reasoningText += part.text; // 思考片段（可选字段）
      } else {
        text += part.text;
      }
    } else if (part.text !== undefined) {
      // 存在但非 string 的畸形 text 域留证据（轮 29 #2）：undefined 是 functionCall
      // part 的正常形态不告警，仅「存在但形态异常」（如网关产出 text:123）丢弃留证
      log(`[llm] gemini 丢弃形态异常的 text part（text 非 string）：${stringifyForLog(part.text)}`);
    }
    // 官方 proto Part 内容域为 oneof（text 与 functionCall 互斥）——并存形态由
    // 转换型网关产出时两者都处理（轮 28 #4：continue 会静默丢弃并存 functionCall）
    if (isRecord(part.functionCall)) {
      const name = part.functionCall.name;
      if (typeof name !== "string") {
        // String 包装（轮 17 #15）：name 可能 undefined，JSON.stringify(undefined)
        // 返回 undefined 非字符串，直挂 .slice 会 TypeError
        log(`[llm] gemini 丢弃形态异常的 functionCall：${stringifyForLog(name)}`);
        continue;
      }
      if (!requestedNames.has(name)) {
        log(`[llm] gemini 忽略非请求工具名的 functionCall：${name}`);
        continue;
      }
      const rawArgs: unknown = part.functionCall.args;
      // args 缺失/null 兜底 {}：proto3 JSON 会省略空 Struct，无参工具的合法形态是
      // {name}；经 OpenAI→Gemini 转换型网关还可能出现 args:null（与缺失语义相同）。
      //（与 anthropic input / openai arguments 的口径对齐）
      if (rawArgs !== undefined && rawArgs !== null && !isRecord(rawArgs)) {
        log(`[llm] gemini 丢弃 args 非对象的 functionCall：${name}`);
        continue;
      }
      // 无调用 id——合成，保证 canonical 不变量；同回合多 functionCall 即并行调用。
      // 序号是 provider 实例级自增：跨回合/跨响应唯一（宿主可能以 toolCallId 作跨回合
      // 键，与 anthropic/openai 真实端点的全局唯一 id 行为对齐）。
      // thoughtSignature 捕获进 ToolCall.signature（2.5/3 thinking 模型回传硬要求）
      const signature =
        typeof part.thoughtSignature === "string" ? part.thoughtSignature : undefined;
      toolCalls.push({
        id: nextCallId(),
        name,
        args: (rawArgs as Record<string, unknown>) ?? {},
        ...(signature !== undefined ? { signature } : {}),
      });
    } else if (part.functionCall !== undefined) {
      // functionCall 存在但非对象（网关畸形输出，如 "foo"）——与 name 非字符串同款
      // 「丢弃留证据」口径，不静默跳过；串化截断（轮 17 #6）与 http.ts 错误体同口径
      log(`[llm] gemini 丢弃形态异常的 functionCall：${stringifyForLog(part.functionCall)}`);
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
  // 合成 id 的实例级随机盐 + 自增序号（轮 15 #14）：fallback 切换
  //（client.ts trySwitchToFallback）会在会话中途重建 provider 实例，纯自增
  // 序号会在同一会话内复用 id（历史已存 gemini-call-0 时新实例再产出同 id）——
  // 盐前缀保证跨实例唯一（宿主可能以 toolCallId 作跨回合键）
  const synthSalt = Math.random().toString(36).slice(2, 8);
  let synthSeq = 0;
  // schema 清洗事件告警的去重集：工具 schema 逐请求固定，同一事件重复告警只有
  // 噪音；每条一次即保留「约束被清洗丢失」的排障线索。设条数上限防动态工具
  // schema（属性名随页面变化）在长生命周期实例上无界增长——上限后新事件静默
  const warnedSchemaIssues = new Set<string>();
  const onSchemaIssue = (detail: string): void => {
    if (warnedSchemaIssues.has(detail) || warnedSchemaIssues.size >= SCHEMA_ISSUE_DEDUP_MAX) {
      return;
    }
    warnedSchemaIssues.add(detail);
    deps.log(`[llm] gemini schema 清洗：${detail}（约束丢失，模型可能生成违反原 schema 的参数）`);
  };
  // 钳制告警实例级去重（轮 16 #4）：误配每请求都在发生，告警一次即可
  const onTemperatureClamp = makeOnceWarn(deps.log);
  // maxTokens 非法回退的实例级一次性告警（轮 18 #11）
  const onMaxTokensInvalid = makeOnceWarn(deps.log);
  // baseUrl 整段误配官方端点的一次性告警（轮 24 #4，与 anthropic /v1 同族）：
  // 官方文档 URL 本身以 /v1beta 结尾，整段复制进卡片会拼出 /v1beta/v1beta → 404
  const onBaseUrlV1beta = makeOnceWarn(deps.log);
  const chat = async (req: ChatRequest): Promise<ChatResponse> => {
    assertValidMessages(req.messages, config.name);
    // key 走头不走 URL query——避免 key 进日志/Referer（query ?key= 同样合法，不用）；
    // model 段编码：含空格/#/? 等字符时避免 URL 截断把配置问题变形为 Invalid URL/404
    const base = stripTrailingSlash(config.baseUrl);
    if (base.endsWith("/v1beta")) {
      onBaseUrlV1beta(
        `baseUrl 以 /v1beta 结尾，gemini 协议将拼接 ${base}/v1beta/models/…——疑似官方端点整段误配`,
      );
    }
    const url = `${base}/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-goog-api-key": config.apiKey,
      ...config.extraHeaders,
    };
    const body: Record<string, unknown> = {
      ...(req.systemPrompt !== null && req.systemPrompt !== ""
        ? { systemInstruction: { parts: [{ text: req.systemPrompt }] } }
        : {}),
      contents: toWireContents(req.messages),
      // ChatRequest 契约：tools 为 null/空数组时不发 tools 且忽略 toolChoice——
      // 空 functionDeclarations 与孤立 toolConfig 都是端点 400 形态
      ...(req.tools !== null && req.tools.length > 0
        ? {
            tools: [
              {
                functionDeclarations: req.tools.map((t) => {
                  const sanitized = sanitizeGeminiSchema(t.parameters, onSchemaIssue);
                  // 顶层 parameters 语义恒为命名参数集（object）：无参工具上游常给
                  // {}（清洗兜底成 type:string）——严格端点 400、宽容端点也把工具
                  // 声明成「参数是一个字符串」诱导病态 args；嵌套节点兜底 string
                  // 合理（语义未知），顶层在此调用点收口（轮 22 #7）。
                  // 归一时同步剥离 type 域外键（轮 25 #7 + 轮 26 #5）：items 仅
                  // ARRAY、enum/format 仅 STRING、pattern/minLength/maxLength 仅
                  // STRING、minItems/maxItems 仅 ARRAY、minimum/maximum 仅 NUMBER/
                  // INTEGER——原 type 合法的键残留在 object 节点上要么是 400 形态
                  //（与 FORMATS_BY_TYPE 分域同口径）要么语义失效，约束丢失已由
                  // 归一告警可观测
                  if (sanitized.type !== "object") {
                    onSchemaIssue(
                      `顶层 parameters type=${String(sanitized.type)} 归一为 object（函数参数恒为命名参数集）`,
                    );
                    sanitized.type = "object";
                    delete sanitized.items;
                    delete sanitized.enum;
                    delete sanitized.format;
                    delete sanitized.pattern;
                    delete sanitized.minLength;
                    delete sanitized.maxLength;
                    delete sanitized.minItems;
                    delete sanitized.maxItems;
                    delete sanitized.minimum;
                    delete sanitized.maximum;
                  }
                  return {
                    name: t.name,
                    description: t.description,
                    parameters: sanitized,
                  };
                }),
              },
            ],
          }
        : {}),
      ...(req.toolChoice?.kind === "forced" && req.tools !== null && req.tools.length > 0
        ? {
            toolConfig: {
              functionCallingConfig: { mode: "ANY", allowedFunctionNames: [req.toolChoice.name] },
            },
          }
        : {}),
      generationConfig: {
        maxOutputTokens: resolveMaxTokens(req, config, onMaxTokensInvalid),
        // temperature 回退链（common.temperatureEntry）；两级缺省不发
        ...temperatureEntry(req, config, onTemperatureClamp),
      },
    };
    const json = await postJson(deps.fetch, url, headers, body, {
      provider: config.name,
      signal: req.signal,
      timeoutMs: req.timeoutMs,
    });
    const requestedNames = new Set((req.tools ?? []).map((t) => t.name));
    return parseResponse(
      json,
      requestedNames,
      deps.log,
      () => `gemini-call-${synthSalt}-${synthSeq++}`,
      config.name,
    );
  };

  return {
    protocol: "gemini",
    model: config.model,
    capabilities,
    chat,
    testConnection: () => defaultTestConnection(chat, config.model),
  };
}
