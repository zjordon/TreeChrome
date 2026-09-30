#!/usr/bin/env node
// 示例：生成 CSV。移植自 browser-use/examples/features/csv_file_generation.py，经
// TreeWalker examples/features/csv_generation.py（无 agent file system——让 agent 用
// write_file 工具把结构化数据写成 CSV 到受 allowed_write_paths 白名单约束的工作区）。
// Python 版结束有 input() 交互清理工作区；本版改为提示路径不自动删（脚本无 stdin
// 交互惯例——方案 F4 登记偏离）。
//
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行；设置 ZHIPU_API_KEY
//（或写 cwd/.env）。用法：node examples/features/csv-generation.mjs

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKit } from "../../packages/node-host/boot.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = join(SCRIPT_DIR, "csv_workspace"); // 受白名单约束的工作区（每次运行复用）
const TARGET = join(WORKSPACE, "top_cities.csv");
mkdirSync(WORKSPACE, { recursive: true });

const TASK =
  "Go to https://en.wikipedia.org/wiki/List_of_largest_cities and collect the top 10 cities by population.\n" +
  `Then use the write_file tool to save a CSV (columns: rank,city,population) to: ${TARGET}\n` +
  "After saving, read the file back with read_file to verify it looks correct, then tell me the file path.";

try {
  const kit = await loadKit();
  const history = await kit.runAgent({
    task: TASK,
    // write_file/replace_file 受 allowed_write_paths 白名单约束（前缀匹配）
    overrides: { agent: { allowedWritePaths: [WORKSPACE] } },
  });

  console.log(`\ndone: ${history.isDone()}`);
  try {
    const content = readFileSync(TARGET, "utf8");
    console.log(`\n--- ${TARGET} ---`);
    console.log(content.slice(0, 1000));
  } catch {
    console.log(`\n（未生成 ${TARGET}——检查 agent 是否完成任务）`);
  }
  console.log(`\n工作区 ${WORKSPACE} 保留供检查，可手动删除。`);
} catch (e) {
  console.error(`[csv-generation] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
