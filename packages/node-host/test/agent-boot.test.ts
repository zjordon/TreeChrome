// assembleAgent / runAgent / autoAllowSummaryLine：装配接线与 one-shot 早退/失败路径
// （无网络：transport 用假工厂，LLM 用真 LLMClient+死端点卡片——构造期不触网）。

import {
  type AutoAllowPolicy,
  type BrowserSession,
  type CdpTransport,
  EventBus,
  LLMClient,
  PolicyGate,
} from "@tw/core";
import { describe, expect, test, vi } from "vitest";
import {
  type AssembledAgent,
  assembleAgent,
  autoAllowSummaryLine,
  finalizeAssembled,
  type HostSettings,
  runAgent,
} from "../src/index.js";

const settings = (over: Partial<HostSettings> = {}): HostSettings => ({
  llm: {
    apiKey: "k",
    model: "glm-test",
    baseUrl: "http://127.0.0.1:1",
    maxTokens: 64,
  },
  browser: { cdpHost: "localhost", cdpPort: 9222, wsUrl: "ws://stub" },
  agent: {},
  ...over,
});

const fakeTransport = (): CdpTransport => ({
  send: async () => {
    throw new Error("fake transport: not scripted");
  },
  on: () => () => {},
  stop: () => {},
});

const deadLlm = () =>
  new LLMClient({
    name: "test",
    protocol: "anthropic-messages",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "k",
    model: "glm-test",
    maxTokens: 64,
  });

describe("assembleAgent", () => {
  test("装配零件：缺省 AutoAllow 门 + 自建 bus + NodeFs；console:false 静默", () => {
    const assembled = assembleAgent({
      task: "t",
      settings: settings(),
      wsUrl: "ws://stub",
      console: false,
      llm: deadLlm(),
      transportFactory: async () => fakeTransport(),
    });
    expect(assembled.agent.task).toBe("t");
    expect(assembled.autoAllow).not.toBeNull();
    expect(assembled.bus).not.toBeNull();
    // Agent 构造完成（systemPrompt/toolSchema 装配即离线全通）
    expect(assembled.agent.systemPrompt.length).toBeGreaterThan(0);
  });

  test("注入自定义 policy 时 autoAllow 为 null（记账汇总不适用）", () => {
    const gate = new PolicyGate({
      requestPermission: async () => "allow-once",
      confirmSubmit: async () => true,
    });
    const assembled = assembleAgent({
      task: "t",
      settings: settings(),
      wsUrl: "ws://stub",
      console: false,
      llm: deadLlm(),
      transportFactory: async () => fakeTransport(),
      policy: gate,
    });
    expect(assembled.autoAllow).toBeNull();
    expect(assembled.agent.policy).toBe(gate);
  });

  test("注入自定义 eventBus 时复用（不新建）", () => {
    const bus = new EventBus({ log: () => {} });
    const assembled = assembleAgent({
      task: "t",
      settings: settings(),
      wsUrl: "ws://stub",
      console: false,
      llm: deadLlm(),
      transportFactory: async () => fakeTransport(),
      eventBus: bus,
    });
    expect(assembled.bus).toBe(bus);
  });

  test("agent 覆盖透传（settings.agent 只含显式键）", () => {
    const assembled = assembleAgent({
      task: "t",
      settings: settings({ agent: { maxSteps: 9, useVision: true } }),
      wsUrl: "ws://stub",
      console: false,
      llm: deadLlm(),
      transportFactory: async () => fakeTransport(),
    });
    expect(assembled.agent.settings.maxSteps).toBe(9);
    expect(assembled.agent.settings.useVision).toBe(true);
    expect(assembled.agent.settings.maxFailures).toBe(5); // 未覆盖键走核心默认
  });

  test("缺省分支：不注入 llm/transportFactory 也能装配（卡片构造 LLMClient + wsUrl 工厂闭包）", () => {
    const assembled = assembleAgent({
      task: "t",
      settings: settings(),
      wsUrl: "ws://stub",
      console: false,
    });
    expect(assembled.agent.systemPrompt.length).toBeGreaterThan(0);
  });
});

describe("runAgent", () => {
  test("缺 key：抛 Python 原文案", async () => {
    const noKey = settings();
    noKey.llm.apiKey = "";
    await expect(runAgent({ task: "t", settings: noKey, console: false })).rejects.toThrow(
      "Error: Set ZHIPU_API_KEY environment variable",
    );
  });

  test("Chrome 发现失败：抛 Python 同款文案 + 详情", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(
        runAgent({
          task: "t",
          settings: settings({ browser: { cdpHost: "localhost", cdpPort: 9222, wsUrl: null } }),
          console: false,
        }),
      ).rejects.toThrow(
        /Error: Cannot connect to Chrome\. Is it running with --remote-debugging-port=9222\?[\s\S]*发现失败详情/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("缺省 env 装载（applyDotEnv+loadHostSettings）+ wsUrl 解析 + transport 失败透传 + finally 收口", async () => {
    const prevKey = process.env.ZHIPU_API_KEY;
    const prevWs = process.env.CDP_WS_URL;
    process.env.ZHIPU_API_KEY = "from-env";
    process.env.CDP_WS_URL = "ws://from-env";
    try {
      await expect(
        runAgent({
          task: "t",
          console: false,
          transportFactory: async () => {
            throw new Error("transport boom");
          },
        }),
      ).rejects.toThrow("transport boom"); // 到达装配与 run——证明 env 装载与 wsUrl 直连解析成功
    } finally {
      if (prevKey === undefined) {
        delete process.env.ZHIPU_API_KEY;
      } else {
        process.env.ZHIPU_API_KEY = prevKey;
      }
      if (prevWs === undefined) {
        delete process.env.CDP_WS_URL;
      } else {
        process.env.CDP_WS_URL = prevWs;
      }
    }
  });
  test("注入自定义 policy：autoAllow 为 null 的收口路径（transport 失败透传）", async () => {
    await expect(
      runAgent({
        task: "t",
        settings: settings(),
        console: false,
        log: () => {},
        transportFactory: async () => {
          throw new Error("boom");
        },
        policy: new PolicyGate({
          requestPermission: async () => "deny",
          confirmSubmit: async () => false,
        }),
      }),
    ).rejects.toThrow("boom");
  });
});

describe("finalizeAssembled", () => {
  const stubAssembled = (over: {
    requests?: Array<{ capability: string; host: string }>;
    closeThrows?: boolean;
    stopThrows?: boolean;
  }): AssembledAgent =>
    ({
      autoAllow: { requests: over.requests ?? [] } as AutoAllowPolicy,
      bus: {
        close: over.closeThrows
          ? () => {
              throw new Error("close boom");
            }
          : () => {},
      } as unknown as EventBus,
      browser: {
        stop: over.stopThrows
          ? async () => {
              throw new Error("stop boom");
            }
          : async () => {},
      } as unknown as BrowserSession,
    }) as unknown as AssembledAgent;

  test("有请求且 console 开：打印汇总（自定义 log）；close/stop 抛错被吞", async () => {
    const lines: string[] = [];
    await finalizeAssembled(
      stubAssembled({
        requests: [{ capability: "CLICK", host: "a.com" }],
        closeThrows: true,
        stopThrows: true,
      }),
      { console: true, log: (m) => lines.push(m) },
    );
    expect(lines).toEqual(["[权限门] AutoAllow 放行 1 次：CLICK@a.com"]);
  });

  test("console 关或零请求：不打印；默认 log 通道分支", async () => {
    await finalizeAssembled(stubAssembled({ requests: [{ capability: "TYPE", host: "b" }] }), {
      console: false,
    });
    await finalizeAssembled(stubAssembled({}));
  });
});

describe("autoAllowSummaryLine", () => {
  test("零请求 null", () => {
    expect(autoAllowSummaryLine([])).toBeNull();
  });

  test("计数 + (capability@host) 去重保序", () => {
    expect(
      autoAllowSummaryLine([
        { capability: "CLICK", host: "a.com" },
        { capability: "CLICK", host: "a.com" },
        { capability: "TYPE", host: "b.com" },
      ]),
    ).toBe("[权限门] AutoAllow 放行 3 次：CLICK@a.com、TYPE@b.com");
  });
});
