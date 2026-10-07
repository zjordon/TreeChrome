#!/usr/bin/env node
// 示例：数据抽取（任务驱动）。移植自 browser-use/examples/getting_started/03_data_extraction.py，
// 经 TreeWalker examples/getting_started/data_extraction.py（quotes.toscrape.com 名言抽取，
// 纯任务驱动、无需 output_model）。
//
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行；设置 ZHIPU_API_KEY
//（或写 cwd/.env）。用法：node examples/getting-started/data-extraction.mjs

import { loadKit } from "../../packages/node-host/boot.mjs";

// 任务文本逐字保留 Python 版
const TASK =
  "Go to https://quotes.toscrape.com/ and extract the first 5 quotes " +
  "with their text and author. Return them as a plain list.";

try {
  const kit = await loadKit();
  const history = await kit.runAgent({ task: TASK });

  if (history.isDone()) {
    console.log(`\nTask completed: ${history.finalResult()}`);
  } else {
    console.log("\nTask did not complete within max steps");
  }
} catch (e) {
  console.error(`[data-extraction] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
