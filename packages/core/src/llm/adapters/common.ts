// 三适配器共享的小件：isRecord / stripTrailingSlash / defaultTestConnection /
// temperatureEntry。折叠连续 toolResult、块形状转换等协议差异逻辑不在此抽象
//（改一漏二的风险主要来自逐字重复的小件与完全同构的探测逻辑）。

import { DEFAULT_MAX_TOKENS, type ProviderConfig } from "../config.js";
import type { LlmProtocol } from "../provider.js";
import type { ChatRequest, ChatResponse } from "../types.js";
import { ERROR_DETAIL_MAX } from "./http.js";

export { isRecord } from "../transforms.js";

/** toolResult.isError 无原生 wire 字段时的前缀约定（openai content / gemini
 * response 两协议共用，02 §3.2 映射表；轮 21 #3 单源防口径漂移） */
export const TOOL_RESULT_ERROR_PREFIX = "[error] ";

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

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
      maxTokens: 16,
      timeoutMs: 10_000,
    });
    return { ok: true, model };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * temperature 回退链（请求级 ?? 卡片级，与 maxTokens 同款；两级都缺省则不发——
 * 新契约模型 400 地雷的缺省口径）。三适配器同构语义，非协议差异，收敛于此。
 * 取值按协议上限钳制到 [0, max]（轮 12 #7）：anthropic 要求 0-1、openai/gemini
 * 0-2——卡片误配（如智谱 anthropic 兼容卡配 1.5）会整链每请求硬 400（非 infra
 * 不重试），与「主动拆解 400 地雷」的口径一致（maxTokens=16 同款思路）。
 */
const PROTOCOL_MAX_TEMPERATURE: Record<LlmProtocol, number> = {
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
  return String(JSON.stringify(value)).slice(0, ERROR_DETAIL_MAX);
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
