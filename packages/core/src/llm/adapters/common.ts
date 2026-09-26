// 三适配器共享的小件：isRecord / stripTrailingSlash / defaultTestConnection /
// temperatureEntry / collectToolResults（toolResult 段收集重排——纯同构骨架，
// 轮 37 #10 收敛于此防改一漏一）。块形状转换、wire 角色名等协议差异逻辑不在
// 此抽象（改一漏二的风险主要来自逐字重复的小件与完全同构的探测逻辑）。

import { DEFAULT_MAX_TOKENS, type ProviderConfig } from "../config.js";
import { LLMProtocolViolationError } from "../errors.js";
import type { LLMProtocol } from "../provider.js";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ToolCall,
  ToolResultMessage,
} from "../types.js";
import { ERROR_DETAIL_MAX } from "./http.js";

export { isRecord } from "../transforms.js";

/** toolResult.isError 无原生 wire 字段时的前缀约定（openai content / gemini
 * response 两协议共用，02 §3.2 映射表；轮 21 #3 单源防口径漂移） */
export const TOOL_RESULT_ERROR_PREFIX = "[error] ";

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * 收集紧随 assistant 的 toolResult 段并按 toolCalls 顺序重排（轮 37 #10 单源）：
 * anthropic toWireMessages 与 gemini toWireContents 的折叠骨架（Map 收集 + 按
 * 前置 assistant.toolCalls 顺序重排 + 配对过滤）逐字同构，仅结果块形状与 wire
 * 角色名是协议差异——骨架收敛防单点修补改一漏一（兜底跳过补日志轮 37 #8/#9
 * 即需双处同步的实例）。assertValidMessages 已保证完备配对，配对过滤仅为防御；
 * pairs 携带配对的 call（gemini 的 functionResponse 需回挂 call.signature）。
 * 防御分支同样留证据（轮 38 #16）：段内未匹配任何 call 的结果、calls 缺结果
 *（wire 缺 tool_result 同为端点 400 形态）经可选 log 上报——真实触发即校验与
 * 折叠逻辑漂移，与「丢弃必留证据」口径一致。
 */
export function collectToolResults(
  messages: ChatMessage[],
  from: number,
  calls: readonly ToolCall[],
  log?: (message: string) => void,
): { pairs: Array<{ call: ToolCall; result: ToolResultMessage }>; next: number } {
  const byId = new Map<string, ToolResultMessage>();
  let j = from;
  while (j < messages.length) {
    const cur = messages[j];
    if (cur.role !== "toolResult") {
      break;
    }
    byId.set(cur.toolCallId, cur);
    j += 1;
  }
  const pairs: Array<{ call: ToolCall; result: ToolResultMessage }> = [];
  for (const call of calls) {
    const result = byId.get(call.id);
    if (result !== undefined) {
      pairs.push({ call, result });
    }
  }
  if (log !== undefined) {
    for (const id of byId.keys()) {
      if (!calls.some((c) => c.id === id)) {
        log(
          `[llm] toolResult（${id}）未匹配前置 assistant 的 toolCalls，丢弃（canonical 校验漂移的防御分支）`,
        );
      }
    }
    if (pairs.length < calls.length) {
      log(
        `[llm] assistant 的 ${calls.length} 个 toolCall 仅配对 ${pairs.length} 条结果（wire 将缺失对应 tool_result，端点 400 形态）`,
      );
    }
  }
  return { pairs, next: j };
}

/** 连通性探测的输出上限（轮 35 #12 导出锚定）：16 是全协议安全最小值（o 系
 * max_completion_tokens 下限，传更小值会被端点 400） */
export const TEST_CONNECTION_MAX_TOKENS = 16;
/** 连通性探测兜底超时（轮 35 #12 导出锚定）：端点半开/黑洞时探测不能永久 pending */
export const TEST_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * 连通性检查的公共实现（webbrain 形状）：chat("Hi", maxTokens=16) 的成败包装。
 * maxTokens 取 16（非 webbrain 原形的 5）：OpenAI 推理型模型（o 系/gpt-5，
 * max_completion_tokens）输出上限最小值是 16，传 5 会被端点 400 拒绝——
 * 配置正确的卡片在探测中假性不可用。16 是全协议安全的最小值。
 * 携带 10s 兜底超时——端点半开/黑洞（baseUrl 配错、代理挂起）时探测不能永久 pending。
 */
export async function defaultTestConnection(
  chat: (req: ChatRequest) => Promise<ChatResponse>,
  model: string,
): Promise<{ ok: boolean; error?: string; model?: string }> {
  try {
    await chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "Hi" }] }],
      tools: null,
      maxTokens: TEST_CONNECTION_MAX_TOKENS,
      timeoutMs: TEST_CONNECTION_TIMEOUT_MS,
    });
    return { ok: true, model };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 工具契约前置校验（轮 35 #13 起，轮 36 #8 补工具名空串、轮 37 #14 补重名，三适配器共用）：
 * ① forced toolChoice 名不在本次 tools 中、② 工具 name 空串、③ 工具 name 重复
 * ——均为端点硬 400
 * 形态（非 infra 不重试还误触 fallback 切换），调用方数据病态在适配器层拦截
 * 而非烧 400 后错误归因（与 toolCall id/name 空串的 canonical 拦截同口径；
 * assertValidMessages 只裁决消息序列）。名字字符集/长度按协议各异的约束不在
 * 共享层收口（最严统一拦截会误伤协议间差异），由各端点 400 兜底
 */
export function assertToolContract(req: ChatRequest, config: ProviderConfig): void {
  const forced = req.toolChoice?.kind === "forced" ? req.toolChoice : undefined;
  if (
    forced !== undefined &&
    req.tools !== null &&
    req.tools.length > 0 &&
    !req.tools.some((t) => t.name === forced.name)
  ) {
    throw new LLMProtocolViolationError(
      `forced toolChoice（${forced.name}）不在请求 tools 中（端点 400 形态）`,
      { provider: config.name },
    );
  }
  // 工具名空串与轮 18 #13 的 toolCall name 空串对称（anthropic ^[a-zA-Z0-9_-]{1,128}$
  // 下限即非空；openai/gemini 同为必填非空）
  const tools = req.tools ?? [];
  if (tools.some((t) => t.name === "")) {
    throw new LLMProtocolViolationError(`工具 name 为空串（端点 400 形态）`, {
      provider: config.name,
    });
  }
  // 工具重名（轮 37 #14）：三协议端点均校验 tools 名字唯一（重复即硬 400，非
  // infra 不重试还误触 fallback 切换）——P4 registry 合并场景下重名是现实病态
  if (new Set(tools.map((t) => t.name)).size !== tools.length) {
    throw new LLMProtocolViolationError(`工具 name 存在重复（端点 400 形态）`, {
      provider: config.name,
    });
  }
}

/**
 * temperature 回退链（请求级 ?? 卡片级，与 maxTokens 同款；两级都缺省则不发——
 * 新契约模型 400 地雷的缺省口径）。三适配器同构语义，非协议差异，收敛于此。
 * 取值按协议上限钳制到 [0, max]（轮 12 #7）：anthropic 要求 0-1、openai/gemini
 * 0-2——卡片误配（如智谱 anthropic 兼容卡配 1.5）会整链每请求硬 400（非 infra
 * 不重试），与「主动拆解 400 地雷」的口径一致（maxTokens=16 同款思路）。
 */
const PROTOCOL_MAX_TEMPERATURE: Record<LLMProtocol, number> = {
  "anthropic-messages": 1,
  "openai-completions": 2,
  gemini: 2,
};

export function temperatureEntry(
  req: ChatRequest,
  config: ProviderConfig,
  onClamp?: (message: string) => void,
): Record<string, unknown> {
  const temperature = req.temperature ?? config.temperature;
  // 非有限数值（NaN/Infinity）不发：NaN 序列化成 null、Infinity 溢出上送均是
  // 端点 400（轮 13 #5）——钳制防护的闭环补齐；必留证据（轮 26 #3）：同为宿主
  // parseFloat 类误配，静默吞掉与 onClamp/resolveMaxTokens 的观测口径不一致；
  // 去重由调用方注入的回调负责
  if (temperature === undefined || !Number.isFinite(temperature)) {
    if (temperature !== undefined && onClamp !== undefined) {
      onClamp(`temperature ${temperature} 非有限数值（NaN/Infinity），不发送（${config.name}）`);
    }
    return {};
  }
  const max = PROTOCOL_MAX_TEMPERATURE[config.protocol];
  const clamped = Math.min(Math.max(temperature, 0), max);
  // 钳制发生必留证据（轮 16 #4）：静默吞掉后模型行为与配置不符且无线索——与
  // 「丢弃/清洗必留证据」的观测口径一致；去重由调用方注入的回调负责
  if (clamped !== temperature && onClamp !== undefined) {
    onClamp(
      `temperature ${temperature} 超出协议范围 [0, ${max}]，已钳制为 ${clamped}（${config.name}）`,
    );
  }
  return { temperature: clamped };
}

/** 实例级一次性告警包装（轮 16 #4）：temperatureEntry 每请求调用，agent 长循环下
 * 同一卡片误配不该每步刷屏——每 provider 实例只警告一次（同 gemini warnedSchemaIssues） */
export function makeOnceWarn(log: (message: string) => void): (message: string) => void {
  let warned = false;
  return (message) => {
    if (warned) {
      return;
    }
    warned = true;
    log(`[llm] WARNING: ${message}`);
  };
}

/** image 媒体类型别名表（轮 34 #4 扩）：image/jpg 是 jpeg 常见别名、image/x-png
 * 是 PNG 历史遗留别名——anthropic/gemini 官方均为封闭枚举、裸透传即 400 */
const IMAGE_MIME_ALIAS: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/x-png": "image/png",
};

/** image 媒体类型别名归一（轮 28 #3/#5 单源化，三适配器共用防 mime 口径漂移）：
 * MIME 类型大小写不敏感（RFC 2046），端点枚举均小写——统一小写归一后再查别名表 */
export function normalizeImageMime(mimeType: string): string {
  const lowered = mimeType.toLowerCase();
  return IMAGE_MIME_ALIAS[lowered] ?? lowered;
}

/**
 * 丢弃类日志的安全串化（轮 17 #5/#6/#14/#15）：网关畸形输出长度无上限，直接
 * stringify 会无界膨胀日志；JSON.stringify(undefined) 返回 undefined（非字符串）
 * 不能直挂 .slice——String 包装 + 与 http.ts 错误体同源截断
 */
export function stringifyForLog(value: unknown): string {
  try {
    return String(JSON.stringify(value)).slice(0, ERROR_DETAIL_MAX);
  } catch {
    // BigInt/循环引用（JSON.stringify 既知抛点）——入参不全是网关 JSON 来源
    //（schema-sanitize 以宿主程序化构造的 parameters 原值为入调删除上报），串化
    // 兜底不让「删除留证据」路径自身崩溃（轮 37 #6）；网关 JSON 来源行为不变
    return String(value).slice(0, ERROR_DETAIL_MAX);
  }
}

/**
 * 输出上限解析（轮 18 #10/#11/#12）：卡片值经宿主设置层 parseFloat 等产出时
 * 可能为 NaN/Infinity/0——NaN 序列化成 null、其余上送均为端点硬 400（非 infra
 * 不重试，还可能误触 fallback 单向切换），与 temperature NaN 守卫（轮 13 #5）
 * 同款雷；三协议 max_tokens 均必填，不能走「缺省不发」——回退 DEFAULT_MAX_TOKENS
 * 并经 onInvalid 一次性告警（适配器注入 makeOnceWarn 实例）
 */
export function resolveMaxTokens(
  req: ChatRequest,
  config: ProviderConfig,
  onInvalid: (message: string) => void,
): number {
  const value = req.maxTokens ?? config.maxTokens;
  // 三协议上限字段均整型（anthropic max_tokens / openai 双轨 / gemini int64）：
  // 小数（宿主 parseFloat 产物）与 NaN/0 同为端点硬 400（轮 20 #12 补齐整数维度，
  // isInteger 蕴含 isFinite）
  if (!Number.isInteger(value) || value <= 0) {
    onInvalid(`maxTokens 非正整数值（${value}），回退 ${DEFAULT_MAX_TOKENS}（${config.name}）`);
    return DEFAULT_MAX_TOKENS;
  }
  return value;
}
