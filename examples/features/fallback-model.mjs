#!/usr/bin/env node
// 示例：fallback 模型。移植自 browser-use/examples/features/fallback_model.py，经
// TreeWalker examples/features/fallback_model.py（主模型限流/出错时自动回退到便宜/
// 更快的模型——仅 Anthropic 兼容后端；也可全用 env：FALLBACK_LLM_MODEL /
// FALLBACK_LLM_API_KEY / FALLBACK_LLM_BASE_URL）。
//
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行；设置 ZHIPU_API_KEY
//（或写 cwd/.env）。用法：node examples/features/fallback-model.mjs

import { loadKit } from "../../packages/node-host/boot.mjs";

// 任务文本逐字保留 Python 版
const TASK = "Go to https://news.ycombinator.com/ and list the top 3 story titles.";

try {
  const kit = await loadKit();
  const history = await kit.runAgent({
    task: TASK,
    // 主模型不变，挂一个 fallback（按需改成你可用的便宜模型；key/端点缺省复用主卡）
    overrides: { llm: { fallback: { model: "glm-4-flash" } } },
  });

  if (history.isDone()) {
    console.log(`\nTask completed: ${history.finalResult()}`);
  } else {
    console.log("\nTask did not complete within max steps");
  }
} catch (e) {
  console.error(`[fallback-model] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
