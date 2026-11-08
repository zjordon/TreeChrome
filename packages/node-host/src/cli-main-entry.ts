// dist 构建入口（issue #26 D1）：scripts/build-cli.mjs 以此为 entry 打出自包含
// dist/tc.mjs——版本号经 esbuild define（__TC_VERSION__）构建期嵌入；顶层 catch 是
// 评审轮 1 [3] 同款兜底（启动失败 → stderr + exit 2，不崩成未处理拒绝的 exit 1）。

import { main } from "./cli.js";

declare const __TC_VERSION__: string;

try {
  const code = await main({ version: __TC_VERSION__ });
  process.exitCode = code;
} catch (e) {
  process.stderr.write(`[tc] 启动失败：${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 2;
}
