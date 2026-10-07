#!/usr/bin/env node
// 示例：网页数据生成 CSV。移植自 browser-use/examples/file_system/excel_sheet.py，
// 经 TreeWalker examples/file_system/excel_sheet.py。
//
// agent 查 Meta 与 Amazon 的当前股价，用 write_file 生成 CSV（company,stock_price）
// 再读回校验。适配说明（Python 原注释同款）：原版只让 LLM「make a CSV file」，
// 本版额外钉死绝对输出路径、写经 allowed_write_paths 沙箱、要求读回确认。
// Python 版结束的 input() 交互清理改为提示路径不自动删（方案 D1 登记偏离）。
//
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行；设置 ZHIPU_API_KEY
//（或写 cwd/.env）。用法：node examples/file-system/excel-sheet.mjs

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKit } from "../../packages/node-host/boot.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = join(SCRIPT_DIR, "excel_sheet_workspace");
mkdirSync(WORKSPACE, { recursive: true });

const TARGET = join(WORKSPACE, "stock_prices.csv");

// 任务文本逐字保留 Python 版
const TASK = `
Find the current stock prices of Meta and Amazon (search the web or visit a
finance site).

Then create a CSV file at: ${TARGET}  with two columns — "company" and
"stock_price" — and one row per company (use the write_file tool).

Finally, read the file back with read_file and tell me its content.
`.trim();

try {
  const kit = await loadKit();
  const history = await kit.runAgent({
    task: TASK,
    overrides: { agent: { allowedWritePaths: [WORKSPACE] } },
  });

  console.log(`\nTask completed: ${history.isDone()}`);
  const result = history.isDone() ? history.finalResult() : null;
  if (result) {
    console.log(`Final result: ${result}`);
  }

  try {
    const content = readFileSync(TARGET, "utf8");
    console.log(`\n--- ${TARGET} ---`);
    console.log(content);
  } catch {
    console.log(`\n（未生成 ${TARGET}——检查 agent 是否完成任务）`);
  }
  console.log(`\n工作区 ${WORKSPACE} 保留供检查，可手动删除。`);
} catch (e) {
  console.error(`[excel-sheet] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
