// 侧边栏粘合层（m5/05 §2 + issue #20 M4）：chrome 交互只在此文件——Port 连接工厂 +
// 草稿数查询 + options 单发请求工厂注入 SidepanelApp（组件与状态机零 chrome，可单测）。

import type { OptionsOp } from "@tw/protocol";
import { browser } from "wxt/browser";
import type { UiPort } from "../../src/ui-glue/port-client.js";
import { SidepanelApp } from "../../src/ui-glue/sidepanel-app.js";

const connect = (): UiPort => browser.runtime.connect({ name: "sidepanel" }) as unknown as UiPort;

/** 草稿数查询（issue #5）：走 options 单发面（SW 是唯一写者）——面板上线补查，
 *  弥补 skill-drafts 广播即发即逝的漏看窗口 */
const fetchDraftCount = async (): Promise<number | null> => {
  try {
    const res = (await browser.runtime.sendMessage({
      kind: "options",
      op: "list-skill-drafts",
    })) as { ok?: boolean; drafts?: unknown[] } | undefined;
    if (res?.ok === true && Array.isArray(res.drafts)) return res.drafts.length;
    return null;
  } catch {
    return null;
  }
};

// options 单发请求工厂（issue #20 M4 设置 overlay）：模块级稳定引用（refresh 依赖身份）
const optionsRequest = (op: OptionsOp, payload?: unknown): Promise<unknown> =>
  browser.runtime.sendMessage({
    kind: "options",
    op,
    ...(payload !== undefined ? { payload } : {}),
  });

export function App() {
  return (
    <SidepanelApp
      connect={connect}
      fetchDraftCount={fetchDraftCount}
      optionsRequest={optionsRequest}
      onOpenSettings={() => void browser.runtime.openOptionsPage()}
    />
  );
}
