// 侧边栏粘合层（m5/05 §2）：chrome 交互只在此文件——Port 连接工厂注入
// SidepanelApp（组件与状态机零 chrome，可单测）。

import { browser } from "wxt/browser";
import type { UiPort } from "../../src/ui-glue/port-client.js";
import { SidepanelApp } from "../../src/ui-glue/sidepanel-app.js";

const connect = (): UiPort => browser.runtime.connect({ name: "sidepanel" }) as unknown as UiPort;

export function App() {
  return <SidepanelApp connect={connect} />;
}
