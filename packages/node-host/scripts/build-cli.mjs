// tc 自包含构建（issue #26 D1）：esbuild 打 src/cli-main-entry.ts → dist/tc.mjs
//（版本 define 嵌入），并组装 staging 安装包 dist/tc-package/（package.json + tc.mjs
// + README——无 dependencies，绕开 workspace:* 不可独立安装）。全局安装：
//   npm i -g packages/node-host/dist/tc-package      （本机直装）
//   cd dist/tc-package && npm pack                   （出可分发的版本化 tarball）
// dist/ 在 .gitignore（按需构建不入库）。

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const require = createRequire(import.meta.url);

const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));

let esbuild;
try {
  // Windows：动态 import 绝对路径须转 file:// URL（boot.mjs 同款处理）
  esbuild = await import(pathToFileURL(require.resolve("esbuild")).href);
} catch (e) {
  console.error(`esbuild 解析失败（请先在仓库根执行 pnpm install）：${e?.message ?? e}`);
  process.exit(1);
}

await esbuild.build({
  entryPoints: [join(pkgRoot, "src", "cli-main-entry.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  // shebang 必须有：npm 的 sh shim 靠它路由到 node，缺失则 sh 直接解释 .mjs 报错
  banner: { js: "#!/usr/bin/env node" },
  define: { __TC_VERSION__: JSON.stringify(pkg.version) },
  outfile: join(pkgRoot, "dist", "tc.mjs"),
  // core/cdp-ws 是 TS 源码直发——bundle 内解析；无外部运行时依赖（llm 用原生 fetch）
  external: [],
  logLevel: "info",
});

// staging 包：可 npm i -g 的最小安装目录（无 dependencies）
const staging = join(pkgRoot, "dist", "tc-package");
mkdirSync(staging, { recursive: true });
writeFileSync(
  join(staging, "package.json"),
  `${JSON.stringify(
    {
      name: "tc-cli",
      version: pkg.version,
      private: true,
      type: "module",
      description: "TreeChrome tc CLI——任务级浏览器 agent（自包含单文件构建）",
      bin: { tc: "./tc.mjs" },
    },
    null,
    2,
  )}\n`,
);
copyFileSync(join(pkgRoot, "dist", "tc.mjs"), join(staging, "tc.mjs"));
copyFileSync(join(pkgRoot, "README.md"), join(staging, "README.md"));

console.log(`[build-cli] dist/tc.mjs（v${pkg.version}）+ dist/tc-package/ 就绪`);
console.log("[build-cli] 全局安装：npm i -g packages/node-host/dist/tc-package");
