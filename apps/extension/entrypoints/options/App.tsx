// options 粘合层（m5/05 §2）：chrome 交互只在此文件——options 单发请求工厂注入
// OptionsApp（settings 读写全走 SW 单一写者，UI 不直碰 chrome.storage）。

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
  return <OptionsApp request={request} />;
}
