// bridge-runtime 单测（issue #31 M1 P3）：fake storage/alarms/fetch/tabs 全注入 +
// fake timers 驱动调度——覆盖配对捕获、re-pair、长轮询领批回投、cancel_request、
// 409 回探活、重试预算→paused→alarm 自愈、配置热更新与自身写入回声。
import type { BridgeClientConfig, BridgeCommandRequest } from "@tw/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlarmsApi, StorageArea, StorageOnChangedApi } from "../src/host/chrome-apis.js";
import {
  BRIDGE_POLL_ALARM,
  BRIDGE_STORAGE_KEY,
  BridgeRuntime,
  type BridgeRuntimeDeps,
  canonicalConfigJson,
  DEFAULT_BRIDGE_ENDPOINT,
  pairingTokenFromUrl,
  parseBridgeConfig,
} from "../src/runtime/bridge-runtime.js";

interface Harness {
  deps: BridgeRuntimeDeps;
  runtime: BridgeRuntime;
  store: Map<string, unknown>;
  fetchCalls: Array<{ url: string; body: unknown }>;
  dispatched: BridgeCommandRequest[];
  dispatchSignals: AbortSignal[];
  createdAlarms: string[];
  clearedAlarms: string[];
  fireAlarm(name: string): void;
  fireStorage(value: unknown): void;
  setRouter(router: (url: URL, body: unknown) => Response | Promise<Response>): void;
  setDispatch(impl: (request: BridgeCommandRequest, signal: AbortSignal) => Promise<unknown>): void;
  advance(clockMs?: number): Promise<void>;
  setClock(ms: number): void;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function harness(): Harness {
  const store = new Map<string, unknown>();
  const storage: StorageArea = {
    get: async (keys) => {
      const key = typeof keys === "string" ? keys : String(keys);
      const value = store.get(key);
      return value === undefined ? {} : { [key]: value };
    },
    set: async (items) => {
      for (const [key, value] of Object.entries(items)) store.set(key, value);
    },
  };
  const storageListeners = new Set<Parameters<StorageOnChangedApi["addListener"]>[0]>();
  const storageOnChanged: StorageOnChangedApi = {
    addListener: (cb) => storageListeners.add(cb),
    removeListener: (cb) => storageListeners.delete(cb),
  };
  const alarmListeners = new Set<(alarm: { name: string }) => void>();
  const createdAlarms: string[] = [];
  const clearedAlarms: string[] = [];
  const alarms: AlarmsApi = {
    create: (name) => {
      createdAlarms.push(name);
    },
    clear: async (name) => {
      clearedAlarms.push(name);
      return true;
    },
    onAlarm: {
      addListener: (cb) => alarmListeners.add(cb),
      removeListener: (cb) => alarmListeners.delete(cb),
    },
  };
  const fetchCalls: Array<{ url: string; body: unknown }> = [];
  let router: (url: URL, body: unknown) => Response | Promise<Response> = () => jsonRes({});
  const doFetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body !== undefined ? (JSON.parse(String(init.body)) as unknown) : undefined;
    fetchCalls.push({ url, body });
    return await router(new URL(url), body);
  }) as typeof fetch;
  const dispatched: BridgeCommandRequest[] = [];
  const dispatchSignals: AbortSignal[] = [];
  let dispatchImpl: (request: BridgeCommandRequest, signal: AbortSignal) => Promise<unknown> =
    async () => ({ accepted: true, runId: "r-1" });
  let clock = 10_000_000;
  let idSeq = 0;
  const deps: BridgeRuntimeDeps = {
    storage,
    storageOnChanged,
    alarms,
    fetch: doFetch,
    extensionId: "ext-1",
    newId: () => `cid-${++idSeq}`,
    now: () => clock,
    dispatch: async (request, signal) => {
      dispatched.push(request);
      dispatchSignals.push(signal);
      return await dispatchImpl(request, signal);
    },
    log: () => {},
  };
  return {
    deps,
    runtime: new BridgeRuntime(deps),
    store,
    fetchCalls,
    dispatched,
    dispatchSignals,
    createdAlarms,
    clearedAlarms,
    fireAlarm: (name) => {
      for (const listener of alarmListeners) listener({ name });
    },
    fireStorage: (value) => {
      for (const listener of storageListeners) {
        listener({ [BRIDGE_STORAGE_KEY]: { newValue: value } }, "local");
      }
    },
    setRouter: (next) => {
      router = next;
    },
    setDispatch: (impl) => {
      dispatchImpl = impl;
    },
    advance: async (clockMs = 0) => {
      clock += clockMs;
      await vi.advanceTimersByTimeAsync(clockMs);
      await vi.advanceTimersByTimeAsync(0);
    },
    setClock: (ms) => {
      clock = ms;
    },
  };
}

/** 已配对配置（跳过配对段直接测轮询） */
function pairedConfig(over: Partial<BridgeClientConfig> = {}): BridgeClientConfig {
  return {
    enabled: true,
    endpoint: DEFAULT_BRIDGE_ENDPOINT,
    pairingToken: "tok-known",
    extensionId: "ext-1",
    name: "TreeChrome",
    connectionId: "c-1",
    instanceId: "inst-1",
    state: "connected",
    lastError: null,
    connectedAt: 1,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("配对全链（默认 enabled → 探活 → 捕获 t → pair → poll）", () => {
  it("无 token 无邀请时按探活节奏等待；捕获 t 后完成配对并进入轮询", async () => {
    const h = harness();
    let pairBody: Record<string, unknown> | undefined;
    let pollCount = 0;
    h.setRouter((url, body) => {
      if (url.pathname === "/health") {
        return jsonRes({ instanceId: "inst-1", pendingPairing: true });
      }
      if (url.pathname === "/v1/tc/pair") {
        pairBody = body as Record<string, unknown>;
        return jsonRes({ ok: true, instanceId: "inst-1", connectionId: "c-1" });
      }
      if (url.pathname === "/v1/tc/poll") {
        pollCount += 1;
        return pollCount === 1
          ? jsonRes({
              requests: [
                { id: "q1", method: "run_task", params: { task: "查价" }, timeoutMs: 5_000 },
              ],
            })
          : jsonRes({ requests: [] });
      }
      if (url.pathname === "/v1/tc/result") return jsonRes({ ok: true });
      return jsonRes({ error: "not found" }, 404);
    });

    h.runtime.start();
    await h.advance(0);
    // 默认配置已落盘且探活一轮（无 t）——停在被调度上
    expect(h.store.get(BRIDGE_STORAGE_KEY)).toMatchObject({ enabled: true, state: "connecting" });
    expect(pairBody).toBeUndefined();

    // 用户打开 connect URL → 捕获 → 配对
    h.runtime.handleTabUrl(`${DEFAULT_BRIDGE_ENDPOINT}/tc-connect?t=abc123`);
    await h.advance(0);
    expect(pairBody).toMatchObject({ t: "abc123", extensionId: "ext-1" });
    expect((pairBody?.pairingToken as string) ?? "").toMatch(/[\w-]{43}/);
    expect(h.runtime.status()).toMatchObject({ state: "connected", instanceId: "inst-1" });

    // 轮询领批 → dispatch → result 回投
    await h.advance(0);
    expect(h.dispatched.map((r) => r.method)).toEqual(["run_task"]);
    const resultPost = h.fetchCalls.find((c) => c.url.endsWith("/v1/tc/result"));
    expect(resultPost?.body).toMatchObject({ requestId: "q1", ok: true });
    expect(h.createdAlarms).toContain(BRIDGE_POLL_ALARM);
  });

  it("落盘 token 的 re-pair：桥在线即凭旧 token 恢复（t 为空、无需用户确认）", async () => {
    const h = harness();
    h.store.set(BRIDGE_STORAGE_KEY, pairedConfig({ instanceId: "", state: "reconnecting" }));
    let pairBody: Record<string, unknown> | undefined;
    h.setRouter((url, body) => {
      if (url.pathname === "/health")
        return jsonRes({ instanceId: "inst-2", pendingPairing: false });
      if (url.pathname === "/v1/tc/pair") {
        pairBody = body as Record<string, unknown>;
        return jsonRes({ ok: true, instanceId: "inst-2", connectionId: "c-1" });
      }
      return jsonRes({ requests: [] });
    });
    h.runtime.start();
    await h.advance(0);
    expect(pairBody).toMatchObject({ t: "", pairingToken: "tok-known" });
    expect(h.runtime.status().instanceId).toBe("inst-2");
  });

  it('桥侧配对记录丢失（pair 409）后捕获新邀请 → t 用真邀请（不死锁在 t:""）', async () => {
    const h = harness();
    h.store.set(
      BRIDGE_STORAGE_KEY,
      pairedConfig({ instanceId: "", state: "connecting", pairingToken: "tok-known" }),
    );
    const pairBodies: Array<Record<string, unknown>> = [];
    h.setRouter((url, body) => {
      if (url.pathname === "/health")
        return jsonRes({ instanceId: "inst-9", pendingPairing: true });
      if (url.pathname === "/v1/tc/pair") {
        pairBodies.push(body as Record<string, unknown>);
        if ((body as { t?: unknown }).t !== "fix1")
          return jsonRes({ code: "BRIDGE_PAIRING_REQUIRED", error: "no record" }, 409);
        return jsonRes({ ok: true, instanceId: "inst-9", connectionId: "c-9" });
      }
      return jsonRes({ requests: [] });
    });
    h.runtime.start();
    await h.advance(0); // 首拍：持旧 token re-pair（t:""）→ 桥侧记录已丢 409 → 收敛重试
    expect(h.runtime.status()).toMatchObject({
      state: "reconnecting",
      lastError: { code: "BRIDGE_PAIRING_REQUIRED" },
    });
    h.runtime.handleTabUrl(`${DEFAULT_BRIDGE_ENDPOINT}/tc-connect?t=fix1`);
    await h.advance(0); // 捕获有效邀请 → t 用真值 → 配对成功
    expect(pairBodies.map((b) => b.t)).toEqual(["", "fix1"]);
    expect(h.runtime.status()).toMatchObject({ state: "connected", instanceId: "inst-9" });
  });

  it("探活等待稳态不重复落盘（persist 只在转移时）", async () => {
    const h = harness();
    h.setRouter((url) =>
      url.pathname === "/health"
        ? jsonRes({ instanceId: "inst-1", pendingPairing: false })
        : jsonRes({ error: "not found" }, 404),
    );
    const setSpy = vi.spyOn(h.deps.storage, "set");
    h.runtime.start();
    await h.advance(0); // 首轮：restore bootstrap 落盘缺省配置恰 1 次
    await h.advance(2_000);
    await h.advance(2_000);
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(h.runtime.status()).toMatchObject({ state: "connecting", enabled: true });
  });

  it("冷启动扫描：SW 睡眠期间打开的（活动）配对页仍开着——恢复即捕获", async () => {
    const h = harness();
    // chrome.tabs.query 过滤器语义同形：active 传布尔只匹配对应子集——用户地址栏/
    // 新标签页打开的配对页恰是活动页，{active:false} 会把它滤掉（评审轮 1 实录）
    const tabs = [
      { id: 1, url: `${DEFAULT_BRIDGE_ENDPOINT}/tc-connect?t=late9`, active: true },
      { id: 2, url: "https://elsewhere.example/", active: false },
    ];
    let pairBody: Record<string, unknown> | undefined;
    h.deps.tabsQuery = {
      query: async (info) =>
        tabs
          .filter((t) => (typeof info.active === "boolean" ? t.active === info.active : true))
          .map((t) => ({ id: t.id, url: t.url })),
    };
    h.setRouter((url, body) => {
      if (url.pathname === "/health")
        return jsonRes({ instanceId: "inst-1", pendingPairing: true });
      if (url.pathname === "/v1/tc/pair") {
        pairBody = body as Record<string, unknown>;
        return jsonRes({ ok: true, instanceId: "inst-1", connectionId: "c-1" });
      }
      return jsonRes({ requests: [] });
    });
    h.runtime.start();
    await h.advance(0);
    expect(pairBody).toMatchObject({ t: "late9" });
  });
});

describe("轮询与分发", () => {
  it("cancel_request 中止在途 dispatch 的 signal", async () => {
    const h = harness();
    h.store.set(BRIDGE_STORAGE_KEY, pairedConfig());
    let pollCount = 0;
    h.setDispatch(() => new Promise(() => {})); // 永不结束——等 abort
    h.setRouter((url) => {
      if (url.pathname === "/v1/tc/poll") {
        pollCount += 1;
        return pollCount === 1
          ? jsonRes({
              requests: [{ id: "q2", method: "run_task", params: {}, timeoutMs: 60_000 }],
            })
          : jsonRes({
              requests: [
                {
                  id: "cx",
                  method: "cancel_request",
                  params: { requestId: "q2" },
                  timeoutMs: 1_000,
                },
              ],
            });
      }
      return jsonRes({ requests: [] });
    });
    h.runtime.start();
    await h.advance(0);
    await h.advance(0);
    expect(h.dispatchSignals[0]?.aborted).toBe(true);
  });

  it("drive/session_stop 过白名单进 dispatch（#32 M2 直驱命令）", async () => {
    const h = harness();
    h.store.set(BRIDGE_STORAGE_KEY, pairedConfig());
    let pollCount = 0;
    h.setRouter((url) => {
      if (url.pathname === "/v1/tc/poll") {
        pollCount += 1;
        return pollCount === 1
          ? jsonRes({
              requests: [
                {
                  id: "d1",
                  method: "drive",
                  params: { verb: "get_state", args: {} },
                  timeoutMs: 5_000,
                },
                { id: "s1", method: "session_stop", params: {}, timeoutMs: 5_000 },
              ],
            })
          : jsonRes({ requests: [] });
      }
      return jsonRes({ requests: [] });
    });
    h.runtime.start();
    await h.advance(0);
    expect(h.dispatched.map((r) => r.method)).toEqual(["drive", "session_stop"]);
  });

  it("dispatch 抛错 → result 回投 ok:false 错误信封", async () => {
    const h = harness();
    h.store.set(BRIDGE_STORAGE_KEY, pairedConfig());
    h.setDispatch(async () => {
      throw new Error("boom");
    });
    let pollCount = 0;
    h.setRouter((url) => {
      if (url.pathname === "/v1/tc/poll") {
        pollCount += 1;
        return pollCount === 1
          ? jsonRes({
              requests: [{ id: "q3", method: "get_snapshot", params: {}, timeoutMs: 5_000 }],
            })
          : jsonRes({ requests: [] });
      }
      if (url.pathname === "/v1/tc/result") return jsonRes({ ok: true });
      return jsonRes({ requests: [] });
    });
    h.runtime.start();
    await h.advance(0);
    await h.advance(0);
    const resultPost = h.fetchCalls.find((c) => c.url.endsWith("/v1/tc/result"));
    expect(resultPost?.body).toMatchObject({
      requestId: "q3",
      ok: false,
      error: { code: "TOOL_EXECUTION_FAILED", message: "boom" },
    });
  });

  it("poll 409 BRIDGE_INSTANCE_CHANGED → 清 instanceId 回探活层", async () => {
    const h = harness();
    h.store.set(BRIDGE_STORAGE_KEY, pairedConfig());
    let phase: "poll409" | "repair" | "poll" = "poll409";
    let pairBody: Record<string, unknown> | undefined;
    h.setRouter((url, body) => {
      if (url.pathname === "/v1/tc/poll" && phase === "poll409") {
        phase = "repair";
        return jsonRes({ ok: false, code: "BRIDGE_INSTANCE_CHANGED", error: "restarted" }, 409);
      }
      if (url.pathname === "/health")
        return jsonRes({ instanceId: "inst-9", pendingPairing: false });
      if (url.pathname === "/v1/tc/pair") {
        pairBody = body as Record<string, unknown>;
        phase = "poll";
        return jsonRes({ ok: true, instanceId: "inst-9", connectionId: "c-1" });
      }
      return jsonRes({ requests: [] });
    });
    h.runtime.start();
    await h.advance(0); // poll → 409 → 回探活
    await h.advance(2_100); // 探活间隔到 → health → re-pair
    expect(pairBody).toMatchObject({ t: "", pairingToken: "tok-known" });
    expect(h.runtime.status().instanceId).toBe("inst-9");
  });
});

describe("重试预算与自愈", () => {
  it("连续失败 → paused；alarm 唤醒重置预算恢复探活", async () => {
    const h = harness();
    h.setRouter(() => {
      throw new Error("ECONNREFUSED");
    });
    h.runtime.start();
    await h.advance(0);
    // 预算 8：失败 8 次后 paused
    for (let i = 0; i < 8; i += 1) {
      await h.advance(3_100);
    }
    expect(h.runtime.status()).toMatchObject({ state: "paused" });

    // 桥恢复 + alarm 唤醒 → 重置预算 → 探活（无邀请停在 connecting）
    let healthSeen = false;
    h.setRouter((url) => {
      if (url.pathname === "/health") {
        healthSeen = true;
        return jsonRes({ instanceId: "inst-1", pendingPairing: false });
      }
      return jsonRes({ requests: [] });
    });
    h.fireAlarm(BRIDGE_POLL_ALARM);
    await h.advance(0);
    expect(healthSeen).toBe(true);
    expect(h.runtime.status()).toMatchObject({ state: "connecting" });
  });
});

describe("配置热更新", () => {
  it("chrome.storage 键序重排的回声不触发重启（e2e 实证坑：回读按字母序）", async () => {
    const h = harness();
    h.store.set(BRIDGE_STORAGE_KEY, pairedConfig());
    h.setRouter(() => jsonRes({ requests: [] }));
    h.runtime.start();
    await h.advance(0);
    const fetchCount = h.fetchCalls.length;
    // 模拟 chrome.storage 行为：回读对象键按字母序重排（connectedAt 抢到最前）
    const echoed = {};
    for (const key of Object.keys(h.runtime.status()).sort()) {
      echoed[key] = (h.runtime.status() as Record<string, unknown>)[key];
    }
    h.fireStorage(echoed);
    await h.advance(0);
    expect(h.fetchCalls.length).toBe(fetchCount);
  });

  it("外部禁用（enabled:false）→ 停止轮询并清 alarm", async () => {
    const h = harness();
    h.store.set(BRIDGE_STORAGE_KEY, pairedConfig());
    h.setRouter((url) =>
      url.pathname === "/v1/tc/poll" ? jsonRes({ requests: [] }) : jsonRes({ requests: [] }),
    );
    h.runtime.start();
    await h.advance(0);
    const fetchCount = h.fetchCalls.length;

    // 真实语义：onChanged 触发时 store 已是新值（事件不携带权威数据，restore 读盘）
    const disabled = { ...pairedConfig(), enabled: false, state: "disabled" };
    h.store.set(BRIDGE_STORAGE_KEY, disabled);
    h.fireStorage(disabled);
    await h.advance(0);
    await h.advance(3_500);
    expect(h.runtime.status().enabled).toBe(false);
    expect(h.fetchCalls.length).toBe(fetchCount);
    expect(h.clearedAlarms).toContain(BRIDGE_POLL_ALARM);
  });

  it("自身写入回声不触发重启", async () => {
    const h = harness();
    h.store.set(BRIDGE_STORAGE_KEY, pairedConfig());
    h.setRouter(() => jsonRes({ requests: [] }));
    h.runtime.start();
    await h.advance(0);
    const fetchCount = h.fetchCalls.length;
    // 模拟 persist 后的回声：newValue 与 lastWritten 同形（enabled 仍 true）
    h.fireStorage({ ...h.runtime.status() });
    await h.advance(0);
    expect(h.fetchCalls.length).toBe(fetchCount);
  });
});

describe("stop", () => {
  it("摘除监听并清 alarm", async () => {
    const h = harness();
    h.store.set(BRIDGE_STORAGE_KEY, pairedConfig());
    h.setRouter(() => jsonRes({ requests: [] }));
    h.runtime.start();
    await h.advance(0);
    h.runtime.stop();
    await h.advance(0);
    expect(h.clearedAlarms).toContain(BRIDGE_POLL_ALARM);
    // stop 后 alarm 再响不做事
    const fetchCount = h.fetchCalls.length;
    h.fireAlarm(BRIDGE_POLL_ALARM);
    await h.advance(0);
    expect(h.fetchCalls.length).toBe(fetchCount);
  });
});

describe("边界与错误面", () => {
  it("pair 被桥拒绝（409 BRIDGE_CLIENT_IN_USE）→ 错误入账并按重试节奏重排", async () => {
    const h = harness();
    h.setRouter((url) => {
      if (url.pathname === "/health")
        return jsonRes({ instanceId: "inst-1", pendingPairing: true });
      if (url.pathname === "/v1/tc/pair") {
        return jsonRes({ ok: false, code: "BRIDGE_CLIENT_IN_USE", error: "busy" }, 409);
      }
      return jsonRes({ requests: [] });
    });
    h.runtime.start();
    await h.advance(0); // 探活：有邀请但还没捕获 t——正常停在探活节奏
    h.runtime.handleTabUrl(`${DEFAULT_BRIDGE_ENDPOINT}/tc-connect?t=tok1`);
    await h.advance(0); // 捕获 → pair → 409 → 错误收敛
    expect(h.runtime.status()).toMatchObject({
      state: "reconnecting",
      lastError: { code: "BRIDGE_CLIENT_IN_USE", message: "busy" },
    });
  });

  it("poll 500 非 JSON 体 → 错误收敛重试（code 缺省）", async () => {
    const h = harness();
    h.store.set(BRIDGE_STORAGE_KEY, pairedConfig());
    h.setRouter((url) => {
      if (url.pathname === "/v1/tc/poll") {
        return new Response("Internal Server Error", { status: 500 });
      }
      return jsonRes({ requests: [] });
    });
    h.runtime.start();
    await h.advance(0);
    expect(h.runtime.status()).toMatchObject({ state: "reconnecting" });
  });

  it("alarms 抛错不拖垮 runtime（catch 分支）", async () => {
    const h = harness();
    h.deps.alarms.create = () => {
      throw new Error("alarms broken");
    };
    h.store.set(BRIDGE_STORAGE_KEY, pairedConfig());
    h.setRouter(() => jsonRes({ requests: [] }));
    h.runtime.start();
    await h.advance(0);
    expect(h.runtime.status()).toMatchObject({ state: "connected" });
  });

  it("未 start 即触发 handleTabUrl/handleAlarm/status——防御不抛", () => {
    const h = harness();
    expect(() => h.runtime.handleTabUrl(`${DEFAULT_BRIDGE_ENDPOINT}/tc-connect?t=x`)).not.toThrow();
    expect(() => h.runtime.fireAlarm?.()).not.toThrow();
    h.fireAlarm(BRIDGE_POLL_ALARM);
    expect(h.runtime.status()).toMatchObject({ enabled: true, state: "connecting" });
  });

  it("dispatch 抛非 Error 值 → message 走 String()", async () => {
    const h = harness();
    h.store.set(BRIDGE_STORAGE_KEY, pairedConfig());
    h.setDispatch(async () => {
      throw "raw string"; // eslint-disable-next-line @typescript-eslint/only-throw-error
    });
    let pollCount = 0;
    h.setRouter((url) => {
      if (url.pathname === "/v1/tc/poll") {
        pollCount += 1;
        return pollCount === 1
          ? jsonRes({ requests: [{ id: "q9", method: "stop_run", params: {}, timeoutMs: 5_000 }] })
          : jsonRes({ requests: [] });
      }
      return jsonRes({ requests: [] });
    });
    h.runtime.start();
    await h.advance(0);
    await h.advance(0);
    const resultPost = h.fetchCalls.find((c) => c.url.endsWith("/v1/tc/result"));
    expect(resultPost?.body).toMatchObject({
      requestId: "q9",
      ok: false,
      error: { message: "raw string" },
    });
  });

  it("冷启动扫描 tabsQuery 抛错——catch 不致命", async () => {
    const h = harness();
    h.deps.tabsQuery = {
      query: async () => {
        throw new Error("tabs unavailable");
      },
    };
    h.setRouter(() => jsonRes({ requests: [] }));
    h.runtime.start();
    await h.advance(0);
    expect(h.runtime.status().enabled).toBe(true);
  });

  it("start 前 status 返回缺省形态（config 未装载）", () => {
    const h = harness();
    expect(h.runtime.status()).toMatchObject({
      enabled: true,
      instanceId: "",
      state: "connecting",
    });
  });
});

describe("纯函数", () => {
  it("canonicalConfigJson：键序无关相等（chrome.storage 回声判定基础）", () => {
    expect(canonicalConfigJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalConfigJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(canonicalConfigJson({ a: 1 })).not.toBe(canonicalConfigJson({ a: 2 }));
    expect(canonicalConfigJson("junk")).toBe(JSON.stringify("junk"));
  });

  it("pairingTokenFromUrl：仅本桥 endpoint 的 /tc-connect 且带 t", () => {
    expect(
      pairingTokenFromUrl(`${DEFAULT_BRIDGE_ENDPOINT}/tc-connect?t=abc`, DEFAULT_BRIDGE_ENDPOINT),
    ).toBe("abc");
    expect(
      pairingTokenFromUrl("http://127.0.0.1:9999/tc-connect?t=abc", DEFAULT_BRIDGE_ENDPOINT),
    ).toBeNull();
    expect(
      pairingTokenFromUrl(`${DEFAULT_BRIDGE_ENDPOINT}/health?t=abc`, DEFAULT_BRIDGE_ENDPOINT),
    ).toBeNull();
    expect(
      pairingTokenFromUrl(`${DEFAULT_BRIDGE_ENDPOINT}/tc-connect`, DEFAULT_BRIDGE_ENDPOINT),
    ).toBeNull();
    expect(pairingTokenFromUrl(undefined, DEFAULT_BRIDGE_ENDPOINT)).toBeNull();
    expect(pairingTokenFromUrl("::not-a-url", DEFAULT_BRIDGE_ENDPOINT)).toBeNull();
  });

  it("parseBridgeConfig：坏形态回缺省、合法字段保留", () => {
    const fallback = (): BridgeClientConfig =>
      pairedConfig({ instanceId: "", state: "connecting" });
    expect(parseBridgeConfig(null, fallback)).toMatchObject({ enabled: true, instanceId: "" });
    expect(parseBridgeConfig("junk" as unknown, fallback)).toMatchObject({ state: "connecting" });
    expect(
      parseBridgeConfig(
        {
          enabled: false,
          endpoint: "http://x",
          pairingToken: "t",
          instanceId: "i",
          state: "paused",
        },
        fallback,
      ),
    ).toMatchObject({ enabled: false, endpoint: "http://x", instanceId: "i", state: "paused" });
    expect(
      parseBridgeConfig({ lastError: { code: 1, message: "x" }, state: "weird" }, fallback)
        .lastError,
    ).toBeNull();
  });
});
