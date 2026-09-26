// gemini 协议适配器（02 §4）。无内部参考（webbrain 无 gemini provider），纯按官方规格
// 设计——三家中风险最高，验收以 mock 为准，真机差异等有 key 实测后修订（README 风险 3）。
// 关键差异：key 走 x-goog-api-key 头不走 URL；contents 只有 user/model 两种角色（无
// system/assistant/tool）；functionResponse 按 name 关联（无调用 id——canonical 双携带
// 的原因）；forced = toolConfig.functionCallingConfig mode=ANY。

import { type ProviderConfig, resolveCapabilities } from "../config.js";
import type { LLMDeps } from "../deps.js";
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
} from "../types.js";
import { assertValidMessages } from "../types.js";
import {
  assertToolContract,
  collectToolResults,
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
import { sanitizeGeminiSchema, stripKeysOutsideTypeDomain } from "./schema-sanitize.js";

/** schema 清洗事件去重集条数上限（防动态 schema 无界增长；上限后新事件静默）。
 *  导出仅为测试锚定派生（轮 29 #5 常量单源） */
export const SCHEMA_ISSUE_DEDUP_MAX = 128;

/** gemini 官方 mimeType 封闭枚举（轮 36 #2）：png/jpeg/webp/heic/heif（不含 gif，
 * 与 anthropic 集合不同故不共享）——别名归一后仍越界（svg/bmp/gif 等）即硬 400，
 * 降级占位留证据（与滤图 IMAGE_OMITTED_PLACEHOLDER 口径一致） */
const GEMINI_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
]);

function blocksToParts(
  blocks: ContentBlock[],
  log: (message: string) => void,
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  for (const b of blocks) {
    if (b.kind === "text") {
      parts.push({ text: b.text });
      continue;
    }
    if (b.kind === "image") {
      // mimeType 别名归一（轮 28 #3）：gemini 官方受校验的封闭枚举，image/jpg
      // 裸透传有 400 风险——normalizeImageMime 三适配器单源；归一后仍越界的
      // 降级占位（轮 36 #2）
      const mimeType = normalizeImageMime(b.mimeType);
      if (!GEMINI_IMAGE_MIME.has(mimeType)) {
        log(
          `[llm] gemini image mime「${mimeType}」不在官方枚举（png/jpeg/webp/heic/heif），降级占位——图片未出站`,
        );
        parts.push({ text: IMAGE_OMITTED_PLACEHOLDER });
        continue;
      }
      parts.push({ inlineData: { mimeType, data: b.base64 } });
      continue;
    }
    // 穷尽断言（轮 21 #6）：联合扩展新成员时编译期报错（同 anthropic blocksToContent）；
    // 运行期形态统一 throw（轮 38 #9，与 anthropic 对齐）——旧 return [_exhaustive]
    // 会丢弃已累积 parts 并把原始块当 wire part 静默出站（畸形载荷无日志）
    const _exhaustive: never = b;
    throw new Error(`未支持的 ContentBlock kind: ${stringifyForLog(_exhaustive)}`);
  }
  return parts;
}

/**
 * canonical → wire contents。角色只有 user/model。硬规则：
 * - 连续 toolResult 折叠为一条 user turn 的 functionResponse part 并置（同 anthropic
 *   逻辑），按前置 assistant.toolCalls 顺序重排，response 包装为官方推荐的
 *   {"result": text} 形状（按 name 关联）；
 * - 连续同角色 turn 折叠（Gemini 要求 user/model 交替，400 地雷——canonical 不校验
 *   交替；也覆盖 [toolResult 折叠出的 user turn] 与紧随的 user 观察消息相邻）。
 */
function toWireContents(
  messages: ChatMessage[],
  log: (message: string) => void,
): Array<Record<string, unknown>> {
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
      pushMerged("user", blocksToParts(msg.blocks, log));
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
      const parts = blocksToParts(
        msg.blocks.filter((b) => b.kind === "text"),
        log,
      );
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
      // 折叠紧随的 toolResult 段（乱序到达，按 toolCalls 顺序重排——collectToolResults
      // 与 anthropic 单源，轮 37 #10）
      const { pairs, next } = collectToolResults(messages, i + 1, msg.toolCalls ?? [], log);
      if (pairs.length > 0) {
        pushMerged(
          "user",
          pairs.map(({ call, result }) => ({
            functionResponse: {
              name: result.toolName,
              // isError 无原生字段：[error] 前缀约定（与 openai 同款）
              response: {
                result: result.isError ? `${TOOL_RESULT_ERROR_PREFIX}${result.text}` : result.text,
              },
            },
            // 官方 SDK 形态：签名随 functionResponse part 回传（评审轮 10 #9——
            // 官方文档两处口径并存：错误文案指向 functionCall part、SDK 组装
            // 指向 functionResponse，双携带待真机核验，README 风险 3）
            ...(call.signature !== undefined ? { thoughtSignature: call.signature } : {}),
          })),
        );
      }
      i = next;
      continue;
    }
    // toolResult 不在 assistant 之后：assertValidMessages 已拦，兜底跳过——分支
    // 真实触发（校验与折叠逻辑漂移时）同样留证据（轮 37 #9，与全文件「丢弃必留证据」口径一致）
    log(`[llm] gemini 跳过不在 assistant 之后的 toolResult：${msg.toolCallId}`);
    i += 1;
  }
  return out;
}

function mapFinishReason(
  raw: unknown,
  hasKeptToolCall: boolean,
  log: (message: string) => void,
): StopReason {
  if (hasKeptToolCall) {
    return "tool_call"; // finishReason 仍为 STOP——从保留的调用推导优先（02 §4.3）
  }
  if (raw === "STOP") {
    return "stop";
  }
  if (raw === "MAX_TOKENS") {
    return "length";
  }
  if (raw !== undefined && raw !== "SAFETY" && raw !== "RECITATION") {
    // SAFETY/RECITATION 等候选级拦截：有 candidates 时不全局抛，按 other 让梯子
    // 处理（deliberate 设计决策，02 §3.3）——其余未知值（网关私货/拼写变体）留
    // 证据（轮 39 #9，与 anthropic 未知 stop_reason 同口径）；缺失不告警
    log(`[llm] gemini 未知 finishReason 映射为 other：${stringifyForLog(raw)}`);
  }
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
  // promptFeedback.blockReason = 全局拦截（无候选内容，梯子无从处理）→ LLMBlockedError。
  // 「存在但非 record」留证据（轮 32 #11）：畸形载荷会使 blockReason 检测失效，
  // 拦截形态退化为空响应——record 是该字段唯一合法形态，零误报
  const feedback = isRecord(json.promptFeedback) ? json.promptFeedback : undefined;
  if (json.promptFeedback !== undefined && feedback === undefined) {
    log(
      `[llm] gemini 丢弃形态异常的 promptFeedback（非对象）：${stringifyForLog(json.promptFeedback)}`,
    );
  }
  if (feedback !== undefined && feedback.blockReason !== undefined) {
    throw new LLMBlockedError(`gemini promptFeedback 拦截：${String(feedback.blockReason)}`, {
      provider: providerName,
    });
  }
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  // 顶层承载字段「存在但非数组」留证据（轮 32 #10）：与 anthropic content /
  // openai choices 同族；candidates 缺失在 promptFeedback 拦截形态是合法的不告警
  if (json.candidates !== undefined && !Array.isArray(json.candidates)) {
    log(
      `[llm] gemini 丢弃形态异常的顶层 candidates（非数组）：${stringifyForLog(json.candidates)}`,
    );
  }
  const first = candidates.length > 0 ? candidates[0] : undefined;
  // 嵌套承载域「存在但形态异常」留证据（轮 33 #1，与 openai message 域轮 32 #9
  // 同族）：candidate/content/parts 三级任一畸形静默归空，网关畸形载荷退化为无
  // 线索空响应——缺失（undefined）是合法形态不告警
  if (first !== undefined && !isRecord(first)) {
    log(`[llm] gemini 丢弃形态异常的 candidate（非对象）：${stringifyForLog(first)}`);
  } else if (isRecord(first) && first.content !== undefined && !isRecord(first.content)) {
    log(`[llm] gemini 丢弃形态异常的 content（非对象）：${stringifyForLog(first.content)}`);
  } else if (
    isRecord(first) &&
    isRecord(first.content) &&
    first.content.parts !== undefined &&
    !Array.isArray(first.content.parts)
  ) {
    log(`[llm] gemini 丢弃形态异常的 parts（非数组）：${stringifyForLog(first.content.parts)}`);
  }
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
      // thoughtSignature 捕获进 ToolCall.signature（2.5/3 thinking 模型回传硬要求）。
      // 形态异常（非 string）留证据（轮 39 #8）：静默剥签名 → 下回合历史回传缺
      // thoughtSignature → 端点 400 INVALID_ARGUMENT 且本地无线索
      if (part.thoughtSignature !== undefined && typeof part.thoughtSignature !== "string") {
        log(
          `[llm] gemini 丢弃形态异常的 thoughtSignature（非 string）：${stringifyForLog(part.thoughtSignature)}`,
        );
      }
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
    } else if (part.text === undefined) {
      // 对象 part 但无任何已知内容域（inlineData/fileData/executableCode 等官方
      // part 类型、图像输出模型或网关私货，轮 31 #11）——与 anthropic「未知 type
      // 留证据」（轮 30 #3）口径对齐：只记键名集合不 stringify（防大体积 base64
      // 刷屏），无证据的空响应会误导排障
      log(`[llm] gemini 丢弃无已知内容域的 part（keys=${Object.keys(part).join(",")}）`);
    }
  }
  const response: ChatResponse = {
    text,
    toolCalls,
    // 从保留的调用推导（丢弃的幻觉调用不置位，否则 toolCalls 空却报 tool_call 误导排障）
    stopReason: mapFinishReason(
      isRecord(first) ? first.finishReason : undefined,
      toolCalls.length > 0,
      log,
    ),
    usage: mapUsage(json.usageMetadata),
  };
  if (reasoningText.length > 0) {
    response.reasoningText = reasoningText;
  }
  return response;
}

export function createGeminiProvider(config: ProviderConfig, deps: Required<LLMDeps>): LLMProvider {
  const capabilities = resolveCapabilities(config);
  // 合成 id 的实例级随机盐 + 自增序号（轮 15 #14）：fallback 切换
  //（client.ts trySwitchToFallback）会在会话中途重建 provider 实例，纯自增
  // 序号会在同一会话内复用 id（历史已存 gemini-call-0 时新实例再产出同 id）——
  // 盐前缀保证跨实例唯一（宿主可能以 toolCallId 作跨回合键）
  const synthSalt = Math.random().toString(36).slice(2, 8);
  let synthSeq = 0;
  // schema 清洗事件告警的去重集：工具 schema 逐请求固定，同一事件重复告警只有
  // 噪音；每条一次即保留「约束被清洗丢失」的排障线索。设条数上限防动态工具
  // schema（属性名随页面变化）在长生命周期实例上无界增长——达限留一次性提示
  //（轮 31 #5：运维需知道「事件已停止上报」这一事实本身），此后新事件静默
  const warnedSchemaIssues = new Set<string>();
  let warnedSchemaIssueCapReached = false;
  const onSchemaIssue = (detail: string): void => {
    if (warnedSchemaIssues.size >= SCHEMA_ISSUE_DEDUP_MAX) {
      if (!warnedSchemaIssueCapReached) {
        warnedSchemaIssueCapReached = true;
        deps.log(
          `[llm] gemini schema 告警去重集已达 ${SCHEMA_ISSUE_DEDUP_MAX} 条上限，后续清洗事件将不再上报`,
        );
      }
      return;
    }
    if (warnedSchemaIssues.has(detail)) {
      return;
    }
    warnedSchemaIssues.add(detail);
    deps.log(`[llm] gemini schema 清洗：${detail}（约束丢失，模型可能生成违反原 schema 的参数）`);
  };
  // 钳制告警实例级去重（轮 16 #4）：误配每请求都在发生，告警一次即可
  const onTemperatureClamp = makeOnceWarn(deps.log);
  // maxTokens 非法回退的实例级一次性告警（轮 18 #11）
  const onMaxTokensInvalid = makeOnceWarn(deps.log);
  // baseUrl 误配守卫族（轮 24 #4 起，轮 34 #6/#10 补全三形态）：/v1beta 结尾是
  // 官方 base 整段复制（拼出 /v1beta/v1beta → 404）；/v1 结尾是 OpenAI 形态跨
  // 协议复用（轮 23 #1 动机）；:generateContent 结尾是官方完整端点整段复制
  // ——三条守卫各自独立去重实例
  const onBaseUrlV1beta = makeOnceWarn(deps.log);
  const onBaseUrlOpenAiForm = makeOnceWarn(deps.log);
  const onBaseUrlEndpoint = makeOnceWarn(deps.log);
  // timeoutMs 非法值视为未设置的一次性告警（轮 37 #7，与 maxTokens 同观测口径）
  const onTimeoutInvalid = makeOnceWarn(deps.log);
  // assistant 历史 image 块丢弃的一次性告警（轮 38 #11，与 anthropic/openai 同步）
  const onAssistantImageDropped = makeOnceWarn(deps.log);
  const chat = async (req: ChatRequest): Promise<ChatResponse> => {
    assertValidMessages(req.messages, config.name);
    assertToolContract(req, config); // 轮 35 #13：forced 名不在 tools 是端点 400 形态，前置拦截
    // assistant 历史非 text 块丢弃的一次性告警（轮 38 #11，轮 39 #11/#12 收敛
    // common 单源 + #17 统计放宽非 text）：model 角色不接受 inlineData（透传即 400）
    warnDroppedAssistantNonTextBlocks(
      req.messages,
      onAssistantImageDropped,
      "gemini",
      "协议约束：model 角色不接受 inlineData",
    );
    // key 走头不走 URL query——避免 key 进日志/Referer（query ?key= 同样合法，不用）；
    // model 段编码：含空格/#/? 等字符时避免 URL 截断把配置问题变形为 Invalid URL/404
    const base = stripTrailingSlash(config.baseUrl);
    if (base.endsWith("/v1beta")) {
      onBaseUrlV1beta(
        `baseUrl 以 /v1beta 结尾，gemini 协议将拼接 ${base}/v1beta/models/…——疑似官方端点整段误配`,
      );
    } else if (base.endsWith("/v1")) {
      onBaseUrlOpenAiForm(
        `baseUrl 以 /v1 结尾，gemini 协议将拼接 ${base}/v1beta/models/…——疑似 OpenAI 形态误配`,
      );
    }
    if (base.endsWith(":generateContent")) {
      onBaseUrlEndpoint(
        `baseUrl 以 :generateContent 结尾，gemini 协议将拼接 ${base}/v1beta/models/…——疑似整段端点 URL 误配`,
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
      contents: toWireContents(req.messages, deps.log),
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
                  // 归一时同步剥离 type 域外键（轮 25 #7 + 轮 26 #5，轮 35 #7 改
                  // stripKeysOutsideTypeDomain 单源）：与 sanitize 收尾共用域表，
                  // 防两处清单漏同步（改一漏二）
                  if (sanitized.type !== "object") {
                    onSchemaIssue(
                      `顶层 parameters type=${String(sanitized.type)} 归一为 object（函数参数恒为命名参数集）`,
                    );
                    sanitized.type = "object";
                    stripKeysOutsideTypeDomain(sanitized, "object", onSchemaIssue);
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
      onInvalidTimeout: onTimeoutInvalid,
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
