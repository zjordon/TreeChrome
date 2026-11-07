#!/usr/bin/env node
// tc 命令薄壳（issue #25 M1）：esbuild 引导装载 src/cli.ts 后执行 main()。
// bin 不经打包器——版本号运行时直读包 package.json（相对本文件的 URL 定位稳定）。
// 启动失败（esbuild 缺失/打包异常/package.json 不可读）兜底为 stderr 文案 + exit 2
// （评审轮 1 [3]）：未处理拒绝会崩成 exit 1，被调用方误读为「跑完但未成功」。
import { readFileSync } from "node:fs";
import { loadEntry } from "../boot.mjs";

try {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const { main } = await loadEntry("./src/cli.ts");
  process.exitCode = await main({ version: pkg.version });
} catch (e) {
  process.stderr.write(`[tc] 启动失败：${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 2;
}
