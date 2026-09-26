// openai-completions 协议适配器（02 §3）。覆盖 OpenAI 官方与 GLM/DeepSeek/Kimi/Qwen/Groq/
// OpenRouter/vLLM/Ollama 等兼容端点。兼容地雷：输出上限字段双轨（新契约模型拒
// max_tokens）、新契约 temperature 400（TS 侧缺省不发）、tool_calls arguments 是
// JSON 字符串且可能被 length 截断（guard-parse 失败丢弃，不带病 args 进 canonical）。

import { type ProviderConfig, resolveCapabilities } from "../config.js";
import type { LLMDeps } from "../deps.js";
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
  assertToolContract,
  createSharedAdapterWarners,
  defaultTestConnection,
  isRecord,
  makeOnceWarn,
  normalizeImageMime,
  resolveMaxTokens,
  stringifyForLog,
  stripTrailingSlash,
  TOOL_RESULT_ERROR_PREFIX,
  temperatureEntry,
  warnDroppedAssistantNonTextBlocks,
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

/** openai 官方输入图封闭枚举（轮 37 #12，与 anthropic/gemini 轮 36 #2 同族）：
 * PNG/JPEG/WEBP/非动图 GIF——svg/bmp/tiff 等越界即硬 400（非 infra 不重试还误触
 * fallback 切换）；兼容端点（GLM/vLLM 等）的接受集均含这四类，越界降级占位
 * 留证据（请求可继续，图片未出站可观测，与 IMAGE_OMITTED_PLACEHOLDER 口径一致） */
const OPENAI_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** 纯文本 user → content 字符串（最大化兼容）；含图 → 数组形态（data-URL image_url） */
function userContent(
  blocks: ContentBlock[],
  log: (message: string) => void,
): string | Array<Record<string, unknown>> {
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
      // mimeType 别名归一（轮 28 #5，normalizeImageMime 单源）+ 枚举越界降级
      //（轮 37 #12，与 anthropic/gemini 同口径）：越界 mime 裸出站即硬 400
      const mimeType = normalizeImageMime(b.mimeType);
      if (!OPENAI_IMAGE_MIME.has(mimeType)) {
        log(
          `[llm] openai image mime「${mimeType}」不在官方枚举（png/jpeg/webp/gif），降级占位——图片未出站`,
        );
        return { type: "text", text: IMAGE_OMITTED_PLACEHOLDER };
      }
      return {
        type: "image_url",
        image_url: { url: `data:${mimeType};base64,${b.base64}` },
      };
    }
    // 穷尽断言（轮 21 #6）：联合扩展新成员时编译期报错；运行期形态与 anthropic/
    // gemini 统一 throw（轮 38 #9）——旧 return _exhaustive 会把原始块当 content
    // part 静默出站（畸形载荷无日志）
    const _exhaustive: never = b;
    throw new Error(`未支持的 ContentBlock kind: ${stringifyForLog(_exhaustive)}`);
  });
}

/** canonical → wire 消息。toolResult 每条独立 tool 消息（与 anthropic 相反，不合并） */
function toWireMessages(
  messages: ChatMessage[],
  log: (message: string) => void,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  // 待配对的 toolCall id 集合（轮 38 #15 起源，轮 41 #4 改按 id 配对）：openai 的
  // 孤儿/未配对 tool 消息（无前置 assistant.tool_calls 匹配项）是官方端点硬 400
  // 形态——assertValidMessages 已拦，兜底与 anthropic/gemini
  //（collectToolResults 逐 id 配对过滤）同口径跳过留证据，不透传烧 400；
  // 消费后 delete 使同 id 第二条结果自然落入跳过分支（后写覆盖语义不存在，直接跳过）
  let pendingToolCallIds: Set<string> | undefined;
  // 部分配对缺证（轮 43 #4，与 collectToolResults「仅配对 N 条结果」对称）：剩余
  // 未消费 id 被静默清空 → wire 产出 tool_calls 多于 tool 消息的 400 形态无线索
  const warnPending = (): void => {
    if (pendingToolCallIds !== undefined && pendingToolCallIds.size > 0) {
      log(
        `[llm] openai 前置 assistant 有 ${pendingToolCallIds.size} 个 toolCall 未获 tool 消息跟随（wire 将缺 tool 消息，端点 400 形态）`,
      );
    }
  };
  for (const [idx, msg] of messages.entries()) {
    if (msg.role === "user") {
      warnPending();
      out.push({ role: "user", content: userContent(msg.blocks, log) });
      pendingToolCallIds = undefined;
      continue;
    }
    if (msg.role === "assistant") {
      // 残留 pending 在被覆盖/清空前留证据（轮 44 #2，与 user 分支/循环结尾同款）：
      // 部分配对后紧跟 assistant 的场景（校验漂移）否则静默清空
      warnPending();
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
      if (hasCalls) {
        wire.tool_calls = msg.toolCalls?.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) }, // args 字符串化是 openai 独有
        }));
        pendingToolCallIds = new Set(msg.toolCalls?.map((c) => c.id));
      } else {
        pendingToolCallIds = undefined;
      }
      out.push(wire);
      // calls 缺结果方向的观测已由 warnPending 单源承载（user/assistant 分支与
      // 循环末尾，轮 43 #4/轮 44 #2）：next 非 toolResult 时（完全无配对）warnPending
      // 必然触发，此处原冗余检测（轮 40 #4）是该集合的真子集——同事实每请求双发
      // 两条近似日志已删除（轮 45 #5）
      continue;
    }
    if (pendingToolCallIds === undefined || !pendingToolCallIds.has(msg.toolCallId)) {
      // 未配对（孤儿）或同 id 重复结果：assertValidMessages 已拦，兜底跳过留证据
      //（轮 41 #4，与 anthropic/gemini 逐 id 配对过滤同口径）
      log(
        `[llm] openai 跳过未配对前置 assistant.toolCalls 的 toolResult：${msg.toolCallId}（canonical 校验漂移的防御分支）`,
      );
      continue;
    }
    pendingToolCallIds.delete(msg.toolCallId);
    out.push({
      role: "tool",
      tool_call_id: msg.toolCallId,
      // isError 无原生字段：true 时 [error] 前缀约定（写死在适配器，02 §3.2 映射表）
      content: msg.isError ? `${TOOL_RESULT_ERROR_PREFIX}${msg.text}` : msg.text,
    });
  }
  warnPending(); // 序列结束的残留同理（轮 43 #4）
  return out;
}

function mapFinishReason(
  raw: unknown,
  hasKeptToolCall: boolean,
  log: (message: string) => void,
): StopReason {
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
  // LLMBlockedError 只用于 gemini promptFeedback 全局拦截形态（02 §3.3）；
  // 其余未知值（网关私货/拼写变体）留证据（轮 39 #9，与 anthropic 同口径）
  if (raw !== undefined && raw !== "content_filter") {
    log(`[llm] openai 未知 finish_reason 映射为 other：${stringifyForLog(raw)}`);
  }
  return "other";
}

function mapUsage(raw: unknown, log: (message: string) => void): TokenUsage | null {
  if (!isRecord(raw)) {
    // 「存在但形态异常」留证据（轮 42 #22，与 choices 域轮 32 #9 口径对齐）；
    // 缺失是 benign 形态不告警
    if (raw !== undefined) {
      log(`[llm] openai 丢弃形态异常的 usage（非对象）：${stringifyForLog(raw)}`);
    }
    return null;
  }
  // 字段级同款：prompt_tokens_details 存在但非 record 时静默归 {} 会让
  // cached_tokens 统计丢失无证据
  if (raw.prompt_tokens_details !== undefined && !isRecord(raw.prompt_tokens_details)) {
    log(
      `[llm] openai 丢弃形态异常的 usage.prompt_tokens_details（非对象）：${stringifyForLog(raw.prompt_tokens_details)}`,
    );
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
  // 顶层承载字段「存在但非数组」留证据（轮 32 #9）：网关 200 + 错误载荷顶替
  // choices 时静默归空，client 只能记「no parseable response」不含响应体线索
  if (json.choices !== undefined && !Array.isArray(json.choices)) {
    log(`[llm] openai 丢弃形态异常的顶层 choices（非数组）：${stringifyForLog(json.choices)}`);
  }
  const first = choices.length > 0 ? choices[0] : undefined;
  // choice 元素本身非对象（网关畸形输出）留证据（轮 33 #2）：与下方 message 域
  // 口径同族，静默归空是无证据丢弃路径
  if (first !== undefined && !isRecord(first)) {
    log(`[llm] openai 丢弃形态异常的 choice（非对象）：${stringifyForLog(first)}`);
  }
  const message = isRecord(first) && isRecord(first.message) ? first.message : {};
  // message 缺失（undefined）是兼容端点 benign 形态不告警（轮 39 #19，与
  // content/reasoning/tool_calls 守卫「缺失不告警」同口径）——只对「存在但非对象」留证据
  if (
    first !== undefined &&
    isRecord(first) &&
    first.message !== undefined &&
    !isRecord(first.message)
  ) {
    // 同族（轮 32 #9）：message 域「存在但非对象」静默归空同样无证据
    log(`[llm] openai 丢弃形态异常的 message（非对象）：${stringifyForLog(first.message)}`);
  }
  const rawContent: unknown = message.content;
  const text = typeof rawContent === "string" ? rawContent : "";
  // 存在但既非 string 也非 null/undefined 的形态留证据（轮 29 #8）：转换型网关回传
  // content-parts 数组等形态原先被静默折叠为空文本，文本丢失只见空响应无线索；
  // null=纯工具调用回合、缺失=兼容端点常见 benign 形态，均不告警
  if (typeof rawContent !== "string" && rawContent !== null && rawContent !== undefined) {
    log(`[llm] openai 丢弃形态异常的 message.content（非 string）：${stringifyForLog(rawContent)}`);
  }
  const rawReasoning: unknown = message.reasoning_content ?? message.reasoning; // GLM/DeepSeek 思考字段
  const reasoningText = typeof rawReasoning === "string" ? rawReasoning : "";
  // 思考字段形态异常留证据（轮 30 #5）：存在但非 string（网关畸形输出）原先静默
  // 折叠为空串——与 message.content（轮 29 #8）同款口径；null/缺失不告警
  if (typeof rawReasoning !== "string" && rawReasoning !== null && rawReasoning !== undefined) {
    log(
      `[llm] openai 丢弃形态异常的 reasoning 字段（非 string）：${stringifyForLog(rawReasoning)}`,
    );
  }

  // message.tool_calls「存在但非数组」留证据（轮 33 #6）：本文件响应解析唯一
  // 遗漏的承载域——转换型网关回传 {tool_calls: "..."} 等形态时调用全部静默丢失
  // 且 finish_reason:"tool_calls" 被映射为 other，client 只见空响应无线索
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) {
    log(
      `[llm] openai 丢弃形态异常的 message.tool_calls（非数组）：${stringifyForLog(message.tool_calls)}`,
    );
  }
  const toolCalls: ToolCall[] = [];
  if (Array.isArray(message.tool_calls)) {
    for (const item of message.tool_calls) {
      if (!isRecord(item) || !isRecord(item.function)) {
        // 形态异常（item 合法但 function 非对象等）——与 gemini「丢弃留证据」口径一致；
        // 串化截断（轮 17 #5）：畸形输出长度无上限，与 http.ts 错误体同口径
        log(`[llm] openai 丢弃形态异常的 tool_call：${stringifyForLog(item)}`);
        continue;
      }
      // 显式非 function 类型（custom/code_interpreter/mcp 等新式形态，轮 31 #4）：
      // function 域恰为对象也会以合法调用身份混入执行链——丢弃留证据；缺失 type
      // 容忍（vLLM/Ollama 等兼容端点可能省略）
      if (item.type !== undefined && item.type !== "function") {
        log(`[llm] openai 丢弃非 function 类型的 tool_call：${stringifyForLog(item.type)}`);
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
      // 缺失/空 id 直接丢弃（先于 arguments 校验，轮 44 #3——与 anthropic
      // name→id→input 顺序对齐：双病态并存时归因到更根本的「无法回传配对」）：
      // 回传历史时 tool_call_id="" 会被官方端点 400 且难定位
      if (typeof item.id !== "string" || item.id === "") {
        log(`[llm] openai tool_call 缺失 id，丢弃调用：${fn.name}`);
        continue;
      }
      const args = parseArguments(fn.arguments);
      if (args === undefined) {
        log(`[llm] openai tool_call arguments 解析失败，丢弃调用：${fn.name}`);
        continue; // 截断容错：不带病 args 进 canonical，消费侧自然落入文本兜底
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
      log,
    ),
    usage: mapUsage(json.usage, log),
  };
  if (reasoningText.length > 0) {
    response.reasoningText = reasoningText;
  }
  return response;
}

export function createOpenAICompletionsProvider(
  config: ProviderConfig,
  deps: Required<LLMDeps>,
): LLMProvider {
  // 公共观测束单源（轮 43 #5）：四项三适配器必备告警一次产出，防新增观测点三处
  // 同步漏挂；协议专属告警（baseUrl 守卫族等）留本地
  const {
    onTemperatureClamp,
    onTemperatureInvalid,
    onMaxTokensInvalid,
    onTimeoutInvalid,
    onAssistantImageDropped,
  } = createSharedAdapterWarners(deps.log);
  const capabilities = resolveCapabilities(config);
  // baseUrl 整段端点 URL 误配的一次性告警（轮 26 #2，与 anthropic /v1、gemini
  // /v1beta 同族）：官方 curl 示例以 /chat/completions 结尾，整段复制进卡片会
  // 拼出 …/chat/completions/chat/completions → 404
  const onBaseUrlEndpoint = makeOnceWarn(deps.log);
  const chat = async (req: ChatRequest): Promise<ChatResponse> => {
    assertValidMessages(req.messages, config.name);
    assertToolContract(req, config); // 轮 35 #13：forced 名不在 tools 是端点 400 形态，前置拦截
    // assistant 历史非 text 块折叠丢弃的一次性告警（轮 38 #11，轮 39 #11/#13 收敛
    // common 单源 + #18 统计放宽非 text）：content 仅 string|null、image 无 wire 形态
    warnDroppedAssistantNonTextBlocks(
      req.messages,
      onAssistantImageDropped,
      "openai",
      config.name,
      "协议约束：assistant content 仅 string|null",
    );
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
    wireMessages.push(...toWireMessages(req.messages, deps.log));
    // temperature 抑制判定（轮 30 #6 提取为具名布尔，恢复单层三元——嵌套三元
    // 违反清单规范）：缺省走 TEMPERATURE_UNSUPPORTED_PREFIX 前缀启发式，
    // temperatureSuppressed（轮 29 #3）是显式逃生门——前缀误命中自定义/网关模型
    //（o1-finetune 等实际支持温度）时显式 false 恢复发送，未入清单新模型可显式 true
    const temperatureSuppressed =
      config.temperatureSuppressed === undefined
        ? TEMPERATURE_UNSUPPORTED_PREFIX.test(config.model)
        : config.temperatureSuppressed;
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
      // gpt-5 系只接受默认温度——卡片误配即每请求硬 400 且误触 fallback 单向切换，
      // 与 maxTokensField 同源的地雷在此拆除：抑制时不发送并留一次性告警
      //（轮 21 #11；gpt-4.1/gpt-oss 支持 0-2 不抑制）
      ...(temperatureSuppressed
        ? suppressedTemperatureEntry(req, config, onTemperatureClamp)
        : temperatureEntry(req, config, onTemperatureClamp, onTemperatureInvalid)),
    };
    const json = await postJson(deps.fetch, url, headers, body, {
      provider: config.name,
      signal: req.signal,
      timeoutMs: req.timeoutMs,
      onInvalidTimeout: onTimeoutInvalid,
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
