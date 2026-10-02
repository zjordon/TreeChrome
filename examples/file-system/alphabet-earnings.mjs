#!/usr/bin/env node
// 示例：网页数据抽取落盘。移植自 browser-use/examples/file_system/alphabet_earnings.py，
// 经 TreeWalker examples/file_system/alphabet_earnings.py。
//
// agent 打开 Alphabet 财报 PDF（Chrome 内置阅读器渲染），取 3 个数据点经 write_file
// 存本地文件再读回。适配说明（Python 原注释同款）：原版存 .pdf，write_file 是文本
// 工具故存 .md；数据从浏览器（Chrome PDF 阅读器）读而非 read_file（只读本地文件）——
// PDF 文本能否到达 agent 取决于 Chrome 阅读器是否把文本暴露给 DOM，取不到可改用
// extract 工具或换 HTML 报告页。写经 allowed_write_paths 沙箱。
// Python 版结束的 input() 交互清理改为提示路径不自动删（方案 D1 登记偏离）。
//
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行；设置 ZHIPU_API_KEY
//（或写 cwd/.env）。用法：node examples/file-system/alphabet-earnings.mjs

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKit } from "../../packages/node-host/boot.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = join(SCRIPT_DIR, "alphabet_earnings_workspace");
mkdirSync(WORKSPACE, { recursive: true });

const TARGET = join(WORKSPACE, "alphabet_earnings.md");

// 任务文本逐字保留 Python 版
const TASK = `
Go to https://abc.xyz/assets/cc/27/3ada14014efbadd7a58472f1f3f4/2025q2-alphabet-earnings-release.pdf

Read the earnings release shown in the browser and pick 3 interesting data points.
Save those 3 data points to the file at: ${TARGET}  (use the write_file tool)
Then read the file back with read_file and tell me its content.
`.trim();

try {
  const kit = await loadKit();
  await kit.runAgent({
    task: TASK,
    overrides: { agent: { allowedWritePaths: [WORKSPACE] } },
  });

  try {
    const content = readFileSync(TARGET, "utf8");
    console.log(`\n--- ${TARGET} ---`);
    console.log(content);
  } catch {
    console.log(`\n（未生成 ${TARGET}——检查 agent 是否完成任务）`);
  }
  console.log(`\n工作区 ${WORKSPACE} 保留供检查，可手动删除。`);
} catch (e) {
  console.error(`[alphabet-earnings] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
