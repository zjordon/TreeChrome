// esbuild 运行时引导（对齐 node-host boot.mjs 先例——@tw/* 包 exports 指向 src/*.ts
// 源码直发，Node 原生 import 不了 TS；esbuild 认这条链）。仅 bin/tc-bridge.mjs 消费；
// 自包含 dist 产品化（#26 build:cli 形态）列为 M1 验收外后续项。
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function resolveEsbuild() {
  try {
    // esbuild 是本包 devDependency——从包根解析必有（pnpm workspace 非提升布局）
    return require.resolve("esbuild");
  } catch (e) {
    throw new Error(
      `esbuild 解析失败（请先在仓库根执行 pnpm install）：${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

/** 打包并加载相对本包根的 TS 入口（esbuild stdin re-export 形态；返回其导出面） */
export async function loadEntry(entryRel) {
  const mod = await import(pathToFileURL(resolveEsbuild()).href);
  const build = mod.build ?? mod.default?.build;
  if (typeof build !== "function") {
    throw new Error("esbuild JS API 不可用（build 导出缺失）");
  }
  const tmp = mkdtempSync(join(tmpdir(), "tw-mcp-bridge-"));
  try {
    const out = join(tmp, "entry.mjs");
    await build({
      stdin: {
        contents: `export * from "${entryRel}";\n`,
        resolveDir: here,
        loader: "ts",
      },
      bundle: true,
      format: "esm",
      platform: "node",
      outfile: out,
    });
    return await import(pathToFileURL(out).href);
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Windows 杀毒/索引器瞬时文件锁：清理失败不影响主流程
    }
  }
}
