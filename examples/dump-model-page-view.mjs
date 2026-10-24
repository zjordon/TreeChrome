#!/usr/bin/env node
// 示例：把当前页面「发给模型的 DOM 树」原样写入文件（不含任何诊断信息）。移植自
// TreeWalker examples/dump_model_page_view.py——只 dump element_tree_text（即 [Page DOM]
// 段的 `[index]<tag attr=val /> text` 文本树），是模型定位/操作元素时实际看到的内容。
// 自进化质量核查用：验证下拉等控件的选项/选中值在模型视野里的形态（issue #5）。
//
// 用法：
//   1. Chrome 以 --remote-debugging-port=9223 启动，手动停在目标页面。
//   2. node examples/dump-model-page-view.mjs [输出文件路径] [--port 9223]
//      - 输出文件路径：默认 examples/_model_page_view_dump.txt（_ 前缀不入库）
//   3. 标准输出只打印写入的文件路径，DOM 树全在文件里。

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadKit } from "../packages/node-host/boot.mjs";

const DEFAULT_OUT = join("examples", "_model_page_view_dump.txt");

// ── argv：首个非 -- 参数 = 输出路径（Python 同款单参数形态）；--port 为本仓
//    env→配置惯例（须在 loadKit/loadHostSettings 之前进 env） ─────────────────
const args = { out: DEFAULT_OUT, port: 9223 };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--port") {
    const v = process.argv[++i];
    const n = Number(v);
    if (v === undefined || !Number.isInteger(n) || n < 1) {
      console.error(`--port 需 ≥1 的整数（收到: ${v ?? "无"}）`);
      process.exit(2);
    }
    args.port = n;
  } else if (args.out === DEFAULT_OUT) {
    args.out = a;
  } else {
    console.error(`未知参数: ${a}`);
    process.exit(2);
  }
}
process.env.CDP_PORT = String(args.port);

const kit = await loadKit();
kit.applyDotEnv();
const settings = kit.loadHostSettings();
let wsUrl;
try {
  wsUrl = await kit.resolveWsUrl(settings.browser);
} catch (e) {
  console.error("Error: 无法连接 Chrome（确认以 --remote-debugging-port 启动）");
  console.error(`  发现失败详情：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const browser = new kit.BrowserSession(
  () => kit.CdpWsClient.connect({ wsUrl, logger: (m) => console.error(`[cdp-ws] ${m}`) }),
  {},
  { log: () => {} },
);

let treeText = "";
await browser.start();
try {
  const state = await browser.getState({ includeScreenshot: false });
  // 模型在 [Page DOM] 段看到的 DOM 文本树（[index]<tag attr=val /> text）
  treeText = state.domState?.elementTreeText ?? "";
} finally {
  await browser.stop();
}

writeFileSync(args.out, treeText, "utf8");
// 只在标准输出打印写入的文件路径（Python 同款约定）
console.log(args.out);
