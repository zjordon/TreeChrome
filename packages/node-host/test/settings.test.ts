// loadHostSettings / applyDotEnv / checkReady / resolveWsUrl（env 注入假对象，不触网）。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_TOKENS } from "@tw/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  applyDotEnv,
  checkReady,
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  type HostSettings,
  loadHostSettings,
  mergeHostSettings,
  resolveWsUrl,
} from "../src/settings.js";

describe("loadHostSettings", () => {
  test("缺省面：host 自有缺省（model/baseUrl）+ core 常量派生 + agent 覆盖为空对象", () => {
    const s = loadHostSettings({});
    expect(s.llm).toEqual({
      apiKey: "",
      model: DEFAULT_LLM_MODEL,
      baseUrl: DEFAULT_LLM_BASE_URL,
      maxTokens: DEFAULT_MAX_TOKENS,
      outputMode: "standard",
      fallback: null,
    });
    expect(s.llm.model).toBe("glm-5.3"); // 偏离登记：Python glm-5.1
    expect(s.browser).toEqual({
      cdpHost: "localhost",
      cdpPort: 9222,
      wsUrl: null,
      downloadsPath: join(homedir(), "Downloads"),
    });
    expect(s.agent).toEqual({}); // 未设键不出现——核心默认生效（§5.1 单源纪律）
  });

  test("env 覆盖各键", () => {
    const s = loadHostSettings({
      ZHIPU_API_KEY: "k",
      LLM_MODEL: "glm-4v",
      LLM_BASE_URL: "https://gw.example/api/anthropic",
      LLM_MAX_TOKENS: "1024",
      CDP_HOST: "127.0.0.1",
      CDP_PORT: "9333",
      CDP_WS_URL: "ws://localhost:9333/devtools/browser/x",
      AGENT_MAX_STEPS: "7",
      AGENT_USE_VISION: "true",
    });
    expect(s.llm.apiKey).toBe("k");
    expect(s.llm.model).toBe("glm-4v");
    expect(s.llm.baseUrl).toBe("https://gw.example/api/anthropic");
    expect(s.llm.maxTokens).toBe(1024);
    expect(s.browser).toEqual({
      cdpHost: "127.0.0.1",
      cdpPort: 9333,
      wsUrl: "ws://localhost:9333/devtools/browser/x",
      downloadsPath: join(homedir(), "Downloads"),
    });
    expect(s.agent).toEqual({ maxSteps: 7, useVision: true });
  });

  test("空串按未设置（shell 变量空置形态）", () => {
    const s = loadHostSettings({ LLM_MODEL: "", CDP_WS_URL: "", AGENT_USE_VISION: "" });
    expect(s.llm.model).toBe(DEFAULT_LLM_MODEL);
    expect(s.browser.wsUrl).toBeNull();
    expect(s.agent).toEqual({});
  });

  test("AGENT_USE_VISION=false 显式 false 也进覆盖（与缺省等价但键出现）", () => {
    expect(loadHostSettings({ AGENT_USE_VISION: "false" }).agent).toEqual({ useVision: false });
  });

  test("非法整数：告警 + 忽略（缺省生效）", () => {
    const warns: string[] = [];
    const s = loadHostSettings(
      { LLM_MAX_TOKENS: "abc", CDP_PORT: "0", AGENT_MAX_STEPS: "-3" },
      { log: (m) => warns.push(m) },
    );
    expect(warns.length).toBe(3);
    expect(s.llm.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(s.browser.cdpPort).toBe(9222);
    expect(s.agent).toEqual({});
  });

  test("LLM_OUTPUT_MODE：合法直传 / 非法告警回退 standard / 空串=未设置（config.py:601-604）", () => {
    expect(loadHostSettings({ LLM_OUTPUT_MODE: "flash" }).llm.outputMode).toBe("flash");
    expect(loadHostSettings({ LLM_OUTPUT_MODE: "thinking" }).llm.outputMode).toBe("thinking");
    const warns: string[] = [];
    const s = loadHostSettings({ LLM_OUTPUT_MODE: "turbo" }, { log: (m) => warns.push(m) });
    expect(s.llm.outputMode).toBe("standard");
    expect(warns[0]).toContain('LLM_OUTPUT_MODE="turbo"');
    expect(loadHostSettings({ LLM_OUTPUT_MODE: "" }).llm.outputMode).toBe("standard");
  });

  test("FALLBACK_LLM 缺省链（config.py:588-600）：无 model=无 fallback；key/baseUrl 缺省复用主卡", () => {
    expect(loadHostSettings({ ZHIPU_API_KEY: "k" }).llm.fallback).toBeNull();
    expect(loadHostSettings({ FALLBACK_LLM_MODEL: "" }).llm.fallback).toBeNull();
    // 只给 model：key/baseUrl 复用主卡（含 env 覆盖后的主卡值）
    expect(
      loadHostSettings({
        ZHIPU_API_KEY: "k",
        LLM_BASE_URL: "https://gw.example/api/anthropic",
        FALLBACK_LLM_MODEL: "glm-4-flash",
      }).llm.fallback,
    ).toEqual({ model: "glm-4-flash", apiKey: "k", baseUrl: "https://gw.example/api/anthropic" });
    // 三键齐全
    expect(
      loadHostSettings({
        FALLBACK_LLM_MODEL: "m2",
        FALLBACK_LLM_API_KEY: "k2",
        FALLBACK_LLM_BASE_URL: "https://fb.example",
      }).llm.fallback,
    ).toEqual({ model: "m2", apiKey: "k2", baseUrl: "https://fb.example" });
  });

  test("DOWNLOADS_PATH：env 命中 / 空串=未设置回落用户 Downloads（session.py:1882 解析序）", () => {
    expect(loadHostSettings({ DOWNLOADS_PATH: "D:/dl" }).browser.downloadsPath).toBe("D:/dl");
    expect(loadHostSettings({ DOWNLOADS_PATH: "" }).browser.downloadsPath).toBe(
      join(homedir(), "Downloads"),
    );
  });
});

describe("mergeHostSettings（Python replace 形态等价）", () => {
  const base = loadHostSettings({ ZHIPU_API_KEY: "k", LLM_MODEL: "glm-test" });

  test("三面各自覆盖显式键，其余保留 base", () => {
    const merged = mergeHostSettings(base, {
      llm: { outputMode: "flash" },
      browser: { waitBetweenActions: 0.1, pageSettleTimeout: 0.5 },
      agent: { maxSteps: 3 },
    });
    expect(merged.llm.outputMode).toBe("flash");
    expect(merged.llm.model).toBe("glm-test"); // 未覆盖键保留
    expect(merged.llm.apiKey).toBe("k");
    expect(merged.browser).toEqual({
      cdpHost: "localhost",
      cdpPort: 9222,
      wsUrl: null,
      waitBetweenActions: 0.1,
      pageSettleTimeout: 0.5,
      downloadsPath: join(homedir(), "Downloads"),
    });
    expect(merged.agent).toEqual({ maxSteps: 3 });
  });

  test("显式 undefined 不清 base 值（definedOnly 语义）；空 overrides 原样", () => {
    const merged = mergeHostSettings(base, {
      llm: { model: undefined },
      browser: { waitBetweenActions: undefined },
    });
    expect(merged.llm.model).toBe("glm-test");
    expect(merged.browser.waitBetweenActions).toBeUndefined();
    expect(mergeHostSettings(base)).toEqual(base);
  });

  test("fallback 二级合并（轮 2 #2）：部分覆盖保留 base 子键；null 显式关闭；base null 时纯增", () => {
    const withFb: HostSettings = {
      ...base,
      llm: {
        ...base.llm,
        fallback: { model: "env-model", apiKey: "fb-key", baseUrl: "https://fb.example" },
      },
    };
    // 只传 model（fallback-model.mjs 的形态）：env 层 apiKey/baseUrl 保留
    const merged = mergeHostSettings(withFb, { llm: { fallback: { model: "glm-4-flash" } } });
    expect(merged.llm.fallback).toEqual({
      model: "glm-4-flash",
      apiKey: "fb-key",
      baseUrl: "https://fb.example",
    });
    // 显式 null = 关闭（不与 base 合并）
    expect(mergeHostSettings(withFb, { llm: { fallback: null } }).llm.fallback).toBeNull();
    // base 无 fallback、override 提供：纯增
    const added = mergeHostSettings(base, { llm: { fallback: { model: "m2" } } });
    expect(added.llm.fallback).toEqual({ model: "m2" });
  });
});

describe("applyDotEnv", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tw-node-host-env-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("加载缺失键 / override=false（已存在键不覆盖）/ 引号剥除 / 注释空行无=行跳过", () => {
    const p = join(dir, ".env");
    writeFileSync(
      p,
      [
        "# 注释",
        "",
        'ZHIPU_API_KEY="quoted-key"',
        "LLM_MODEL='single'",
        "LLM_MAX_TOKENS=77",
        "MALFORMED_LINE_NO_EQ",
        "AGENT_USE_VISION=true",
      ].join("\n"),
      "utf8",
    );
    const env: Record<string, string | undefined> = {
      LLM_MODEL: "already-set", // 不得被覆盖
      LLM_MAX_TOKENS: "", // 空串视同未设置——会被 .env 填充
    };
    applyDotEnv(env, [p]);
    expect(env.ZHIPU_API_KEY).toBe("quoted-key");
    expect(env.LLM_MODEL).toBe("already-set");
    expect(env.LLM_MAX_TOKENS).toBe("77");
    expect(env.AGENT_USE_VISION).toBe("true");
    expect(env.MALFORMED_LINE_NO_EQ).toBeUndefined();
  });

  test("文件不存在：静默 no-op；首个存在的文件生效", () => {
    const env: Record<string, string | undefined> = {};
    applyDotEnv(env, [join(dir, "missing"), join(dir, "also-missing")]);
    expect(env).toEqual({});
    const p1 = join(dir, "first.env");
    const p2 = join(dir, "second.env");
    writeFileSync(p1, "A=1\n", "utf8");
    writeFileSync(p2, "B=2\n", "utf8");
    applyDotEnv(env, [p1, p2]);
    expect(env.A).toBe("1");
    expect(env.B).toBeUndefined();
  });

  test("路径是目录（读抛 EISDIR）：跳过该文件继续找下一个", () => {
    const p = join(dir, "next.env");
    writeFileSync(p, "C=3\n", "utf8");
    const env: Record<string, string | undefined> = {};
    applyDotEnv(env, [dir, p]); // dir 存在但不可读 → 跳到 p
    expect(env.C).toBe("3");
  });

  test("与 loadHostSettings 串联：.env 值进入配置", () => {
    const p = join(dir, "app.env");
    writeFileSync(p, "ZHIPU_API_KEY=from-dotenv\nAGENT_MAX_STEPS=9\n", "utf8");
    const env: Record<string, string | undefined> = {};
    applyDotEnv(env, [p]);
    const s = loadHostSettings(env);
    expect(s.llm.apiKey).toBe("from-dotenv");
    expect(s.agent).toEqual({ maxSteps: 9 });
  });
});

describe("checkReady", () => {
  test("缺 key：Python 原文案", () => {
    const s = loadHostSettings({});
    expect(checkReady(s)).toEqual({
      ok: false,
      message: "Error: Set ZHIPU_API_KEY environment variable",
    });
  });

  test("有 key：ok", () => {
    expect(checkReady(loadHostSettings({ ZHIPU_API_KEY: "k" }))).toEqual({
      ok: true,
      message: null,
    });
  });
});

describe("resolveWsUrl", () => {
  test("CDP_WS_URL 直连优先（不触网）", async () => {
    const ws = await resolveWsUrl({
      cdpHost: "h",
      cdpPort: 1,
      wsUrl: "ws://direct",
      downloadsPath: "D:/tmp/dl",
    });
    expect(ws).toBe("ws://direct");
  });

  test("无直连走发现（注入 discover）", async () => {
    const discover = async (host: string, port: number) => `ws://${host}:${port}/found`;
    await expect(
      resolveWsUrl(
        { cdpHost: "127.0.0.1", cdpPort: 9333, wsUrl: null, downloadsPath: "D:/tmp/dl" },
        { discover },
      ),
    ).resolves.toBe("ws://127.0.0.1:9333/found");
  });

  test("发现失败原样抛出（包装留给调用方）", async () => {
    const discover = async () => {
      throw new Error("boom");
    };
    await expect(
      resolveWsUrl(
        { cdpHost: "h", cdpPort: 1, wsUrl: null, downloadsPath: "D:/tmp/dl" },
        { discover },
      ),
    ).rejects.toThrow("boom");
  });
});
