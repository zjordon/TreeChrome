#!/usr/bin/env node
// 示例：抽取专用小模型。移植自 browser-use/examples/features/small_model_for_extraction.py，
// 经 TreeWalker examples/features/extraction_small_model.py（extract 工具换便宜/快模型；
// Python 用 AgentSettings.extract_llm，本版经 runAgent 的 extractLlm 注入口——
// 缺省/为空时复用主 LLM）。
//
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行；设置 ZHIPU_API_KEY
//（或写 cwd/.env）。用法：node examples/features/extraction-small-model.mjs

import { loadKit } from "../../packages/node-host/boot.mjs";

// 任务文本逐字保留 Python 版
const TASK =
  "Go to https://news.ycombinator.com/ and use the extract action to get the " +
  "titles and points of the top 5 stories.";

try {
  const kit = await loadKit();
  kit.applyDotEnv();
  const settings = kit.loadHostSettings();
  // extract 工具换用小模型（按需改成你可用的便宜模型；maxTokens 4096 = Python
  // AGENT_EXTRACT_MAX_TOKENS 缺省，config.py:570）
  const extractLlm = new kit.LLMClient({
    name: "zhipu-extract",
    protocol: "anthropic-messages",
    baseUrl: settings.llm.baseUrl,
    apiKey: settings.llm.apiKey,
    model: "glm-4-flash",
    maxTokens: 4096,
  });

  const history = await kit.runAgent({ task: TASK, extractLlm });

  if (history.isDone()) {
    console.log(`\nTask completed: ${history.finalResult()}`);
  } else {
    console.log("\nTask did not complete within max steps");
  }
} catch (e) {
  console.error(`[extraction-small-model] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
