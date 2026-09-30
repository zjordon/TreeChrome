#!/usr/bin/env node
// 示例：滚动长页面。移植自 browser-use/examples/features/scrolling_page.py，经
// TreeWalker examples/features/scrolling_page.py（scroll 动作演示：滚到底抓末条）。
//
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行；设置 ZHIPU_API_KEY
//（或写 cwd/.env）。用法：node examples/features/scrolling-page.mjs

import { loadKit } from "../../packages/node-host/boot.mjs";

// 任务文本逐字保留 Python 版
const TASK =
  "Go to https://news.ycombinator.com/ , scroll down to the bottom of the page " +
  "using the scroll action, then report the title of the last item on the page.";

try {
  const kit = await loadKit();
  const history = await kit.runAgent({ task: TASK });

  if (history.isDone()) {
    console.log(`\nTask completed: ${history.finalResult()}`);
  } else {
    console.log("\nTask did not complete within max steps");
  }
} catch (e) {
  console.error(`[scrolling-page] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
