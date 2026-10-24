#!/usr/bin/env node
// 示例（issue #5 阶段 0 → D17 收敛循环）：自蒸馏终身学习循环——沙箱无卡则先探索
// 建卡；此后每轮带最新卡跑同一任务，成功门控过后增量蒸馏：有新观察 → 卡更新 +
// 计数清零；无新观察 → 卡内容不动、distill_streak +1；连续 N 次（--converge，默认
// 2）无新观察即收敛——后续同任务成功 run 连蒸馏调用都跳过（预算允许时脚本自动追加
// 一轮「收敛验证」展示跳过路径）。回答三个问题：卡的注入增益（探索轮 vs 带卡轮）、
// 增量蒸馏的反复正确性、收敛跳过是否可触达。
//
// 真机脚本（手动跑不入 CI）：真实 LLM + 真实 Chrome。沙箱默认保留（跨脚本运行
// 积累——已有卡则直接进带卡循环，不重跑探索）；--fresh 显式清空重来（仅允许 _
// 前缀目录——防误删真实内容库）。沉淀进正式库：沙箱产物人工审阅后手动拷贝进
// domain-skills/ 走 git 评审（SCRATCHPAD D15）。
//
// 用法（Chrome 以 --remote-debugging-port=9223 启动并手动登录目标站后）：
//   node examples/self-evolution/distill-and-rerun.mjs --task-id 1
//   node examples/self-evolution/distill-and-rerun.mjs --task-id 1 --runs 4 --converge 2
//   node examples/self-evolution/distill-and-rerun.mjs --task-id 1 --fresh

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadKit } from "../../packages/node-host/boot.mjs";

const DEFAULT_WEBARENA_REPO = "D:\\dev\\git\\z_jordon\\evals\\webarena\\webarena_repo";

// ── argv（p7-rerun-webarena-task.mjs 同款形态） ──────────────────────────────
const args = {
  taskId: 1,
  port: 9223,
  maxSteps: 30,
  taskTimeout: 1800,
  webarenaRepo: DEFAULT_WEBARENA_REPO,
  sandbox: "_self-evolution-sandbox/domain-skills",
  logFile: null,
  runs: 4,
  converge: 2,
  fresh: false,
};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  const value = (name) => {
    const v = process.argv[++i];
    if (v === undefined || v.startsWith("--")) {
      console.error(`${name} 缺值（收到: ${v ?? "无"}）`);
      process.exit(2);
    }
    return v;
  };
  const intArg = (name, min) => {
    const n = Number(value(name));
    if (!Number.isInteger(n) || n < min) {
      console.error(`${name} 需 ≥${min} 的整数（收到: ${process.argv[i]}）`);
      process.exit(2);
    }
    return n;
  };
  if (a === "--task-id") args.taskId = intArg(a, 0);
  else if (a === "--port") args.port = intArg(a, 1);
  else if (a === "--max-steps") args.maxSteps = intArg(a, 1);
  else if (a === "--task-timeout") args.taskTimeout = intArg(a, 1);
  else if (a === "--webarena-repo") args.webarenaRepo = value(a);
  else if (a === "--sandbox") args.sandbox = value(a);
  else if (a === "--log-file") args.logFile = value(a);
  else if (a === "--runs") args.runs = intArg(a, 1);
  else if (a === "--converge") args.converge = intArg(a, 1);
  else if (a === "--fresh") args.fresh = true;
  else {
    console.error(`未知参数: ${a}`);
    process.exit(2);
  }
}

process.env.CDP_PORT = String(args.port);

const kit = await loadKit();
const configPath = join(args.webarenaRepo, "config_files", `${args.taskId}.json`);
if (!existsSync(configPath)) {
  console.error(`✗ 任务配置不存在: ${configPath}`);
  process.exit(1);
}
const task = JSON.parse(readFileSync(configPath, "utf8"));
const intent = task.intent ?? "";
const startUrl = task.start_url ?? "";
const taskText = startUrl ? `${intent}\n\n起始页: ${startUrl}` : intent;
console.log(`task ${args.taskId}: ${intent}`);
console.log(`参考答案: ${JSON.stringify(task.eval?.reference_answers ?? {})}`);

// --fresh 清空（防误删护栏：仅允许 _ 前缀目录——仓库 scratch 约定）
if (args.fresh) {
  const sandboxTop = args.sandbox.split(/[\\/]/)[0];
  if (!sandboxTop.startsWith("_")) {
    console.error(
      `✗ --fresh 只允许清空 _ 前缀目录（收到: ${args.sandbox}）——` +
        `指向真实内容库（如 domain-skills）会误删全部内置文件。`,
    );
    process.exit(2);
  }
  rmSync(args.sandbox, { recursive: true, force: true });
  console.log(`[fresh] 沙箱已清空: ${args.sandbox}`);
}
mkdirSync(args.sandbox, { recursive: true });

let log;
if (args.logFile !== null) {
  mkdirSync(dirname(args.logFile), { recursive: true });
  log = (m) => {
    console.log(m);
    appendFileSync(args.logFile, `${m}\n`, "utf8");
  };
}

// ── 卡目录扫描（沙箱内全部任务卡 + meta） ────────────────────────────────────
const cardDirsOf = () => {
  const out = [];
  if (!existsSync(args.sandbox)) return out;
  for (const host of readdirSync(args.sandbox)) {
    const tasksDir = join(args.sandbox, host, "tasks");
    if (!existsSync(tasksDir)) continue;
    for (const slug of readdirSync(tasksDir)) {
      const metaPath = join(tasksDir, slug, "_task.json");
      if (!existsSync(metaPath)) continue;
      try {
        out.push({ dir: join(tasksDir, slug), meta: JSON.parse(readFileSync(metaPath, "utf8")) });
      } catch {
        // 坏 meta 卡跳过（不阻断循环）
      }
    }
  }
  return out;
};

const judgePassed = (history) => {
  const lastStep = history.history[history.history.length - 1];
  return lastStep?.result.find((r) => r.isDone)?.judgement?.verdict === true;
};

const summaryLine = (history) => {
  const lastStep = history.history[history.history.length - 1];
  const judgement = lastStep?.result.find((r) => r.isDone)?.judgement ?? null;
  const verdict = judgement?.verdict === true ? "pass" : judgement === null ? "无" : "FAIL";
  return `steps=${history.history.length} successful=${history.isSuccessful()} judge=${verdict}`;
};

/** judge 判词直打（p7 同款补偿面——agent 侧静默附挂，脚本负责呈现；失败可诊断） */
const printJudgement = (history) => {
  const lastStep = history.history[history.history.length - 1];
  const j = lastStep?.result.find((r) => r.isDone)?.judgement ?? null;
  if (j === null) {
    console.log("  judgement   : 无（judge 未运行或调用失败）");
    return;
  }
  console.log(
    `  judgement   : verdict=${String(j.verdict)} impossible_task=${String(j.impossible_task ?? false)} captcha=${String(j.captcha ?? false)}`,
  );
  if (typeof j.reasoning === "string" && j.reasoning !== "") {
    console.log(`  reasoning   : ${j.reasoning}`);
  }
  if (typeof j.failure_reason === "string" && j.failure_reason !== "") {
    console.log(`  failure_reason: ${j.failure_reason}`);
  }
};

/** 单跑（taskTimeout race——p7 同款）；返回 {history, seconds} */
const runOnce = async (label, extra) => {
  console.log(`\n=========== 跑 ${label} ===========`);
  const startedAt = Date.now();
  const history = await Promise.race([
    kit.runAgent({
      task: taskText,
      log,
      overrides: { agent: { maxSteps: args.maxSteps } },
      ...extra,
    }),
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`任务超过 ${args.taskTimeout}s 被中断`)),
        args.taskTimeout * 1000,
      ).unref?.();
    }),
  ]).catch((e) => {
    console.error(`✗ 跑 ${label} 失败: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
  return { history, seconds: Math.round((Date.now() - startedAt) / 1000) };
};

// ── 收敛循环 ────────────────────────────────────────────────────────────────
const initialCards = cardDirsOf();
console.log(
  initialCards.length === 0
    ? "沙箱无卡——第 1 轮为探索跑（无 skill 基线）"
    : `沙箱已有 ${initialCards.length} 张卡——直接进入带卡循环（积累模式，--fresh 可重来）`,
);

const results = [];
let converged = false;
for (let i = 0; i < args.runs; i++) {
  const isVerify = converged;
  const isExplore = i === 0 && initialCards.length === 0;
  const label = isVerify
    ? `${i + 1}（收敛验证：应跳过蒸馏）`
    : isExplore
      ? `${i + 1}（探索：无卡基线）`
      : `${i + 1}（带卡）`;
  const r = await runOnce(label, {
    ...(isExplore
      ? { skillSource: null }
      : {
          skillSource: new kit.FsSkillSource(args.sandbox, (m) =>
            (log ?? console.log)(`[skill] ${m}`),
          ),
          overrides: { agent: { maxSteps: args.maxSteps, enableTaskSkillInjection: true } },
        }),
    distill: {
      skillsDir: args.sandbox,
      runId: `phase0-run${i + 1}`,
      convergeThreshold: args.converge,
    },
  });
  const passed = r.history.isSuccessful() && judgePassed(r.history);
  results.push({ label, isExplore, isVerify, ...r, passed });
  console.log(`${label} 结果: ${summaryLine(r.history)}`);
  printJudgement(r.history);

  if (isVerify) break; // 收敛验证轮跑完即收口（预期日志已出现 converged — skip）
  if (!passed) {
    console.error(
      `✗ 第 ${i + 1} 轮门控未过（非成功完成或 Judge 未通过）——循环终止，卡保持上一轮状态`,
    );
    break;
  }
  const cards = cardDirsOf();
  if (cards.length === 0) {
    console.error("✗ 本轮后沙箱无卡（探索跑蒸馏失败？——查 distill: 日志行）");
    process.exit(1);
  }
  const maxStreak = cards.reduce((m, c) => Math.max(m, c.meta.distill_streak ?? 0), 0);
  if (maxStreak >= args.converge) {
    converged = true;
    console.log(
      `✓ 收敛：卡连续 ${maxStreak} 次成功且无新观察（阈值 ${args.converge}）` +
        (i + 1 < args.runs ? "——下一轮为收敛验证（应跳过蒸馏）" : "——已达 --runs 上限，跳过验证轮"),
    );
  }
}

// ── 报告 ────────────────────────────────────────────────────────────────────
console.log("\n=========== 收敛循环报告 ===========");
for (const r of results) {
  console.log(`${r.label}: ${summaryLine(r.history)} 耗时 ${r.seconds}s`);
}
const cards = cardDirsOf();
if (cards.length > 0) {
  console.log("\n卡终态:");
  for (const { dir, meta } of cards) {
    console.log(
      `  ${meta.slug ?? "?"}: source_traces=${JSON.stringify(meta.source_traces ?? [])}` +
        ` distill_streak=${meta.distill_streak ?? 0} distilled_at=${meta.distilled_at ?? "?"}`,
    );
    console.log(`    ${dir}`);
  }
  const verdict = converged
    ? results.some((r) => r.isVerify)
      ? "已收敛 + 验证轮跑完（验证轮日志应含 converged — skip 且卡零改动）"
      : "已收敛（--runs 上限内未跑验证轮）"
    : results.every((r) => r.passed)
      ? "未收敛（达到 --runs 上限——卡仍在积累）"
      : "中断（有轮门控未过）";
  console.log(`收敛判定: ${verdict}`);
  const explore = results.find((r) => r.isExplore && r.passed);
  const assisted = results.filter((r) => !r.isExplore && !r.isVerify && r.passed);
  if (explore !== undefined && assisted.length > 0) {
    const avg = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
    console.log(
      `注入增益: 探索 ${explore.history.history.length} 步 vs 带卡平均 ` +
        `${avg(assisted.map((r) => r.history.history.length))} 步（${explore.seconds}s vs 平均 ${avg(assisted.map((r) => r.seconds))}s）`,
    );
  }
}
console.log(
  "\n人工检查项：① 带卡轮日志含 [skill] task-skill hit: slug=…（命中注入）；② 增量轮（distill: 已写入（增量更新，计数清零））后卡内容以旧卡为基线（措辞可压缩、主题不丢）；③ 无新观察轮：内容文件不动、仅 _task.json 的 distill_streak +1；④ 收敛验证轮：distill: … converged … — skip 且卡零改动。",
);
