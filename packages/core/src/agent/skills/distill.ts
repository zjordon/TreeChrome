// 任务级技能蒸馏器（issue #5 S1，架构 §6.3 自进化闭环中段）：成功轨迹 →
// SkillCardDraft。编排 = matcher 预匹配（同 host catalog；命中且可更新 → 增量模式
// 旧卡进 prompt、slug 复用；未命中 → 新卡模式）+ structuredCall 蒸馏（2 次尝试 +
// 60s 超时 + fail-soft）+ 产物校验（schema/非空/PII 正则门）。宿主只注入 LLM 与
// 既有卡读取面——扩展 worker 与 node-host 钩子同入口（SCRATCHPAD D6/D14/D16）；
// D14（built-in 命中跳过）由宿主经 isUpdatable 判定注入，本层不感知 provenance。

import type { SensitiveDataSpec } from "../settings.js";
import { type AgentHistoryList, redactSensitiveString } from "../views.js";
import { buildTaskDistillPrompt, DISTILL_SYSTEM_PROMPT } from "./distill-prompt.js";
import { type MatcherLLM, matchTaskSkill } from "./task-matcher.js";
import { serializeTraceForPrompt } from "./trace-serialize.js";
import type { TaskCardMeta } from "./types.js";

/** 蒸馏单次调用超时（judge 同级 60s） */
export const DISTILL_CALL_TIMEOUT_MS = 60_000;
/** 调用+解析重试次数（TreeForge _DISTILL_ATTEMPTS：HTTP 成功但 JSON 畸形发生在
 *  解析层，重取一次新样本大概率过） */
export const DISTILL_ATTEMPTS = 2;
/** 蒸馏输入轨迹的字符预算（尾部截断对齐 "Step " 边界——judge 同款手法；缺省比
 *  judge 的 40k 宽：SOP 需要完整流程叙事，100 步序列化通常 < 40k） */
export const DISTILL_TRACE_MAX_CHARS = 60_000;
/** 蒸馏输出 maxTokens（sop ≤ 8000 字符中文 + selectors/quirks——防默认卡值截断） */
export const DISTILL_MAX_TOKENS = 8192;
/** 收敛阈值缺省（D17）：连续 N 次成功且无新观察 → 后续 matcher 命中该卡直接跳过蒸馏 */
export const DISTILL_CONVERGE_THRESHOLD = 2;

/** 结构化调用面（LLMClient.structuredCall 结构满足——与 MatcherLLM 同款形态） */
export interface DistillLLM {
  structuredCall(
    systemPrompt: string,
    userPrompt: string,
    outputSchema: Record<string, unknown>,
    opts?: { maxTokens?: number; callTimeoutMs?: number | null },
  ): Promise<Record<string, unknown> | null>;
}

/** 蒸馏产物草稿（宿主落库为 status='draft'；采纳才进入注入路径） */
export interface SkillCardDraft {
  host: string;
  slug: string;
  description: string;
  keywords: string[];
  sop: string;
  selectors: string;
  quirks: string;
  /** new = 新卡；update = 增量更新既有卡（slug 复用，采纳时整卡替换） */
  mode: "new" | "update";
  /** 来源轨迹 runId（采纳时并入既有卡 sourceTraces） */
  sourceTraces: string[];
  distilledAt: string;
}

export type DistillOutcome =
  | { kind: "draft"; card: SkillCardDraft }
  /** 命中既有卡且蒸馏判定无新观察（D17 收敛循环）：卡内容不动，宿主只累计 streak */
  | { kind: "unchanged"; slug: string }
  /** 不可蒸馏也不可重试（命中受保护卡 / 已收敛卡）——宿主应 ack 队列条目 */
  | { kind: "skip"; reason: string }
  /** 可重试失败（LLM/解析/校验）——宿主按 attempts 计数重试 */
  | { kind: "error"; error: string };

export const DISTILL_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    task_slug: {
      type: "string",
      description:
        "English kebab-case slug (at most 5 words) identifying THIS task, e.g. 'upload-video'.",
    },
    task_description: {
      type: "string",
      description: "One concise line (site's language) describing what this task does.",
    },
    task_keywords: {
      type: "array",
      items: { type: "string" },
      description: "At most 5 retrieval keywords in the site's language.",
    },
    sop_md: { type: "string", description: "Step-by-step procedural narrative (markdown)." },
    selectors_md: {
      type: "string",
      description: "Element fingerprint table (markdown; may be a short note).",
    },
    quirks_md: { type: "string", description: "DOM-invisible pitfalls only (markdown)." },
    has_new_observations: {
      type: "boolean",
      description:
        "Incremental mode only: false when the new trace reveals NOTHING the existing card " +
        "doesn't already cover — then return the previous card content as-is. Omit or true " +
        "when there is something new to add/fix/remove.",
    },
  },
  required: ["task_slug", "task_description", "sop_md"],
};

export interface DistillTaskInput {
  task: string;
  host: string;
  /** 来源 run 的 id（进 sourceTraces） */
  runId: string;
  history: AgentHistoryList;
  /** 该 host 的既有任务卡目录（matcher 预匹配 + 新卡撞名判定）；空 = 必然新卡 */
  catalog: readonly TaskCardMeta[];
  /** 命中卡的全文（增量 addendum 用）；miss/不可得返回 null */
  cardText?: (slug: string) => Promise<string | null>;
  /** 命中卡是否可增量更新（D14：扩展侧对 built-in 卡传 () => false → skip）。
   *  缺省全部可更新（node-host 目录形态无 provenance 面） */
  isUpdatable?: (slug: string) => boolean;
  /** 命中卡的收敛状态（D17）：streak ≥ convergeThreshold → 跳过整个蒸馏调用 */
  cardDistillState?: (slug: string) => Promise<{ streak: number } | null>;
  /** 收敛阈值（缺省 DISTILL_CONVERGE_THRESHOLD：连续 N 次成功且无新观察即收敛） */
  convergeThreshold?: number;
  llm: DistillLLM;
  /** 敏感数据（与 Agent 同一配置形态）——序列化后整串占位脱敏 */
  sensitiveData?: Record<string, SensitiveDataSpec> | null;
  traceMaxChars?: number;
  maxTokens?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

/** 敏感配置 → key→real 映射（URL 过滤条目保守一律脱敏——蒸馏输入宁可过度占位） */
function keyToReal(
  sensitiveData: Record<string, SensitiveDataSpec> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (sensitiveData === null || sensitiveData === undefined) return out;
  for (const [key, spec] of Object.entries(sensitiveData)) {
    const real = typeof spec === "string" ? spec : (spec.value ?? "");
    if (real !== "") out[key] = real;
  }
  return out;
}

/** 尾部截断对齐 "Step " 边界（judge buildJudgePrompt 同款手法） */
function clipTraceTail(trace: string, maxChars: number): string {
  if (trace.length <= maxChars) return trace;
  let clipped = trace.slice(-maxChars);
  const boundary = clipped.indexOf("\nStep ");
  if (boundary !== -1) {
    clipped = clipped.slice(boundary + 1);
  }
  return `${clipped}\n[trace truncated, kept most recent steps]`;
}

// —— PII 正则门（issue 治理第 5 条：蒸馏产物再过一遍门；命中即 error 重试——
//    产物将注入未来 prompt，敏感真值固化进卡不可接受）——

const PII_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { label: "mobile", re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { label: "card-number", re: /\b\d[\d ]{12,24}\b|\b\d{13,19}\b/ },
];

/** PII 扫描：命中返回类别标签（样本不外泄——error 文案只带 label） */
export function scanPII(text: string): string | null {
  for (const { label, re } of PII_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

/** slug 归一化：小写 kebab-case、非法字符折叠、≤5 词 */
export function normalizeTaskSlug(raw: string): string {
  const kebab = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return kebab.split("-").filter(Boolean).slice(0, 5).join("-");
}

/** keywords 归一化：字符串过滤 + 去空 + 去重 + 截 5（TreeForge「至多 5 个」） */
function normalizeKeywords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const kw = item.trim();
    if (kw === "" || seen.has(kw)) continue;
    seen.add(kw);
    out.push(kw);
    if (out.length >= 5) break;
  }
  return out;
}

/** LLM JSON 双重转义修复（阶段 0 实跑实证，2026-10-24）：长中文 markdown 塞进
 *  JSON 字符串时模型偶发写 `\\n`（wire 解析一次后成字面量 \n 两字符）——产物 md
 *  会变成带 \n 字面量的单行长文。判定口径：**内部**无真换行（trim 后）才反转义——
 *  正常转义的 md 必有多行，混入字面量 \n 的单行 md 必是双转义；卡内容讲正则转义
 *  时用的是 `\\d` 等形态不含成串字面 \n。TreeForge 同族病症是未转义引号（解析层
 *  重试兜住）；双转义可被正常解析漏过重试，必须在产物校验层确定性修复。 */
function unescapeLiteralNewlines(s: string): string {
  if (!s.includes("\\n")) return s;
  if (s.trim().includes("\n")) return s;
  return s.replaceAll("\\n", "\n");
}

interface ValidatedFields {
  slug: string;
  description: string;
  keywords: string[];
  sop: string;
  selectors: string;
  quirks: string;
}

/** 产物校验：字段类型/非空 + slug 归一化（update 模式强制复用命中 slug、new 模式
 *  撞名加后缀）+ PII 门。失败返回 error 文案（消耗一次重试） */
function validateOutput(
  result: Record<string, unknown>,
  opts: { mode: "new" | "update"; matchedSlug: string; takenSlugs: ReadonlySet<string> },
): { ok: true; fields: ValidatedFields } | { ok: false; error: string } {
  const sop = typeof result.sop_md === "string" ? result.sop_md.trim() : "";
  if (sop === "") return { ok: false, error: "empty sop_md" };
  const description =
    typeof result.task_description === "string" ? result.task_description.trim() : "";
  if (description === "") return { ok: false, error: "empty task_description" };
  let slug: string;
  if (opts.mode === "update") {
    // 增量模式 slug 强制复用（D6：由 matcher 决定归属，不信模型自报）
    slug = opts.matchedSlug;
  } else {
    const rawSlug = typeof result.task_slug === "string" ? result.task_slug : "";
    slug = normalizeTaskSlug(rawSlug);
    if (slug === "") return { ok: false, error: "empty/unnormalizable task_slug" };
    if (opts.takenSlugs.has(slug)) {
      let n = 2;
      while (opts.takenSlugs.has(`${slug}-${n}`)) n += 1;
      slug = `${slug}-${n}`;
    }
  }
  const fields: ValidatedFields = {
    slug,
    description: unescapeLiteralNewlines(description),
    keywords: normalizeKeywords(result.task_keywords),
    sop: unescapeLiteralNewlines(sop),
    selectors: unescapeLiteralNewlines(
      typeof result.selectors_md === "string" ? result.selectors_md.trim() : "",
    ),
    quirks: unescapeLiteralNewlines(
      typeof result.quirks_md === "string" ? result.quirks_md.trim() : "",
    ),
  };
  const pii = scanPII([fields.description, fields.sop, fields.selectors, fields.quirks].join("\n"));
  if (pii !== null) {
    return { ok: false, error: `PII gate hit (${pii}) — 敏感值不得固化进卡` };
  }
  return { ok: true, fields };
}

/** 任务级蒸馏编排入口（双宿主共用）。任何失败不抛——以 outcome 分流 */
export async function distillTaskCard(input: DistillTaskInput): Promise<DistillOutcome> {
  const log = input.log ?? (() => {});
  const traceRaw = serializeTraceForPrompt(input.history);
  if (traceRaw === "") return { kind: "error", error: "empty history" };
  const secrets = keyToReal(input.sensitiveData);
  const hasSecrets = Object.keys(secrets).length > 0;
  const trace = clipTraceTail(
    hasSecrets ? redactSensitiveString(traceRaw, secrets) : traceRaw,
    input.traceMaxChars ?? DISTILL_TRACE_MAX_CHARS,
  );
  const task = hasSecrets ? redactSensitiveString(input.task, secrets) : input.task;

  // —— matcher 预匹配（D6）：命中可更新卡 → 增量；命中受保护卡 → skip（D14）——
  let update: { slug: string; cardText: string | null } | null = null;
  let matchedSlug = "";
  if (input.catalog.length > 0) {
    const match = await matchTaskSkill(task, [...input.catalog], input.llm as MatcherLLM);
    if (match.callFailed) {
      // matcher 基建失败≠未命中——照新卡走会造出既有卡的近重复，按可重试失败处理
      return { kind: "error", error: `matcher call failed: ${match.reason}` };
    }
    if (match.slug !== null) {
      if (input.isUpdatable !== undefined && !input.isUpdatable(match.slug)) {
        log(`distill: matched card ${match.slug} is not updatable — skip (D14)`);
        return { kind: "skip", reason: `matched protected card: ${match.slug}` };
      }
      // D17 收敛跳过：streak 达阈值 → 连蒸馏调用都不发（判停必须先于判定器——
      // 判定器本身是一次蒸馏调用，收敛的意义就是把它也省掉）
      const threshold = input.convergeThreshold ?? DISTILL_CONVERGE_THRESHOLD;
      if (input.cardDistillState !== undefined) {
        const state = await input.cardDistillState(match.slug);
        if (state !== null && state.streak >= threshold) {
          log(
            `distill: card ${match.slug} converged (streak ${state.streak} ≥ ${threshold}) — skip`,
          );
          return {
            kind: "skip",
            reason: `card converged: ${match.slug} (streak ${state.streak} ≥ ${threshold})`,
          };
        }
      }
      matchedSlug = match.slug;
      const cardText = input.cardText !== undefined ? await input.cardText(match.slug) : null;
      update = { slug: match.slug, cardText };
    }
  }
  const mode: "new" | "update" = update !== null ? "update" : "new";

  const prompt = buildTaskDistillPrompt({
    task,
    host: input.host,
    stepCount: input.history.history.length,
    trace,
    catalog: input.catalog,
    update,
  });

  // —— 蒸馏调用（2 次尝试：API 抛错 / null 不可解析 / 校验失败都消耗一次）——
  const takenSlugs = new Set(input.catalog.map((c) => c.slug));
  let lastError = "unknown";
  for (let attempt = 1; attempt <= DISTILL_ATTEMPTS; attempt++) {
    let result: Record<string, unknown> | null = null;
    try {
      result = await input.llm.structuredCall(
        DISTILL_SYSTEM_PROMPT,
        prompt,
        DISTILL_OUTPUT_SCHEMA,
        {
          maxTokens: input.maxTokens ?? DISTILL_MAX_TOKENS,
          callTimeoutMs: DISTILL_CALL_TIMEOUT_MS,
        },
      );
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      log(`distill: attempt ${attempt} threw: ${lastError}`);
      continue;
    }
    if (result === null) {
      lastError = "unparseable output";
      continue;
    }
    const validated = validateOutput(result, { mode, matchedSlug, takenSlugs });
    if (!validated.ok) {
      lastError = validated.error;
      log(`distill: attempt ${attempt} rejected: ${lastError}`);
      continue;
    }
    // D17 收敛循环：增量模式无新观察 → unchanged（卡内容不动，宿主只累计 streak）。
    // 漏报该字段按 true 处理——宁可多更新一次，不误判收敛
    if (mode === "update" && result.has_new_observations === false) {
      return { kind: "unchanged", slug: matchedSlug };
    }
    return {
      kind: "draft",
      card: {
        host: input.host,
        slug: validated.fields.slug,
        description: validated.fields.description,
        keywords: validated.fields.keywords,
        sop: validated.fields.sop,
        selectors: validated.fields.selectors,
        quirks: validated.fields.quirks,
        mode,
        sourceTraces: [input.runId],
        distilledAt: (input.now ?? (() => new Date()))().toISOString(),
      },
    };
  }
  return { kind: "error", error: lastError };
}
