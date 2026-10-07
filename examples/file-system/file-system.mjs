#!/usr/bin/env node
// 示例：本地文件读写回路。移植自 browser-use/examples/file_system/file_system.py，
// 经 TreeWalker examples/file_system/file_system.py。
//
// agent 访问一篇博客，把标题写入本地文件、追加首句、读回校验——演示本地文件
// 工具链：write_file（write + append）与 read_file。
// 与 browser-use 原版的关键差异（Python 原注释同款）：browser-use 用挂载在
// file_system_path 的内存 FileSystem（相对路径）；TreeWalker/TreeChrome 无内存层，
// 直接写真实文件到绝对路径，写操作经 allowed_write_paths 白名单（前缀匹配，
// gate write_file/replace_file，不 gate read_file）。append 并入 write_file 的
// append=true 参数（browser-use 是独立 append_file 工具）。
// Python 版结束的 input() 交互清理改为提示路径不自动删（方案 D1 登记偏离）。
//
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行；设置 ZHIPU_API_KEY
//（或写 cwd/.env）。用法：node examples/file-system/file-system.mjs

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKit } from "../../packages/node-host/boot.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// 写沙箱（browser-use file_system_path 的 TreeChrome 等价物）
const WORKSPACE = join(SCRIPT_DIR, "file_system_workspace");
mkdirSync(WORKSPACE, { recursive: true });

const TARGET = join(WORKSPACE, "data.md");

// 任务文本逐字保留 Python 版
const TASK = `
Go to https://mertunsall.github.io/posts/post1.html

1. Save the article's title to the file at: ${TARGET}  (use the write_file tool)
2. Use write_file with append=True to add the first sentence of the article
   to the SAME file
3. Use read_file to read the file back and confirm the content looks correct
4. Tell me the file's final content

NOTE: the whole page is visible in the browser state — do NOT use the extract tool.
`.trim();

try {
  const kit = await loadKit();
  const history = await kit.runAgent({
    task: TASK,
    // 写沙箱限于 workspace（前缀匹配）；read_file 默认不受限
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
  console.error(`[file-system] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
