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

  it("hold/release 引用计数（issue #5 S4）：蒸馏期间保活——run 结束 hold 在位不清，归零才清", () => {
    const created: number[] = [];
    const cleared: string[] = [];
    const alarms: AlarmsApi = {
      create: (_name, info) => void created.push(info.periodInMinutes),
      clear: async (name) => void cleared.push(name),
    };
    const keepalive = new KeepaliveController(alarms);
    keepalive.hold();
    keepalive.release();
    keepalive.release(); // 归零后多余 release 无害
    expect(cleared).toEqual([KEEPALIVE_ALARM]); // 无 run：归零即清

    keepalive.onStartRun();
    keepalive.hold();
    keepalive.onEndRun(); // run 结束但蒸馏 hold 在位——闹钟保住
    expect(cleared).toEqual([KEEPALIVE_ALARM]);
    keepalive.release(); // 蒸馏结束——此时才清
    expect(cleared).toEqual([KEEPALIVE_ALARM, KEEPALIVE_ALARM]);
    // 每次转入保活态都 create（同名幂等覆盖）：hold 起 / run 起 / run 中再 hold /
    // run 结束 hold 仍在位重申
    expect(created).toHaveLength(4);
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
