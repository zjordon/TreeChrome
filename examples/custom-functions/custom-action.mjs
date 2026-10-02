#!/usr/bin/env node
// 示例：自定义动作注册范式。移植自 browser-use/examples/custom-functions/file_upload.py
//（取其注册范式），经 TreeWalker examples/custom-functions/custom_action.py
//（内置 upload_file 已存在，故用 count_words 演示）。
//
// TreeChrome 注册自定义动作的标准范式：
// - new Tools() 先注册默认 25 个动作；
// - tools.registry.register({name, description, params, handler, terminatesSequence})
//   注册新动作（Python @tools.registry.action(...) 装饰器的直传形态）；
// - handler 签名固定 (params, browser) => ActionResult|string|null（按位置注入，
//   非 browser-use 的按名注入；本例不用 browser）；
// - 无 per-decorator domains=；按页过滤改用 tools.applyPageFilters({动作名:[glob]})。
//
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行；设置 ZHIPU_API_KEY
//（或写 cwd/.env）。用法：node examples/custom-functions/custom-action.mjs

import { loadKit } from "../../packages/node-host/boot.mjs";

// CountParams（pydantic BaseModel 的 ParamModel 同构字面量）
const CountParams = {
  name: "CountParams",
  fields: [{ name: "text", type: "string", required: true, description: "要统计单词数的文本" }],
};

function buildTools(kit) {
  const tools = new kit.Tools(); // 先注册默认动作（构造参数全可省）

  tools.registry.register({
    name: "count_words",
    description: "Count the number of words in the given text and return the result.",
    params: CountParams,
    terminatesSequence: false,
    handler: async (params) => {
      // 注意签名：按位置注入 (params, browser)，不是按名注入
      const n = String(params.text).split(/\s+/).filter(Boolean).length;
      return new kit.ActionResult({ extractedContent: `word count = ${n}` });
    },
  });

  return tools;
}

// 任务文本逐字保留 Python 版
const TASK =
  "Use the count_words action to count the words in " +
  "'hello world from tree walker' and tell me the result.";

try {
  const kit = await loadKit();
  const history = await kit.runAgent({ task: TASK, tools: buildTools(kit) });

  if (history.isDone()) {
    console.log(`\nTask completed: ${history.finalResult()}`);
  } else {
    console.log("\nTask did not complete within max steps");
  }
} catch (e) {
  console.error(`[custom-action] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
