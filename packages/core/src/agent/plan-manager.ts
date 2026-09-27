// 无状态计划管理（plan_manager.py 91 全量）：渲染/整替/前进/replan·探索 nudge。
// enablePlanning 默认关——本模块纯函数，无副作用。

import type { AgentState, PlanItem } from "./views.js";
import { planItem } from "./views.js";

const MARKERS: Record<string, string> = {
  done: "[x]",
  current: "[>]",
  pending: "[ ]",
  skipped: "[-]",
};

export class PlanManager {
  /** 当前计划 → LLM 上下文文本（无计划返回 null） */
  renderPlanDescription(plan: PlanItem[] | null): string | null {
    if (!plan || plan.length === 0) return null;
    const lines: string[] = [];
    for (const [i, step] of plan.entries()) {
      lines.push(`${MARKERS[step.status] ?? "[ ]"} ${i}: ${step.text}`);
    }
    return lines.join("\n");
  }

  /** 从 LLM 输出更新计划：A) plan_update 整替 / B) current_plan_item 前进（互斥） */
  updateFromModelOutput(state: AgentState, modelOutput: Record<string, unknown>): void {
    // Path A: full plan replacement
    if ("plan_update" in modelOutput && modelOutput.plan_update != null) {
      const steps = modelOutput.plan_update;
      if (Array.isArray(steps)) {
        state.plan = steps.map((text) => planItem(String(text)));
        state.currentPlanItemIndex = 0;
        state.planGenerationStep = state.nSteps;
        if (state.plan.length > 0) {
          state.plan[0].status = "current";
        }
      }
      return;
    }
    // Path B: advance current step index
    if (
      "current_plan_item" in modelOutput &&
      modelOutput.current_plan_item != null &&
      state.plan !== null
    ) {
      const idx = Number(modelOutput.current_plan_item);
      if (!Number.isFinite(idx) || state.plan.length === 0) return;
      const newIdx = Math.max(0, Math.min(Math.trunc(idx), state.plan.length - 1));
      const oldIdx = state.currentPlanItemIndex;
      for (let i = oldIdx; i < newIdx; i++) {
        if (
          i < state.plan.length &&
          (state.plan[i].status === "current" || state.plan[i].status === "pending")
        ) {
          state.plan[i].status = "done";
        }
      }
      if (newIdx < state.plan.length) {
        state.plan[newIdx].status = "current";
      }
      state.currentPlanItemIndex = newIdx;
    }
  }

  /** 连败超阈值 → 重计划提示（无计划/未达阈值返回 null） */
  buildReplanNudge(
    consecutiveFailures: number,
    threshold: number,
    plan: PlanItem[] | null,
  ): string | null {
    if (!plan || consecutiveFailures < threshold) return null;
    return (
      "You have failed multiple consecutive times. The current plan may not be working. " +
      "Consider revising the plan by providing a new plan_update with adjusted steps " +
      "(plan_update is a response field, not an action)."
    );
  }

  /** 无计划探索达阈值 → 建计划提示 */
  buildExplorationNudge(nSteps: number, threshold: number, plan: PlanItem[] | null): string | null {
    if (plan !== null || nSteps < threshold) return null;
    return (
      "You have been exploring for several steps without a structured plan. " +
      "Consider breaking down the task into clear steps by providing a plan_update " +
      "(a response field, not an action)."
    );
  }
}
