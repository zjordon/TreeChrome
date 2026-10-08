// transport 单测（m5/02 §6）：fake DebuggerApi/TabsApi 全分支——send 路由矩阵 /
// 握手与 tabs 拦截合成（探针定案的行为锚）/ switchTab 重映射与失败回滚 / 事件
// 多播与 onDetach 语义 / stop 幂等。零真网络零真 CDP。

import type { CdpEventListener } from "@tw/core";
import { describe, expect, it, vi } from "vitest";
import {
  ChromeDebuggerTransport,
  createChromeDebuggerTransport,
  type Debuggee,
  type DebuggerApi,
  ROOT_SESSION_ID,
  type TabsApi,
  type TargetInfoDto,
} from "../src/index.js";

interface Call {
  kind: "attach" | "detach" | "command" | "activate" | "remove";
  debuggee?: Debuggee;
  method?: string;
  params?: object;
  tabId?: number;
}

function fakeApis(pages: TargetInfoDto[], opts: { failAttach?: (tabId: number) => string } = {}) {
  const calls: Call[] = [];
  const attached = new Set<number>();
  const eventListeners = new Set<(source: Debuggee, method: string, params: unknown) => void>();
  const detachListeners = new Set<(source: Debuggee, reason?: string) => void>();
  const api: DebuggerApi = {
    attach: async (debuggee) => {
      calls.push({ kind: "attach", debuggee });
      const tabId = debuggee.tabId ?? -1;
      if (opts.failAttach?.(tabId)) throw new Error(opts.failAttach(tabId));
      attached.add(tabId);
    },
    detach: async (debuggee) => {
      calls.push({ kind: "detach", debuggee });
      attached.delete(debuggee.tabId ?? -1);
    },
    sendCommand: async (debuggee, method, params) => {
      calls.push({ kind: "command", debuggee, method, params });
      if (method === "Target.createTarget") return { targetId: "NEW_TID" };
      return { ok: true };
    },
    onEvent: {
      addListener: (cb) => eventListeners.add(cb),
      removeListener: (cb) => eventListeners.delete(cb),
    },
    onDetach: {
      addListener: (cb) => detachListeners.add(cb),
      removeListener: (cb) => detachListeners.delete(cb),
    },
    getTargets: async () => pages.map((p) => ({ ...p })),
  };
  const tabs: TabsApi = {
    activate: async (tabId) => {
      calls.push({ kind: "activate", tabId });
    },
    remove: async (tabId) => {
      calls.push({ kind: "remove", tabId });
    },
  };
  return {
    api,
    tabs,
    calls,
    fire: (source: Debuggee, method: string, params: unknown) => {
      for (const cb of eventListeners) cb(source, method, params);
    },
    fireDetach: (source: Debuggee, reason?: string) => {
      attached.delete(source.tabId ?? -1);
      for (const cb of detachListeners) cb(source, reason);
    },
  };
}

const PAGES: TargetInfoDto[] = [
  { id: "TID_A", type: "page", url: "https://a.example/", title: "A", tabId: 11 },
  { id: "TID_B", type: "page", url: "https://b.example/", title: "B", tabId: 22 },
  { id: "TID_WORKER", type: "shared_worker", url: "https://a.example/w.js", tabId: undefined },
];

function makeTransport(tabId = 11) {
  const env = fakeApis(PAGES);
  const t = new ChromeDebuggerTransport({ api: env.api, tabs: env.tabs, tabId });
  return { t, env };
}

describe("send 路由矩阵", () => {
  it("根会话（无 sessionId / ROOT 标记）→ Debuggee 仅带 tabId", async () => {
    const { t, env } = makeTransport();
    await t.send("Page.enable", {});
    await t.send("DOM.getDocument", {}, ROOT_SESSION_ID);
    const cmds = env.calls.filter((c) => c.kind === "command");
    expect(cmds).toHaveLength(2);
    expect(cmds[0]?.debuggee).toEqual({ tabId: 11 });
    expect(cmds[1]?.debuggee).toEqual({ tabId: 11 });
  });

  it("非根 sessionId → Debuggee 带原 sessionId（子会话路由面保留）", async () => {
    const { t, env } = makeTransport();
    await t.send("Runtime.evaluate", {}, "4A5B6C");
    expect(env.calls[0]?.debuggee).toEqual({ tabId: 11, sessionId: "4A5B6C" });
  });

  it("协议错误原文透传（不吞不译）", async () => {
    const env = fakeApis(PAGES);
    env.api.sendCommand = async () => {
      throw new Error('{"code":-32000,"message":"Not allowed"}');
    };
    const t = new ChromeDebuggerTransport({ api: env.api, tabs: env.tabs, tabId: 11 });
    await expect(t.send("Page.navigate", { url: "https://x/" })).rejects.toThrow("Not allowed");
  });
});

describe("Target.getTargets 拦截合成（探针 P1：协议命令被拒）", () => {
  it("page 条目 id→targetId 映射；附着 tab 置首并标 attached", async () => {
    const { t } = makeTransport(22);
    const r = (await t.send("Target.getTargets", {})) as {
      targetInfos: Array<{ targetId: string; attached: boolean; url: string; type: string }>;
    };
    expect(r.targetInfos.map((x) => x.targetId)).toEqual(["TID_B", "TID_A"]);
    expect(r.targetInfos[0]).toMatchObject({
      attached: true,
      url: "https://b.example/",
      type: "page",
    });
    expect(r.targetInfos[1]?.attached).toBe(false);
  });

  it("非 page 目标（worker）不入列", async () => {
    const { t } = makeTransport();
    const r = (await t.send("Target.getTargets", {})) as {
      targetInfos: Array<{ targetId: string }>;
    };
    expect(r.targetInfos.some((x) => x.targetId === "TID_WORKER")).toBe(false);
  });
});

describe("Target.attachToTarget 拦截（探针 q2：真 targetId 亦被拒）", () => {
  it("目标即附着 tab（connectSession 握手）→ 返回 ROOT_SESSION_ID，零 api 调用", async () => {
    const { t, env } = makeTransport(11);
    const r = await t.send("Target.attachToTarget", { targetId: "TID_A", flatten: true });
    expect(r).toEqual({ sessionId: ROOT_SESSION_ID });
    expect(env.calls.filter((c) => c.kind === "attach" || c.kind === "detach")).toHaveLength(0);
  });

  it("其它 tab（switchTab）→ attach 新在前 detach 旧在后，锚点更新", async () => {
    const { t, env } = makeTransport(11);
    const r = await t.send("Target.attachToTarget", { targetId: "TID_B", flatten: true });
    expect(r).toEqual({ sessionId: ROOT_SESSION_ID });
    const seq = env.calls.filter((c) => c.kind === "attach" || c.kind === "detach");
    expect(seq.map((c) => `${c.kind}:${c.debuggee?.tabId}`)).toEqual(["attach:22", "detach:11"]);
    expect(t.tabId).toBe(22);
    // 切换后根命令路由到新 tab
    await t.send("Page.enable", {});
    expect(env.calls.at(-1)?.debuggee).toEqual({ tabId: 22 });
  });

  it("新 tab attach 失败 → 原附着不动（天然回滚）", async () => {
    const env = fakeApis(PAGES, { failAttach: (tabId) => (tabId === 22 ? "attach rejected" : "") });
    const t = new ChromeDebuggerTransport({ api: env.api, tabs: env.tabs, tabId: 11 });
    await expect(
      t.send("Target.attachToTarget", { targetId: "TID_B", flatten: true }),
    ).rejects.toThrow("attach rejected");
    expect(t.tabId).toBe(11);
    expect(env.calls.some((c) => c.kind === "detach")).toBe(false);
    await t.send("Page.enable", {});
    expect(env.calls.at(-1)?.debuggee).toEqual({ tabId: 11 });
  });

  it("未知 targetId / 缺 targetId → 明确报错", async () => {
    const { t } = makeTransport();
    await expect(t.send("Target.attachToTarget", { targetId: "NOPE" })).rejects.toThrow(
      "not found",
    );
    await expect(t.send("Target.attachToTarget", {})).rejects.toThrow("missing targetId");
  });
});

describe("activate/close/setAutoAttach/createTarget", () => {
  it("activateTarget → TabsApi.activate（id→tabId 解析）", async () => {
    const { t, env } = makeTransport(11);
    await t.send("Target.activateTarget", { targetId: "TID_B" });
    expect(env.calls.some((c) => c.kind === "activate" && c.tabId === 22)).toBe(true);
  });

  it("closeTarget → TabsApi.remove", async () => {
    const { t, env } = makeTransport(11);
    await t.send("Target.closeTarget", { targetId: "TID_B" });
    expect(env.calls.some((c) => c.kind === "remove" && c.tabId === 22)).toBe(true);
  });

  it("setAutoAttach → 透传（评审轮 1 [2] 探针修正实证：autoAttach 可用，Worker 子会话双通）", async () => {
    const { t, env } = makeTransport();
    const r = await t.send<{ ok: boolean }>("Target.setAutoAttach", {
      autoAttach: true,
      flatten: true,
    });
    expect(r).toEqual({ ok: true });
    expect(env.calls.at(-1)?.method).toBe("Target.setAutoAttach");
    expect(env.calls.at(-1)?.debuggee).toEqual({ tabId: 11 });
  });

  it("createTarget → 原生透传（探针 P6 实证可用），结果原样返回", async () => {
    const { t, env } = makeTransport();
    const r = await t.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    expect(r.targetId).toBe("NEW_TID");
    expect(env.calls.at(-1)?.method).toBe("Target.createTarget");
  });

  it("带非根 sessionId 的 Target.* 不进拦截（防误吞会话级命令）", async () => {
    const { t, env } = makeTransport();
    await t.send("Target.getTargets", {}, "SESSION_X");
    expect(env.calls.at(-1)?.method).toBe("Target.getTargets");
    expect(env.calls.at(-1)?.debuggee).toEqual({ tabId: 11, sessionId: "SESSION_X" });
  });
});

describe("事件多播与 onDetach", () => {
  it("on 按 method 多播；source.sessionId 透传第二参；解订幂等", async () => {
    const { t, env } = makeTransport();
    const l1: CdpEventListener = vi.fn();
    const l2: CdpEventListener = vi.fn();
    const off1 = t.on("Page.loadEventFired", l1);
    t.on("Page.loadEventFired", l2);
    env.fire({ tabId: 11 }, "Page.loadEventFired", { ts: 1 });
    expect(l1).toHaveBeenCalledWith({ ts: 1 }, undefined);
    expect(l2).toHaveBeenCalledWith({ ts: 1 }, undefined);
    env.fire({ tabId: 11, sessionId: "CHILD1" }, "Page.loadEventFired", { ts: 2 });
    expect(l1).toHaveBeenCalledWith({ ts: 2 }, "CHILD1");
    off1();
    off1();
    env.fire({ tabId: 11 }, "Page.loadEventFired", { ts: 3 });
    expect(l1).toHaveBeenCalledTimes(2);
    expect(l2).toHaveBeenCalledTimes(3);
  });

  it("无关 method 不投递", async () => {
    const { t, env } = makeTransport();
    const l: CdpEventListener = vi.fn();
    t.on("Network.requestWillBeSent", l);
    env.fire({ tabId: 11 }, "Page.loadEventFired", {});
    expect(l).not.toHaveBeenCalled();
  });

  it("onDetach（当前 tab）→ 在途 send 拒绝 + 回调触发 + 后续 send 拒绝", async () => {
    const env = fakeApis(PAGES);
    env.api.sendCommand = () =>
      new Promise((_resolve, reject) => {
        // 在途命令执行中被用户取消：pendingRejections 先于内层 reject 生效（先到先 settle）
        env.fireDetach({ tabId: 11 }, "canceled_by_user");
        reject(new Error("unreachable"));
      });
    const onDetached = vi.fn();
    const t = new ChromeDebuggerTransport({ api: env.api, tabs: env.tabs, tabId: 11, onDetached });
    const inflight = t.send("Page.navigate", { url: "https://x/" });
    await expect(inflight).rejects.toThrow("Debugger detached: canceled_by_user");
    expect(onDetached).toHaveBeenCalledWith("canceled_by_user");
    await expect(t.send("Page.enable", {})).rejects.toThrow("Debugger detached");
  });

  it("onDetach（其它 tab，切换残余）→ 不影响本 transport", async () => {
    const { t, env } = makeTransport(11);
    env.fireDetach({ tabId: 99 }, "canceled_by_user");
    await t.send("Page.enable", {});
    expect(env.calls.at(-1)?.kind).toBe("command");
  });
});

describe("评审轮 1 修复回归", () => {
  it("[4] createTarget 透传后快照失效——navigate(new_tab) 全链（activate→attach）可达", async () => {
    // 动态世界：getTargets 随 createTarget 增长（静态 fake 掩盖了陈旧缓存缺陷）
    const world = PAGES.map((p) => ({ ...p }));
    const env = fakeApis([]);
    env.api.getTargets = async () => world.map((p) => ({ ...p }));
    env.api.sendCommand = async (debuggee, method, params) => {
      env.calls.push({ kind: "command", debuggee, method, params });
      if (method === "Target.createTarget") {
        world.push({ id: "NEW_TID", type: "page", url: "about:blank", tabId: 33 });
        return { targetId: "NEW_TID" };
      }
      return { ok: true };
    };
    const t = new ChromeDebuggerTransport({ api: env.api, tabs: env.tabs, tabId: 11 });
    // connectSession 首步填缓存 → createTab 链：createTarget → activate → attach
    await t.send("Target.getTargets", {});
    const created = await t.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    expect(created.targetId).toBe("NEW_TID");
    await t.send("Target.activateTarget", { targetId: created.targetId }); // 修复前此处必抛 not found
    const r = await t.send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
    expect(r).toEqual({ sessionId: ROOT_SESSION_ID });
    expect(t.tabId).toBe(33);
  });

  it("[5] 关当前锚定 tab：预期 target_closed 被抑制，会话不击穿、后续命令可达", async () => {
    const env = fakeApis(PAGES);
    // 真 Chrome 语义：移除附着中的 tab 会派发 onDetach(source, "target_closed")
    const origRemove = env.tabs.remove;
    env.tabs.remove = async (tabId) => {
      await origRemove(tabId);
      env.fireDetach({ tabId }, "target_closed");
    };
    const onDetached = vi.fn();
    const t = new ChromeDebuggerTransport({ api: env.api, tabs: env.tabs, tabId: 11, onDetached });
    await t.send("Target.closeTarget", { targetId: "TID_A" });
    expect(onDetached).not.toHaveBeenCalled();
    // core closeTab 随后的 getTargets（重锚流程）不被 "Debugger detached" 拒绝
    const r = await t.send("Target.getTargets", {});
    expect(r).toBeInstanceOf(Object);
    await t.send("Page.enable", {});
  });

  it("[5] 关非当前 tab：无抑制路径，target_closed 不影响（source 过滤）", async () => {
    const { t, env } = makeTransport(11);
    await t.send("Target.closeTarget", { targetId: "TID_B" }); // tab 22 无附着
    await t.send("Page.enable", {});
    expect(env.calls.at(-1)?.kind).toBe("command");
  });

  it("[轮2-2] remove 失败（用户拖标签条）：抑制标记回滚，后续真实 detach 照常击穿", async () => {
    const env = fakeApis(PAGES);
    env.tabs.remove = async () => {
      throw new Error("The tabs cannot be edited right now");
    };
    const onDetached = vi.fn();
    const t = new ChromeDebuggerTransport({ api: env.api, tabs: env.tabs, tabId: 11, onDetached });
    await expect(t.send("Target.closeTarget", { targetId: "TID_A" })).rejects.toThrow(
      "cannot be edited",
    );
    // tab 未关、仍附着——后续用户取消调试是真实 detach，必须击穿（残留标记会吞掉它）
    env.fireDetach({ tabId: 11 }, "canceled_by_user");
    expect(onDetached).toHaveBeenCalledWith("canceled_by_user");
    await expect(t.send("Page.enable", {})).rejects.toThrow("Debugger detached: canceled_by_user");
  });

  it("[轮3-1] remove 失败回滚恢复原值：前次成功 closeTarget 未消费的抑制标记不被误清", async () => {
    const env = fakeApis(PAGES);
    // 第 1 步：关当前 tab A 成功但 target_closed **迟到**（不在此刻派发）——标记=A 挂起
    let failForB = false;
    env.tabs.remove = async (tabId) => {
      if (failForB && tabId === 22) throw new Error("The tabs cannot be edited right now");
    };
    const onDetached = vi.fn();
    const t = new ChromeDebuggerTransport({ api: env.api, tabs: env.tabs, tabId: 11, onDetached });
    await t.send("Target.closeTarget", { targetId: "TID_A" });
    // 第 2 步：关非当前 tab B 失败——回滚须恢复 A 的挂起标记（无条件置 null 会误清）
    failForB = true;
    await expect(t.send("Target.closeTarget", { targetId: "TID_B" })).rejects.toThrow(
      "cannot be edited",
    );
    // 第 3 步：A 的迟到 target_closed 到达——被挂起标记消费（旧代码此处误击穿会话）
    env.fireDetach({ tabId: 11 }, "target_closed");
    expect(onDetached).not.toHaveBeenCalled();
    await t.send("Page.enable", {});
  });

  it("[6] 事件源过滤：他 tab 事件不入多播；锚定 tab 与无 tabId 事件照常", async () => {
    const { t, env } = makeTransport(11);
    const l: CdpEventListener = vi.fn();
    t.on("Page.frameStartedLoading", l);
    env.fire({ tabId: 99 }, "Page.frameStartedLoading", { from: "other-tab" });
    expect(l).not.toHaveBeenCalled();
    env.fire({ tabId: 11 }, "Page.frameStartedLoading", { from: "own" });
    env.fire({ tabId: undefined }, "Page.frameStartedLoading", { from: "no-tabid" });
    expect(l).toHaveBeenCalledTimes(2);
    expect(l).toHaveBeenNthCalledWith(1, { from: "own" }, undefined);
    expect(l).toHaveBeenNthCalledWith(2, { from: "no-tabid" }, undefined);
  });

  it("[6] switchTab 后旧 tab 残留事件（detach 失败场景）被过滤", async () => {
    const env = fakeApis(PAGES);
    const origDetach = env.api.detach;
    env.api.detach = async (debuggee) => {
      if (debuggee.tabId === 11) throw new Error("detach rejected"); // 旧 tab 残留附着
      return origDetach(debuggee);
    };
    const t = new ChromeDebuggerTransport({ api: env.api, tabs: env.tabs, tabId: 11 });
    await t.send("Target.attachToTarget", { targetId: "TID_B", flatten: true });
    const l: CdpEventListener = vi.fn();
    t.on("Page.javascriptDialogOpening", l);
    env.fire({ tabId: 11 }, "Page.javascriptDialogOpening", { stale: true }); // 旧 tab
    env.fire({ tabId: 22 }, "Page.javascriptDialogOpening", { fresh: true }); // 新锚
    expect(l).toHaveBeenCalledTimes(1);
    expect(l).toHaveBeenCalledWith({ fresh: true }, undefined);
  });
});

describe("边值分支", () => {
  it("switchTab 后 detach 旧 tab 失败 → 容错（切换已成功，只记日志）", async () => {
    const env = fakeApis(PAGES);
    const originalDetach = env.api.detach;
    env.api.detach = async (debuggee) => {
      if (debuggee.tabId === 11) throw new Error("old tab already gone");
      return originalDetach(debuggee);
    };
    const t = new ChromeDebuggerTransport({ api: env.api, tabs: env.tabs, tabId: 11 });
    const r = await t.send("Target.attachToTarget", { targetId: "TID_B", flatten: true });
    expect(r).toEqual({ sessionId: ROOT_SESSION_ID });
    expect(t.tabId).toBe(22);
  });

  it("activateTarget / closeTarget 未知 targetId → 明确报错", async () => {
    const { t } = makeTransport();
    await expect(t.send("Target.activateTarget", { targetId: "NOPE" })).rejects.toThrow(
      "activateTarget: target NOPE not found",
    );
    await expect(t.send("Target.closeTarget", { targetId: "NOPE" })).rejects.toThrow(
      "closeTarget: target NOPE not found",
    );
  });

  it("api 抛非 Error 值 → 包成 Error 原文上抛", async () => {
    const env = fakeApis(PAGES);
    env.api.sendCommand = (async () => {
      throw "raw string failure";
    }) as unknown as DebuggerApi["sendCommand"];
    const t = new ChromeDebuggerTransport({ api: env.api, tabs: env.tabs, tabId: 11 });
    await expect(t.send("Page.enable", {})).rejects.toThrow("raw string failure");
  });
});

describe("stop 与工厂", () => {
  it("stop：解订全局监听 + detach + 幂等", async () => {
    const { t, env } = makeTransport();
    const l: CdpEventListener = vi.fn();
    t.on("Page.loadEventFired", l);
    await t.stop();
    await t.stop();
    const detaches = env.calls.filter((c) => c.kind === "detach");
    expect(detaches).toHaveLength(1);
    env.fire({ tabId: 11 }, "Page.loadEventFired", {});
    expect(l).not.toHaveBeenCalled();
  });

  it("工厂：attach 成功返回 transport；失败原文上抛", async () => {
    const env = fakeApis(PAGES);
    const t = await createChromeDebuggerTransport({ api: env.api, tabs: env.tabs, tabId: 11 });
    expect(t.tabId).toBe(11);
    const envFail = fakeApis(PAGES, { failAttach: () => "cannot attach" });
    await expect(
      createChromeDebuggerTransport({ api: envFail.api, tabs: envFail.tabs, tabId: 11 }),
    ).rejects.toThrow("cannot attach");
  });

  it("stop 后 send 拒绝（含原因 stopped）", async () => {
    const { t } = makeTransport();
    await t.stop();
    await expect(t.send("Page.enable", {})).rejects.toThrow("Debugger detached: stopped");
  });
});
