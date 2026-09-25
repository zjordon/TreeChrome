// 跨测试文件共享的轻量夹具（评审 2.14：AGENT_TOOL 与 stubDeps 四处逐字重复）。
// 各协议卡片仍留在各自文件——协议/模型/baseUrl 是被测差异本身，共享反而抹平语义。

import type { LLMProvider, LlmDeps, ProviderConfig, ToolDefinition } from "../../src/index.js";
import { URL_MIN_LENGTH } from "../../src/llm/transforms.js";
import { MockFetch } from "./mock-fetch.js";

export const AGENT_TOOL: ToolDefinition = {
  name: "agent_response",
  description: "respond",
  parameters: { type: "object", properties: { action: { type: "object" } } },
};

// 长度派生自核心阈值（+10 余量，轮 24 #2）：URL_MIN_LENGTH 上调时夹具自动跟随，
// 缩写/还原用例不会静默失去覆盖
const LONG_URL_HEAD = "https://example.com/";
export const LONG_URL = LONG_URL_HEAD + "a".repeat(URL_MIN_LENGTH - LONG_URL_HEAD.length + 10);

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

/** 带日志采集的装配变体（丢弃类/清洗类告警断言用例共用，轮 13 #2） */
export function setupProviderWithLogs(
  factory: (config: ProviderConfig, deps: Required<LlmDeps>) => LLMProvider,
  card: ProviderConfig,
  over: Partial<ProviderConfig> = {},
): { mock: MockFetch; logs: string[]; provider: LLMProvider } {
  const mock = new MockFetch();
  const logs: string[] = [];
  const provider = factory({ ...card, ...over }, { ...stubDeps(mock), log: (m) => logs.push(m) });
  return { mock, logs, provider };
}
