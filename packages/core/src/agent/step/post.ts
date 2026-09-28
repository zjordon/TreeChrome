// Stage 4 Post：_post_process（:1601-1687）——下载并入 done attachments/plan 更新/
// 循环检测记录（豁免过滤）/失败计数（单动作步 error 才计；#194 infra 清零在
// early return 之前）。denied 结果同规则排除（04 §3 TreeChrome 增补——4.5 接线）。

import { actionsOf, nameOf, paramsOf } from "../action-shape.js";
import { LOOP_EXEMPT_ACTIONS } from "../constants.js";
import type { ActionResult, ModelOutput } from "../views.js";
import type { StepCtx } from "./context.js";

export function postProcess(ctx: StepCtx, results: ActionResult[], modelOutput: ModelOutput): void {
  ctx.state.lastResult = results;
  ctx.state.lastModelOutput = modelOutput;

  // 二.C：会话下载自动并入 done 结果 attachments（去重；跳过无 path）
  if (ctx.settings.trackDownloads && ctx.state.downloadedFiles.length > 0) {
    attachDownloadsToDoneResults(results, ctx.state.downloadedFiles);
  }

  // plan 更新（enablePlanning 默认关）
  if (ctx.settings.enablePlanning && ctx.planManager !== null) {
    ctx.planManager.updateFromModelOutput(ctx.state, modelOutput);
  }

  // 循环检测记录（豁免 wait/done/go_back；多动作步逐动作记录）
  for (const action of actionsOf(modelOutput)) {
    const actionName = String(nameOf(action) ?? "");
    if (!LOOP_EXEMPT_ACTIONS.has(actionName)) {
      ctx.loopDetector.recordAction(actionName, paramsOf(action) as Record<string, unknown>);
    }
  }

  // #194 review2：infra 清零须在单动作失败 early return **之前**（到达即证明 LLM 可达）
  if (ctx.state.infraFailures > 0) {
    ctx.state.infraFailures = 0;
  }
  // denied 不计失败（04 §2）——落非失败面：不递增且与成功步同规则清零
  if (
    results.length === 1 &&
    results[results.length - 1].error !== null &&
    !results[results.length - 1].denied
  ) {
    ctx.state.consecutiveFailures += 1;
    return;
  }
  if (results.length > 1 && results.some((r) => r.error !== null)) {
    // browser-use 语义：多动作步失败不计（交循环检测 + replan）——仅日志
    ctx.log(
      `Multi-action step had ${results.filter((r) => r.error !== null).length}/${results.length} ` +
        "actions failed — not incrementing consecutive_failures (deferred to loop detection)",
    );
  }
  // 非计数步（成功或多动作失败）→ 清零
  if (ctx.state.consecutiveFailures > 0) {
    ctx.state.consecutiveFailures = 0;
  }

  // 完成结果日志（Python ANSI 色彩省略——宿主日志面自渲染，偏离 6）
  if (results.length > 0 && results[results.length - 1].isDone) {
    const result = results[results.length - 1];
    ctx.log(`📄 Final Result:\n${result.extractedContent ?? ""}`);
    if (result.attachments !== null) {
      for (const [i, filePath] of result.attachments.entries()) {
        ctx.log(`👉 Attachment ${result.attachments.length > 1 ? `${i + 1} ` : ""}${filePath}`);
      }
    }
  }
}

/** 下载并入 done attachments（原地修改；去重；跳过无 path）——纯函数可单测 */
export function attachDownloadsToDoneResults(
  results: ActionResult[],
  downloadedFiles: ReadonlyArray<{ path?: string | null }>,
): void {
  const dlPaths = downloadedFiles
    .map((d) => d.path)
    .filter((p): p is string => typeof p === "string" && p !== "");
  if (dlPaths.length === 0) return;
  for (const r of results) {
    if (!r.isDone) continue;
    const existing = new Set(r.attachments ?? []);
    const merged = [...(r.attachments ?? []), ...dlPaths.filter((p) => !existing.has(p))];
    if (merged.length > 0) {
      (r as { attachments: string[] | null }).attachments = merged;
    }
  }
}
