// 全局 chrome 适配件（本包唯一接触 globalThis.chrome 的文件——架构铁律的收口点：
// chrome.* 只能出现在 cdp-chrome 适配层与扩展宿主粘合层）。SW 装配时调用取真实
// 实现；Node 单测永不 import 本文件（注入 fake）。

import type { TabsApi } from "./transport.js";
import type { Debuggee, DebuggerApi, TargetInfoDto } from "./types.js";

interface ChromeDebuggerShape {
  attach(debuggee: Debuggee, version: string, callback?: () => void): unknown;
  detach(debuggee: Debuggee, callback?: () => void): unknown;
  sendCommand(
    debuggee: Debuggee,
    method: string,
    params?: object,
    callback?: (r: unknown) => void,
  ): unknown;
  getTargets(callback?: (r: TargetInfoDto[]) => void): unknown;
  onEvent: {
    addListener(cb: (source: Debuggee, method: string, params: unknown) => void): void;
    removeListener(cb: (source: Debuggee, method: string, params: unknown) => void): void;
  };
  onDetach: {
    addListener(cb: (source: Debuggee, reason?: string) => void): void;
    removeListener(cb: (source: Debuggee, reason?: string) => void): void;
  };
}

interface ChromeTabsShape {
  update(tabId: number, props: { active: boolean }): Promise<unknown>;
  remove(tabId: number): Promise<unknown>;
}

interface ChromeGlobal {
  debugger?: ChromeDebuggerShape;
  tabs?: ChromeTabsShape;
}

function chromeGlobal(): ChromeGlobal {
  const g = globalThis as { chrome?: ChromeGlobal };
  if (g.chrome === undefined) {
    throw new Error("global chrome unavailable — adapter 只能在扩展上下文使用（测试请注入 fake）");
  }
  return g.chrome;
}

/**
 * chrome.debugger 的 DebuggerApi 适配。MV3 Promise 形态（Chrome 116+）：callback
 * 省略时原生返回 Promise；onEvent/onDetach 是事件源直传。
 */
export function chromeDebuggerApi(): DebuggerApi {
  const dbg = chromeGlobal().debugger;
  if (dbg === undefined) throw new Error("chrome.debugger unavailable (debugger 权限未声明?)");
  return {
    attach: async (debuggee, version) => {
      await dbg.attach(debuggee, version);
    },
    detach: async (debuggee) => {
      await dbg.detach(debuggee);
    },
    sendCommand: async (debuggee, method, params) =>
      (await dbg.sendCommand(debuggee, method, params)) as unknown,
    onEvent: dbg.onEvent,
    onDetach: dbg.onDetach,
    getTargets: async () => (await dbg.getTargets()) as TargetInfoDto[],
  };
}

/** chrome.tabs 的 TabsApi 适配（activate/remove——debugger API 覆盖不了的动作） */
export function chromeTabsApi(): TabsApi {
  const tabs = chromeGlobal().tabs;
  if (tabs === undefined) throw new Error("chrome.tabs unavailable (tabs 权限未声明?)");
  return {
    activate: async (tabId) => {
      await tabs.update(tabId, { active: true });
    },
    remove: async (tabId) => {
      await tabs.remove(tabId);
    },
  };
}
