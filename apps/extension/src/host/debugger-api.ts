// cdp-chrome 工厂绑定（m5/04 §2）：段 B 出口的消费——chrome.debugger 适配 +
// ChromeDebuggerTransport 工厂（绑 run tabId）。run-manager 每次装配时对绑定
// tab 构造新 transport（SW 内存态无复用价值；旧 transport 由 BrowserSession.stop
// 收口）。

import {
  type ChromeDebuggerTransport,
  chromeDebuggerApi,
  chromeTabsApi,
  createChromeDebuggerTransport,
} from "@tw/cdp-chrome";

export interface DebuggerTransportDeps {
  /** chrome.debugger 适配（缺省真绑定——cdp-chrome/adapter.ts） */
  api?: Parameters<typeof createChromeDebuggerTransport>[0]["api"];
  /** chrome.tabs 适配（缺省真绑定） */
  tabs?: Parameters<typeof createChromeDebuggerTransport>[0]["tabs"];
}

export function makeDebuggerTransportFactory(
  tabId: number,
  deps: DebuggerTransportDeps = {},
  log: (message: string) => void = () => {},
): () => Promise<ChromeDebuggerTransport> {
  const api = deps.api ?? chromeDebuggerApi();
  const tabs = deps.tabs ?? chromeTabsApi();
  return () =>
    createChromeDebuggerTransport({
      api,
      tabs,
      tabId,
      log: (m) => log(`[cdp-chrome] ${m}`),
    });
}
