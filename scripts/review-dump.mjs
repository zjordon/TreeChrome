#!/usr/bin/env node
/**
 * 评审结果摘要工具：把 open-code-review 产出的 JSON（含大量 thinking 原文，
 * 通常 400KB+）抽取成紧凑 markdown，便于人和 agent 阅读。
 *
 * 用法：
 *   node scripts/review-dump.mjs docs/code-review/four-review.json          # 打印到 stdout
 *   node scripts/review-dump.mjs docs/code-review/four-review.json --out _review.md
 *   node scripts/review-dump.mjs docs/code-review/four-review.json --min-severity medium
 *
 * --min-severity <critical|high|medium|low>：读之前机械滤掉低于该档的意见
 * （评审自评严重度，缺失按 low 处理）——体量闸门而非正确性担保（自评会双向
 * 误标，P2 循环轮 47 实证：2 条 high 是 stale、3 条 low 是真缺陷），过滤后
 * 剩余意见仍需核验。
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

const sevIdx = args.indexOf("--min-severity");
let minSeverity = null;
if (sevIdx >= 0) {
  minSeverity = args[sevIdx + 1];
  args.splice(sevIdx, 2);
}

const file = args[0];
if (!file) {
  console.error(
    "用法: node scripts/review-dump.mjs <review.json> [--out <md>] [--min-severity <critical|high|medium|low>]",
  );
  exit(1);
}

// 自评严重度档位序（LlmComment.Severity 官方枚举）；缺失/未知按最低档处理
const SEV_RANK = { low: 0, medium: 1, high: 2, critical: 3 };
const rankOf = (s) => SEV_RANK[String(s ?? "").toLowerCase()] ?? 0;
if (minSeverity !== null && !(minSeverity.toLowerCase() in SEV_RANK)) {
  console.error(
    `[review-dump] 非法 --min-severity "${minSeverity}"（须为 critical|high|medium|low）`,
  );
  exit(1);
}

let j;
try {
  j = JSON.parse(readFileSync(file, "utf8"));
} catch (err) {
  console.error(`[review-dump] 无法读取或解析 ${file}: ${err.message}`);
  exit(1);
}
const all = j.comments ?? [];
const comments =
  minSeverity === null
    ? all
    : all.filter((c) => rankOf(c.severity) >= SEV_RANK[minSeverity.toLowerCase()]);
const filtered = all.length - comments.length;

const sevDist = {};
for (const c of all) {
  const s = String(c.severity ?? "").toLowerCase() || "(无)";
  sevDist[s] = (sevDist[s] ?? 0) + 1;
}
const distText = Object.entries(sevDist)
  .map(([k, v]) => `${k}:${v}`)
  .join(" ");

const lines = [];
lines.push(`# 评审摘要：${file}`);
lines.push("");
lines.push(
  `状态: ${j.status} | 文件数: ${j.summary?.files_reviewed ?? "?"} | 意见数: ${comments.length}` +
    (filtered > 0
      ? `（自评严重度分布 ${distText}，已滤除 ${filtered} 条低于 ${minSeverity}）`
      : `（自评严重度分布 ${distText}）`) +
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
  const sev = String(c.severity ?? "").toLowerCase() || "未知档";
  const cat = String(c.category ?? "").toLowerCase();
  const tag = cat ? `[${sev}/${cat}]` : `[${sev}]`;
  lines.push(`### [${i + 1}] ${tag} ${c.path}:${c.start_line ?? "?"}-${c.end_line ?? "?"}`);
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
  console.log(
    `[review-dump] ${comments.length}/${all.length} 条意见 -> ${outFile}（${text.length} 字符${filtered > 0 ? `，滤除 ${filtered} 条 < ${minSeverity}` : ""}）`,
  );
} else {
  console.log(text);
}
