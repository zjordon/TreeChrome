#!/usr/bin/env node
// 示例：在简单搜索任务上跑通 TreeChrome agent（移植自 TreeWalker examples/basic_agent.py）。
//
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行；设置 ZHIPU_API_KEY。
// 用法：$env:ZHIPU_API_KEY="your_key"; node examples/basic-agent.mjs（PowerShell）
// 可选 env（LLM_MODEL / LLM_BASE_URL / LLM_MAX_TOKENS / CDP_HOST / CDP_PORT / CDP_WS_URL /
// AGENT_MAX_STEPS / AGENT_USE_VISION，另读 cwd/.env）及默认值口径见
// packages/node-host/src/settings.ts 模块头注释。
//
// 宿主配套件（env→配置 / NodeFs / esbuild 引导 / 控制台观测 / Agent 装配）全部收编在
// @tw/node-host——本文件只剩任务文本与结果打印（方案 docs/implement-plan/node-host §8.1）。

import { loadKit } from "../packages/node-host/boot.mjs";

// 任务文本逐字保留 Python 版
const TASK =
  "帮我到'https://www.google.com/'搜索与'浏览器自动化'相关的信息然后获取前三条的标题告诉我";

try {
  const kit = await loadKit();
  const history = await kit.runAgent({ task: TASK });

  if (history.isDone()) {
    console.log(`\nTask completed: ${history.finalResult()}`);
  } else {
    console.log("\nTask did not complete within max steps");
  }
} catch (e) {
  console.error(`[basic-agent] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
