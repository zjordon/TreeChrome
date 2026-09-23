// 三适配器共享的小件：isRecord / stripTrailingSlash / defaultTestConnection。
// 折叠连续 toolResult、块形状转换等协议差异逻辑不在此抽象（改一漏二的风险主要来自
// 逐字重复的小件与完全同构的探测逻辑）。

import type { ChatRequest, ChatResponse } from "../types.js";

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * 连通性检查的公共实现（webbrain 形状）：chat("Hi", maxTokens=5) 的成败包装。
 * 携带 10s 兜底超时——端点半开/黑洞（baseUrl 配错、代理挂起）时探测请求不能永久 pending。
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
      maxTokens: 5,
      timeoutMs: 10_000,
    });
    return { ok: true, model };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
