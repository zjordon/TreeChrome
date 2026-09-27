// Stage 1 Sense：_prepare_context（step.py:320-486）——状态采集/循环检测/nudge 汇编/
// skill·sensitive·grid 装配/state 消息替换式/history 滑窗/预算警告/done-only 降级。
// AGENT_DEBUG_DUMP_DIR 调试件与 _save_conversation 出界（偏离 7——宿主/审计域）。

import type { BrowserStateSummary } from "../../browser/views.js";
import { skillActiveEvent } from "../../events/events.js";
import { modelSupportsVision } from "../../llm/config.js";
import type { ContentBlock } from "../../llm/types.js";
import { fnmatchLike } from "../../tools/registry.js";
import {
  buildStateBlocks,
  buildStateMessage,
  buildSystemPrompt,
} from "../prompts/system-prompt.js";
import { extractHostWithPort } from "../url-utils.js";
import type { StepCtx } from "./context.js";
import { addContextMessage } from "./pipeline.js";

/** 视觉门：配置门 + 模型门（逐步评估——fallback 切换后自动跟随） */
export function visionGateOpen(ctx: StepCtx): boolean {
  return ctx.settings.useVision && modelSupportsVision(ctx.llm.model);
}

export async function prepareContext(
  ctx: StepCtx,
): Promise<[BrowserStateSummary, ContentBlock[] | string]> {
  // 0. 清上一步注入提示（budget/last/failure/loop）
  clearContextMessages(ctx);

  // 1. 状态采集（视觉门开时含截图）
  const browserState = await ctx.browser.getState({ includeScreenshot: visionGateOpen(ctx) });

  // 2b. 按当前页 URL 重建动作面（pagePatterns 可见性）
  updateActionModelsForPage(ctx, browserState.url);

  // 3. 循环检测指纹（url + element_tree_text + selectorMap 数量）
  const dom = browserState.domState;
  ctx.loopDetector.recordPageState(
    browserState.url,
    dom ? dom.elementTreeText : "",
    dom ? dom.selectorMap.size : 0,
  );

  // 3b. 计划描述与 replan/探索 nudge（enablePlanning 默认关）
  let planDescription: string | null = null;
  let planningNudge: string | null = null;
  if (ctx.settings.enablePlanning && ctx.planManager !== null) {
    planDescription = ctx.planManager.renderPlanDescription(ctx.state.plan);
    planningNudge =
      ctx.planManager.buildReplanNudge(
        ctx.state.consecutiveFailures,
        ctx.settings.replanFailureThreshold,
        ctx.state.plan,
      ) ??
      ctx.planManager.buildExplorationNudge(
        ctx.state.nSteps,
        ctx.settings.explorationThreshold,
        ctx.state.plan,
      );
  }

  // 4. nudge 汇编（loop / failureStreak peek / zeroResult peek——ack 在 LLM 响应后）
  let nudge = ctx.loopDetector.getNudgeMessage();
  const streakCandidate = ctx.failureStreak.peekNudge();
  ctx.pendingStreakNudge = streakCandidate;
  const streakNudge = streakCandidate ? streakCandidate.message : null;
  if (streakNudge !== null) {
    nudge = [nudge, streakNudge].filter((x) => x !== null).join("\n\n");
  }
  const zeroCandidate = ctx.zeroResultStreak.peekNudge();
  ctx.pendingZeroResultNudge = zeroCandidate;
  if (zeroCandidate !== null) {
    nudge = [nudge, zeroCandidate.message].filter((x) => x !== null).join("\n\n");
  }

  // 4b. 新下载通知
  let downloadNotice: string | null = null;
  if (ctx.settings.trackDownloads) {
    const newDownloads = ctx.browser.consumeCompletedDownloads();
    if (newDownloads.length > 0) {
      for (const d of newDownloads) {
        ctx.state.downloadedFiles.push({
          filename: d.filename,
          url: d.url,
          path: d.path ?? null,
        });
      }
      downloadNotice = `New files available: ${newDownloads.map((d) => d.filename).join(", ")}`;
    }
  }

  // 装配可选段
  const pageStats =
    ctx.settings.enablePageStats && browserState.domState
      ? ((browserState.domState.pageStats as Record<string, unknown> | undefined) ?? null)
      : null;
  const gridMeta = ctx.settings.enableGridMeta ? browserState.gridMeta : null;
  const sensitiveDesc = ctx.settings.enableSensitiveDescription
    ? buildSensitiveDescription(ctx, browserState.url)
    : null;
  const skillDesc =
    ctx.settings.enableSkillInjection && ctx.skillSource !== null
      ? await buildSkillDescription(ctx, browserState.url)
      : null;
  const taskSkillDesc = currentTaskSkillText(ctx);

  if (ctx.obsBus !== null) {
    const skillHost = extractHostWithPort(browserState.url);
    ctx.obsBus.emit(
      skillActiveEvent(ctx.state.nSteps, ctx.obsSessionId, {
        host: skillHost,
        skillLoaded: skillDesc !== null,
        charCount: (skillDesc ?? "").length,
        taskSlug: ctx.taskSkillSlug ?? "",
        taskSkillChars: (taskSkillDesc ?? "").length,
      }),
    );
  }

  const stateOpts = {
    task: ctx.safeTask,
    previousResult: ctx.state.lastResult,
    previousEvaluation: lastOutputField(ctx, "evaluation_previous_goal"),
    previousMemory: lastOutputField(ctx, "memory"),
    previousGoal: lastOutputField(ctx, "next_goal"),
    currentTargetId: ctx.browser.currentTargetId,
    nudgeMessage: nudge,
    planDescription,
    planningNudge,
    downloadNotice,
    pageStats,
    gridMeta,
    sensitiveDescription: sensitiveDesc,
    skillDescription: skillDesc,
    taskSkillDescription: taskSkillDesc,
  };

  // 截图 → image block（降采样不实现=Python 无 Pillow 的原样回落，登记偏离；
  // 视觉关/新标签页 step 0/无图/编码失败 → 纯文本，绝不因图挂步）
  const screenshotB64 = prepareStateScreenshotB64(ctx, browserState);
  const stateMsg: ContentBlock[] | string =
    screenshotB64 !== null
      ? buildStateBlocks(browserState, screenshotB64, stateOpts)
      : buildStateMessage(browserState, stateOpts);
  setStateMessage(ctx, stateMsg);

  // <agent_history> 滑窗（每步替换；首步无历史仅清残留）
  setHistoryMessage(ctx, ctx.historyMessageProvider());

  // 5. 步数预算警告 ≥75%
  injectBudgetWarning(ctx);
  // 6. 最后一步强制 done
  forceDoneOnLastStep(ctx);
  // 7. 连败达限强制 done
  forceDoneAfterFailure(ctx);

  return [browserState, stateMsg];
}

function lastOutputField(ctx: StepCtx, field: string): string | null {
  const mo = ctx.state.lastModelOutput;
  if (mo !== null && typeof mo[field] === "string") return mo[field] as string;
  return null;
}

function clearContextMessages(ctx: StepCtx): void {
  if (!ctx.settings.enableMessageTyping) return;
  ctx.messages = ctx.messages.filter((m) => m.kind !== "context");
}

export function setStateMessage(ctx: StepCtx, content: ContentBlock[] | string): void {
  if (!ctx.settings.enableMessageTyping) {
    ctx.messages.push({
      kind: "plain",
      message: { role: "user", blocks: toBlocks(content) },
    });
    return;
  }
  // 保留最近 1 份旧 state（before/after DOM 对比），删更老的
  const stateIdxs = ctx.messages.map((m, i) => (m.kind === "state" ? i : -1)).filter((i) => i >= 0);
  const drop = new Set(stateIdxs.slice(0, -1));
  ctx.messages = ctx.messages.filter((_, i) => !drop.has(i));
  // 保留的旧 state 丢图留文（恒定单图在飞，图片 token 成本可预算）
  if (Array.isArray(content)) {
    for (const m of ctx.messages) {
      if (m.kind !== "state" || m.message.role !== "user") continue;
      m.message.blocks = m.message.blocks.filter((b) => b.kind !== "image");
    }
  }
  ctx.messages.push({ kind: "state", message: { role: "user", blocks: toBlocks(content) } });
}

function setHistoryMessage(ctx: StepCtx, content: string | null): void {
  if (!ctx.settings.enableMessageTyping) return;
  ctx.messages = ctx.messages.filter((m) => m.kind !== "history");
  if (content) {
    ctx.messages.push({
      kind: "history",
      message: { role: "user", blocks: [{ kind: "text", text: content }] },
    });
  }
}

function toBlocks(content: ContentBlock[] | string): ContentBlock[] {
  return typeof content === "string" ? [{ kind: "text", text: content }] : content;
}

export function updateActionModelsForPage(ctx: StepCtx, pageUrl: string): void {
  ctx.toolSchema = ctx.tools.registry.getToolSchema({
    pageUrl,
    enablePlanning: ctx.settings.enablePlanning,
    maxActions: ctx.settings.maxActionsPerStep,
  }) as unknown as Record<string, unknown>;
  ctx.systemPrompt = buildSystemPrompt(
    ctx.tools.registry.getActionDescriptionsText(pageUrl),
    ctx.safeTask,
    ctx.settings.enableDecisionAttribution,
  );
}

function injectBudgetWarning(ctx: StepCtx): void {
  const stepsUsed = ctx.state.nSteps + 1;
  const budgetRatio = stepsUsed / ctx.settings.maxSteps;
  if (budgetRatio >= 0.75 && ctx.state.nSteps < ctx.settings.maxSteps) {
    const stepsRemaining = ctx.settings.maxSteps - stepsUsed;
    const pct = Math.trunc(budgetRatio * 100);
    const msg =
      `BUDGET WARNING: You have used ${stepsUsed}/${ctx.settings.maxSteps} steps ` +
      `(${pct}%). ${stepsRemaining} steps remaining. ` +
      `If the task cannot be completed in the remaining steps, ` +
      `prioritize consolidating your results and call done. ` +
      `Partial results are far more valuable than exhausting all steps with nothing saved.`;
    addContextMessage(ctx, msg);
  }
}

function forceDoneOnLastStep(ctx: StepCtx): void {
  if (ctx.state.nSteps >= ctx.settings.maxSteps - 1) {
    const msg =
      "LAST STEP: You have reached max_steps - this is your final step. " +
      'You must call the "done" action now. ' +
      "Summarize what you have accomplished so far.";
    addContextMessage(ctx, msg);
    ctx.toolSchema = ctx.tools.registry.getToolSchema({
      includeActions: ["done"],
      maxActions: 1,
    }) as unknown as Record<string, unknown>;
  }
}

function forceDoneAfterFailure(ctx: StepCtx): void {
  if (ctx.state.consecutiveFailures >= ctx.settings.maxFailures) {
    const msg =
      `FAILURE LIMIT: You have failed ${ctx.state.consecutiveFailures} consecutive times. ` +
      `The agent will terminate after this step. ` +
      'You must call the "done" action now with whatever results you have.';
    addContextMessage(ctx, msg);
    ctx.toolSchema = ctx.tools.registry.getToolSchema({
      includeActions: ["done"],
      maxActions: 1,
    }) as unknown as Record<string, unknown>;
  }
}

function prepareStateScreenshotB64(ctx: StepCtx, browserState: BrowserStateSummary): string | null {
  if (!visionGateOpen(ctx)) return null;
  if (isNewTabStepZero(ctx, browserState)) return null;
  const shot = browserState.screenshot;
  if (shot === null) return null;
  // 降采样未实现：Python 无 Pillow 时原样返回原图（登记偏离；4.6 真机观察点）
  try {
    return bytesToBase64(shot);
  } catch {
    return null;
  }
}

function isNewTabStepZero(ctx: StepCtx, browserState: BrowserStateSummary): boolean {
  if (ctx.state.nSteps !== 0) return false;
  const url = (browserState.url ?? "").trim().toLowerCase();
  const dom = browserState.domState;
  const domEmpty = dom === null || dom.elementTreeText.trim() === "";
  return (url === "" || url === "about:blank") && domEmpty;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  if (typeof btoa !== "function") {
    throw new Error("btoa unavailable");
  }
  return btoa(binary);
}

/** 当前页可用 <secret> 占位符（只列 key 绝不列真值；fnmatchcase 大小写敏感） */
export function buildSensitiveDescription(ctx: StepCtx, pageUrl: string): string | null {
  const raw = ctx.sensitiveDataRaw;
  if (raw === null) return null;
  const available: string[] = [];
  for (const [placeholder, spec] of Object.entries(raw)) {
    if (!spec.urls || spec.urls.length === 0) {
      available.push(placeholder);
    } else if (spec.urls.some((p) => fnmatchLike(pageUrl, p))) {
      available.push(placeholder);
    }
  }
  if (available.length === 0) return null;
  return (
    "Available secrets (use as <secret>key</secret> in input_text params): " +
    available.sort().join(", ")
  );
}

async function buildSkillDescription(ctx: StepCtx, pageUrl: string): Promise<string | null> {
  const host = extractHostWithPort(pageUrl);
  if (!host || ctx.skillSource === null) return null;
  const card = await ctx.skillSource.loadHostSkill(host);
  if (card === null) return null;
  const sections: Array<[string, string]> = [
    ["[SOP]", card.sop],
    ["[SELECTORS]", card.selectors],
    ["[QUIRKS]", card.quirks],
  ];
  const parts: string[] = [];
  for (const [header, text] of sections) {
    const t = text.trim();
    if (!t) continue;
    parts.push(header, t, "");
  }
  const rendered = parts.join("\n").trim();
  return rendered || null;
}

/** 每步取任务级 skill 文本（开关门控集中在此——评测红线执行点） */
export function currentTaskSkillText(ctx: StepCtx): string | null {
  if (ctx.settings.enableTaskSkillInjection && ctx.taskSkillText) {
    return ctx.taskSkillText;
  }
  return null;
}
