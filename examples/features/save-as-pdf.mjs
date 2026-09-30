#!/usr/bin/env node

// 示例：把网页存成 PDF。移植自 browser-use/examples/features/save_as_pdf.py，经
// TreeWalker examples/features/save_as_pdf.py（任务驱动调 save_as_pdf 动作）。
// 注意：save_as_pdf 写盘路径不受 allowed_write_paths 约束（白名单只作用于
// write_file/replace_file/read_file）——Python 原注释同款。
// 输出路径：Python 版硬编码 C:/tmp/browser_automation.pdf，此处改 os.tmpdir()
// 可移植化（方案 F4 登记）。
//
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行；设置 ZHIPU_API_KEY
//（或写 cwd/.env）。用法：node examples/features/save-as-pdf.mjs

import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKit } from "../../packages/node-host/boot.mjs";

const OUTPUT = join(tmpdir(), "browser_automation.pdf");
const TASK =
  "Go to https://en.wikipedia.org/wiki/Browser_automation and use the save_as_pdf " +
  `action to save the whole page as a PDF to ${OUTPUT}.`;

try {
  const kit = await loadKit();
  const history = await kit.runAgent({ task: TASK });

  console.log(`\ndone: ${history.isDone()} | pdf: ${OUTPUT}`);
} catch (e) {
  console.error(`[save-as-pdf] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
