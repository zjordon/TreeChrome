// SW 壳（m5/01 §1.4）：消息路由（diag:echo 冒烟 + diag:smoke:attach——段 B e2e
// 对拍通道：cdp-chrome transport + core BrowserSession 全链采集）+ 图标点击开
// 侧边栏 + onInstalled 占位（段 D 扩为 skills 刷新/run journal 恢复）。
// 本目录（entrypoints/）与 src/host/ 是扩展内合法使用 chrome.*/browser 的区域。

import {
  type ChromeDebuggerTransport,
  chromeDebuggerApi,
  chromeTabsApi,
  createChromeDebuggerTransport,
} from "@tw/cdp-chrome";
import { BrowserSession } from "@tw/core";
import type { UiDiagMessage } from "@tw/protocol";
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

function isDiagMessage(v: unknown): v is UiDiagMessage {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { kind?: unknown }).kind === "diag" &&
    typeof (v as { command?: unknown }).command === "string"
  );
}

/**
 * diag:smoke:attach——e2e 对拍通道（m5/02 §6）：对指定 tab 走真实装配
 * （chrome.debugger 适配 → ChromeDebuggerTransport → core BrowserSession 连接序列
 * 与 get_state 九步），返回 element_tree_text 供与 cdp-ws 通道逐字节比对。
 * payload: { tabId: number }
 */
async function runSmokeAttach(payload: unknown): Promise<unknown> {
  const tabId = (payload as { tabId?: unknown } | null)?.tabId;
  if (typeof tabId !== "number") return { ok: false, error: "smoke:attach requires payload.tabId" };
  // ref 对象持有闭包内赋值的 transport（TS CFA 对 let+闭包赋值会在 finally 处
  // 收窄成 never——属性访问不受窄化影响）
  const transportRef: { current: ChromeDebuggerTransport | null } = { current: null };
  const factory = async (): Promise<ChromeDebuggerTransport> => {
    if (transportRef.current !== null) await transportRef.current.stop().catch(() => {});
    transportRef.current = await createChromeDebuggerTransport({
      api: chromeDebuggerApi(),
      tabs: chromeTabsApi(),
      tabId,
      log: (m) => console.log(`[cdp-chrome] ${m}`),
    });
    return transportRef.current;
  };
  const session = new BrowserSession(factory, {}, { log: (m) => console.log(`[smoke] ${m}`) });
  try {
    await session.start();
    const state = await session.getState({ includeScreenshot: false });
    return {
      ok: true,
      url: state.url,
      title: state.title,
      elementTreeText: state.domState?.elementTreeText ?? null,
      interactiveCount: state.domState?.selectorMap?.size ?? 0,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await session.stop().catch(() => {});
    // 兜底（评审轮 1 [1]）：connectSession 失败路径 core 只置 transportRef=null 不级联
    // stop——闭包 transport 直接 stop 回收附着与全局监听（幂等，成功路径零 API 调用）
    await transportRef.current?.stop().catch(() => {});
  }
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener((details) => {
    console.log(`[tc] onInstalled: ${details.reason}`);
  });

  // 消息路由先注册（后续任何宿主探测失败都不得拖死路由——headless 无 sidePanel
  // API 时 setPanelBehavior 同步抛错的教训）
  browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isDiagMessage(message)) return false;
    if (message.command === "echo") {
      // sendMessage 请求-应答的自由形态（非 Port 信封——event 流才走 @tw/protocol 信封）
      sendResponse({ ok: true, command: "echo", payload: message.payload ?? null });
      return false; // 同步应答
    }
    if (message.command === "smoke:attach") {
      // 异步应答：return true 保持消息通道打开（BrowserSession 采集秒级）
      void runSmokeAttach(message.payload)
        .then((result) => sendResponse(result))
        .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    return false;
  });

  // 点扩展图标 = 开侧边栏（sidepanel entrypoint 由 WXT 注册 default_path）。
  // headless/旧内核无 sidePanel API——特性探测，失败只降级不抛
  try {
    void browser.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((e: unknown) => console.warn(`[tc] setPanelBehavior failed: ${String(e)}`));
  } catch (e) {
    console.warn(`[tc] sidePanel API unavailable: ${String(e)}`);
  }
});
