// 三适配器共享的小件：isRecord / stripTrailingSlash / defaultTestConnection /
// temperatureEntry。折叠连续 toolResult、块形状转换等协议差异逻辑不在此抽象
//（改一漏二的风险主要来自逐字重复的小件与完全同构的探测逻辑）。

import type { ProviderConfig } from "../config.js";
import type { LlmProtocol } from "../provider.js";
import type { ChatRequest, ChatResponse } from "../types.js";
import { ERROR_DETAIL_MAX } from "./http.js";

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

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
  // 非有限数值（NaN 等）不发：Math.min/max 对 NaN 透传，JSON 序列化成 null 上送
  // 会被端点 400（Infinity 反而能被正确钳制）——钳制防护的闭环补齐（轮 13 #5）
  if (temperature === undefined || !Number.isFinite(temperature)) {
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

/**
 * 丢弃类日志的安全串化（轮 17 #5/#6/#14/#15）：网关畸形输出长度无上限，直接
 * stringify 会无界膨胀日志；JSON.stringify(undefined) 返回 undefined（非字符串）
 * 不能直挂 .slice——String 包装 + 与 http.ts 错误体同源截断
 */
export function stringifyForLog(value: unknown): string {
  return String(JSON.stringify(value)).slice(0, ERROR_DETAIL_MAX);
}
