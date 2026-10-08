// SW 壳（m5/01 §1.4 段 A）：最小消息路由（diag:echo 往返——侧边栏冒烟 + 段 B 探针
// 入口）+ 图标点击开侧边栏 + onInstalled 占位（段 D 扩为 skills 刷新/run journal 恢复）。
// 本目录（entrypoints/）与 src/host/ 是扩展内合法使用 chrome.*/browser 的区域。

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

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener((details) => {
    console.log(`[tc] onInstalled: ${details.reason}`);
  });

  // 消息路由先注册（后续任何宿主探测失败都不得拖死路由——headless 无 sidePanel
  // API 时 setPanelBehavior 同步抛错的教训）
  browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (isDiagMessage(message) && message.command === "echo") {
      // sendMessage 请求-应答的自由形态（非 Port 信封——event 流才走 @tw/protocol 信封）
      sendResponse({ ok: true, command: "echo", payload: message.payload ?? null });
    }
    return false; // 同步应答
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
