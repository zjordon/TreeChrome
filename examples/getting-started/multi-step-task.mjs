#!/usr/bin/env node
// 示例：多步任务（搜索 → 进结果 → 抽取 → 汇报）。移植自
// browser-use/examples/getting_started/04_multi_step_task.py，
// 经 TreeWalker examples/getting_started/multi_step_task.py。
//
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行；设置 ZHIPU_API_KEY
//（或写 cwd/.env）。用法：node examples/getting-started/multi-step-task.mjs

import { loadKit } from "../../packages/node-host/boot.mjs";

// 任务文本逐字保留 Python 版
const TASK =
  "Go to https://www.google.com and search for 'what is browser automation'. " +
  "Open the first result, extract a one-paragraph definition of browser automation " +
  "from that page, then tell me the source URL and the definition.";

try {
  const kit = await loadKit();
  const history = await kit.runAgent({ task: TASK });

  if (history.isDone()) {
    console.log(`\nTask completed: ${history.finalResult()}`);
  } else {
    console.log("\nTask did not complete within max steps");
  }
} catch (e) {
  console.error(`[multi-step-task] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
