#!/usr/bin/env node
// 示例：多标签。移植自 browser-use/examples/features/multi_tab.py，经 TreeWalker
// examples/features/multi_tab.py（开 3 个标签页分别搜索，再切回第一个停止）。
//
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行；设置 ZHIPU_API_KEY
//（或写 cwd/.env）。用法：node examples/features/multi-tab.mjs

import { loadKit } from "../../packages/node-host/boot.mjs";

// 任务文本逐字保留 Python 版
const TASK =
  "Open 3 search tabs on https://www.google.com for 'Elon Musk', 'Sam Altman' " +
  "and 'Steve Jobs', then switch back to the first tab and stop.";

try {
  const kit = await loadKit();
  const history = await kit.runAgent({ task: TASK });

  console.log(`\ndone: ${history.isDone()}`);
} catch (e) {
  console.error(`[multi-tab] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
