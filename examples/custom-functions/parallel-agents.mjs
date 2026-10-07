#!/usr/bin/env node
// 示例：并发多 agent（Promise.all，Python asyncio.gather 等价）。移植自
// browser-use/examples/custom-functions/parallel_agents.py，经 TreeWalker
// examples/custom-functions/parallel_agents.py。
//
// 形态 A（本文件）：多个 BrowserSession 连同一个 Chrome，共享浏览器上下文/标签页
// 空间。适合演示并发写法，但任务间可能互相干扰（标签切换/焦点）——每次 runAgent
// 自建独立的 LLMClient/bus/browser（LLMClient 按串行 agent loop 设计，并发必须
// 每 agent 独立实例），三路控制台日志会交错输出。
//
// 【强隔离方案（形态 B）】如需互不干扰，应为每个并发 agent 启动独立的 Chrome
//（各自独立的 --remote-debugging-port，例如 9222/9223/9224），再用各自的
// CDP_WS_URL / CDP_PORT 连接（runAgent 的 wsUrl 参数或 env）。TreeChrome 不启动
// 浏览器，无法靠配置实现多实例隔离。
//
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行；设置 ZHIPU_API_KEY
//（或写 cwd/.env）。用法：node examples/custom-functions/parallel-agents.mjs

import { loadKit } from "../../packages/node-host/boot.mjs";

// 任务文本逐字保留 Python 版
const TASKS = [
  "Go to https://news.ycombinator.com/ and return only the top story title.",
  "Go to https://www.github.com/trending and return only the top repository name.",
  "Go to https://quotes.toscrape.com/ and return only the first quote and its author.",
];

try {
  const kit = await loadKit();
  const results = await Promise.all(
    TASKS.map(async (task, i) => {
      const history = await kit.runAgent({ task });
      const done = history.isDone();
      const result = (done ? history.finalResult() : null) ?? "(no result)";
      console.log(`[${i}] done=${done} -> ${result}`);
      return { i, done, result };
    }),
  );
  const okCount = results.filter((r) => r.done).length;
  console.log(`\n${okCount}/${results.length} agents completed`);
} catch (e) {
  console.error(`[parallel-agents] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
