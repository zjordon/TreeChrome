// openai-completions 协议适配器（02 §3）。覆盖 OpenAI 官方与 GLM/DeepSeek/Kimi/Qwen/Groq/
// OpenRouter/vLLM/Ollama 等兼容端点。兼容地雷：输出上限字段双轨（新契约模型拒
// max_tokens）、新契约 temperature 400（TS 侧缺省不发）、tool_calls arguments 是
// JSON 字符串且可能被 length 截断（guard-parse 失败丢弃，不带病 args 进 canonical）。

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
  TextBlock,
  TokenUsage,
  ToolCall,
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
const NEW_CONTRACT_PREFIX = /^(gpt-5|gpt-4\.1|gpt-oss|o1|o3|o4)/;

/** 只接受默认温度 1 的模型前缀（轮 21 #4 具名）：o 系全系 + gpt-5 全系（400
 * "Unsupported value: 'temperature' …Only the default (1) value is supported"，
 * 轮 20 #11 web 核实）；成员集与 NEW_CONTRACT_PREFIX **刻意不同**（gpt-4.1/
 * gpt-oss 走新上限字段但仍收温度）——新增模型时两清单分别核对 */
const TEMPERATURE_UNSUPPORTED_PREFIX = /^(o\d|gpt-5)/;

/** 温度抑制路径的观测（轮 21 #11）：「配置了却被静默忽略」与「两级缺省不发」
 * 不同——宿主误配无线索；复用钳制告警的 makeOnceWarn 实例（同一卡片要么命中
 * 抑制前缀永不钳制、要么走钳制，互斥无冲突） */
function suppressedTemperatureEntry(
  req: ChatRequest,
  config: ProviderConfig,
  onWarn: (message: string) => void,
): Record<string, unknown> {
  if (req.temperature !== undefined || config.temperature !== undefined) {
    onWarn(
      `模型 ${config.model} 只接受默认温度，配置的 temperature 将被忽略不发送（${config.name}）`,
    );
  }
  return {};
}

/** 纯文本 user → content 字符串（最大化兼容）；含图 → 数组形态（data-URL image_url） */
function userContent(blocks: ContentBlock[]): string | Array<Record<string, unknown>> {
  // 类型谓词守卫（轮 21 #10）：评审建议的 some(image) 反向守卫无法让 TS 收窄
  //（never 断言编译不过）——every 谓词对现联合语义等价，且联合扩展新成员
  //（PDF 等）时自然落入数组路径的穷尽断言
  if (blocks.every((b): b is TextBlock => b.kind === "text")) {
    return blocks.map((b) => b.text).join("");
  }
  return blocks.map((b) => {
    if (b.kind === "text") {
      return { type: "text", text: b.text };
    }
    if (b.kind === "image") {
      // mimeType 别名归一（轮 28 #5）：与 anthropic/gemini 同口径（normalizeImageMime 单源）
      return {
        type: "image_url",
        image_url: { url: `data:${normalizeImageMime(b.mimeType)};base64,${b.base64}` },
      };
    }
    const _exhaustive: never = b;
    return _exhaustive;
  });
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
      // OpenAI 的 assistant content 仅 string|null：历史中 image 块无 wire 形态，
      // 静默丢弃（与 user 侧 image_url 数组形态的不对称是协议约束，非遗漏）
      const text = msg.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("");
      const hasCalls = msg.toolCalls !== undefined && msg.toolCalls.length > 0;
      // 纯工具调用回合（blocks 空或过滤后无文本且带调用）content 置 null（官方
      // 形态）；仅含 image 块且无 toolCalls 过滤后为空串——降级 "[image omitted]"
      // 与 anthropic/gemini 占位口径对齐（轮 14 #8/#9，轮 16 #3 补齐 openai 侧）
      let content: string | null;
      if (msg.blocks.length === 0 || (text === "" && hasCalls)) {
        content = null;
      } else if (text === "") {
        content = IMAGE_OMITTED_PLACEHOLDER;
      } else {
        content = text;
      }
      const wire: Record<string, unknown> = { role: "assistant", content };
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
      content: msg.isError ? `${TOOL_RESULT_ERROR_PREFIX}${msg.text}` : msg.text,
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
    if (parsed === null) {
      // "null" 字符串（OpenAI→Gemini 转换型网关把 null args 字符串化的形态）与
      // 原生 null 同义——兜底 {} 而非按解析失败丢弃（轮 18 #7，与上方原生 null 口径对齐）
      return {};
    }
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
    throw new LLMProtocolViolationError(`openai 响应不是对象：${stringifyForLog(json)}`, {
      provider: providerName,
    });
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
        // 形态异常（item 合法但 function 非对象等）——与 gemini「丢弃留证据」口径一致；
        // 串化截断（轮 17 #5）：畸形输出长度无上限，与 http.ts 错误体同口径
        log(`[llm] openai 丢弃形态异常的 tool_call：${stringifyForLog(item)}`);
        continue;
      }
      const fn = item.function;
      if (typeof fn.name !== "string") {
        // 形态异常与名字失配分档留证据（轮 16 #12）：与 gemini「丢弃形态异常的
        // functionCall」口径对齐，畸形输出不得误标为非请求名
        log(`[llm] openai 丢弃形态异常的 tool_call（name 非 string）：${stringifyForLog(fn.name)}`);
        continue;
      }
      if (!requestedNames.has(fn.name)) {
        // 与 anthropic/gemini 同款观测：忽略的调用留证据（02 §2.3 泛化规则）
        log(`[llm] openai 忽略非请求工具名的 tool_call：${fn.name}`);
        continue;
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
  // 钳制告警实例级去重（轮 16 #4）：误配每请求都在发生，告警一次即可
  const onTemperatureClamp = makeOnceWarn(deps.log);
  // maxTokens 非法回退的实例级一次性告警（轮 18 #12）
  const onMaxTokensInvalid = makeOnceWarn(deps.log);
  // baseUrl 整段端点 URL 误配的一次性告警（轮 26 #2，与 anthropic /v1、gemini
  // /v1beta 同族）：官方 curl 示例以 /chat/completions 结尾，整段复制进卡片会
  // 拼出 …/chat/completions/chat/completions → 404
  const onBaseUrlEndpoint = makeOnceWarn(deps.log);
  const chat = async (req: ChatRequest): Promise<ChatResponse> => {
    assertValidMessages(req.messages, config.name);
    const base = stripTrailingSlash(config.baseUrl);
    if (base.endsWith("/chat/completions")) {
      onBaseUrlEndpoint(
        `baseUrl 以 /chat/completions 结尾，openai 协议将拼接 ${base}/chat/completions——疑似整段端点 URL 误配`,
      );
    }
    const url = `${base}/chat/completions`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
      ...config.extraHeaders,
    };
    const maxTokensField =
      config.maxTokensField ??
      (NEW_CONTRACT_PREFIX.test(config.model) ? "max_completion_tokens" : "max_tokens");
    const wireMessages: Array<Record<string, unknown>> = [];
    if (req.systemPrompt !== null && req.systemPrompt !== "") {
      wireMessages.push({ role: "system", content: req.systemPrompt });
    }
    wireMessages.push(...toWireMessages(req.messages));
    const body: Record<string, unknown> = {
      model: config.model,
      messages: wireMessages,
      [maxTokensField]: resolveMaxTokens(req, config, onMaxTokensInvalid),
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
      // temperature 回退链（common.temperatureEntry）；两级缺省不发。o 系与
      // gpt-5 系只接受默认温度（TEMPERATURE_UNSUPPORTED_PREFIX，轮 20 #11 web
      // 核实）——卡片误配即每请求硬 400 且误触 fallback 单向切换，与
      // maxTokensField 同源的地雷在此拆除：前缀命中时抑制发送并留一次性告警
      //（轮 21 #11；gpt-4.1/gpt-oss 支持 0-2 不抑制）
      ...(TEMPERATURE_UNSUPPORTED_PREFIX.test(config.model)
        ? suppressedTemperatureEntry(req, config, onTemperatureClamp)
        : temperatureEntry(req, config, onTemperatureClamp)),
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
