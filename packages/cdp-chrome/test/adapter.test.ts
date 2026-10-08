// adapter 单测：globalThis.chrome 注入 fake（adapter 是本包唯一全局 chrome 文件，
// 结构上可测——SW 真实路径由 e2e smoke 覆盖）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { chromeDebuggerApi, chromeTabsApi } from "../src/adapter.js";

interface ChromeGlobalShape {
  debugger?: unknown;
  tabs?: unknown;
}

function setChrome(value: ChromeGlobalShape | undefined): void {
  (globalThis as { chrome?: ChromeGlobalShape }).chrome = value;
}

afterEach(() => {
  setChrome(undefined);
});

const fakeDebugger = {
  attach: vi.fn(async () => {}),
  detach: vi.fn(async () => {}),
  sendCommand: vi.fn(async () => ({ ok: 1 })),
  getTargets: vi.fn(async () => [{ id: "T", type: "page", tabId: 1 }]),
  onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
  onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
};

const fakeTabs = {
  update: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
};

describe("chromeDebuggerApi / chromeTabsApi 适配件", () => {
  it("无全局 chrome → 明确报错（适配层只准扩展上下文用）", () => {
    setChrome(undefined);
    expect(() => chromeDebuggerApi()).toThrow("global chrome unavailable");
    expect(() => chromeTabsApi()).toThrow("global chrome unavailable");
  });

  it("权限面缺失（debugger/tabs 未声明）→ 明确报错", () => {
    setChrome({ tabs: fakeTabs });
    expect(() => chromeDebuggerApi()).toThrow("chrome.debugger unavailable");
    setChrome({ debugger: fakeDebugger });
    expect(() => chromeTabsApi()).toThrow("chrome.tabs unavailable");
  });

  it("适配透传：方法与事件源直连，getTargets 断言返回类型", async () => {
    setChrome({ debugger: fakeDebugger, tabs: fakeTabs });
    const api = chromeDebuggerApi();
    await api.attach({ tabId: 3 }, "1.3");
    expect(fakeDebugger.attach).toHaveBeenCalledWith({ tabId: 3 }, "1.3");
    await api.detach({ tabId: 3 });
    expect(fakeDebugger.detach).toHaveBeenCalled();
    const r = await api.sendCommand({ tabId: 3 }, "Page.enable", {});
    expect(r).toEqual({ ok: 1 });
    const targets = await api.getTargets();
    expect(targets[0]).toMatchObject({ id: "T", tabId: 1 });
    const noop = () => {};
    api.onEvent.addListener(noop);
    expect(fakeDebugger.onEvent.addListener).toHaveBeenCalledWith(noop);
    api.onDetach.removeListener(noop);
    expect(fakeDebugger.onDetach.removeListener).toHaveBeenCalledWith(noop);

    const tabs = chromeTabsApi();
    await tabs.activate(7);
    expect(fakeTabs.update).toHaveBeenCalledWith(7, { active: true });
    await tabs.remove(8);
    expect(fakeTabs.remove).toHaveBeenCalledWith(8);
  });
});
