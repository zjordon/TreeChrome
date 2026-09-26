// 跨测试文件共享的轻量夹具（评审 2.14：AGENT_TOOL 与 stubDeps 四处逐字重复）。
// 各协议卡片仍留在各自文件——协议/模型/baseUrl 是被测差异本身，共享反而抹平语义。

import type {
  AssistantMessage,
  ChatMessage,
  ChatRequest,
  LLMDeps,
  LLMProvider,
  ProviderConfig,
  ToolDefinition,
  UserMessage,
} from "../../src/index.js";
import { URL_MIN_LENGTH } from "../../src/llm/transforms.js";
import { MockFetch, type MockResponseSpec } from "./mock-fetch.js";

export const AGENT_TOOL: ToolDefinition = {
  name: "agent_response",
  description: "respond",
  parameters: { type: "object", properties: { action: { type: "object" } } },
};

// 长度派生自核心阈值（+10 余量，轮 24 #2）：URL_MIN_LENGTH 上调时夹具自动跟随，
// 缩写/还原用例不会静默失去覆盖
const LONG_URL_HEAD = "https://example.com/";
export const LONG_URL = LONG_URL_HEAD + "a".repeat(URL_MIN_LENGTH - LONG_URL_HEAD.length + 10);

/** 适配器单测的缺省 deps：mock fetch + 零耗时 sleep + 静音日志（缺省 console.warn 会刷屏）。
 * 仅 assemble 内部消费（适配器单测经 setupProvider 间接使用），非导出面（轮 34 #8） */
function stubDeps(mock: MockFetch): Required<LLMDeps> {
  return { fetch: mock.fetch, now: () => 0, sleep: async () => {}, log: () => {} };
}

/** 角色收窄辅助（轮 34 #2/#3，与 assertOk 同风格）：替代 client/transforms 两文件
 * 约 7 处逐字重复的 `role !== ...` unreachable 守卫，失败信息携带实际 role */
export function asUser(m: ChatMessage, at = 0): UserMessage {
  if (m.role !== "user") {
    throw new Error(`asUser: messages[${at}] 应为 user，实际 ${m.role}`);
  }
  return m;
}

export function asAssistant(m: ChatMessage, at = 0): AssistantMessage {
  if (m.role !== "assistant") {
    throw new Error(`asAssistant: messages[${at}] 应为 assistant，实际 ${m.role}`);
  }
  return m;
}

/** 三适配器测试共用的装配样板（卡片由调用方传入——协议差异不共享的既定取舍不变；
 * log 注入点差异由 setupProvider / setupProviderWithLogs 分化，轮 31 #2 收敛装配主体） */
function assemble(
  factory: (config: ProviderConfig, deps: Required<LLMDeps>) => LLMProvider,
  card: ProviderConfig,
  over: Partial<ProviderConfig>,
  log?: (message: string) => void,
): { mock: MockFetch; provider: LLMProvider } {
  const mock = new MockFetch();
  const deps = log === undefined ? stubDeps(mock) : { ...stubDeps(mock), log };
  return { mock, provider: factory({ ...card, ...over }, deps) };
}

export function setupProvider(
  factory: (config: ProviderConfig, deps: Required<LLMDeps>) => LLMProvider,
  card: ProviderConfig,
  over: Partial<ProviderConfig> = {},
): { mock: MockFetch; provider: LLMProvider } {
  return assemble(factory, card, over);
}

/** 阴性对照共用（轮 43 #3，三适配器约 6 处同构样板收敛）：真发一请求后
 *  返回关键词命中数——调用方 toBe(0) 断言（夹具零断言纪律） */
export async function logCountAfterChat(
  assembled: { mock: MockFetch; logs: string[]; provider: LLMProvider },
  spec: MockResponseSpec,
  req: ChatRequest,
  keyword: string,
): Promise<number> {
  assembled.mock.queueMany(spec);
  await assembled.provider.chat(req);
  return assembled.logs.filter((m) => m.includes(keyword)).length;
}

/** 带日志采集的装配变体（丢弃类/清洗类告警断言用例共用，轮 13 #2） */
export function setupProviderWithLogs(
  factory: (config: ProviderConfig, deps: Required<LLMDeps>) => LLMProvider,
  card: ProviderConfig,
  over: Partial<ProviderConfig> = {},
): { mock: MockFetch; logs: string[]; provider: LLMProvider } {
  const logs: string[] = [];
  const { mock, provider } = assemble(factory, card, over, (m) => logs.push(m));
  return { mock, logs, provider };
}
