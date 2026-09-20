#!/usr/bin/env node
/**
 * 评审结果摘要工具：把 open-code-review 产出的 JSON（含大量 thinking 原文，
 * 通常 400KB+）抽取成紧凑 markdown，便于人和 agent 阅读。
 *
 * 用法：
 *   node scripts/review-dump.mjs docs/code-review/four-review.json          # 打印到 stdout
 *   node scripts/review-dump.mjs docs/code-review/four-review.json --out _review.md
 *
 * 输出文件建议用 _ 前缀（提交门会拦截 _ 前缀临时文件，天然不入库）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { argv, exit } from "node:process";

const rest = argv.slice(2);
const outIdx = rest.indexOf("--out");
const outFile = outIdx >= 0 ? rest[outIdx + 1] : null;
// 同时剥掉 --out 与其值：容忍 `--out x.md a.json` 的参数顺序；
// 未传 --out 时（outIdx=-1）不得剥除，否则第 0 个参数（输入文件）会被误滤掉
const args = outIdx >= 0 ? rest.filter((_, i) => i !== outIdx && i !== outIdx + 1) : rest;
const file = args[0];
if (!file) {
  console.error("用法: node scripts/review-dump.mjs <review.json> [--out <md>]");
  exit(1);
}

let j;
try {
  j = JSON.parse(readFileSync(file, "utf8"));
} catch (err) {
  console.error(`[review-dump] 无法读取或解析 ${file}: ${err.message}`);
  exit(1);
}
const comments = j.comments ?? [];
const lines = [];
lines.push(`# 评审摘要：${file}`);
lines.push("");
lines.push(
  `状态: ${j.status} | 文件数: ${j.summary?.files_reviewed ?? "?"} | 意见数: ${comments.length}` +
    ` | 模型: ${j.llm?.model ?? "?"} | 耗时: ${j.summary?.elapsed ?? "?"}`,
);
lines.push("");
lines.push(j.summary?.project_summary ?? "");
lines.push("");

const clip = (s, n) => {
  const t = String(s ?? "").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

comments.forEach((c, i) => {
  lines.push(`### [${i + 1}] ${c.path}:${c.start_line ?? "?"}-${c.end_line ?? "?"}`);
  lines.push("");
  lines.push(c.content ?? "");
  if (c.existing_code) {
    lines.push("");
    // 四反引号围栏：评审意见原文常含 ``` 围栏，三反引号会被提前截断
    lines.push("````");
    lines.push(clip(c.existing_code, 600));
    lines.push("````");
  }
  if (c.suggestion_code) {
    lines.push("");
    lines.push("建议:");
    lines.push("````");
    lines.push(clip(c.suggestion_code, 800));
    lines.push("````");
  }
  lines.push("");
});

const text = lines.join("\n");
if (outFile) {
  writeFileSync(outFile, text, "utf8");
  console.log(`[review-dump] ${comments.length} 条意见 -> ${outFile}（${text.length} 字符）`);
} else {
  console.log(text);
}
