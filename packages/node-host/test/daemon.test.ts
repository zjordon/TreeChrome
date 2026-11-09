// daemon 面契约测试（issue #27 M2）：协议纯函数（端口/空闲/动词参数校验）、server
//（真 HTTP 绑 127.0.0.1:0 + 假会话——串行队列/惰性单例/shutdown/空闲回收）、
// session-holder（wsUrl 解析序/死会话重建/自拉 Chrome 回收）、client（自动拉起重试）、
// doctor 三类诊断、CLI 动词解析与 main 分发（daemonCall 注入）。零真 Chrome/真 spawn。

import { ActionResult, type BrowserSession, type Tools } from "@tw/core";
import { afterAll, describe, expect, test } from "vitest";
import {
  buildParams,
  createDaemonSession,
  type DaemonEnvelope,
  type DaemonInfo,
  type DaemonSession,
  DEFAULT_DAEMON_PORT,
  DEFAULT_IDLE_SECS,
  daemonPort,
  diagnoseDaemon,
  ensureDaemonRunning,
  findVerb,
  idleSecs,
  main,
  PortInUseError,
  parseCliArgs,
  parseDaemonInfo,
  probeHealth,
  requestDaemon,
  SessionError,
  type StateOut,
  startDaemonServer,
  stopDaemon,
} from "../src/index.js";

// ── protocol ────────────────────────────────────────────────────────────────

describe("daemon protocol", () => {
  test("端口/空闲缺省与覆盖（非法回落）", () => {
    expect(daemonPort({})).toBe(DEFAULT_DAEMON_PORT);
    expect(daemonPort({ TC_DAEMON_PORT: "9999" })).toBe(9999);
    expect(daemonPort({ TC_DAEMON_PORT: "abc" })).toBe(DEFAULT_DAEMON_PORT);
    expect(daemonPort({ TC_DAEMON_PORT: "0" })).toBe(DEFAULT_DAEMON_PORT);
    expect(idleSecs({})).toBe(DEFAULT_IDLE_SECS);
    expect(idleSecs({ TC_DAEMON_IDLE_SECS: "60" })).toBe(60);
    expect(idleSecs({ TC_DAEMON_IDLE_SECS: "0" })).toBe(0);
    expect(idleSecs({ TC_DAEMON_IDLE_SECS: "x" })).toBe(DEFAULT_IDLE_SECS);
  });

  test("buildParams：类型转换/必填/XOR/反向布尔/多值收集", () => {
    const click = findVerb("click");
    expect(click && buildParams(click, { index: "5" })).toEqual({ ok: true, params: { index: 5 } });
    expect(click && buildParams(click, { "element-id": "9" })).toEqual({
      ok: true,
      params: { element_id: 9 },
    });
    // XOR：缺 locator / 两个都给 → 错
    expect(click && buildParams(click, {}).ok).toBe(false);
    expect(click && buildParams(click, { index: "1", "element-id": "2" }).ok).toBe(false);
    // int 非法
    expect(click && buildParams(click, { index: "1.5" }).ok).toBe(false);

    const input = findVerb("input_text");
    expect(input && buildParams(input, { index: "3", text: "hi", "no-clear": true })).toEqual({
      ok: true,
      params: { index: 3, text: "hi", clear: false },
    });
    expect(input && buildParams(input, { index: "3" }).ok).toBe(false); // 缺 text

    const dd = findVerb("select_dropdown");
    expect(dd && buildParams(dd, { index: "2", values: ["a", "b"], value: "", extra: 1 })).toEqual({
      ok: true,
      params: { index: 2, values: ["a", "b"] },
    });
    expect(dd && buildParams(dd, { index: "2" }).ok).toBe(false); // value/values 二选一

    const gs = findVerb("get_state");
    expect(gs && buildParams(gs, { anything: 1 })).toEqual({ ok: true, params: {} });

    // str[] 非数组形态（直接单值）；负整数仍合法
    const rg = findVerb("read_grid");
    expect(rg && buildParams(rg, { fields: "entity_id" })).toEqual({
      ok: true,
      params: { fields: ["entity_id"] },
    });
    expect(click && buildParams(click, { index: "-3" })).toEqual({
      ok: true,
      params: { index: -3 },
    });
    // 未设动词在表外 → null
    expect(findVerb("nope")).toBeNull();
  });

  test("buildParams：布尔 default:false 不误当已给（invert/普通）+ screenshot save-path", () => {
    // parseArgs 布尔旗标带 default:false——false 即「未给」，不得置参（评审轮 1 [8]：
    // clear/fresh/await_promise 被显式 false 覆盖会翻转 core 缺省 true 的行为）
    const input = findVerb("input_text");
    expect(input && buildParams(input, { index: "3", text: "hi", "no-clear": false })).toEqual({
      ok: true,
      params: { index: 3, text: "hi" },
    });
    const nav = findVerb("navigate");
    expect(nav && buildParams(nav, { url: "https://a.b", "new-tab": false })).toEqual({
      ok: true,
      params: { url: "https://a.b" },
    });
    const shot = findVerb("screenshot");
    expect(shot && buildParams(shot, { "save-path": "s.jpeg", quality: "60" })).toEqual({
      ok: true,
      params: { save_path: "s.jpeg", quality: 60 },
    });
  });
});

// ── server（真 HTTP，临时端口 + 假会话）────────────────────────────────────

interface FakeSession extends DaemonSession {
  events: string[];
  calls: Array<{ action: string; params: Record<string, unknown> }>;
  delayMs: number;
}

const fakeSession = (): FakeSession => {
  const events: string[] = [];
  const calls: FakeSession["calls"] = [];
  const session: FakeSession = {
    events,
    calls,
    delayMs: 0,
    get wsUrl() {
      return "ws://127.0.0.1:9222/devtools/browser/x";
    },
    get spawnedChrome() {
      return null;
    },
    async runAction(action, params) {
      events.push(`start:${action}`);
      calls.push({ action, params });
      if (session.delayMs > 0) {
        await new Promise((r) => setTimeout(r, session.delayMs));
      }
      events.push(`end:${action}`);
      return { ...projected(), extractedContent: `ok:${action}` };
    },
    async getState() {
      calls.push({ action: "get_state", params: {} });
      return {
        url: "https://x",
        title: "T",
        tabs: [],
        currentTargetId: "ab12",
        elementTreeText: "tree",
        gridMeta: null,
      };
    },
    async tabs() {
      calls.push({ action: "tabs", params: {} });
      return { tabs: [], currentTargetId: "ab12" };
    },
    async shutdown() {
      events.push("shutdown");
    },
  };
  return session;
};

const projected = () => ({
  isDone: false,
  success: null,
  error: null,
  extractedContent: null,
  longTermMemory: null,
  judgement: null,
  metadata: null,
  attachments: null,
  denied: false,
});

const post = async (port: number, body: unknown): Promise<DaemonEnvelope> => {
  const res = await fetch(`http://127.0.0.1:${port}/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return (await res.json()) as DaemonEnvelope;
};

/** 轮询等 health 探测转 null（shutdown 生效判据）；超时 false */
const waitHealthDown = async (port: number): Promise<boolean> => {
  for (let i = 0; i < 40; i += 1) {
    if ((await probeHealth(fetch.bind(globalThis), port)) === null) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

describe("daemon server", () => {
  const running: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const close of running) {
      await close();
    }
  });

  test("health 形态；特殊动词直调会话面；未知动作 usage 信封", async () => {
    const session = fakeSession();
    const daemon = await startDaemonServer({ port: 0, env: {}, makeSession: () => session });
    running.push(daemon.close);
    const health = await probeHealth(fetch.bind(globalThis), daemon.port);
    expect(health).toMatchObject({ pid: process.pid, port: daemon.port, sessionStarted: false });
    const gs = await post(daemon.port, { action: "get_state", params: {} });
    expect(gs.ok).toBe(true);
    expect(gs.data).toMatchObject({ elementTreeText: "tree", currentTargetId: "ab12" });
    const click = await post(daemon.port, { action: "click", params: { index: 5 } });
    expect(click.ok && click.data).toMatchObject({ extractedContent: "ok:click" });
    expect(session.calls[1]).toEqual({ action: "click", params: { index: 5 } });
    const unknown = await post(daemon.port, { action: "fly", params: {} });
    expect(unknown).toMatchObject({ ok: false, kind: "usage" });
    const bad = await post(daemon.port, "{nope");
    expect(bad).toMatchObject({ ok: false, kind: "usage" });
    // 非对象请求体 / 缺 params / 未知路由
    const noParams = await post(daemon.port, { action: "click" });
    expect(noParams).toMatchObject({ ok: false, kind: "usage" });
    const wrongRoute = await fetch(`http://127.0.0.1:${daemon.port}/other`);
    expect(wrongRoute.status).toBe(404);
  });

  test("串行队列：并发请求 FIFO，无重入；会话惰性单例", async () => {
    const session = fakeSession();
    session.delayMs = 120;
    const made: number[] = [];
    const daemon = await startDaemonServer({
      port: 0,
      env: {},
      makeSession: () => {
        made.push(1);
        return session;
      },
    });
    running.push(daemon.close);
    const first = post(daemon.port, { action: "scroll", params: {} });
    const second = post(daemon.port, { action: "go_back", params: {} });
    await Promise.all([first, second]);
    // 第一个请求持队列 120ms，第二个必须等它结束才开始（FIFO 串行）
    expect(session.events).toEqual(["start:scroll", "end:scroll", "start:go_back", "end:go_back"]);
    expect(made.length).toBe(1); // 惰性单例：两请求一会话
  });

  test("shutdown 端点：回包后关停（health 随之不可达）+ clearInfo", async () => {
    const cleared: boolean[] = [];
    const infos: DaemonInfo[] = [];
    const daemon = await startDaemonServer({
      port: 0,
      env: {},
      makeSession: () => fakeSession(),
      writeInfo: (i) => infos.push(i),
      clearInfo: () => cleared.push(true),
    });
    expect(infos).toHaveLength(1);
    const res = await fetch(`http://127.0.0.1:${daemon.port}/shutdown`, { method: "POST" });
    expect(res.ok).toBe(true);
    expect(await waitHealthDown(daemon.port)).toBe(true);
    expect(cleared).toHaveLength(1);
    expect(daemon.sessionStarted()).toBe(false);
  });

  test("空闲回收：超时自动关停", async () => {
    const daemon = await startDaemonServer({
      port: 0,
      env: { TC_DAEMON_IDLE_SECS: "1" },
      idleCheckIntervalMs: 50,
      makeSession: () => fakeSession(),
    });
    await new Promise((r) => setTimeout(r, 1800));
    expect(await probeHealth(fetch.bind(globalThis), daemon.port)).toBeNull();
  });

  test("空闲回收门禁在途任务：长动作执行中不关停，结束后重计空闲（评审轮 1 [5]）", async () => {
    const session = fakeSession();
    session.delayMs = 350;
    const daemon = await startDaemonServer({
      port: 0,
      env: { TC_DAEMON_IDLE_SECS: "0.1" }, // 空闲 100ms 即回收
      idleCheckIntervalMs: 30,
      makeSession: () => session,
    });
    // 任务 350ms > 空闲 100ms：无在途门禁时 closeAllConnections 会掐断在途响应
    const res = await post(daemon.port, { action: "scroll", params: {} });
    expect(res.ok && res.data).toMatchObject({ extractedContent: "ok:scroll" });
    // 任务结束刷新活跃时刻 → 空闲窗重新起算后回收。静置等回收（不轮询探活——
    // /health 请求也刷新活跃时刻，轮询会让 100ms 空闲窗永远凑不满）
    await new Promise((r) => setTimeout(r, 500));
    expect(await probeHealth(fetch.bind(globalThis), daemon.port)).toBeNull();
  });

  test("端口占用 → PortInUseError", async () => {
    const holder = await startDaemonServer({ port: 0, env: {}, makeSession: () => fakeSession() });
    running.push(holder.close);
    await expect(
      startDaemonServer({ port: holder.port, env: {}, makeSession: () => fakeSession() }),
    ).rejects.toBeInstanceOf(PortInUseError);
  });
});

// ── session-holder（makeCore/discover/launch 全注入）────────────────────────

interface CoreFake {
  started: number;
  stopped: number;
  connected: boolean;
  stateCalls: Array<Record<string, unknown> | undefined>;
  executed: Array<{ action: string; params: Record<string, unknown> }>;
}

const coreFake = (opts: { elementTreeText?: string; executeError?: string } = {}) => {
  const fake: CoreFake = { started: 0, stopped: 0, connected: true, stateCalls: [], executed: [] };
  const browser = {
    start: async () => {
      fake.started += 1;
      fake.connected = true; // 新会话 start 后即连通（重建语义）
    },
    stop: async () => {
      fake.stopped += 1;
      fake.connected = false;
    },
    getState: async (options?: Record<string, unknown>) => {
      fake.stateCalls.push(options);
      return {
        url: "https://page",
        title: "标题",
        tabs: [{ targetId: "aa11", url: "https://page", title: "标题" }],
        domState:
          opts.elementTreeText === undefined ? null : { elementTreeText: opts.elementTreeText },
        screenshot: null,
        gridMeta: null,
        recentEvents: [],
      };
    },
    getTabs: async () => [{ targetId: "aa11", url: "https://page", title: "标题" }],
    get currentTargetId() {
      return "aa11";
    },
    get isConnected() {
      return fake.connected;
    },
  };
  const tools = {
    execute: async (action: string, params: Record<string, unknown>) => {
      fake.executed.push({ action, params });
      if (opts.executeError !== undefined) {
        return new ActionResult({ error: opts.executeError });
      }
      return new ActionResult({ extractedContent: `done:${action}` });
    },
  };
  return { fake, core: { browser, tools } };
};

const asCore = (
  core: ReturnType<typeof coreFake>["core"],
): { browser: BrowserSession; tools: Tools } =>
  core as unknown as { browser: BrowserSession; tools: Tools };

describe("session-holder", () => {
  test("wsUrl 解析序：显式 CDP_WS_URL 不发现不自拉；发现可达不自拉；不通才自拉", async () => {
    // ① 显式
    {
      const { core } = coreFake();
      let discovered = 0;
      const s = createDaemonSession({
        env: { CDP_WS_URL: "ws://explicit/devtools/browser/x" },
        discover: async () => {
          discovered += 1;
          return "ws://found";
        },
        makeCore: () => asCore(core),
      });
      await s.getState();
      expect(s.wsUrl).toBe("ws://explicit/devtools/browser/x");
      expect(discovered).toBe(0);
      await s.shutdown();
    }
    // ② 发现可达
    {
      const { core } = coreFake();
      const launched: number[] = [];
      const s = createDaemonSession({
        env: {},
        discover: async () => "ws://found",
        launch: async () => {
          launched.push(1);
          throw new Error("不应自拉");
        },
        makeCore: () => asCore(core),
      });
      await s.getState();
      expect(s.wsUrl).toBe("ws://found");
      expect(launched).toHaveLength(0);
    }
    // ③ 不通 → 自拉（假 chrome）→ 二次发现成功；shutdown 回收
    {
      const { core } = coreFake();
      let discoverCalls = 0;
      const stopped: boolean[] = [];
      const s = createDaemonSession({
        env: {},
        discover: async () => {
          discoverCalls += 1;
          if (discoverCalls === 1) {
            throw new Error("conn refused");
          }
          return "ws://launched";
        },
        launch: async () => ({
          pid: 4242,
          profileDir: "C:/tmp/p",
          cdpPort: 9222,
          stop: async () => {
            stopped.push(true);
          },
        }),
        makeCore: () => asCore(core),
      });
      await s.getState();
      expect(s.wsUrl).toBe("ws://launched");
      expect(s.spawnedChrome).toEqual({ pid: 4242 });
      await s.shutdown();
      expect(stopped).toHaveLength(1);
    }
  });

  test("自拉失败 → env 类错误；get_state 投影（无截图参数 + domState null 容错）", async () => {
    const { core } = coreFake();
    const s = createDaemonSession({
      env: {},
      discover: async () => {
        throw new Error("refused");
      },
      launch: async () => {
        throw new Error("未找到 Chrome 可执行文件");
      },
      makeCore: () => asCore(core),
    });
    await expect(s.getState()).rejects.toMatchObject({ kind: "env" });
    const { core: core2, fake: fake2 } = coreFake();
    const ok = createDaemonSession({
      env: { CDP_WS_URL: "ws://x" },
      makeCore: () => asCore(core2),
    });
    const state: StateOut = await ok.getState();
    expect(state).toMatchObject({
      url: "https://page",
      elementTreeText: "",
      currentTargetId: "aa11",
    });
    expect(fake2.stateCalls[0]).toEqual({ includeScreenshot: false });
  });

  test("runAction 透传注册表并投影 error；连接死亡 → env 错误 + 下次调用重建", async () => {
    // error 投影（动作执行失败走 ActionResult.error）
    {
      const { core, fake } = coreFake({ executeError: "index 不存在" });
      const s = createDaemonSession({
        env: { CDP_WS_URL: "ws://x" },
        makeCore: () => asCore(core),
      });
      const out = await s.runAction("click", { index: 99 });
      expect(out.error).toBe("index 不存在");
      expect(fake.executed[0]).toEqual({ action: "click", params: { index: 99 } });
    }
    // 连接死亡：runAction 抛 env + core 置空 → 下次 ensure 重建（start 再 +1）
    {
      const { core, fake } = coreFake();
      const s = createDaemonSession({
        env: { CDP_WS_URL: "ws://x" },
        makeCore: () => asCore(core),
      });
      await s.getState();
      fake.connected = false;
      // tools.execute 抛错 + isConnected=false → SessionError env
      core.tools.execute = async () => {
        throw new Error("WebSocket closed");
      };
      await expect(s.runAction("click", { index: 1 })).rejects.toBeInstanceOf(SessionError);
      core.tools.execute = async (action: string) => new ActionResult({ extractedContent: action });
      const again = await s.runAction("go_back", {});
      expect(again.extractedContent).toBe("go_back");
      expect(fake.started).toBe(2); // 重建过一次
    }
  });

  test("tabs 正常面；getState/tabs 执行失败走 exec；shutdown 幂等收口 browser", async () => {
    const { core, fake } = coreFake({ elementTreeText: "树" });
    const s = createDaemonSession({ env: { CDP_WS_URL: "ws://x" }, makeCore: () => asCore(core) });
    const tabs = await s.tabs();
    expect(tabs).toEqual({
      tabs: [{ targetId: "aa11", url: "https://page", title: "标题" }],
      currentTargetId: "aa11",
    });
    // getState 执行失败（连接仍活）→ exec
    core.browser.getState = async () => {
      throw new Error("snapshot 超时");
    };
    await expect(s.getState()).rejects.toMatchObject({ kind: "exec" });
    // 传输在调用中途断开（ensure 已过、执行时死）→ env + core 置空待重建
    core.browser.getState = async () => {
      fake.connected = false;
      throw new Error("boom");
    };
    await expect(s.getState()).rejects.toMatchObject({ kind: "env" });
    // tabs 同款：中途断开 → env
    core.browser.getTabs = async () => {
      fake.connected = false;
      throw new Error("tabs boom");
    };
    await expect(s.tabs()).rejects.toMatchObject({ kind: "env" });
    core.browser.getState = async (options?: Record<string, unknown>) => {
      fake.stateCalls.push(options);
      return {
        url: "https://page",
        title: "t",
        tabs: [],
        domState: { elementTreeText: "树" },
        screenshot: null,
        gridMeta: null,
        recentEvents: [],
      };
    };
    const st = await s.getState();
    expect(st.elementTreeText).toBe("树");
    await s.shutdown();
    await s.shutdown(); // 幂等
    // stop 计数：getState env 路径重建 1 次 + tabs env 路径重建 1 次 + shutdown 1 次
    expect(fake.stopped).toBe(3);
  });

  test("自拉后二次发现仍失败 → env 错误且 chrome 已回收", async () => {
    const { core } = coreFake();
    const stopped: boolean[] = [];
    const s = createDaemonSession({
      env: {},
      discover: async () => {
        throw new Error("still refused");
      },
      launch: async () => ({
        pid: 11,
        profileDir: "C:/tmp/q",
        cdpPort: 9222,
        stop: async () => {
          stopped.push(true);
        },
      }),
      makeCore: () => asCore(core),
    });
    await expect(s.getState()).rejects.toMatchObject({
      kind: "env",
      message: expect.stringContaining("Chrome 拉起后 CDP 仍不可达"),
    });
    expect(stopped).toHaveLength(1);
    expect(s.spawnedChrome).toBeNull();
  });
});

// ── client（fetch/spawn 注入）───────────────────────────────────────────────

const jsonResponse = (body: unknown, ok = true) =>
  new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: { "content-type": "application/json" },
  });

/** undici 形态的连接被拒错误（TypeError 外壳 + cause.code=ECONNREFUSED） */
const refusedErr = () =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), { code: "ECONNREFUSED" }),
  });

describe("daemon client", () => {
  test("requestDaemon：可达直发；连接被拒 → 自动拉起 → 重试一次", async () => {
    const spawned: number[] = [];
    let actionCalls = 0;
    let healthProbes = 0;
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/health")) {
        healthProbes += 1;
        // 前 2 次探活失败（ensure 初始探测 + spawn 轮询第 1 次），第 3 次起就绪
        return healthProbes <= 2
          ? Promise.reject(new TypeError("fetch failed"))
          : Promise.resolve(jsonResponse({ ok: true, data: { pid: 77 } }));
      }
      actionCalls += 1;
      if (actionCalls === 1) {
        throw refusedErr(); // 连接被拒：请求从未到达 daemon，重发安全
      }
      expect(init?.method).toBe("POST");
      return jsonResponse({ ok: true, data: { fine: true } });
    };
    const envelope = await requestDaemon(
      9780,
      "get_state",
      {},
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        spawnSelf: (port) => {
          spawned.push(port);
          return { pid: 77 };
        },
        startupTimeoutMs: 3000,
      },
    );
    expect(envelope).toEqual({ ok: true, data: { fine: true } });
    expect(spawned).toEqual([9780]);
  });

  test("拉起后仍不可达 → env 信封；ensureDaemonRunning pid<=0 视为失败", async () => {
    const envelope = await requestDaemon(
      9781,
      "tabs",
      {},
      {
        fetchImpl: (async () => {
          throw refusedErr();
        }) as unknown as typeof fetch,
        spawnSelf: () => ({ pid: -1 }),
        startupTimeoutMs: 100,
      },
    );
    expect(envelope).toMatchObject({ ok: false, kind: "env" });
    expect(envelope.error).toContain("自动拉起失败");
    const ok = await ensureDaemonRunning(9782, {
      fetchImpl: (async () => {
        throw new TypeError("down");
      }) as unknown as typeof fetch,
      spawnSelf: () => ({ pid: -1 }),
    });
    expect(ok).toBe(false);
  });

  test("拉起成功但重发仍失败 → env 信封（请求失败文案）", async () => {
    let healthProbes = 0;
    let calls = 0;
    const envelope = await requestDaemon(
      9787,
      "go_back",
      {},
      {
        fetchImpl: (async (url: string) => {
          if (url.endsWith("/health")) {
            healthProbes += 1;
            // 前 2 次探活失败（ensure 初始 + spawn 轮询第 1 次），第 3 次起就绪
            return healthProbes <= 2
              ? Promise.reject(new TypeError("down"))
              : jsonResponse({ ok: true, data: { pid: 9 } });
          }
          calls += 1;
          if (calls === 1) {
            throw refusedErr(); // 首发被拒 → 拉起重发
          }
          throw new TypeError("reset"); // 重发仍失败
        }) as unknown as typeof fetch,
        spawnSelf: () => ({ pid: 9 }),
        startupTimeoutMs: 1000,
      },
    );
    expect(calls).toBe(2);
    expect(envelope).toMatchObject({ ok: false, kind: "env" });
    expect(envelope.error).toContain("daemon 请求失败");
  });

  test("stopDaemon：连不上视作未运行", async () => {
    const r = await stopDaemon(9783, {
      fetchImpl: (async () => {
        throw new TypeError("down");
      }) as unknown as typeof fetch,
    });
    expect(r).toEqual({ stopped: false, wasRunning: false });
  });

  test("probeHealth：坏信封 → null；非 2xx → null", async () => {
    const r = await probeHealth(
      (async () => jsonResponse({ nope: 1 })) as unknown as typeof fetch,
      1234,
    );
    expect(r).toBeNull();
    const bad = await probeHealth(
      (async () => jsonResponse({ ok: true, data: {} }, false)) as unknown as typeof fetch,
      1234,
    );
    expect(bad).toBeNull();
  });

  test("ensureDaemonRunning：health 已活 → 直接 true 不 spawn", async () => {
    let spawned = 0;
    const ok = await ensureDaemonRunning(9786, {
      fetchImpl: (async () =>
        jsonResponse({ ok: true, data: { pid: 2 } })) as unknown as typeof fetch,
      spawnSelf: () => {
        spawned += 1;
        return { pid: 2 };
      },
    });
    expect(ok).toBe(true);
    expect(spawned).toBe(0);
  });

  test("stopDaemon：可达并 200 → stopped；daemon 活着时失败不盲重发（评审轮 1 [4]）", async () => {
    const stopped = await stopDaemon(9784, {
      fetchImpl: (async () => jsonResponse({ ok: true })) as unknown as typeof fetch,
    });
    expect(stopped).toEqual({ stopped: true, wasRunning: true });
    let actionCalls = 0;
    const envelope = await requestDaemon(
      9785,
      "go_back",
      {},
      {
        fetchImpl: (async (url: string) => {
          if (url.endsWith("/health")) {
            return jsonResponse({ ok: true, data: { pid: 1 } });
          }
          actionCalls += 1;
          throw new TypeError("conn reset"); // 600s 超时/连接中断形态：daemon 仍存活
        }) as unknown as typeof fetch,
        spawnSelf: () => {
          throw new Error("daemon 活着不应触发自起");
        },
        startupTimeoutMs: 500,
      },
    );
    // 非「连接被拒」一律不重发——非幂等动作（click/提交）重发会被重复执行
    expect(actionCalls).toBe(1);
    expect(envelope).toMatchObject({ ok: false, kind: "env" });
    expect(envelope.error).toContain("daemon 仍存活");
    expect(envelope.error).toContain("请确认副作用后手动重发");
  });

  test("连接中断且 daemon 已死 → 不重发不自起（动作执行状态未知，评审轮 2 [1]）", async () => {
    let calls = 0;
    let spawns = 0;
    const envelope = await requestDaemon(
      9788,
      "click",
      { index: 7 },
      {
        fetchImpl: (async (url: string) => {
          if (url.endsWith("/health")) {
            throw new TypeError("down"); // 探活失败——但连接中断非「被拒」，不得自起重发
          }
          calls += 1;
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
          });
        }) as unknown as typeof fetch,
        spawnSelf: () => {
          spawns += 1;
          return { pid: 5 };
        },
        startupTimeoutMs: 500,
      },
    );
    // 探活假阴性竞态收口：即使 daemon 全程存活只是探测超时，非被拒失败也绝不重发
    expect(calls).toBe(1);
    expect(spawns).toBe(0);
    expect(envelope).toMatchObject({ ok: false, kind: "env" });
    expect(envelope.error).toContain("动作执行状态未知");
  });
});

// ── doctor（探测全注入）─────────────────────────────────────────────────────

describe("doctor", () => {
  const baseDeps = {
    env: {} as Record<string, string | undefined>,
    readInfo: () => null,
    pidAlive: () => false,
  };

  test("全绿：daemon 在跑 + CDP 可达 → healthy", async () => {
    const r = await diagnoseDaemon({
      ...baseDeps,
      fetchImpl: (async (url: string) =>
        url.includes("/health")
          ? jsonResponse({ ok: true, data: { pid: 1 } })
          : jsonResponse({ ok: true })) as unknown as typeof fetch,
    });
    expect(r.summary).toBe("healthy");
    expect(r.findings.map((f) => f.name)).toEqual(["daemon", "chrome"]);
  });

  test("parseDaemonInfo：合法文本 → DaemonInfo；坏 JSON/形状不对/空 → null", () => {
    expect(parseDaemonInfo('{"pid":5,"port":9780,"startedAt":123}')).toEqual({
      pid: 5,
      port: 9780,
      startedAt: 123,
    });
    expect(parseDaemonInfo("{nope")).toBeNull();
    expect(parseDaemonInfo('{"pid":"5","port":9780,"startedAt":1}')).toBeNull();
    expect(parseDaemonInfo("{}")).toBeNull();
    expect(parseDaemonInfo("")).toBeNull();
  });

  test("缺省探测件：pidAlive 真探 / netProbe 真连（占用 vs 空闲）/ probeCdp 拒绝", async () => {
    // defaultPidAlive：daemon 活 + daemon.json 记当前进程 pid → 无残留 warn
    {
      const r = await diagnoseDaemon({
        env: { CDP_WS_URL: "ws://x" }, // 显式连接 → 跳过 CDP 真探测
        fetchImpl: (async () =>
          jsonResponse({ ok: true, data: { pid: process.pid } })) as unknown as typeof fetch,
        readInfo: () => ({ pid: process.pid, port: 9780, startedAt: 1 }),
      });
      expect(r.findings[0]).toMatchObject({ name: "daemon", status: "ok" });
      expect(r.findings.some((f) => f.name === "daemon.json")).toBe(false);
    }
    // defaultNetProbe connected：/health 死但端口被真监听 → port fail + 换端口建议
    {
      const holder = await startDaemonServer({
        port: 0,
        env: {},
        makeSession: () => fakeSession(),
      });
      const r = await diagnoseDaemon({
        env: { TC_DAEMON_PORT: String(holder.port), CDP_WS_URL: "ws://x" },
        fetchImpl: (async () => {
          throw new TypeError("down");
        }) as unknown as typeof fetch,
      });
      expect(r.findings.find((f) => f.name === "port")).toMatchObject({ status: "fail" });
      await holder.close();
    }
    // defaultNetProbe refused + defaultProbeCdp 连拒绝（端口 1 恒无人听）→ ok / warn
    {
      const r = await diagnoseDaemon({
        env: { TC_DAEMON_PORT: "1", CDP_HOST: "127.0.0.1", CDP_PORT: "1" },
        fetchImpl: (async () => {
          throw new TypeError("down");
        }) as unknown as typeof fetch,
      });
      expect(r.findings.find((f) => f.name === "port")).toMatchObject({ status: "ok" });
      expect(r.findings.find((f) => f.name === "chrome")).toMatchObject({ status: "warn" });
      expect(r.summary).toBe("degraded");
    }
  });

  test("daemon 僵死（pid 活 /health 死）+ 端口被占 → down + 两条 fail", async () => {
    const r = await diagnoseDaemon({
      env: {},
      readInfo: () => ({ pid: 999, port: DEFAULT_DAEMON_PORT, startedAt: 0 }),
      pidAlive: () => true,
      fetchImpl: (async () => {
        throw new TypeError("down");
      }) as unknown as typeof fetch,
      netProbe: async () => "connected",
    });
    expect(r.summary).toBe("down");
    const daemon = r.findings[0];
    expect(daemon.status).toBe("fail");
    expect(daemon.hint).toContain("taskkill");
    expect(r.findings.find((f) => f.name === "port")?.status).toBe("fail");
  });

  test("daemon 未起 + 端口空闲 → warn + ok（自动拉起提示）", async () => {
    const r = await diagnoseDaemon({
      ...baseDeps,
      fetchImpl: (async () => {
        throw new TypeError("down");
      }) as unknown as typeof fetch,
      netProbe: async () => "refused",
    });
    expect(r.findings[0]).toMatchObject({ name: "daemon", status: "warn" });
    expect(r.findings.find((f) => f.name === "port")?.status).toBe("ok");
    expect(r.summary).toBe("degraded");
  });

  test("daemon 活但 daemon.json pid 已死 → 残留 warn", async () => {
    const r = await diagnoseDaemon({
      env: {},
      readInfo: () => ({ pid: 555, port: DEFAULT_DAEMON_PORT, startedAt: 0 }),
      pidAlive: () => false,
      fetchImpl: (async (url: string) =>
        url.includes("/health")
          ? jsonResponse({ ok: true, data: { pid: 9 } })
          : jsonResponse({ ok: true })) as unknown as typeof fetch,
    });
    expect(r.findings.find((f) => f.name === "daemon.json")?.status).toBe("warn");
    expect(r.summary).toBe("degraded"); // 任一非 ok 即降级
  });

  test("显式 CDP_WS_URL → 自管语义不探测；Chrome 可达 hint null；探测超时 warn", async () => {
    // 显式 wsUrl：chrome 项直接 ok 且 detail 含自管说明
    const explicit = await diagnoseDaemon({
      env: { CDP_WS_URL: "ws://exp/devtools/browser/x" },
      readInfo: () => null,
      fetchImpl: (async () => {
        throw new TypeError("down");
      }) as unknown as typeof fetch,
      netProbe: async () => "refused",
    });
    const chromeFinding = explicit.findings.find((f) => f.name === "chrome");
    expect(chromeFinding).toMatchObject({ status: "ok" });
    expect(chromeFinding?.detail).toContain("自管");
    // Chrome 可达（/health 死、/json/version 活）：daemon warn + chrome ok + 无 hint
    const up = await diagnoseDaemon({
      ...baseDeps,
      fetchImpl: (async (url: string) =>
        url.includes("/json/version")
          ? jsonResponse({ ok: true })
          : Promise.reject(new TypeError("down"))) as unknown as typeof fetch,
      netProbe: async () => "refused",
    });
    expect(up.findings.find((f) => f.name === "chrome")).toMatchObject({
      status: "ok",
      hint: null,
    });
    // 端口探测 error → warn
    const err = await diagnoseDaemon({
      ...baseDeps,
      fetchImpl: (async () => {
        throw new TypeError("down");
      }) as unknown as typeof fetch,
      netProbe: async () => "error",
    });
    expect(err.findings.find((f) => f.name === "port")?.status).toBe("warn");
  });
});

// ── CLI 动词解析与 main 分发 ────────────────────────────────────────────────

describe("cli 动词/daemon 解析", () => {
  test("15 动词全集可解析（空参动词 params={}）；动词不吃位置参数", () => {
    for (const verb of ["get_state", "go_back", "tabs"]) {
      const r = parseCliArgs([verb]);
      expect(r.ok && r.args.command).toBe("action");
      expect(r.ok && r.args.actionParams).toEqual({});
    }
    expect(parseCliArgs(["click", "5"]).ok).toBe(false);
  });

  test("click/ input_text/ navigate/ select_dropdown 全参解析", () => {
    expect(parseCliArgs(["click", "--index", "5"])).toMatchObject({
      ok: true,
      args: { actionVerb: "click", actionParams: { index: 5 } },
    });
    expect(
      parseCliArgs(["input_text", "--element-id", "7", "--text", "你好", "--no-clear"]),
    ).toMatchObject({
      ok: true,
      args: { actionParams: { element_id: 7, text: "你好", clear: false } },
    });
    expect(parseCliArgs(["navigate", "--url", "https://a.b", "--new-tab"])).toMatchObject({
      ok: true,
      args: { actionParams: { url: "https://a.b", new_tab: true } },
    });
    expect(
      parseCliArgs(["select_dropdown", "--index", "2", "--values", "a", "--values", "b"]),
    ).toMatchObject({ ok: true, args: { actionParams: { index: 2, values: ["a", "b"] } } });
    expect(parseCliArgs(["upload_file", "--index", "1", "--path", "x.txt"])).toMatchObject({
      ok: true,
      args: { actionParams: { index: 1, path: "x.txt" } },
    });
    // 校验错：XOR / 必填
    expect(parseCliArgs(["click"]).ok).toBe(false);
    expect(parseCliArgs(["evaluate"]).ok).toBe(false);
    // 生产形态：未给布尔旗标（default:false）不得混进参数——clear 被显式 false 覆盖
    // 会让有旧值的输入框变成追加输入（评审轮 1 [8]）
    {
      const r = parseCliArgs(["input_text", "--index", "5", "--text", "x"]);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.args.actionParams).toEqual({ index: 5, text: "x" });
      }
    }
    expect(
      parseCliArgs(["screenshot", "--save-path", "shot.jpeg", "--quality", "60"]),
    ).toMatchObject({ ok: true, args: { actionParams: { save_path: "shot.jpeg", quality: 60 } } });
  });

  test("daemon 子命令：单模式旗标；缺/多/位置参数 → 错；--daemon-port 校验", () => {
    expect(parseCliArgs(["daemon", "--status"])).toMatchObject({
      ok: true,
      args: { command: "daemon", daemonMode: "status" },
    });
    expect(parseCliArgs(["daemon", "--doctor", "--daemon-port", "9999"])).toMatchObject({
      ok: true,
      args: { daemonMode: "doctor", daemonPortFlag: 9999 },
    });
    expect(parseCliArgs(["daemon"]).ok).toBe(false);
    expect(parseCliArgs(["daemon", "--status", "--stop"]).ok).toBe(false);
    expect(parseCliArgs(["daemon", "x"]).ok).toBe(false);
    expect(parseCliArgs(["get_state", "--daemon-port", "abc"]).ok).toBe(false);
  });
});

describe("main：daemon 分发（注入假客户端）", () => {
  const ttyStdin = { isTTY: true, text: () => Promise.resolve("") };
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, deps: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
  };
  const base = {
    env: {} as Record<string, string | undefined>,
    applyEnv: () => {},
    stdin: ttyStdin,
  };

  test("动作：ok → stdout 单 JSON + exit 0；error 字段 → exit 1（stdout 仍有 JSON）", async () => {
    {
      const c = capture();
      const code = await main({
        ...base,
        argv: ["get_state"],
        daemonCall: async () => ({ ok: true, data: { url: "https://x", error: null } }),
        ...c.deps,
      });
      expect(code).toBe(0);
      expect(c.out).toEqual(['{"url":"https://x","error":null}']);
    }
    {
      const c = capture();
      const code = await main({
        ...base,
        argv: ["click", "--index", "3"],
        daemonCall: async () => ({ ok: true, data: { error: "index 不存在" } }),
        ...c.deps,
      });
      expect(code).toBe(1);
      expect(c.out).toEqual(['{"error":"index 不存在"}']);
    }
  });

  test("动作：env/usage 信封 → stderr + exit 2；upload path 解析为绝对路径", async () => {
    const c = capture();
    let seen: Record<string, unknown> = {};
    const code = await main({
      ...base,
      argv: ["upload_file", "--index", "1", "--path", "./视频.mp4"],
      daemonCall: async (_port, _action, params) => {
        seen = params;
        return { ok: false, error: "daemon 不可达", kind: "env" };
      },
      ...c.deps,
    });
    expect(code).toBe(2);
    expect(c.out).toEqual([]);
    expect(c.err.join("\n")).toContain("daemon 不可达");
    expect(String(seen.path)).toMatch(/[\\/]视频\.mp4$/);
    expect(String(seen.index)).toBe("1");
  });

  test("动作：screenshot --save-path 相对路径解析为绝对路径（daemon CWD 可能不同）", async () => {
    const c = capture();
    let seen: Record<string, unknown> = {};
    const code = await main({
      ...base,
      argv: ["screenshot", "--save-path", "./shot.jpeg", "--quality", "60"],
      daemonCall: async (_port, _action, params) => {
        seen = params;
        return { ok: true, data: { extractedContent: "saved" } };
      },
      ...c.deps,
    });
    expect(code).toBe(0);
    expect(String(seen.save_path)).toMatch(/[\\/]shot\.jpeg$/);
    expect(seen.quality).toBe(60);
  });

  test("daemon status/stop/doctor：JSON 输出 + exit 0", async () => {
    {
      const c = capture();
      const code = await main({
        ...base,
        argv: ["daemon", "--status"],
        daemonHealth: async () => ({ pid: 9 }),
        ...c.deps,
      });
      expect(code).toBe(0);
      expect(JSON.parse(c.out[0])).toMatchObject({ running: true, pid: 9 });
    }
    {
      const c = capture();
      const code = await main({
        ...base,
        argv: ["daemon", "--stop"],
        daemonStopFn: async () => ({ stopped: true, wasRunning: true }),
        ...c.deps,
      });
      expect(code).toBe(0);
      expect(JSON.parse(c.out[0])).toEqual({ stopped: true, wasRunning: true });
    }
    {
      const c = capture();
      const code = await main({
        ...base,
        argv: ["daemon", "--doctor"],
        daemonDoctor: async () => ({ summary: "healthy", findings: [] }),
        ...c.deps,
      });
      expect(code).toBe(0);
      expect(JSON.parse(c.out[0])).toMatchObject({ summary: "healthy" });
    }
  });

  test("daemon 分支：端口在凭据链应用后计算；--daemon-port 写入 env（评审轮 1 [3]）", async () => {
    // .env 链里的 TC_DAEMON_PORT：status 面与动作面解析一致（修复前 status 探缺省 9780）
    {
      const c = capture();
      const env: Record<string, string | undefined> = {};
      let seenPort = -1;
      const code = await main({
        env,
        applyEnv: () => {
          env.TC_DAEMON_PORT = "9990"; // 模拟 ~/.tc/.env 链补键
        },
        stdin: ttyStdin,
        argv: ["daemon", "--status"],
        daemonHealth: async (port) => {
          seenPort = port;
          return null;
        },
        ...c.deps,
      });
      expect(code).toBe(0);
      expect(seenPort).toBe(9990);
      expect(JSON.parse(c.out[0])).toMatchObject({ running: false, port: 9990 });
    }
    // doctor 面内部从 env 取端口：显式旗标覆盖须可见
    {
      const c = capture();
      const env: Record<string, string | undefined> = {};
      let doctorEnvPort: string | undefined;
      const code = await main({
        env,
        applyEnv: () => {},
        stdin: ttyStdin,
        argv: ["daemon", "--doctor", "--daemon-port", "9995"],
        daemonDoctor: async () => {
          doctorEnvPort = env.TC_DAEMON_PORT;
          return { summary: "healthy", findings: [] };
        },
        ...c.deps,
      });
      expect(code).toBe(0);
      expect(doctorEnvPort).toBe("9995");
    }
  });

  test("serve：端口被占 → 幂等 exit 0；启动异常 → exit 2（盘面全注入）", async () => {
    const noDisk = {
      ensureDir: async () => {},
      appendLog: () => {},
      writeInfo: async () => {},
      removeFile: async () => {},
    };
    {
      const c = capture();
      const code = await main({
        ...base,
        argv: ["daemon", "--serve"],
        startServer: (async () => {
          throw new PortInUseError(9780);
        }) as unknown as typeof startDaemonServer,
        ...noDisk,
        ...c.deps,
      });
      expect(code).toBe(0);
      expect(c.err.join("\n")).toContain("已在运行");
    }
    {
      const c = capture();
      const code = await main({
        ...base,
        argv: ["daemon", "--serve"],
        startServer: (async () => {
          throw new Error("boom");
        }) as unknown as typeof startDaemonServer,
        ...noDisk,
        ...c.deps,
      });
      expect(code).toBe(2);
    }
  });
});
