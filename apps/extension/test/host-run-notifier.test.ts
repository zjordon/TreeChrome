// RunNotifier 单测（issue #41 U4 批 C + 评审轮 1 [1][2]，验收②）：终态通知创建
// （设置门/文案/截断）+ 点击回流（激活 tab + 打开面板 + 失败 fail-soft + SW
// 冷启动恢复——id 内嵌 tabId，内存上下文丢失后解析 id 仍可回流）。

import { describe, expect, it, vi } from "vitest";
import type { NotificationsApi } from "../src/host/chrome-apis.js";
import {
  NOTIFICATION_ICON_URL,
  RunNotifier,
  renderTerminalNotification,
  type TerminalNotifyInput,
  tabIdOfNotificationId,
} from "../src/host/run-notifier.js";

interface Notified {
  id: string;
  options: { title: string; message: string; iconUrl: string; type: string };
}

function makeHarness() {
  const created: Notified[] = [];
  const clickListeners: Array<(id: string) => void> = [];
  const cleared: string[] = [];
  const notifications: NotificationsApi = {
    create: (id, options) => {
      created.push({ id, options });
      return id;
    },
    clear: async (id) => {
      cleared.push(id);
      return true;
    },
    onClicked: { addListener: (cb) => void clickListeners.push(cb) },
  };
  const tabsUpdate = { update: vi.fn(async () => undefined) };
  const sidePanelOpen = vi.fn(async () => undefined);
  const logs: string[] = [];
  let idSeq = 0;
  const deps = {
    notifications,
    tabsUpdate,
    sidePanelOpen,
    log: (m: string) => void logs.push(m),
    // id 内嵌 tabId（可解析形态——冷启动恢复的前提）
    makeId: (tabId: number) => `run-terminal-${tabId}-t${++idSeq}`,
  };
  return { created, clickListeners, cleared, tabsUpdate, sidePanelOpen, logs, deps };
}

const doneInput: TerminalNotifyInput = {
  status: "done",
  task: "查价并汇总",
  finalResult: "价格是 42 元",
  lastError: null,
  tabId: 7,
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("renderTerminalNotification（文案面）", () => {
  it("done：任务 + 结果；error/interrupted：任务 + 原因；截断 40/80", () => {
    expect(renderTerminalNotification(doneInput)).toEqual({
      title: "任务完成",
      message: "查价并汇总\n价格是 42 元",
    });
    expect(
      renderTerminalNotification({
        ...doneInput,
        status: "error",
        finalResult: null,
        lastError: "连接断开",
      }),
    ).toEqual({
      title: "任务失败",
      message: "查价并汇总\n连接断开",
    });
    expect(
      renderTerminalNotification({
        ...doneInput,
        status: "interrupted",
        finalResult: null,
        lastError: null,
      }),
    ).toEqual({
      title: "任务已中断",
      message: "查价并汇总",
    });
    const long = renderTerminalNotification({
      status: "done",
      task: "长".repeat(60),
      finalResult: "果".repeat(100),
      lastError: null,
      tabId: 1,
    });
    expect(long.message.split("\n")[0]).toHaveLength(41); // 40 + 省略号
    expect(long.message.split("\n")[1]).toHaveLength(81);
  });
});

describe("RunNotifier（#41 批 C）", () => {
  it("终态通知：basic 形态 + 图标 + 文案；设置门关不发（异步门）", async () => {
    const h = makeHarness();
    const on = new RunNotifier(h.deps);
    on.notifyTerminal(doneInput);
    await flush();
    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.options).toMatchObject({
      type: "basic",
      iconUrl: NOTIFICATION_ICON_URL,
      title: "任务完成",
    });
    expect(h.created[0]?.id).toBe("run-terminal-7-t1");

    const off = new RunNotifier({ ...h.deps, enabled: () => Promise.resolve(false) });
    off.notifyTerminal(doneInput);
    await flush();
    expect(h.created).toHaveLength(1); // 未新增
  });

  it("设置门异常 fail-open（通知是观测面——设置读不到不静默吞）", async () => {
    const h = makeHarness();
    const n = new RunNotifier({ ...h.deps, enabled: () => Promise.reject(new Error("存储炸")) });
    n.notifyTerminal(doneInput);
    await flush();
    expect(h.created).toHaveLength(1);
  });

  it("点击回流：激活绑定 tab + 打开面板；二次点击幂等无害；非本器形态 no-op", async () => {
    const h = makeHarness();
    const n = new RunNotifier(h.deps);
    n.notifyTerminal({ ...doneInput, tabId: 9 });
    await flush();
    h.clickListeners[0]?.(h.created[0]?.id ?? "");
    await flush();
    expect(h.tabsUpdate.update).toHaveBeenCalledWith(9, { active: true });
    expect(h.sidePanelOpen).toHaveBeenCalledWith({ tabId: 9 });
    // 无内存去重（幂等操作）——重复点击重复回流无害
    h.clickListeners[0]?.(h.created[0]?.id ?? "");
    expect(h.tabsUpdate.update).toHaveBeenCalledTimes(2);
    h.clickListeners[0]?.("unknown-id");
    h.clickListeners[0]?.("run-terminal-x-bad"); // 前缀对但形态坏
    expect(h.tabsUpdate.update).toHaveBeenCalledTimes(2);
  });

  it("SW 冷启动恢复（评审轮 1 [2]）：新实例无内存上下文，解析 id 内嵌 tabId 仍可回流", async () => {
    const h = makeHarness();
    // 缺省 id 生成（不注入 makeId——走 crypto 路径，id 形态 run-terminal-<tabId>-<rand>）
    const first = new RunNotifier({ ...h.deps, makeId: undefined });
    first.notifyTerminal({ ...doneInput, tabId: 12 });
    await flush();
    const id = h.created[0]?.id ?? "";
    expect(tabIdOfNotificationId(id)).toBe(12);
    // SW 空闲回收后点击 → 冷启动 boot() 重建的实例（构造注册的监听器在列表尾，
    // 零内存态——仅凭 id 解析回流）
    new RunNotifier({ ...h.deps, makeId: undefined });
    h.clickListeners.at(-1)?.(id);
    await flush();
    expect(h.tabsUpdate.update).toHaveBeenCalledWith(12, { active: true });
    expect(h.sidePanelOpen).toHaveBeenCalledWith({ tabId: 12 });
  });

  it("回流失败 fail-soft：tab 已关（update reject）记日志不炸", async () => {
    const h = makeHarness();
    h.tabsUpdate.update.mockRejectedValueOnce(new Error("No tab with id: 9"));
    const n = new RunNotifier(h.deps);
    n.notifyTerminal({ ...doneInput, tabId: 9 });
    await flush();
    h.clickListeners[0]?.(h.created[0]?.id ?? "");
    await flush();
    expect(h.logs[0]).toContain("回流失败");
    expect(h.logs[0]).toContain("9");
  });

  it("onClicked 在构造时注册（MV3 纪律——首个 await 前同步）", () => {
    const h = makeHarness();
    const before = h.clickListeners.length;
    new RunNotifier(h.deps);
    expect(h.clickListeners.length).toBe(before + 1);
  });
});
