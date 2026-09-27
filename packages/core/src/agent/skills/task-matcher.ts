// 任务级 skill 匹配器（task_matcher.py 270 全量）：模板语义匹配（ENTITY=参数永不
// 拒绝 / TEMPLATE=三族全同）经 structuredCall 工具强制；保守降级（low/缺失降档、
// 任何失败=不注入）。prompts/注入头字节锚定 prompt-consts.ts + agent.json。

import {
  MATCH_PROMPT_TEMPLATE,
  MATCH_SYSTEM_PROMPT,
  TASK_SKILL_HEADER_SAME_TASK,
  TASK_SKILL_HEADER_SAME_TEMPLATE,
  TASK_SKILL_READ_APPENDIX,
} from "../prompt-consts.js";
import { catalogLine, type TaskCardMeta } from "./types.js";

/** 匹配调用单次超时（对齐 extract 的 call_timeout 模式；超时=降级 null） */
export const MATCH_CALL_TIMEOUT_S = 15.0;

const NULL_SLUG_LITERALS = new Set(["", "null", "none"]);

/** 结构化调用面（LLMClient.structuredCall 结构满足） */
export interface MatcherLLM {
  structuredCall(
    systemPrompt: string,
    userPrompt: string,
    outputSchema: Record<string, unknown>,
    opts?: { maxTokens?: number; callTimeoutMs?: number | null },
  ): Promise<Record<string, unknown> | null>;
}

export interface TaskSkillMatch {
  /** null 即未命中 */
  slug: string | null;
  confidence: string | null;
  reason: string;
  /** low-confidence 降档标记 */
  downgraded: boolean;
  matchKind: "same_task" | "same_template";
  taskKind: "read" | "operate" | null;
  /** API 异常/超时重试后仍失败（基础设施故障，非匹配语义） */
  callFailed: boolean;
}

function formatTemplate(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{${key}}`).join(value);
  }
  return out;
}

/** 组装注入 [Task Skill] 内容：分级头（本尊/同模板换实体）+ 读型加严段 + 卡体 */
export function buildTaskSkillText(
  slug: string,
  cardText: string,
  opts: { matchKind?: "same_task" | "same_template"; taskKind?: "read" | "operate" | null } = {},
): string {
  const { matchKind = "same_task", taskKind = null } = opts;
  let header =
    matchKind === "same_template"
      ? formatTemplate(TASK_SKILL_HEADER_SAME_TEMPLATE, { slug })
      : formatTemplate(TASK_SKILL_HEADER_SAME_TASK, { slug });
  if (taskKind === "read") {
    header = `${header}\n${TASK_SKILL_READ_APPENDIX}`;
  }
  if (!cardText) return header;
  return `${header}\n\n${cardText}`;
}

export const MATCH_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    match: {
      type: ["string", "null"],
      description: "Matched card slug, or null when no card shares the task's operation template.",
    },
    match_kind: {
      type: ["string", "null"],
      enum: ["same_task", "same_template", null],
      description:
        "same_task = same template AND same entity values; " +
        "same_template = same template with different entity values; null when no match.",
    },
    task_kind: {
      type: ["string", "null"],
      enum: ["read", "operate", null],
      description:
        "Whether the user task reads a fact from the site (read) or changes site state (operate).",
    },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
      description: "How certain the match (or non-match) is.",
    },
    reason: {
      type: "string",
      description: "One-sentence justification.",
    },
  },
  required: ["match", "confidence", "reason"],
};

/** 单次保守匹配调用。任何失败 → slug=null（未命中的代价只是回落探索） */
export async function matchTaskSkill(
  taskText: string,
  catalog: TaskCardMeta[],
  llm: MatcherLLM,
  opts: { callTimeoutS?: number } = {},
): Promise<TaskSkillMatch> {
  const callTimeoutS = opts.callTimeoutS ?? MATCH_CALL_TIMEOUT_S;
  const knownSlugs = new Set(catalog.map((c) => c.slug));
  const prompt = formatTemplate(MATCH_PROMPT_TEMPLATE, {
    task: taskText.trim(),
    catalog: catalog.map((c) => catalogLine(c)).join("\n"),
  });
  let result: Record<string, unknown> | null = null;
  for (const attempt of [1, 2]) {
    try {
      result = await llm.structuredCall(MATCH_SYSTEM_PROMPT, prompt, MATCH_OUTPUT_SCHEMA, {
        callTimeoutMs: callTimeoutS * 1000,
      });
      break;
    } catch (e) {
      if (attempt === 2) {
        return {
          slug: null,
          confidence: null,
          reason: `call failed: ${e instanceof Error ? e.message : String(e)}`,
          downgraded: false,
          matchKind: "same_task",
          taskKind: null,
          callFailed: true,
        };
      }
    }
  }
  if (result === null || typeof result !== "object") {
    return {
      slug: null,
      confidence: null,
      reason: "unparseable output",
      downgraded: false,
      matchKind: "same_task",
      taskKind: null,
      callFailed: false,
    };
  }
  const rawSlug = result.match;
  const slug = rawSlug ? String(rawSlug).trim() : "";
  const confidence =
    String(result.confidence ?? "")
      .trim()
      .toLowerCase() || null;
  const reason = String(result.reason ?? "").trim();
  // 分级字段归一化：白名单 + 保守缺省（乱值回 same_task；task_kind 乱值 → null）
  const rawMatchKind = String(result.match_kind ?? "")
    .trim()
    .toLowerCase();
  const matchKind: "same_task" | "same_template" =
    rawMatchKind === "same_template" ? "same_template" : "same_task";
  const rawTaskKind = String(result.task_kind ?? "")
    .trim()
    .toLowerCase();
  const taskKind: "read" | "operate" | null =
    rawTaskKind === "read" || rawTaskKind === "operate" ? rawTaskKind : null;
  if (NULL_SLUG_LITERALS.has(slug.toLowerCase())) {
    return {
      slug: null,
      confidence,
      reason,
      downgraded: false,
      matchKind,
      taskKind,
      callFailed: false,
    };
  }
  if (!knownSlugs.has(slug)) {
    return {
      slug: null,
      confidence,
      reason: `unknown slug: ${slug}`,
      downgraded: false,
      matchKind,
      taskKind,
      callFailed: false,
    };
  }
  if (confidence !== "high" && confidence !== "medium") {
    return {
      slug: null,
      confidence,
      reason,
      downgraded: true,
      matchKind,
      taskKind,
      callFailed: false,
    };
  }
  return {
    slug,
    confidence,
    reason,
    downgraded: false,
    matchKind,
    taskKind,
    callFailed: false,
  };
}
