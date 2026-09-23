// 跨测试文件共享的轻量夹具（评审 2.14：AGENT_TOOL 与 stubDeps 四处逐字重复）。
// 各协议卡片仍留在各自文件——协议/模型/baseUrl 是被测差异本身，共享反而抹平语义。

import type { LlmDeps, ToolDefinition } from "../../src/index.js";
import type { MockFetch } from "./mock-fetch.js";

export const AGENT_TOOL: ToolDefinition = {
  name: "agent_response",
  description: "respond",
  parameters: { type: "object", properties: { action: { type: "object" } } },
};

/** 适配器单测的缺省 deps：mock fetch + 零耗时 sleep + 静音日志（缺省 console.warn 会刷屏） */
export function stubDeps(mock: MockFetch): Required<LlmDeps> {
  return { fetch: mock.fetch, now: () => 0, sleep: async () => {}, log: () => {} };
}
