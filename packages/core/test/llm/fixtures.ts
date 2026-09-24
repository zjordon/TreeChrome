// 跨测试文件共享的轻量夹具（评审 2.14：AGENT_TOOL 与 stubDeps 四处逐字重复）。
// 各协议卡片仍留在各自文件——协议/模型/baseUrl 是被测差异本身，共享反而抹平语义。

import type { LLMProvider, LlmDeps, ProviderConfig, ToolDefinition } from "../../src/index.js";
import { MockFetch } from "./mock-fetch.js";

export const AGENT_TOOL: ToolDefinition = {
  name: "agent_response",
  description: "respond",
  parameters: { type: "object", properties: { action: { type: "object" } } },
};

/** ≥100 字符的长 URL（URL 缩写/还原测试共用；transform 契约阈值 URL_MIN_LENGTH=100） */
export const LONG_URL = `https://example.com/${"a".repeat(90)}`;

/** 适配器单测的缺省 deps：mock fetch + 零耗时 sleep + 静音日志（缺省 console.warn 会刷屏） */
export function stubDeps(mock: MockFetch): Required<LlmDeps> {
  return { fetch: mock.fetch, now: () => 0, sleep: async () => {}, log: () => {} };
}

/** 三适配器测试共用的装配样板（卡片由调用方传入——协议差异不共享的既定取舍不变） */
export function setupProvider(
  factory: (config: ProviderConfig, deps: Required<LlmDeps>) => LLMProvider,
  card: ProviderConfig,
  over: Partial<ProviderConfig> = {},
): { mock: MockFetch; provider: LLMProvider } {
  const mock = new MockFetch();
  const provider = factory({ ...card, ...over }, stubDeps(mock));
  return { mock, provider };
}
