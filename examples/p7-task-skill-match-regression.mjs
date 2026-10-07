#!/usr/bin/env node
// 示例：P7 任务级 skill 匹配离线回归（docs/p7/04 §七 S3，issue #182）。移植自
// TreeWalker examples/p7_task_skill_match_regression.py——不跑浏览器，匹配器是纯
// LLM 调用（matchTaskSkill），对「44 卡 catalog × 184 任务文本」批量跑匹配层量三率：
// 回放命中 / 泛化正确命中（模板等价类）/ 跨模板误命中（+ 降档数 + 分级字段分布）。
// prompt 迭代在离线完成，真机全量只跑最终版——省的是每轮 184 任务的完整 agent 跑。
//
// 数据对齐（离线保真三要素）：
//   1. 任务文本组装对齐 runner（`{intent}\n\n起始页: {start_url}`——matcher 收到的）；
//   2. 任务集 = 评测仓 webarena_repo/config_files/test.raw.json 里 sites 含
//      shopping_admin 的 184 个；
//   3. 回放映射 = 评测仓 config/replay_map.json（44 卡 slug → 本尊 task_id）；
//      卡的模板 = 本尊任务的 intent_template_id——正确性按模板等价类判
//      （42 模板 44 卡，命中同模板另一张卡算正确命中）。
//
// 调用失败（callFailed——API 异常/超时重试后仍失败）在 harness 层重试至 3 次
// （matchTaskSkill 内部只重试一次）；重试穷尽仍失败的持续失败从命中率统计剔除
// （分母不含）、metrics 单列 call_failed_persistent、门槛不判 PASS——基础设施故障
// 不是匹配语义，不得计入未命中。
//
// 用法（TreeChrome 仓库根）：
//   node examples/p7-task-skill-match-regression.mjs --eval-root <evals/webarena> \
//     --concurrency 6 --out out/task_skill_match_regression.json --gate
//
// 门槛（--gate，docs/p7/04 §七：达标才上真机）：回放正确命中 44/44（漏命中 0）
// 且泛化正确命中 ≥ 80%；退出码 1 = 不达标。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKit } from "../packages/node-host/boot.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 离线门槛（docs/p7/04 §七）：泛化命中 30% → ≥80%；回放漏命中保持 0。
const GATE_REPLAY_TOTAL = 44;
const GATE_VARIANT_RATE = 0.8;

// ── argv（argparse 子集：值参数 + 布尔开关，未知参数退出码 2） ─────────────────
const args = {
  evalRoot: null,
  hostKey: "localhost_7780",
  concurrency: 6,
  out: join(REPO_ROOT, "out", "task_skill_match_regression.json"),
  limit: 0,
  gate: false,
};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--eval-root") args.evalRoot = process.argv[++i];
  else if (a === "--host-key") args.hostKey = process.argv[++i];
  else if (a === "--concurrency") args.concurrency = Number(process.argv[++i]);
  else if (a === "--out") args.out = process.argv[++i];
  else if (a === "--limit") args.limit = Number(process.argv[++i]);
  else if (a === "--gate") args.gate = true;
  else {
    console.error(`未知参数: ${a}`);
    process.exit(2);
  }
}
if (args.evalRoot === null) {
  console.error("--eval-root 必填（evals/webarena 工作区路径）");
  process.exit(2);
}

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

// ── 数据装载（三守卫 fail-fast：任务字段 / 卡缺映射 / 陈旧 slug） ──────────────
const loadTasks = (evalRoot) => {
  const raw = JSON.parse(
    readFileSync(join(evalRoot, "webarena_repo", "config_files", "test.raw.json"), "utf8"),
  );
  const tasks = raw.filter((t) => (t.sites ?? []).includes("shopping_admin"));
  for (const t of tasks) {
    // intent_template_id 与另两者同为统计硬依赖（card_template/rows 直接键访问），
    // 缺失时变体任务会在 184 次调用跑完后才 KeyError——必须 startup 就拦
    if (!t.intent || !t.start_url || !("intent_template_id" in t)) {
      die(`task ${t.task_id} 缺 intent/start_url/intent_template_id——数据源不对？`);
    }
  }
  return tasks;
};

const loadReplay = (evalRoot, tasksById) => {
  const data = JSON.parse(readFileSync(join(evalRoot, "config", "replay_map.json"), "utf8"));
  const mapping = {};
  for (const [slug, v] of Object.entries(data.mapping)) {
    const tid = v.task_id;
    if (!(tid in tasksById)) die(`replay_map 卡 ${slug} 的 task_id=${tid} 不在任务集内`);
    mapping[slug] = tid;
  }
  return mapping;
};

// ── 装配：catalog（repo 根绝对路径，不依赖 CWD）+ matcher LLM（镜像 agent 接线） ──
const kit = await loadKit();
const skillSource = new kit.FsSkillSource(join(REPO_ROOT, "domain-skills"), (m) =>
  console.log(`[skill] ${m}`),
);
const catalog = await skillSource.taskCatalog(args.hostKey);
if (catalog.length === 0) {
  die(`catalog 空（host_key=${args.hostKey}）——检查 domain-skills 路径`);
}
console.log(`catalog: ${catalog.length} cards (host_key=${args.hostKey})`);

// matcher LLM：镜像 agent.py:160-163 接线——AGENT_TASK_SKILL_MODEL 未设则复用主 llm
kit.applyDotEnv();
const settings = kit.loadHostSettings();
const taskSkillCard = kit.buildTaskSkillCard(settings.llm);
const matcherLlm =
  taskSkillCard !== null
    ? new kit.LLMClient(taskSkillCard)
    : new kit.LLMClient(kit.buildProviderCard(settings.llm));

// ── fail-fast 双向校验（184 调用前拦，防统计期报废 / 门槛永久 FAIL） ────────────
const tasks = loadTasks(args.evalRoot);
const tasksById = Object.fromEntries(tasks.map((t) => [t.task_id, t]));
const replay = loadReplay(args.evalRoot, tasksById);
// catalog 里有卡缺 replay 映射：card_template 取值会在全部调用完成后的统计阶段炸
const catalogSlugs = new Set(catalog.map((c) => c.slug));
const unmapped = [...catalogSlugs].filter((s) => !(s in replay));
if (unmapped.length > 0) {
  die(
    `catalog 卡缺 replay 映射: ${unmapped.sort()}——card_template 会取空，` +
      "先补 config/replay_map.json 再跑",
  );
}
// 反向：replay_map 陈旧 slug（不在当前 catalog）会抬高 replay total（≠44），门槛永久 FAIL
const stale = Object.keys(replay).filter((s) => !catalogSlugs.has(s));
if (stale.length > 0) {
  die(
    `replay_map 有 catalog 外的陈旧 slug: ${stale.sort()}——replay total 会被抬高，` +
      "门槛永久 FAIL，先清理 config/replay_map.json 再跑",
  );
}
const replayIds = new Set(Object.values(replay));
// 卡的模板 = 本尊任务的 intent_template_id（模板等价类，docs/p7/04 §4.5）
const cardTemplate = Object.fromEntries(
  Object.entries(replay).map(([slug, tid]) => [slug, tasksById[tid].intent_template_id]),
);
console.log(
  `tasks: ${tasks.length} (replay ${replayIds.size} / variants ${tasks.length - replayIds.size}); ` +
    `${catalog.length} cards over ${new Set(Object.values(cardTemplate)).size} templates`,
);

// ── 并发限流跑匹配：信号量只在调用期占槽（退避等待不占——故障突发时槽被 sleep
//    占着会让有效并行度塌到零）；callFailed 在 harness 层再试 2 次（共 3 次） ─────
const semaphore = (() => {
  let active = 0;
  const waiters = [];
  return {
    async acquire() {
      if (active < args.concurrency) {
        active += 1;
        return;
      }
      await new Promise((resolve) => waiters.push(resolve));
      active += 1;
    },
    release() {
      active -= 1;
      waiters.shift()?.();
    },
  };
})();

const matchWithRetry = async (taskText) => {
  let m;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await semaphore.acquire();
    try {
      m = await kit.matchTaskSkill(taskText, catalog, matcherLlm);
    } finally {
      semaphore.release();
    }
    if (!m.callFailed) return m;
    console.warn(`call failed (attempt ${attempt}/3): ${m.reason}`);
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000)); // 末次失败不空等
  }
  return m;
};

const tasksToRun = args.limit > 0 ? tasks.slice(0, args.limit) : tasks;
const started = Date.now();
const results = await Promise.all(
  tasksToRun.map((t) =>
    // 离线保真：任务文本组装对齐 runner（loadTasks 已守 start_url 非空，无需 fallback）
    matchWithRetry(`${t.intent}\n\n起始页: ${t.start_url}`),
  ),
);
console.log(`matched ${results.length} tasks in ${((Date.now() - started) / 1000).toFixed(1)}s`);

// ── 归类统计 ────────────────────────────────────────────────────────────────
const rows = tasksToRun.map((t, i) => {
  const m = results[i];
  const tpl = t.intent_template_id;
  const ownSlug = Object.entries(replay).find(([, tid]) => tid === t.task_id)?.[0] ?? null;
  return {
    task_id: t.task_id,
    template_id: tpl,
    is_replay: replayIds.has(t.task_id),
    matched_slug: m.slug,
    correct_template: m.slug !== null && cardTemplate[m.slug] === tpl,
    exact_slug: m.slug !== null && m.slug === ownSlug,
    confidence: m.confidence,
    match_kind: m.slug !== null ? m.matchKind : null,
    task_kind: m.taskKind,
    downgraded: m.downgraded,
    call_failed: m.callFailed,
    reason: m.reason,
    intent: t.intent,
  };
});

// 持续调用失败 = 基础设施故障不是匹配语义——从命中率统计剔除（分母不含），门槛
// 存在即不判 PASS，metrics 单列显式标注（此前以 slug=None 混入 missed/correct，
// 配额耗尽这类持续故障会被误报成全量漏命中，门槛 FAIL 时无法区分归因）
const failedRows = rows.filter((r) => r.call_failed);
const replayRows = rows.filter((r) => r.is_replay && !r.call_failed);
const variantRows = rows.filter((r) => !r.is_replay && !r.call_failed);

const dist = (rs, key) => {
  const out = {};
  for (const r of rs) {
    const k = String(r[key]);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
};

const metrics = {
  replay: {
    total: replayRows.length,
    hit: replayRows.filter((r) => r.matched_slug).length,
    correct: replayRows.filter((r) => r.correct_template).length,
    exact_slug: replayRows.filter((r) => r.exact_slug).length,
    missed: replayRows.filter((r) => !r.matched_slug).map((r) => r.task_id),
  },
  variants: {
    total: variantRows.length,
    hit: variantRows.filter((r) => r.matched_slug).length,
    correct: variantRows.filter((r) => r.correct_template).length,
    cross_template: variantRows
      .filter((r) => r.matched_slug && !r.correct_template)
      .map((r) => r.task_id),
    // 与 replay.missed 同型（task_id 列表）——下游逐例复核脚本依赖同型
    missed: variantRows.filter((r) => !r.matched_slug).map((r) => r.task_id),
  },
  call_failed_persistent: {
    count: failedRows.length,
    task_ids: failedRows.map((r) => r.task_id),
  },
  downgraded: rows.filter((r) => r.downgraded).length,
  // 分级字段分布（实证核对）：本尊命中应 mostly same_task，变体命中应 mostly
  // same_template——倒挂说明模型没理解分级指令。只统计命中行（未命中行
  // match_kind=None，混入会造出无法与「模型对命中行返回 null」区分的 None 桶）
  match_kind_of_hits: {
    replay: dist(
      replayRows.filter((r) => r.matched_slug),
      "match_kind",
    ),
    variants: dist(
      variantRows.filter((r) => r.matched_slug),
      "match_kind",
    ),
  },
  task_kind: dist(rows, "task_kind"),
};

// 按模板聚合（变体侧）：零命中模板 = 有卡模板的变体 correct=0；无卡模板的变体
// 不可能正确命中，不属此列（单列 no_card）
const templatesWithCards = new Set(Object.values(cardTemplate));
const perTemplate = {};
for (const r of variantRows) {
  const d = perTemplate[r.template_id] ?? { variants: 0, hit: 0, correct: 0, example: r.intent };
  d.variants += 1;
  d.hit += r.matched_slug ? 1 : 0;
  d.correct += r.correct_template ? 1 : 0;
  perTemplate[r.template_id] = d;
}
// ⚠ JS 键类型陷阱（Python dict 键是 int 两边天然同型）：perTemplate 经 JSON 键化后
// Object.keys/entries 一律是字符串，templatesWithCards 装的是数字——Set.has 严格等值，
// 不 Number() 归一会把所有模板判成无卡（no_card 全量误报、zero_hit 恒空）
const zeroHitTemplates = Object.entries(perTemplate)
  .filter(([t, d]) => d.correct === 0 && templatesWithCards.has(Number(t)))
  .map(([t]) => Number(t))
  .sort((a, b) => a - b);
const noCardTemplates = Object.keys(perTemplate)
  .map(Number)
  .filter((t) => !templatesWithCards.has(t))
  .sort((a, b) => a - b);

// ── 报告 ────────────────────────────────────────────────────────────────────
const rp = metrics.replay;
const vp = metrics.variants;
// --limit 前缀可能不含变体任务（除零丢整轮结果）
const variantRate = vp.total > 0 ? vp.correct / vp.total : 0.0;
console.log("\n===== 匹配离线回归结果 =====");
console.log(
  `回放集:  正确命中 ${rp.correct}/${rp.total}（exact slug ${rp.exact_slug}；漏命中 ${rp.missed.length}）`,
);
console.log(
  `泛化集:  命中 ${vp.hit}/${vp.total} | 正确模板 ${vp.correct}/${vp.total}` +
    `（${(variantRate * 100).toFixed(1)}%）` +
    ` | 跨模板误命中 ${vp.cross_template.length} | 未命中 ${vp.missed.length}`,
);
console.log(
  `降档: ${metrics.downgraded}；命中分级分布: ${JSON.stringify(metrics.match_kind_of_hits)}`,
);
if (failedRows.length > 0) {
  console.log(
    `⚠ 持续调用失败 ${failedRows.length} 个——基础设施故障已从命中率统计剔除，` +
      `门槛不判 PASS: ${JSON.stringify(metrics.call_failed_persistent.task_ids)}`,
  );
}
console.log(
  `零命中模板（有卡且 correct=0）: ${zeroHitTemplates.length} 个 -> [${zeroHitTemplates}]`,
);
if (noCardTemplates.length > 0) {
  console.log(
    `（另有无卡模板 ${noCardTemplates.length} 个: [${noCardTemplates}]——变体无从正确命中，不计零命中）`,
  );
}

mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(
  args.out,
  JSON.stringify(
    {
      generated_at: `${new Date().toISOString().slice(0, 19)}Z`,
      catalog_size: catalog.length,
      host_key: args.hostKey,
      metrics,
      zero_hit_templates: zeroHitTemplates,
      no_card_templates: noCardTemplates,
      per_template: Object.fromEntries(
        // Python sorted(dict) 是 int 键数值序；字符串 sort 会得 "111"<"2" 的字典序
        Object.keys(perTemplate)
          .sort((a, b) => Number(a) - Number(b))
          .map((k) => [k, perTemplate[k]]),
      ),
      tasks: rows,
    },
    null,
    2,
  ),
  "utf8",
);
console.log(`明细已写 ${args.out}（含全部 reason，误命中/漏命中逐例复核用）`);

if (args.gate) {
  // 持续失败存在即不判 PASS：变体被剔除会缩小分母 artificially 抬高命中率，
  // 数据不完整不能过关
  const ok =
    failedRows.length === 0 &&
    rp.correct === GATE_REPLAY_TOTAL &&
    rp.total === GATE_REPLAY_TOTAL &&
    variantRate >= GATE_VARIANT_RATE;
  console.log(
    `\n门槛判定: ${ok ? "PASS" : "FAIL"}` +
      `（要求 回放 ${GATE_REPLAY_TOTAL}/${GATE_REPLAY_TOTAL} + 泛化 ≥${GATE_VARIANT_RATE * 100}%）`,
  );
  process.exitCode = ok ? 0 : 1;
}
