// options 粘合层（m5/05 §2 + issue #20 M4 双宿主薄壳）：chrome 交互只在此文件——options 单发
// 请求工厂注入 OptionsApp（settings 读写全走 SW 单一写者，UI 不直碰 chrome.storage）。
// ThemedRoot/页面壳在此（OptionsApp 已不带主题壳——sidepanel overlay 共用同组件）。

import { ThemedRoot } from "@tw/console-ui";
import type { OptionsOp } from "@tw/protocol";
import { browser } from "wxt/browser";
import { OptionsApp } from "../../src/ui-glue/options-app.js";

// 模块级稳定引用（OptionsApp 的 refresh 依赖 request 身份——内联箭头会每渲染重建）
const request = (op: OptionsOp, payload?: unknown): Promise<unknown> =>
  browser.runtime.sendMessage({
    kind: "options",
    op,
    ...(payload !== undefined ? { payload } : {}),
  });

export function App() {
  return (
    <ThemedRoot>
      <main style={{ maxWidth: 860, margin: "0 auto", padding: 16, display: "grid", gap: 10 }}>
        <h1 style={{ fontSize: 16, margin: 0 }}>TreeChrome 设置</h1>
        <OptionsApp request={request} />
      </main>
    </ThemedRoot>
  );
}
