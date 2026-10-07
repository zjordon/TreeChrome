#!/usr/bin/env node
// 示例：下载文件（track_downloads）。移植自 browser-use/examples/features/download_file.py，
// 经 TreeWalker examples/features/download_file.py。
// 开启 trackDownloads 后已下载文件作为 done 的附件回传；配合 displayFilesInDoneText
// 可把附件信息内联进 final_result()。下载目录：DOWNLOADS_PATH env 可改，缺省用户
// Downloads 目录（C:/Users/<you>/Downloads）。
//
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行；设置 ZHIPU_API_KEY
//（或写 cwd/.env）。用法：node examples/features/download-file.mjs

import { loadKit } from "../../packages/node-host/boot.mjs";

// 一个稳定可下载的小文件（公共资源）；按需替换为别的可下载直链
const TASK =
  "Go to https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf " +
  "and download the PDF file.";

try {
  const kit = await loadKit();
  const history = await kit.runAgent({
    task: TASK,
    overrides: {
      agent: {
        trackDownloads: true, // 跟踪下载 → 作为 done 附件回传
        displayFilesInDoneText: true, // 把附件信息内联进 final_result()
      },
    },
  });

  console.log(`\ndone: ${history.isDone()}`);
  const result = history.isDone() ? history.finalResult() : null;
  if (result) {
    console.log("\n--- final_result ---");
    console.log(result);
  }
} catch (e) {
  console.error(`[download-file] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
