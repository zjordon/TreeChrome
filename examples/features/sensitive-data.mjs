#!/usr/bin/env node
// 示例：敏感数据（扁平 sensitive_data）。移植自 browser-use/examples/features/
// sensitive_data.py，经 TreeWalker examples/features/sensitive_data.py（仅简单/扁平形式；
// 「按域嵌套」{'domain':{...}} TreeWalker 不支持——Python 原注释同款）。
// 机制：发往 LLM 前真实值被替换为占位符（LLM 看不到真实值）；LLM 输出动作里的
// 占位符会在执行前还原成真实值。
//
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行；设置 ZHIPU_API_KEY
//（或写 cwd/.env）。用法：node examples/features/sensitive-data.mjs

import { loadKit } from "../../packages/node-host/boot.mjs";

// key=占位符（任务里用 <x_name> 引用），value=真实值
const SENSITIVE_DATA = {
  "<x_name>": "my_x_name",
  "<x_password>": "my_x_password",
};

// 任务文本逐字保留 Python 版
const TASK =
  "Go to https://httpbin.org/forms/post and fill the custname field with <x_name> " +
  "and put <x_password> into the comment field, then submit the form.";

try {
  const kit = await loadKit();
  const history = await kit.runAgent({ task: TASK, sensitiveData: SENSITIVE_DATA });

  if (history.isDone()) {
    console.log(`\nTask completed: ${history.finalResult()}`);
  } else {
    console.log("\nTask did not complete within max steps");
  }
} catch (e) {
  console.error(`[sensitive-data] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
