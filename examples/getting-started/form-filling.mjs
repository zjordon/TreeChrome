#!/usr/bin/env node
// 示例：表单填写（多字段 + 提交）。移植自 browser-use/examples/getting_started/02_form_filling.py，
// 经 TreeWalker examples/getting_started/form_filling.py（httpbin 表单页链式填多个字段再提交）。
//
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行；设置 ZHIPU_API_KEY
//（或写 cwd/.env）。用法：node examples/getting-started/form-filling.mjs

import { loadKit } from "../../packages/node-host/boot.mjs";

// 任务文本逐字保留 Python 版
const TASK =
  "Go to https://httpbin.org/forms/post . Fill the form with: " +
  "custname='John Doe', custtel='555-1234', custemail='john@example.com', " +
  "and select size='large'. Then submit the form and tell me what the response page shows.";

try {
  const kit = await loadKit();
  const history = await kit.runAgent({ task: TASK });

  if (history.isDone()) {
    console.log(`\nTask completed: ${history.finalResult()}`);
  } else {
    console.log("\nTask did not complete within max steps");
  }
} catch (e) {
  console.error(`[form-filling] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
