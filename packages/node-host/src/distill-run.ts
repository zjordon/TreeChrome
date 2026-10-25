// runAgent 蒸馏钩子（issue #5 S2a，SCRATCHPAD D16）：run 成功门控（D1 严格读法：
// done(success) 且 Judge verdict 通过，judgement 缺失 = 不蒸馏）→ core distillTaskCard
// 编排 → 目录四文件落盘。同步 await（runAgent 返回前完成——Node 无 SW 生命周期约束，
// 阶段 0 二跑对拍依赖产物就位）。目录形态无 provenance 面：目标目录内既有卡皆可增量
// 更新（D14 的 built-in 跳过是扩展 IDB 概念，此处不适用）；审阅语义 = 操作者看文件/
// 进 git（TreeForge 离线管线同款）。失败一律 fail-soft 记日志——蒸馏是可选增强，
// 绝不影响 run 结果。

import { promises as fsp } from "node:fs";
import { join } from "node:path";
import {
  type AgentHistoryList,
  DISTILL_CONVERGE_THRESHOLD as DISTILL_CONVERGE_THRESHOLD_DEFAULT,
  type DistillLLM,
  distillTaskCard,
  dominantHostOf,
  gateFailureReason,
  type SensitiveDataSpec,
  type SkillCardDraft,
} from "@tw/core";
import { FsSkillSource, type FsTaskCardMeta } from "./skill-source.js";

// 门控/host 判定已下放 core（agent/skills/distill-gate.ts，issue #5 S4——扩展
// worker 同源共用）；此处 re-export 维持本模块既有导出面
export { dominantHostOf, gateFailureReason, passesDistillGate } from "@tw/core";

export interface DistillRunOptions {
  /** 蒸馏产物写入的技能根目录（domain-skills 形态：<root>/<host>/tasks/<slug>/…） */
  skillsDir: string;
  /** 来源 runId（缺省 run_<16 进制时间戳>——与扩展 runManager 同款形态） */
  runId?: string;
  /** 收敛阈值（D17：连续 N 次成功且无新观察 → 后续跳过蒸馏；缺省 core 的 2） */
  convergeThreshold?: number;
  /** 单次蒸馏 LLM 调用超时毫秒（issue #10 B2：缺省 180s 对齐扩展 worker——
   *  thinking 模型生成整卡 60s 实测不够，2026-10-24 抖音真机超时实录） */
  callTimeoutMs?: number;
}

export interface DistillAfterRunOptions {
  task: string;
  distill: DistillRunOptions;
  llm: DistillLLM;
  history: AgentHistoryList;
  sensitiveData?: Record<string, SensitiveDataSpec> | null;
  now?: () => Date;
  log?: (message: string) => void;
}

/** runAgent 收尾蒸馏（fail-soft）。既有 catalog 经 FsSkillSource 现读（增量判定与
 *  撞名兜底在 core 编排内）；产物经 writeTaskCard 落盘 */
export async function distillAfterRun(options: DistillAfterRunOptions): Promise<void> {
  const log = options.log ?? (() => {});
  // issue #10 D4：归因单源（core gateFailureReason）——三态区分，不再混淆
  // judgement=null 与 verdict=false
  const gateReason = gateFailureReason(options.history);
  if (gateReason !== null) {
    log(`distill: 门控未过——${gateReason}`);
    return;
  }
  const host = dominantHostOf(options.history);
  if (host === null) {
    log("distill: 轨迹无 http URL，无法判定 host——跳过蒸馏");
    return;
  }
  const runId = options.distill.runId ?? `run_${Date.now().toString(16)}`;
  const source = new FsSkillSource(options.distill.skillsDir, log);
  const catalog = (await source.taskCatalog(host)) as FsTaskCardMeta[];
  const cardText = async (slug: string): Promise<string | null> => {
    const meta = catalog.find((c) => c.slug === slug);
    return meta === undefined ? null : source.taskCardText(meta);
  };
  // D17 收敛状态注入：streak 从卡 meta 直读（distillTaskCard 在蒸馏调用前判停）
  const cardDistillState = async (slug: string): Promise<{ streak: number } | null> => {
    const meta = await readTaskMeta(join(options.distill.skillsDir, host, "tasks", slug));
    return meta === null
      ? null
      : { streak: typeof meta.distill_streak === "number" ? meta.distill_streak : 0 };
  };
  let outcome: Awaited<ReturnType<typeof distillTaskCard>>;
  try {
    outcome = await distillTaskCard({
      task: options.task,
      host,
      runId,
      history: options.history,
      catalog,
      cardText,
      cardDistillState,
      ...(options.distill.convergeThreshold !== undefined
        ? { convergeThreshold: options.distill.convergeThreshold }
        : {}),
      // issue #10 B2：缺省 180s 对齐扩展 worker（长轨迹 + thinking 模型整卡
      // 生成 60s 不够——2026-10-24 抖音真机超时实录）
      callTimeoutMs: options.distill.callTimeoutMs ?? 180_000,
      llm: options.llm,
      sensitiveData: options.sensitiveData ?? null,
      ...(options.now !== undefined ? { now: options.now } : {}),
      log,
    });
  } catch (e) {
    log(`distill: 编排异常——${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (outcome.kind === "skip") {
    log(`distill: ${outcome.reason}——跳过`);
    return;
  }
  if (outcome.kind === "error") {
    log(`distill: 蒸馏失败（不影响 run 结果）——${outcome.error}`);
    return;
  }
  if (outcome.kind === "unchanged") {
    // D17：无新观察——内容文件与 distilled_at 都不动，只累计 streak（meta 单文件重写）
    try {
      const streak = await bumpDistillStreak(options.distill.skillsDir, host, outcome.slug);
      const threshold = options.distill.convergeThreshold ?? DISTILL_CONVERGE_THRESHOLD_DEFAULT;
      log(
        `distill: 无新观察——卡 ${outcome.slug} 内容不动，连续无新观察 ${streak} 次` +
          `${streak >= threshold ? "（已收敛：后续同任务成功 run 将跳过蒸馏）" : ""}`,
      );
    } catch (e) {
      log(`distill: streak 落盘失败——${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }
  try {
    const dir = await writeTaskCard(options.distill.skillsDir, host, outcome.card, {
      distillStreak: 0,
    });
    log(`distill: 已写入${outcome.card.mode === "update" ? "（增量更新，计数清零）" : ""} ${dir}`);
  } catch (e) {
    log(`distill: 落盘失败——${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 目录四文件落盘（_task.json snake_case 键与既有卡一致——parseCard 对齐面）。
 *  目录已有 _task.json 时合并 source_traces（D8 并集，旧在前）；写入即真蒸馏，
 *  distillStreak 归 0（D17——unchanged 路径不经此函数）。增量蒸馏的「采纳即写」
 *  在 Node 宿主由操作者经 git diff 承担审阅 */
export async function writeTaskCard(
  rootDir: string,
  host: string,
  draft: SkillCardDraft,
  opts: { distillStreak?: number } = {},
): Promise<string> {
  const dir = join(rootDir, host, "tasks", draft.slug);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(join(dir, "_sop.md"), `${draft.sop}\n`, "utf8");
  await fsp.writeFile(join(dir, "selectors.md"), `${draft.selectors}\n`, "utf8");
  await fsp.writeFile(join(dir, "quirks.md"), `${draft.quirks}\n`, "utf8");
  const metaPath = join(dir, "_task.json");
  let sourceTraces = [...draft.sourceTraces];
  try {
    const prev = JSON.parse(await fsp.readFile(metaPath, "utf8")) as {
      source_traces?: unknown;
    };
    if (Array.isArray(prev.source_traces)) {
      sourceTraces = [...new Set([...prev.source_traces.map(String), ...sourceTraces])];
    }
  } catch {
    // 无既有 _task.json（新卡）或坏 JSON（覆盖写）
  }
  const meta = {
    slug: draft.slug,
    task_description: draft.description,
    task_keywords: draft.keywords,
    source_traces: sourceTraces,
    distilled_at: draft.distilledAt,
    ...(opts.distillStreak !== undefined ? { distill_streak: opts.distillStreak } : {}),
  };
  await fsp.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return dir;
}

/** 读卡 meta JSON（坏/缺 → null）——cardDistillState 注入与 streak 累计共用 */
async function readTaskMeta(cardDir: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fsp.readFile(join(cardDir, "_task.json"), "utf8");
    const data: unknown = JSON.parse(raw);
    return data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** D17 无新观察：只重写 _task.json 的 distill_streak（内容文件与 distilled_at 不动
 *  ——没发生真蒸馏），保留既有全部键；返回累计后的 streak */
export async function bumpDistillStreak(
  rootDir: string,
  host: string,
  slug: string,
): Promise<number> {
  const metaPath = join(rootDir, host, "tasks", slug, "_task.json");
  const meta = (await readTaskMeta(join(rootDir, host, "tasks", slug))) ?? {};
  const streak = (typeof meta.distill_streak === "number" ? meta.distill_streak : 0) + 1;
  meta.distill_streak = streak;
  await fsp.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return streak;
}
