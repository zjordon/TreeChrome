// assembleAgent / runAgent / autoAllowSummaryLine / buildProviderCard：装配接线与
// one-shot 早退/失败路径（无网络：transport 用假工厂，LLM 用真 LLMClient+死端点
// 卡片——构造期不触网）。

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AutoAllowPolicy,
  type BrowserSession,
  DEFAULT_MAX_TOKENS,
  EventBus,
  LLMClient,
  PolicyGate,
} from "@tw/core";
import { describe, expect, test, vi } from "vitest";
import {
  type AssembledAgent,
  assembleAgent,
  autoAllowSummaryLine,
  buildProviderCard,
  buildTaskSkillCard,
  DEFAULT_LLM_BASE_URL,
  finalizeAssembled,
  runAgent,
} from "../src/index.js";
import { deadLlm, fakeTransport, settings } from "./agent-boot-helpers.js";

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

  test("taskSkillLlm 三态（Python task_skill_llm 镜像）：settings 驱动构造 / null=复用主 llm / 显式注入位优先", () => {
    // settings.llm.taskSkill 非空 → 独立 LLMClient（构造期不触网）
    const withCard = assembleAgent({
      task: "t",
      settings: settings({
        llm: {
          apiKey: "k",
          model: "main",
          baseUrl: "http://127.0.0.1:1",
          maxTokens: 64,
          outputMode: "standard",
          fallback: null,
          taskSkill: { model: "matcher-model" },
        },
      }),
      wsUrl: "ws://stub",
      console: false,
      llm: deadLlm(),
      transportFactory: async () => fakeTransport(),
    });
    expect(withCard.agent.taskSkillLlm).toBeInstanceOf(LLMClient);

    // taskSkill=null 且未注入 → null（agent 侧复用主 llm）
    const off = assembleAgent({
      task: "t",
      settings: settings(),
      wsUrl: "ws://stub",
      console: false,
      llm: deadLlm(),
      transportFactory: async () => fakeTransport(),
    });
    expect(off.agent.taskSkillLlm).toBeNull();

    // 显式注入位优先（即使 settings 有 taskSkill 卡）
    const explicit = deadLlm();
    const injected = assembleAgent({
      task: "t",
      settings: settings(),
      wsUrl: "ws://stub",
      console: false,
      llm: deadLlm(),
      transportFactory: async () => fakeTransport(),
      taskSkillLlm: explicit,
    });
    expect(injected.agent.taskSkillLlm).toBe(explicit);
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
    // 未覆盖时浏览器/Agent 走核心默认（fast_agent.py 对照组）
    expect(assembled.browser.waitBetweenActionsS).toBe(0);
    expect(assembled.agent.waitBetweenActionsS).toBe(0);
    expect(assembled.agent.outputMode).toBe("standard");
  });

  test("browser 时延覆盖落 BrowserSession、llm.outputMode 落卡片（fast_agent 接线）", () => {
    const assembled = assembleAgent({
      task: "t",
      settings: settings({
        llm: {
          apiKey: "k",
          model: "glm-test",
          baseUrl: "http://127.0.0.1:1",
          maxTokens: 64,
          outputMode: "flash",
          fallback: null,
          taskSkill: null,
        },
        browser: {
          cdpHost: "localhost",
          cdpPort: 9222,
          wsUrl: "ws://stub",
          waitBetweenActions: 0.1,
          pageSettleTimeout: 0.5,
          downloadsPath: "D:/tmp/dl",
        },
      }),
      wsUrl: "ws://stub",
      console: false,
      transportFactory: async () => fakeTransport(),
    });
    expect(assembled.browser.waitBetweenActionsS).toBe(0.1);
    expect(assembled.agent.waitBetweenActionsS).toBe(0.1); // Agent 构造快照（agent.py:93）
    expect(assembled.agent.outputMode).toBe("flash"); // 卡片 → LLMClient → Agent 快照
    const schema = assembled.agent.toolSchema as {
      input_schema: { required: string[] };
    };
    expect(schema.input_schema.required).toEqual(["action"]); // flash schema 形态
  });

  test("downloadsPath/sensitiveData/extractLlm 透传落 Agent（features 批 F3）", () => {
    const extractLlm = deadLlm();
    const assembled = assembleAgent({
      task: "填 <x_name>",
      settings: settings(),
      wsUrl: "ws://stub",
      console: false,
      extractLlm,
      sensitiveData: { "<x_name>": "real-name" },
      transportFactory: async () => fakeTransport(),
    });
    expect(assembled.agent.downloadsPath).toBe("D:/tmp/dl");
    expect(assembled.agent.tools.ctx.extractClient).toBe(extractLlm);
    // sensitive：safeTask 占位替换 + 归一化字典（Agent.normalizeSensitiveData 扁平形态）
    expect(assembled.agent.safeTask).toBe("填 <x_name>");
    expect(assembled.agent.sensitiveDataRaw).toEqual({
      "<x_name>": { value: "real-name", urls: null },
    });
    // 对照：不注入时 extractClient 复用主 llm、sensitiveDataRaw 为 null
    const plain = assembleAgent({
      task: "t",
      settings: settings(),
      wsUrl: "ws://stub",
      console: false,
      transportFactory: async () => fakeTransport(),
    });
    expect(plain.agent.tools.ctx.extractClient).toBe(plain.agent.llm);
    expect(plain.agent.sensitiveDataRaw).toBeNull();
  });

  test("tools 透传（第三批 C2-1）：注入实例落 agent.tools 身份；缺省自建 25 动作面", async () => {
    const { Tools } = await import("@tw/core");
    const custom = new Tools({ log: () => {} });
    custom.registry.register({
      name: "count_words",
      description: "Count words (test).",
      params: {
        name: "CountParams",
        fields: [{ name: "text", type: "string", required: true }],
      },
      handler: async () => null,
      terminatesSequence: false,
    });
    const assembled = assembleAgent({
      task: "t",
      settings: settings(),
      wsUrl: "ws://stub",
      console: false,
      tools: custom,
      transportFactory: async () => fakeTransport(),
    });
    expect(assembled.agent.tools).toBe(custom); // 身份——Agent 不自建
    expect(assembled.agent.tools.registry.actions.has("count_words")).toBe(true);
    expect(assembled.agent.tools.registry.actions.size).toBe(26); // 默认 25 + 自定义 1

    const plain = assembleAgent({
      task: "t",
      settings: settings(),
      wsUrl: "ws://stub",
      console: false,
      transportFactory: async () => fakeTransport(),
    });
    expect(plain.agent.tools).not.toBe(custom);
    expect(plain.agent.tools.registry.actions.size).toBe(25);
  });
});

describe("buildProviderCard（fallback 卡面）", () => {
  test("无 fallback：卡片不挂 fallback 键值（null）", () => {
    const card = buildProviderCard(settings().llm);
    expect(card.name).toBe("zhipu-anthropic");
    expect(card.protocol).toBe("anthropic-messages");
    expect(card.fallback).toBeNull();
  });

  test("有 fallback：完整独立卡（maxTokens 恒 DEFAULT_MAX_TOKENS）", () => {
    const card = buildProviderCard(
      settings({
        llm: {
          apiKey: "k",
          model: "glm-test",
          baseUrl: "http://127.0.0.1:1",
          maxTokens: 64,
          outputMode: "standard",
          fallback: { model: "glm-4-flash", apiKey: "k", baseUrl: "http://127.0.0.1:1" },
          taskSkill: null,
        },
      }).llm,
    );
    expect(card.fallback).toEqual({
      name: "zhipu-anthropic-fallback",
      protocol: "anthropic-messages",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "k",
      model: "glm-4-flash",
      maxTokens: DEFAULT_MAX_TOKENS,
    });
  });

  test("fallback 部分覆盖：key/baseUrl 未设（含空串）时复用主卡（overrides 形态）", () => {
    const card = buildProviderCard({
      apiKey: "main-key",
      model: "glm-test",
      baseUrl: "http://main.example",
      maxTokens: 64,
      outputMode: "standard",
      fallback: { model: "glm-4-flash", apiKey: "", baseUrl: "" },
      taskSkill: null,
    });
    expect(card.fallback).toMatchObject({
      model: "glm-4-flash",
      apiKey: "main-key",
      baseUrl: "http://main.example",
      maxTokens: DEFAULT_MAX_TOKENS,
    });
    const card2 = buildProviderCard({
      apiKey: "main-key",
      model: "glm-test",
      baseUrl: "http://main.example",
      maxTokens: 64,
      outputMode: "standard",
      fallback: { model: "m2" },
      taskSkill: null,
    });
    expect(card2.fallback).toMatchObject({ model: "m2", apiKey: "main-key" });
  });
});

describe("buildTaskSkillCard（匹配器专用卡面，config.py:575-583）", () => {
  test("taskSkill=null → null；部分键缺省链：key 复用主卡 / baseUrl 智谱端点（非主卡）/ maxTokens 2048", () => {
    expect(buildTaskSkillCard(settings().llm)).toBeNull();
    const card = buildTaskSkillCard({
      apiKey: "main-key",
      model: "glm-test",
      baseUrl: "http://main.example",
      maxTokens: 64,
      outputMode: "standard",
      fallback: null,
      taskSkill: { model: "matcher" },
    });
    expect(card).toEqual({
      name: "zhipu-anthropic-task-skill",
      protocol: "anthropic-messages",
      baseUrl: DEFAULT_LLM_BASE_URL, // Python 硬编码智谱端点，非主卡 baseUrl
      apiKey: "main-key",
      model: "matcher",
      maxTokens: 2048,
    });
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

  test("overrides 在 checkReady 前合并生效（双向证据：补 key 放行 / 清 key 拦截）", async () => {
    const noKey = settings();
    noKey.llm.apiKey = "";
    // 正向：overrides 补回 key → 通过前置检查，推进到 transport（wsUrl 直连跳过发现）
    await expect(
      runAgent({
        task: "t",
        settings: noKey,
        overrides: { llm: { apiKey: "k" } },
        console: false,
        transportFactory: async () => {
          throw new Error("reached-transport");
        },
      }),
    ).rejects.toThrow("reached-transport");
    // 反向：overrides 清空 key → 被前置检查拦截
    await expect(
      runAgent({
        task: "t",
        settings: settings(),
        overrides: { llm: { apiKey: "" } },
        console: false,
      }),
    ).rejects.toThrow("Error: Set ZHIPU_API_KEY environment variable");
  });

  test("trackDownloads：runAgent 先 ensureDir 再装配（目录在 transport 失败前已建）", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tw-dltest-"));
    const dl = join(tmp, "nested", "downloads");
    try {
      await expect(
        runAgent({
          task: "t",
          settings: settings({
            agent: { trackDownloads: true },
            browser: { ...settings().browser, downloadsPath: dl },
          }),
          console: false,
          transportFactory: async () => {
            throw new Error("boom");
          },
        }),
      ).rejects.toThrow("boom");
      expect(existsSync(dl)).toBe(true); // ensureDir 在装配前执行（嵌套层级可建）
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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
          settings: settings({
            browser: {
              cdpHost: "localhost",
              cdpPort: 9222,
              wsUrl: null,
              downloadsPath: "D:/tmp/dl",
            },
          }),
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
