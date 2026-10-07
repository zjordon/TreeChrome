// agent-boot 系测试共享件：settings fixture / 假 transport / 死端点 LLMClient
// （构造期不触网）。skill-source.test.ts 与 agent-boot.test.ts 复用。

import type { CdpTransport } from "@tw/core";
import { LLMClient } from "@tw/core";
import type { HostSettings } from "../src/settings.js";

export const settings = (over: Partial<HostSettings> = {}): HostSettings => ({
  llm: {
    apiKey: "k",
    model: "glm-test",
    baseUrl: "http://127.0.0.1:1",
    maxTokens: 64,
    outputMode: "standard",
    fallback: null,
  },
  browser: { cdpHost: "localhost", cdpPort: 9222, wsUrl: "ws://stub", downloadsPath: "D:/tmp/dl" },
  agent: {},
  skillsDir: null, // 测试缺省关闭 skill 源（不触盘）
  ...over,
});

export const fakeTransport = (): CdpTransport => ({
  send: async () => {
    throw new Error("fake transport: not scripted");
  },
  on: () => () => {},
  stop: () => {},
});

export const deadLlm = () =>
  new LLMClient({
    name: "test",
    protocol: "anthropic-messages",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "k",
    model: "glm-test",
    maxTokens: 64,
  });
