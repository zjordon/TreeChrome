#!/usr/bin/env node
// tc 命令薄壳（issue #25 M1）：esbuild 引导装载 src/cli.ts 后执行 main()。
// bin 不经打包器——版本号运行时直读包 package.json（相对本文件的 URL 定位稳定）。
import { readFileSync } from "node:fs";
import { loadEntry } from "../boot.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const { main } = await loadEntry("./src/cli.ts");
process.exitCode = await main({ version: pkg.version });
