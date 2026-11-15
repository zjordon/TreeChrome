#!/usr/bin/env node
// tc-bridge 命令薄壳（issue #31 M1）：esbuild 引导装载 src/cli.ts 后执行。
// 启动失败兜底 stderr + exit 2（对齐 bin/tc.mjs 评审先例：未处理拒绝会崩成 exit 1，
// 被调用方误读为「跑完但未成功」）。
import { readFileSync } from "node:fs";
import { loadEntry } from "../boot.mjs";

try {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const { runBridgeCli } = await loadEntry("./src/cli.ts");
  process.exitCode = await runBridgeCli(process.argv.slice(2), { version: pkg.version });
} catch (e) {
  process.stderr.write(`[tc-bridge] 启动失败：${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 2;
}
