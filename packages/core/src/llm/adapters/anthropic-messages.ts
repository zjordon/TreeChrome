// anthropic-messages 协议适配器（02 §2；parity 主通道——TreeWalker 现役默认智谱兼容端点）。
// 请求：canonical → wire 映射 + 连续 toolResult/同角色折叠（400 地雷）；响应：content 块解析。

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
  TokenUsage,
  ToolCall,
} from "../types.js";
import { assertValidMessages } from "../types.js";
import {
  assertToolContract,
  collectToolResults,
  createSharedAdapterWarners,
  defaultTestConnection,
  hasNonEmptyTools,
  isRecord,
  makeOnceWarn,
  normalizeImageMime,
  resolveMaxTokens,
  stringifyForLog,
  stripTrailingSlash,
  temperatureEntry,
  warnDroppedAssistantNonTextBlocks,
} from "./common.js";
import { postJson } from "./http.js";

/** anthropic 官方 media_type 封闭枚举（轮 36 #2）：svg/bmp/tiff 等合法 MIME
 * 越界即硬 400——别名归一后仍越界的降级占位留证据（与滤图 IMAGE_OMITTED_
 * PLACEHOLDER 口径一致：请求可继续，图片未出站可观测） */
const ANTHROPIC_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** canonical 内容块 → anthropic content 块 */
function blocksToContent(
  blocks: ContentBlock[],
  log: (message: string) => void,
): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  for (const b of blocks) {
    if (b.kind === "text") {
      content.push({ type: "text", text: b.text });
    } else if (b.kind === "image") {
      // anthropic 官方 media_type 是封闭枚举（jpeg/png/gif/webp）：image/jpg 等
      // 常见别名裸透传即 400（不可重试且烧 fallback 切换）——别名归一收口
      //（轮 27 #1；轮 28 #3 提取 normalizeImageMime 三适配器单源）；归一后仍
      // 越界的降级占位（轮 36 #2）
      const mediaType = normalizeImageMime(b.mimeType);
      if (!ANTHROPIC_IMAGE_MIME.has(mediaType)) {
        log(
          `[llm] anthropic image mime「${mediaType}」不在官方枚举（jpeg/png/gif/webp），降级占位——图片未出站`,
        );
        content.push({ type: "text", text: IMAGE_OMITTED_PLACEHOLDER });
        continue;
      }
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
function toWireMessages(
  messages: ChatMessage[],
  log: (message: string) => void,
): Array<Record<string, unknown>> {
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
      pushMerged("user", blocksToContent(msg.blocks, log));
      i += 1;
      continue;
    }
    if (msg.role === "assistant") {
      // assistant 角色输入只接受 text/tool_use 块（thinking 需显式开启）：image 块
      // 透传会被官方端点 400（"Input tag 'image' found where 'text' or 'tool_use'
      // was expected"）——与 openai 适配器「assistant 历史 image 块静默丢弃」口径
      // 对齐（轮 13 #13）
      const content = blocksToContent(
        msg.blocks.filter((b) => b.kind === "text"),
        log,
      );
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
      // 折叠紧随的 toolResult 段（乱序到达，按 toolCalls 顺序重排——collectToolResults
      // 与 gemini 单源，轮 37 #10）
      const { pairs, next } = collectToolResults(
        messages,
        i + 1,
        msg.toolCalls ?? [],
        log,
        "anthropic",
      );
      if (pairs.length > 0) {
        pushMerged(
          "user",
          pairs.map(({ result }) => ({
            type: "tool_result",
            tool_use_id: result.toolCallId,
            content: result.text,
            ...(result.isError ? { is_error: true } : {}),
          })),
        );
      }
      i = next;
      continue;
    }
    // toolResult 不在 assistant 之后：assertValidMessages 已拦，兜底跳过——分支
    // 真实触发（校验与折叠逻辑漂移时）同样留证据（轮 37 #8，与全文件「丢弃必留证据」口径一致）
    log(`[llm] anthropic 跳过不在 assistant 之后的 toolResult：${msg.toolCallId}`);
    i += 1;
  }
  return out;
}

function mapStopReason(
  raw: unknown,
  hasKeptToolCall: boolean,
  log: (message: string) => void,
): StopReason {
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
  // 官方安全拒答/长任务暂停（轮 42 #10）：与 gemini SAFETY/RECITATION、openai
  // content_filter 同为 deliberate 已知值——按 other 让梯子处理且不告警（真实
  // refusal 场景每实例告警一次会把官方拒答误判为网关私货）；网关私货/拼写
  // 变体仍走未知档留证据（轮 39 #9）；缺失（undefined）是兼容端点 benign 形态
  if (raw === "refusal" || raw === "pause_turn") {
    return "other";
  }
  if (raw !== undefined) {
    log(`[llm] anthropic 未知 stop_reason 映射为 other：${stringifyForLog(raw)}`);
  }
  return "other";
}

function mapUsage(raw: unknown, log: (message: string) => void): TokenUsage | null {
  if (!isRecord(raw)) {
    // 「存在但形态异常」留证据（轮 42 #19，与顶层 content 域轮 32 #8 口径对齐）：
    // 畸形形态静默归 null 会让 token 统计/成本核算失真且无排障线索；缺失是
    // benign 形态不告警
    if (raw !== undefined) {
      log(`[llm] anthropic 丢弃形态异常的 usage（非对象）：${stringifyForLog(raw)}`);
    }
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
  onThinkingSignatureDropped: (message: string) => void,
): ChatResponse {
  if (!isRecord(json)) {
    throw new LLMProtocolViolationError(`anthropic 响应不是对象：${stringifyForLog(json)}`, {
      provider: providerName,
    });
  }
  const content = Array.isArray(json.content) ? json.content : [];
  // 顶层承载字段「存在但非数组」留证据（轮 32 #8）：网关 200 + 畸形载荷静默归空
  // 后 client 只见空响应无线索；缺失（undefined）是合法形态不告警
  if (json.content !== undefined && !Array.isArray(json.content)) {
    log(`[llm] anthropic 丢弃形态异常的顶层 content（非数组）：${stringifyForLog(json.content)}`);
  }
  let text = "";
  let reasoningText = "";
  const toolCalls: ToolCall[] = [];
  for (const item of content) {
    if (!isRecord(item)) {
      // 非对象项留证据（轮 30 #3）：网关畸形输出的静默 continue 是无证据丢弃路径
      log(`[llm] anthropic 丢弃非对象形态的 content 块：${stringifyForLog(item)}`);
      continue;
    }
    if (item.type === "text") {
      // 形态异常留证据（轮 29 #1）：type:"text" 但 text 非 string 的畸形块原先被
      // 内联条件静默丢弃——与 tool_use 形态异常（轮 16 #11）口径对齐
      if (typeof item.text === "string") {
        text += item.text;
      } else {
        log(
          `[llm] anthropic 丢弃形态异常的 text 块（text 非 string）：${stringifyForLog(item.text)}`,
        );
      }
    } else if (item.type === "thinking") {
      // thinking 域形态异常留证据（轮 30 #10）：内联条件短路会静默丢弃已知 type
      // 的畸形块（与 openai reasoning_content 轮 29 #8 同族）
      if (typeof item.thinking === "string") {
        reasoningText += item.thinking;
        // signature 是 thinking 块标配域（回传验证用）：canonical 无槽位静默剥离
        // 与 gemini textPartSignature（轮 42 #21）口径不一致——一次性告警留证据
        //（轮 44 #15；未来启用 thinking 块回传时该签名是硬要求）
        if (item.signature !== undefined) {
          // 卡片名归因（轮 46 #11，轮 42 #12 口径）：多卡片同协议可定位
          onThinkingSignatureDropped(
            `anthropic(${providerName}) 丢弃 thinking 块携带的 signature（canonical 无槽位，thinking 回传验证域）`,
          );
        }
      } else {
        log(
          `[llm] anthropic 丢弃形态异常的 thinking 块（thinking 非 string）：${stringifyForLog(item.thinking)}`,
        );
      }
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
    } else {
      // 未知 type 留证据（轮 30 #3）：redacted_thinking/server_tool_use 等官方类型
      // 或网关私货的丢弃至少记录 type 值
      log(`[llm] anthropic 丢弃未知 type 的 content 块：${stringifyForLog(item.type)}`);
    }
  }
  const response: ChatResponse = {
    text,
    toolCalls,
    stopReason: mapStopReason(json.stop_reason, toolCalls.length > 0, log),
    usage: mapUsage(json.usage, log),
  };
  if (reasoningText.length > 0) {
    response.reasoningText = reasoningText;
  }
  return response;
}

export function createAnthropicProvider(
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
  // baseUrl 疑似 OpenAI 形态（/v1 结尾）的一次性告警（轮 23 #1）
  // thinking 块 signature 剥离的实例级一次性告警（轮 44 #15，协议专属——与
  // gemini textPartSignature 轮 42 #21 口径对齐：extended thinking 默认开启的网关
  // 下是逐响应常态形态，防刷屏）
  const onThinkingSignatureDropped = makeOnceWarn(deps.log);
  const onBaseUrlV1 = makeOnceWarn(deps.log);
  // baseUrl 整段端点 URL（/v1/messages 结尾）的一次性告警（轮 34 #9）：官方 curl
  // 示例即全端点，整段复制进卡片拼出 /v1/messages/v1/messages → 404——与
  // openai /chat/completions（轮 26 #2）、gemini :generateContent（轮 34 #10）同族
  const onBaseUrlEndpoint = makeOnceWarn(deps.log);
  const chat = async (req: ChatRequest): Promise<ChatResponse> => {
    assertValidMessages(req.messages, config.name);
    assertToolContract(req, config); // 轮 35 #13：forced 名不在 tools 是端点 400 形态，前置拦截
    // assistant 历史非 text 块丢弃的一次性告警（轮 38 #11，轮 39 #11 收敛 common
    // 单源 + #16 统计放宽非 text）：多模态历史被协议剥离不再全静默
    warnDroppedAssistantNonTextBlocks(
      req.messages,
      onAssistantImageDropped,
      "anthropic",
      config.name,
      "协议约束：assistant 角色只收 text/tool_use",
    );
    const base = stripTrailingSlash(config.baseUrl);
    // OpenAI 卡 baseUrl 惯例带 /v1，跨协议复用卡片会拼出 /v1/v1/messages → 404
    //（错误文案不指向根因）——一次性告警留证据，与 maxTokens/temperature 误配口径一致
    if (base.endsWith("/v1")) {
      onBaseUrlV1(
        `baseUrl 以 /v1 结尾，anthropic 协议将拼接 ${base}/v1/messages——疑似 OpenAI 形态误配`,
      );
    }
    if (base.endsWith("/v1/messages")) {
      onBaseUrlEndpoint(
        `baseUrl 以 /v1/messages 结尾，anthropic 协议将拼接 ${base}/v1/messages——疑似整段端点 URL 误配`,
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
      req.toolChoice?.kind === "forced" && hasNonEmptyTools(req)
        ? { type: "tool", name: req.toolChoice.name }
        : undefined;
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: resolveMaxTokens(req, config, onMaxTokensInvalid),
      ...(req.systemPrompt !== null && req.systemPrompt !== "" ? { system: req.systemPrompt } : {}),
      messages: toWireMessages(req.messages, deps.log),
      ...(hasNonEmptyTools(req)
        ? {
            tools: req.tools?.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }
        : {}),
      ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
      // temperature 回退链：请求级 ?? 卡片级（common.temperatureEntry）；两级缺省不发
      ...temperatureEntry(req, config, onTemperatureClamp, onTemperatureInvalid),
      // 思考强度档位（智谱 coding-plan 网关扩展，p5/02 R9）：缺省不发（网关默认
      // max 档）；显式 low/high/max 注入 output_config——anthropic 官方端点不识此
      // 键的网关须测试确认（无效通常被忽略而非报错）
      ...(config.thinkingEffort !== undefined
        ? { output_config: { effort: config.thinkingEffort } }
        : {}),
    };
    const json = await postJson(deps.fetch, url, headers, body, {
      provider: config.name,
      signal: req.signal,
      timeoutMs: req.timeoutMs,
      onInvalidTimeout: onTimeoutInvalid,
    });
    const requestedNames = new Set((req.tools ?? []).map((t) => t.name));
    return parseResponse(json, requestedNames, deps.log, config.name, onThinkingSignatureDropped);
  };

  return {
    protocol: "anthropic-messages",
    model: config.model,
    capabilities,
    chat,
    testConnection: () => defaultTestConnection(chat, config.model),
  };
}
