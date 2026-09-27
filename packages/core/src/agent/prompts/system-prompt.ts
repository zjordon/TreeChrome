// system prompt 组装与 17 段 state message 构建（system_prompt.py 全量）。
// 字节锚定 fixtures/python-anchors/agent.json；模板常量见 prompt-consts.ts。
// buildStateBlocks 产出 TS 规范块（TextBlock/ImageBlock）——wire 转换在适配器层。

import type { BrowserStateSummary } from "../../browser/views.js";
import type { ContentBlock, ImageBlock, TextBlock } from "../../llm/types.js";
import {
  DECISION_ATTRIBUTION_PROMPT,
  DROPDOWN_RULES,
  FILE_UPLOAD_RULES,
  SYSTEM_PROMPT_TEMPLATE,
} from "../prompt-consts.js";
import type { ActionResult } from "../views.js";

function formatTemplate(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{${key}}`).join(value);
  }
  return out;
}

export function buildSystemPrompt(
  actionDescriptions: string,
  task = "",
  enableDecisionAttribution = false,
  maxActions = 5,
): string {
  let prompt = formatTemplate(SYSTEM_PROMPT_TEMPLATE, {
    action_descriptions: actionDescriptions,
    task,
    max_actions: String(maxActions),
  });
  // upload/dropdown 指引仅在对应动作对当前页可用时追加（URL 过滤可能摘除）
  if (actionDescriptions.includes("upload_file")) {
    prompt += FILE_UPLOAD_RULES;
  }
  if (
    actionDescriptions.includes("dropdown_options") ||
    actionDescriptions.includes("select_dropdown")
  ) {
    prompt += DROPDOWN_RULES;
  }
  if (enableDecisionAttribution) {
    prompt += DECISION_ATTRIBUTION_PROMPT;
  }
  return prompt;
}

export interface StateMessageOptions {
  task?: string;
  previousResult?: ActionResult[] | null;
  previousEvaluation?: string | null;
  previousMemory?: string | null;
  previousGoal?: string | null;
  currentTargetId?: string | null;
  nudgeMessage?: string | null;
  planDescription?: string | null;
  planningNudge?: string | null;
  downloadNotice?: string | null;
  pageStats?: Record<string, unknown> | null;
  gridMeta?: Record<string, unknown> | null;
  sensitiveDescription?: string | null;
  skillDescription?: string | null;
  taskSkillDescription?: string | null;
}

/** 用户消息：当前浏览器状态（17 段顺序锚定 Python :171-337） */
export function buildStateMessage(
  browserState: BrowserStateSummary,
  opts: StateMessageOptions = {},
): string {
  const parts: string[] = [];
  if (opts.task) {
    parts.push(`[Task] ${opts.task}`);
  }
  if (opts.taskSkillDescription) {
    parts.push("[Task Skill]");
    parts.push(opts.taskSkillDescription);
    parts.push("");
  }
  if (opts.skillDescription) {
    parts.push("[Domain Skill]");
    parts.push(opts.skillDescription);
    parts.push("");
  }
  if (opts.sensitiveDescription) {
    parts.push(`[Available Secrets] ${opts.sensitiveDescription}`);
  }
  if (opts.previousGoal) {
    parts.push(`[Previous Goal] ${opts.previousGoal}`);
  }
  if (opts.previousEvaluation) {
    parts.push(`[Previous Evaluation] ${opts.previousEvaluation}`);
  }
  if (opts.previousMemory) {
    parts.push(`[Memory] ${opts.previousMemory}`);
  }
  if (opts.previousResult && opts.previousResult.length > 0) {
    parts.push("[Previous Action Results]");
    for (const r of opts.previousResult) {
      parts.push(`  ${r.render()}`);
    }
    parts.push("");
  }
  if (opts.planDescription) {
    parts.push("[Current Plan]");
    parts.push(opts.planDescription);
    parts.push("");
  }
  parts.push(`[Current URL] ${browserState.url}`);
  parts.push(`[Page Title] ${browserState.title}`);
  if (opts.pageStats) {
    const stats =
      `[Page Stats] links=${opts.pageStats.links ?? 0}, ` +
      `interactive=${opts.pageStats.interactive ?? 0}, ` +
      `iframes=${opts.pageStats.iframes ?? 0}`;
    parts.push(
      stats + (opts.pageStats.skeleton ? " SKELETON/LOADING (page may not be fully rendered)" : ""),
    );
  }
  if (opts.gridMeta) {
    const g = opts.gridMeta;
    const ns = g.namespace ?? "grid";
    const loaded = g.rows_loaded;
    parts.push(
      `[Grid] ${String(ns)} | rows ${String(loaded)} of ${String(g.total_records)}` +
        (g.page ? ` (page ${String(g.page)}, ${String(g.page_size)}/page)` : ""),
    );
    const s = g.sorting;
    if (typeof s === "object" && s !== null && (s as Record<string, unknown>).field) {
      const sr = s as Record<string, unknown>;
      let line = `  sorted: ${String(sr.field)} ${String(sr.direction ?? "asc")}`;
      if (g.first_sorted_value !== undefined && g.first_sorted_value !== null) {
        line += ` (first row: ${String(g.first_sorted_value)})`;
      }
      parts.push(line);
    } else {
      parts.push("  sorted: (none — do NOT assume any row order; pass sorting to read_grid)");
    }
    const leftover: string[] = [];
    if (g.active_filters) {
      leftover.push(`filters=${pyReprShallow(g.active_filters)}`);
    }
    if (g.active_search) {
      leftover.push(`search=${pyReprShallow(String(g.active_search))}`);
    }
    if (leftover.length > 0) {
      parts.push(
        "  ⚠️ active " +
          leftover.join(" ") +
          " — leftover from a previous session (server-side bookmark), " +
          "not from your actions; totals above are already filtered",
      );
    }
    parts.push("");
  }
  if (browserState.tabs.length > 1) {
    parts.push("[Open Tabs]");
    for (const tab of browserState.tabs) {
      const marker = tab.targetId === opts.currentTargetId ? " (active)" : "";
      parts.push(`  [${tab.targetId.slice(-4)}] ${tab.title} - ${tab.url}${marker}`);
    }
    parts.push("");
  }
  if (browserState.recentEvents.length > 0) {
    const recent = [...browserState.recentEvents].slice(-5).reverse();
    parts.push("[Recent Events]");
    for (const ev of recent) {
      parts.push(`  ${ev.type}: ${ev.message}`);
    }
    parts.push("");
  }
  if (browserState.domState?.elementTreeText) {
    parts.push("[Page DOM]");
    parts.push(browserState.domState.elementTreeText);
  } else {
    parts.push("[Page DOM] (empty or not available)");
  }
  if (browserState.domState && browserState.domState.fileInputsMeta.length > 1) {
    parts.push("[File Inputs]");
    parts.push(
      "Multiple file inputs on this page. Prefer one that is visible and inside an " +
        "upload container (upload-ancestor=yes); hidden inputs are often decoys with no " +
        "handler (upload reports success but the page does not change).",
    );
    for (const fi of browserState.domState.fileInputsMeta) {
      const vis = fi.visible ? "visible" : "hidden";
      const up = fi.upload_ancestor ? "yes" : "no";
      const acc = fi.accept ? ` accept=${fi.accept}` : "";
      const cls = fi.class_name ? ` class=${fi.class_name}` : "";
      parts.push(`  [${fi.backend_node_id}] ${vis}, upload-ancestor=${up}${acc}${cls}`);
    }
    parts.push("");
  }
  if (opts.downloadNotice) {
    parts.push("");
    parts.push(`[Downloads] ${opts.downloadNotice}`);
  }
  if (opts.nudgeMessage) {
    parts.push("");
    parts.push(`[System Notice] ${opts.nudgeMessage}`);
  }
  if (opts.planningNudge) {
    parts.push("");
    parts.push(`[Planning Suggestion] ${opts.planningNudge}`);
  }
  return parts.join("\n");
}

/** Python f-string 的 str()/!r 渲染：str 直通；dict/str 用 repr */
function pyReprShallow(v: unknown): string {
  if (typeof v === "string") {
    return `'${v}'`;
  }
  return String(JSON.stringify(v)); // active_filters dict 形态（JSON 近似 repr，消费方为 LLM 提示）
}

/** Anthropic blocks 版（文本复用 buildStateMessage + 规范化 image block） */
export function buildStateBlocks(
  browserState: BrowserStateSummary,
  screenshotB64: string | null,
  opts: StateMessageOptions = {},
): ContentBlock[] {
  const text: TextBlock = { kind: "text", text: buildStateMessage(browserState, opts) };
  if (screenshotB64) {
    const image: ImageBlock = { kind: "image", mimeType: "image/png", base64: screenshotB64 };
    return [text, image];
  }
  return [text];
}
