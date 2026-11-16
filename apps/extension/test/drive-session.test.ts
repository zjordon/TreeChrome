// drive-session 单测（issue #32 M2 P1）：惰性创建全链/复用/死会话自愈/stop 幂等/
// 空闲回收与 touch/epoch 跨冷启单调（持久化）/无可驱动 tab/start 失败——fake
// tabsQuery + 假 core（BrowserSession/Tools 假件）+ 真 KeepaliveController（fake
// alarms）+ fake timers。

import type { BrowserSession, Tools } from "@tw/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlarmsApi, StorageArea, TabsQueryApi } from "../src/host/chrome-apis.js";
import { KeepaliveController } from "../src/host/keepalive.js";
import { DEFAULT_DRIVE_IDLE_MS, DriveSession } from "../src/runtime/drive-session.js";
import { pickActiveDrivableTab } from "../src/runtime/tab-pick.js";

interface FakeBrowser {
  isConnected: boolean;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function fakeCore(): { browser: FakeBrowser; tools: Tools } {
  return {
    browser: {
      isConnected: true,
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    },
    tools: {} as Tools,
  };
}

interface Harness {
  session: DriveSession;
  cores: Array<{ browser: FakeBrowser; tools: Tools }>;
  transportTabIds: number[];
  createdAlarms: string[];
  clearedAlarms: string[];
  store: Map<string, unknown>;
  setTabs(tabs: Array<{ id: number; url?: string }>): void;
  advance(ms: number): Promise<void>;
  setNow(ms: number): void;
}

function harness(options: { idleMs?: number } = {}): Harness {
  const cores: Array<{ browser: FakeBrowser; tools: Tools }> = [];
  const transportTabIds: number[] = [];
  let tabs: Array<{ id: number; url?: string }> = [{ id: 7, url: "https://example.com/" }];
  const tabsQuery: TabsQueryApi = {
    query: async () => tabs,
  };
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
      addListener: () => {},
      removeListener: () => {},
    },
  };
  let clock = 10_000;
  const session = new DriveSession({
    tabsQuery,
    makeTransportFactory: (tabId) => {
      transportTabIds.push(tabId);
      return async () => ({}) as never;
    },
    makeCore: () => {
      const core = fakeCore();
      cores.push(core);
      return { browser: core.browser as unknown as BrowserSession, tools: core.tools };
    },
    keepalive: new KeepaliveController(alarms),
    storage,
    now: () => clock,
    log: () => {},
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
  });
  return {
    session,
    cores,
    transportTabIds,
    createdAlarms,
    clearedAlarms,
    store,
    setTabs: (next) => {
      tabs = next;
    },
    advance: async (ms) => {
      clock += ms;
      await vi.advanceTimersByTimeAsync(ms);
      await vi.advanceTimersByTimeAsync(0);
    },
    setNow: (ms) => {
      clock = ms;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("drive-session 生命周期", () => {
  it("惰性创建全链：挑 tab → transport 工厂绑定 → makeCore → start → hold → epoch=1 持久化", async () => {
    const h = harness();
    expect(h.session.active).toBe(false);
    const core = await h.session.ensure();
    expect(h.transportTabIds).toEqual([7]);
    expect(core.browser.start).toHaveBeenCalledTimes(1);
    expect(h.session.active).toBe(true);
    expect(h.session.epoch).toBe(1);
    expect(h.store.get("tc_driveEpoch")).toBe(1);
    expect(h.createdAlarms).toContain("tc-keepalive");
  });

  it("复用：连续 ensure 同一 core 不重建、epoch 不变", async () => {
    const h = harness();
    const first = await h.session.ensure();
    const second = await h.session.ensure();
    expect(second).toBe(first);
    expect(h.cores).toHaveLength(1);
    expect(h.session.epoch).toBe(1);
  });

  it("死会话自愈：isConnected=false 后 ensure → 旧 stop + 重建 + epoch+1", async () => {
    const h = harness();
    await h.session.ensure();
    const first = h.cores[0];
    if (first === undefined) throw new Error("first core missing");
    first.browser.isConnected = false;
    const next = await h.session.ensure();
    expect(h.cores[0]?.browser.stop).toHaveBeenCalledTimes(1);
    expect(next.browser).not.toBe(h.cores[0]?.browser);
    expect(h.cores).toHaveLength(2);
    expect(h.session.epoch).toBe(2);
  });

  it("stop 幂等：browser.stop + release hold（闹钟清）；二次 stop 零调用", async () => {
    const h = harness();
    await h.session.ensure();
    await h.session.stop();
    expect(h.cores[0]?.browser.stop).toHaveBeenCalledTimes(1);
    expect(h.session.active).toBe(false);
    expect(h.clearedAlarms).toContain("tc-keepalive");
    await h.session.stop();
    expect(h.cores[0]?.browser.stop).toHaveBeenCalledTimes(1);
    expect(h.clearedAlarms).toHaveLength(1);
  });

  it("并发 ensure 单飞：同窗多次调用只创建一次", async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.session.ensure(), h.session.ensure()]);
    expect(a).toBe(b);
    expect(h.cores).toHaveLength(1);
  });

  it("start 失败 → SESSION_START_FAILED，不 hold、active 保持 false", async () => {
    const store = new Map<string, unknown>();
    const failing = new DriveSession({
      tabsQuery: { query: async () => [{ id: 3, url: "https://y/" }] },
      makeTransportFactory: () => async () => ({}) as never,
      makeCore: () => {
        const core = fakeCore();
        core.browser.start = vi.fn(async () => {
          throw new Error("attach denied");
        });
        return { browser: core.browser as unknown as BrowserSession, tools: core.tools };
      },
      keepalive: new KeepaliveController({
        create: () => {},
        clear: async () => true,
        onAlarm: { addListener: () => {}, removeListener: () => {} },
      }),
      storage: {
        get: async () => ({}),
        set: async (items) => {
          Object.assign(Object.fromEntries(store), items);
        },
      },
      now: () => 0,
    });
    await expect(failing.ensure()).rejects.toMatchObject({ code: "SESSION_START_FAILED" });
    expect(failing.active).toBe(false);
    expect(failing.epoch).toBe(0);
  });

  it("无可驱动 tab：仅 chrome:// → RESTRICTED_TAB；空 → NO_ACTIVE_TAB", async () => {
    const h = harness();
    h.setTabs([{ id: 1, url: "chrome://extensions" }]);
    await expect(h.session.ensure()).rejects.toMatchObject({ code: "RESTRICTED_TAB" });
    h.setTabs([]);
    await expect(h.session.ensure()).rejects.toMatchObject({ code: "NO_ACTIVE_TAB" });
  });

  it("epoch 跨冷启单调：预置持久值 5 → 首次 ensure = 6（模拟 SW 重生接续）", async () => {
    const h = harness();
    h.store.set("tc_driveEpoch", 5);
    await h.session.ensure();
    expect(h.session.epoch).toBe(6);
    expect(h.store.get("tc_driveEpoch")).toBe(6);
  });
});

describe("drive-session 空闲回收", () => {
  it("idle 超窗自动回收；再 ensure 新会话 epoch+1", async () => {
    const h = harness({ idleMs: 1_000 });
    await h.session.ensure();
    expect(h.session.epoch).toBe(1);
    await h.advance(1_600);
    expect(h.session.active).toBe(false);
    expect(h.cores[0]?.browser.stop).toHaveBeenCalledTimes(1);
    expect(h.clearedAlarms).toContain("tc-keepalive");
    await h.session.ensure();
    expect(h.cores).toHaveLength(2);
    expect(h.session.epoch).toBe(2);
  });

  it("touch 重置空闲窗：静默 800ms → touch → 再 800ms 不回收，续 400ms 才回收", async () => {
    const h = harness({ idleMs: 1_000 });
    await h.session.ensure();
    await h.advance(800);
    h.session.touch();
    await h.advance(800);
    expect(h.session.active).toBe(true);
    await h.advance(400);
    expect(h.session.active).toBe(false);
  });

  it("idleMs<=0 关闭回收：超窗不回收", async () => {
    const h = harness({ idleMs: 0 });
    await h.session.ensure();
    await h.advance(DEFAULT_DRIVE_IDLE_MS + 120_000);
    expect(h.session.active).toBe(true);
  });
});

describe("tab-pick 降级链", () => {
  it("currentWindow 空 → lastFocused 命中；全链空 → tabId undefined", async () => {
    const queries: Array<{
      active: boolean;
      currentWindow?: boolean;
      lastFocusedWindow?: boolean;
    }>[] = [];
    const tabsQuery: TabsQueryApi = {
      query: async (info) => {
        queries.push({ ...info });
        if (info.currentWindow === true) return [];
        if (info.lastFocusedWindow === true) return [{ id: 4, url: "https://z/" }];
        return [];
      },
    };
    const pick = await pickActiveDrivableTab(tabsQuery);
    expect(pick.tabId).toBe(4);
    expect(pick.sawRestricted).toBe(false);
    expect(queries).toHaveLength(2);
  });

  it("sawRestricted：末级结果含内部页 → true", async () => {
    const tabsQuery: TabsQueryApi = {
      query: async (info) =>
        info.currentWindow === true ? [] : [{ id: 2, url: "chrome://settings" }],
    };
    const pick = await pickActiveDrivableTab(tabsQuery);
    expect(pick.tabId).toBeUndefined();
    expect(pick.sawRestricted).toBe(true);
  });
});
