#!/usr/bin/env node
// 示例：flash 快速模式。移植自 browser-use/examples/getting_started/05_fast_agent.py
//（仅保留可移植部分），经 TreeWalker examples/getting_started/fast_agent.py。
//
// browser-use 原版三件套：flash_mode + 时延(minimum_wait_page_load_time/wait_between_actions)
// + extend_system_message(SPEED_OPTIMIZATION_PROMPT)。TreeWalker 对应：output_mode='flash'
// + BrowserSettings(page_settle_timeout/wait_between_actions)——本版同款经 runAgent
// overrides 传入（Python replace(settings.x, ...) 形态等价）。「extend_system_message」
// TreeWalker 无此扩展点 → 丢弃（上游方案 §6，同 Python 版）。
//
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行；设置 ZHIPU_API_KEY
//（或写 cwd/.env）。用法：node examples/getting-started/fast-agent.mjs
//（flash 模式也可经 env LLM_OUTPUT_MODE=flash 全局开启，非法值告警回退 standard）

import { loadKit } from "../../packages/node-host/boot.mjs";

// 任务文本逐字保留 Python 版
const TASK = "Go to https://news.ycombinator.com/ and tell me the top 3 story titles.";

try {
  const kit = await loadKit();
  const history = await kit.runAgent({
    task: TASK,
    // flash 模式 + 收紧页面等待/动作间隔（Python fast_agent.py:36-41 同值）
    overrides: {
      llm: { outputMode: "flash" },
      browser: { waitBetweenActions: 0.1, pageSettleTimeout: 0.5 },
    },
  });

  if (history.isDone()) {
    console.log(`\nTask completed: ${history.finalResult()}`);
  } else {
    console.log("\nTask did not complete within max steps");
  }
} catch (e) {
  console.error(`[fast-agent] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
