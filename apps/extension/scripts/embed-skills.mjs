// built-in skills 打包（m5/04 §5）：仓库根 domain-skills/ 三套 185 文件 →
// public/domain-skills.json（内容内嵌清单 ~600KB——SW onInstalled 一次 fetch 后
// 全量 upsert IndexedDB）。node 脚本（跨平台无 shell 依赖）；vite buildStart 钩子
// 调用（wxt.config.ts）——dev/build 都覆盖。
//
// 用法：node scripts/embed-skills.mjs [--check]（--check：只校验产物与源同步，
// 不写——CI/提交门可挂）。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const skillsDir = join(repoRoot, "domain-skills");
const outFile = join(here, "..", "public", "domain-skills.json");

function safeReadTrim(path) {
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

function listDirs(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

function buildManifest() {
  const hosts = {};
  for (const host of listDirs(skillsDir)) {
    const hostDir = join(skillsDir, host);
    const bundle = {
      sop: safeReadTrim(join(hostDir, "_sop.md")),
      selectors: safeReadTrim(join(hostDir, "selectors.md")),
      quirks: safeReadTrim(join(hostDir, "quirks.md")),
    };
    const tasksDir = join(hostDir, "tasks");
    if (existsSync(tasksDir)) {
      const tasks = {};
      for (const slug of listDirs(tasksDir)) {
        const cardDir = join(tasksDir, slug);
        let meta = {};
        const metaRaw = safeReadTrim(join(cardDir, "_task.json"));
        if (metaRaw !== "") {
          try {
            meta = JSON.parse(metaRaw);
          } catch {
            meta = {};
          }
        }
        tasks[slug] = {
          sop: safeReadTrim(join(cardDir, "_sop.md")),
          selectors: safeReadTrim(join(cardDir, "selectors.md")),
          quirks: safeReadTrim(join(cardDir, "quirks.md")),
          description: typeof meta.task_description === "string" ? meta.task_description : slug,
          ...(Array.isArray(meta.task_keywords) ? { keywords: meta.task_keywords } : {}),
          ...(typeof meta.distilled_at === "string" ? { distilledAt: meta.distilled_at } : {}),
        };
      }
      if (Object.keys(tasks).length > 0) bundle.tasks = tasks;
    }
    hosts[host] = bundle;
  }
  return { sourceType: "built-in", generatedAt: new Date().toISOString(), hosts };
}

const manifest = buildManifest();
const json = JSON.stringify(manifest);
if (process.argv.includes("--check")) {
  // generatedAt 是生成时刻（非内容函数）——check 时两侧剥除再比对
  let current = null;
  try {
    current = JSON.parse(readFileSync(outFile, "utf8"));
  } catch {
    current = null;
  }
  const inSync =
    current !== null &&
    JSON.stringify({ ...current, generatedAt: "" }) ===
      JSON.stringify({ ...manifest, generatedAt: "" });
  if (!existsSync(outFile) || !inSync) {
    console.error(
      "[embed-skills] 产物与 domain-skills/ 源不同步——重跑 node scripts/embed-skills.mjs",
    );
    process.exit(1);
  }
  console.log("[embed-skills] check ok");
} else {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, json, "utf8");
  const hosts = Object.keys(manifest.hosts).length;
  const tasks = Object.values(manifest.hosts).reduce(
    (n, h) => n + Object.keys(h.tasks ?? {}).length,
    0,
  );
  console.log(
    `[embed-skills] wrote ${outFile} (${hosts} hosts, ${tasks} tasks, ${json.length} bytes)`,
  );
}
