// 全仓唯一一份散脚本 esbuild 引导（node-host 方案 §4 决策 3）：把 src/ 下 TS 入口
// 打成临时 ESM 再返回（@tw/* 包 exports 指向 src/*.ts 源码直发，Node 原生 import
// 不了 TS；esbuild 认这条链——exports→src/*.ts，@tw/core 内部引 @tw/dom-snapshot
// 已走通同模式）。
//
// 消费方：
//   import { loadEntry, loadKit } from "<pkg>/boot.mjs";
//   loadKit()               —— examples 散脚本（boot-entry.ts 的 kit 导出面）
//   loadEntry("./src/…")    —— bin/tc.mjs（issue #25 M1：src/cli.ts 入口）
//
// 有构建/发布形态（dist）后本文件可整体退役，散脚本塌缩成一行包名 import。
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
  const tmp = mkdtempSync(join(tmpdir(), "tw-node-host-kit-"));
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

/** examples 散脚本的 kit 面（boot-entry.ts 导出面）——loadEntry 的预置入口形态 */
export function loadKit() {
  return loadEntry("./src/boot-entry.ts");
}
