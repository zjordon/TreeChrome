#!/usr/bin/env node
// 抖音发视频任务实测分析（issue #5 附加观测）：真实 LLM + 用户 Chrome（登录态）跑
// 「上传视频 + 双封面存草稿」任务，逐段计时定位慢点（sense 采集 / 模型延迟 / 动作
// 执行），并挂蒸馏钩子观察收敛——回答三个问题：步数为什么多、步与步之间慢在哪、
// 蒸馏是否收敛。诊断面走 node-host（事件总线全量订阅），不依赖扩展 UI。
//
// ⚠ 每一轮都会在你的抖音账号真实存一份视频草稿——--runs 控制轮数（默认 2：
// 探索建卡 + 带卡复跑；收敛观察加到 3-4）。
//
// 前置：Chrome 以 --remote-debugging-port=9223 运行并已登录抖音创作者中心；
// ZHIPU_API_KEY（或 cwd/.env）。
// 用法：node examples/douyin-upload-analysis.mjs [--runs 2] [--fresh] [--max-steps 50]
//        [--task-timeout 1800] [--port 9223] [--log-file <path>]

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadKit } from "../packages/node-host/boot.mjs";

const VIDEO = "D:\\Videos\\test\\final\\2026-04-29-20-41-59.mp4";
const HENG = "D:\\dev\\git\\claude\\skills-deom\\ppt\\browser-use\\heng.png";
const SHU = "D:\\dev\\git\\claude\\skills-deom\\ppt\\browser-use\\shu.png";

const TASK =
  "用附件里的视频和横竖两张封面图到抖音创作者中心发视频，先暂存为草稿不要直接发布，\n" +
  "存完回到发布视频界面即完成，不要点继续编辑重复编辑。\n" +
  "抖音创作者中心：https://creator.douyin.com/\n" +
  `视频是附件里的 2026-04-29-20-41-59.mp4（本地路径 ${VIDEO}）\n` +
  "作品描述主标题：ai浏览器第五期-browse-use，副标题：browse-use体验及技术原理\n" +
  "合集添加到「AI浏览器合集」；自主声明选「无需添加」\n" +
  `横封面 heng.png（本地路径 ${HENG}）\n` +
  `竖封面 shu.png（本地路径 ${SHU}）`;

// ── argv ────────────────────────────────────────────────────────────────
const args = {
  port: 9223,
  maxSteps: 50,
  taskTimeout: 1800,
  runs: 2,
  sandbox: "_douyin-sandbox/domain-skills",
  logFile: null,
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
  if (a === "--port") args.port = intArg(a, 1);
  else if (a === "--max-steps") args.maxSteps = intArg(a, 1);
  else if (a === "--task-timeout") args.taskTimeout = intArg(a, 1);
  else if (a === "--runs") args.runs = intArg(a, 1);
  else if (a === "--log-file") args.logFile = value(a);
  else if (a === "--fresh") args.fresh = true;
  else {
    console.error(`未知参数: ${a}`);
    process.exit(2);
  }
}
process.env.CDP_PORT = String(args.port);

// ── 前置检查：附件在位（upload 白名单只放行存在的文件——错了 run 必卡） ─────
for (const p of [VIDEO, HENG, SHU]) {
  if (!existsSync(p)) {
    console.error(`✗ 附件不存在: ${p}（改脚本头部 VIDEO/HENG/SHU 常量后重跑）`);
    process.exit(1);
  }
}

// --fresh 护栏（distill-and-rerun 同款：仅允许 _ 前缀目录）
if (args.fresh) {
  const top = args.sandbox.split(/[\\/]/)[0];
  if (!top.startsWith("_")) {
    console.error(`✗ --fresh 只允许清空 _ 前缀目录（收到: ${args.sandbox}）`);
    process.exit(2);
  }
  rmSync(args.sandbox, { recursive: true, force: true });
  console.log(`[fresh] 沙箱已清空: ${args.sandbox}`);
}
mkdirSync(args.sandbox, { recursive: true });

let log = console.log;
if (args.logFile !== null) {
  mkdirSync(dirname(args.logFile), { recursive: true });
  log = (m) => {
    console.log(m);
    appendFileSync(args.logFile, `${m}\n`, "utf8");
  };
}

const kit = await loadKit();
kit.applyDotEnv();

// ── 逐段计时采集器：订阅全量事件，按步聚合 sense/model/act 三段 ────────────
// 相位归属按「区间由结束事件定相位」：step_start→model_call=sense（DOM 采集/快照/
// prompt 组装）；model_call↔model_result=model（LLM 延迟，含步内多次调用）；
// model_result→step_end=act（动作执行 + 动作间观察间隙）。
function makeCollector() {
  const steps = new Map();
  const step = (n) => {
    if (!steps.has(n)) {
      steps.set(n, {
        sense: 0,
        model: 0,
        act: 0,
        total: 0,
        t0: null,
        lastT: null,
        modelCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
        actions: [],
      });
    }
    return steps.get(n);
  };
  return {
    bus: new kit.EventBus({ log: () => {} }),
    steps: () => [...steps.entries()].sort((a, b) => a[0] - b[0]),
    install() {
      this.bus.subscribe("*", (ev) => {
        const t = Date.now();
        const s = step(ev.step);
        const gap = s.lastT === null ? 0 : t - s.lastT;
        s.lastT = t;
        switch (ev.eventType) {
          case "step_start":
            s.t0 = t;
            break;
          case "model_call":
            if (s.modelCalls === 0) s.sense += gap;
            else s.model += gap; // 步内第二次起调用的间隙计入模型段
            s.modelCalls += 1;
            break;
          case "model_result":
            s.model += gap;
            s.tokensIn += ev.inputTokens ?? 0;
            s.tokensOut += ev.outputTokens ?? 0;
            break;
          case "tool_call":
            s.actions.push({
              id: ev.toolCallId,
              name: ev.actionName ?? "?",
              ok: null,
              dur: null,
              params: ev.params,
            });
            break;
          case "tool_result": {
            s.act += gap;
            const a = s.actions.find((x) => x.id === ev.toolCallId);
            if (a !== undefined) {
              a.ok = ev.success === true;
              a.dur = ev.durationSeconds ?? null;
            }
            break;
          }
          case "step_end":
            s.act += gap;
            if (s.t0 !== null) s.total = t - s.t0;
            break;
          default:
            break;
        }
      });
    },
  };
}

const fmt = (ms) => (ms / 1000).toFixed(1).padStart(6);

function report(collector, label, wallSeconds) {
  const rows = collector.steps();
  log(`\n── 逐段计时（${label}，总墙钟 ${wallSeconds}s）──`);
  log("  step |  sense |  model |    act |  total | tokens(in+out) | 动作");
  let sumSense = 0;
  let sumModel = 0;
  let sumAct = 0;
  let sumIn = 0;
  let sumOut = 0;
  for (const [n, s] of rows) {
    sumSense += s.sense;
    sumModel += s.model;
    sumAct += s.act;
    sumIn += s.tokensIn;
    sumOut += s.tokensOut;
    const acts = s.actions
      .map((a) => `${a.ok ? "✓" : "✗"}${a.name}${a.dur !== null ? `(${a.dur.toFixed(1)}s)` : ""}`)
      .join(",");
    log(
      `  ${String(n).padStart(4)} |${fmt(s.sense)} |${fmt(s.model)} |${fmt(s.act)} |${fmt(s.total)} | ${String(s.tokensIn).padStart(6)}+${String(s.tokensOut).padStart(5)} | ${acts}`,
    );
  }
  const tot = sumSense + sumModel + sumAct;
  const pct = (x) => `${((x / tot) * 100).toFixed(0)}%`;
  log(
    `  合计: sense=${(sumSense / 1000).toFixed(1)}s(${pct(sumSense)}) model=${(sumModel / 1000).toFixed(1)}s(${pct(sumModel)}) act=${(sumAct / 1000).toFixed(1)}s(${pct(sumAct)}) tokens=${sumIn}+${sumOut}`,
  );
  const slowest = rows
    .map(([n, s]) => ({ n, total: s.total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 3);
  log(`  最慢 3 步: ${slowest.map((x) => `#${x.n} ${(x.total / 1000).toFixed(1)}s`).join("、")}`);
}

// ── 卡状态（收敛可见性——扩展 UI 看不到的面） ─────────────────────────────
const cardReport = () => {
  if (!existsSync(args.sandbox)) return "（无卡目录）";
  const lines = [];
  for (const host of readdirSync(args.sandbox)) {
    const tasksDir = join(args.sandbox, host, "tasks");
    if (!existsSync(tasksDir)) continue;
    for (const slug of readdirSync(tasksDir)) {
      const metaPath = join(tasksDir, slug, "_task.json");
      if (!existsSync(metaPath)) continue;
      try {
        const m = JSON.parse(readFileSync(metaPath, "utf8"));
        lines.push(
          `  ${host}/${slug}: streak=${m.distill_streak ?? 0}（≥2 即收敛跳过） distilled_at=${m.distilled_at ?? "?"} source_traces=${(m.source_traces ?? []).length}`,
        );
      } catch {
        lines.push(`  ${host}/${slug}: meta 坏形态`);
      }
    }
  }
  return lines.length > 0 ? lines.join("\n") : "（无卡）";
};

// ── 主循环 ───────────────────────────────────────────────────────────────
const printJudgement = (history) => {
  const lastStep = history.history[history.history.length - 1];
  const j = lastStep?.result.find((r) => r.isDone)?.judgement ?? null;
  if (j === null) {
    log("  judgement   : 无（judge 未运行或调用失败）");
    return;
  }
  log(
    `  judgement   : verdict=${String(j.verdict)} impossible=${String(j.impossibleTask ?? false)} captcha=${String(j.captcha ?? false)}`,
  );
  if (typeof j.reasoning === "string" && j.reasoning !== "") log(`  reasoning   : ${j.reasoning}`);
};

const hasCards = () => {
  if (!existsSync(args.sandbox)) return false;
  for (const host of readdirSync(args.sandbox)) {
    const tasksDir = join(args.sandbox, host, "tasks");
    if (existsSync(tasksDir) && readdirSync(tasksDir).length > 0) return true;
  }
  return false;
};

for (let r = 1; r <= args.runs; r++) {
  const withCard = hasCards();
  const label = `跑 ${r}${withCard ? "（带卡注入）" : "（探索/基线）"}`;
  log(`\n=========== ${label} ===========`);
  const collector = makeCollector();
  collector.install();
  const startedAt = Date.now();
  let history;
  try {
    history = await Promise.race([
      kit.runAgent({
        task: TASK,
        log,
        eventBus: collector.bus,
        // 沙箱有卡即注入（distill-and-rerun 同款面）——上一轮蒸馏产物本轮生效；
        // 无卡时显式 null 关闭缺省装配（评审轮 1 [9]：缺省按 CWD "domain-skills"
        // 注入仓库内置卡，探索基线被污染）
        skillSource: withCard
          ? new kit.FsSkillSource(args.sandbox, (m) => log(`[skill] ${m}`))
          : null,
        overrides: {
          agent: {
            maxSteps: args.maxSteps,
            enablePlanning: true,
            allowedUploadPaths: [VIDEO, HENG, SHU],
            ...(withCard ? { enableTaskSkillInjection: true } : {}),
          },
        },
        distill: { skillsDir: args.sandbox },
      }),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error(`任务超过 ${args.taskTimeout}s 被中断`)),
          args.taskTimeout * 1000,
        ).unref?.();
      }),
    ]);
  } catch (e) {
    console.error(`✗ ${label} 失败: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const wall = Math.round((Date.now() - startedAt) / 1000);
  report(collector, label, wall);
  log(
    `  结果: steps=${history.history.length} successful=${history.isSuccessful()} done=${history.isDone()} 耗时 ${wall}s`,
  );
  printJudgement(history);
  log(`  final: ${String(history.finalResult()).slice(0, 300)}`);
  log(`── 蒸馏卡状态（收敛可见性）──\n${cardReport()}`);
}

console.log(
  `\n提示：逐段计时里 sense=步开始→模型调用（DOM 采集/快照/prompt 组装）、model=LLM 延迟、act=动作执行；` +
    `慢点集中段即优化方向。收敛状态看 distill_streak（≥2 后同任务跳过蒸馏）。`,
);
