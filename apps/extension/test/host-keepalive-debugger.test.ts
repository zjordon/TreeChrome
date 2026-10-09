// keepalive + debugger-api 单测（m5/04 §8/§2）：闹钟创建/清除幂等面 +
// cdp-chrome 工厂绑定（fake DebuggerApi/TabsApi 记录构造入参——真绑定面在
// cdp-chrome 包已有 37 例覆盖）。

import { describe, expect, it } from "vitest";
import type { AlarmsApi } from "../src/host/chrome-apis.js";
import { KEEPALIVE_ALARM, KeepaliveController } from "../src/host/keepalive.js";

describe("KeepaliveController", () => {
  it("onStartRun 创建闹钟（0.5min 周期）；onEndRun 清除；重复清除无害", () => {
    const created: Array<{ name: string; period: number }> = [];
    const cleared: string[] = [];
    const alarms: AlarmsApi = {
      create: (name, info) => void created.push({ name, period: info.periodInMinutes }),
      clear: async (name) => void cleared.push(name),
    };
    const keepalive = new KeepaliveController(alarms);
    keepalive.onStartRun();
    keepalive.onStartRun(); // 幂等（同名覆盖语义）
    expect(created).toEqual([
      { name: KEEPALIVE_ALARM, period: 0.5 },
      { name: KEEPALIVE_ALARM, period: 0.5 },
    ]);
    keepalive.onEndRun();
    keepalive.onEndRun(); // 已 inactive——不再清
    expect(cleared).toEqual([KEEPALIVE_ALARM]);
  });
});

describe("makeDebuggerTransportFactory", () => {
  it("工厂绑定 tabId 与注入的 api/tabs（不落真 chrome 绑定）", async () => {
    const { makeDebuggerTransportFactory } = await import("../src/host/debugger-api.js");
    const attached: Array<{ tabId?: number; targetId?: string }> = [];
    const api = {
      attach: async (d) => void attached.push(d),
      detach: async () => {},
      sendCommand: async () => ({}),
      onEvent: { addListener: () => {}, removeListener: () => {} },
      onDetach: { addListener: () => {}, removeListener: () => {} },
      getTargets: async () => [],
    };
    const tabs = {
      remove: async () => {},
      update: async () => {},
      create: async () => 1,
      query: async () => [],
    };
    const factory = makeDebuggerTransportFactory(
      55,
      { api: api as never, tabs: tabs as never },
      () => {},
    );
    expect(attached).toEqual([]); // 惰性——构造不触 chrome
    await factory();
    expect(attached[0]).toEqual({ tabId: 55 });
  });
});
