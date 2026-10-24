// 轨迹序列化器（issue #5 S1）：judge.py 移植形态自 judge.ts 提取为共享模块——
// 全步叙事（URL/Title/Goal/Action+params/Result；done 步附 Page excerpt）。judge
// （复核 prompt）与 distill（蒸馏 prompt）共用同一序列化口径；judge 锚定测试经
// 委托方法继续对拍，行为逐字节不变。

import { pyJsonDumps } from "../../tools/py-json.js";
import type { AgentHistoryList } from "../views.js";

/** 全步序列化：URL/Title/Goal/Action(原始结果)/Result；done 步附 Page excerpt */
export function serializeTraceForPrompt(history: AgentHistoryList): string {
  const allSteps = history.history;
  if (allSteps.length === 0) return "";
  const lines: string[] = [];
  for (const h of allSteps) {
    const modelOut = h.modelOutput ?? {};
    const goal = typeof modelOut.next_goal === "string" ? modelOut.next_goal : "";
    const action = (modelOut.action ?? {}) as Record<string, unknown>;
    const actionName = String(action.name ?? "");
    const actionParams = (action.params ?? {}) as Record<string, unknown>;
    const summary = h.stateSummary ?? {};
    const url = String(summary.url ?? "");
    const title = String(summary.title ?? "");
    const domExcerpt = String(summary.domExcerpt ?? "");
    const resultParts: string[] = [];
    for (const r of h.result) {
      if (r.error) {
        resultParts.push(`ERROR: ${r.error}`);
      } else if (r.extractedContent) {
        resultParts.push(r.extractedContent);
      } else {
        resultParts.push(r.render());
      }
    }
    const block = [
      `Step ${h.stepNumber}:`,
      `  URL: ${url}`,
      `  Title: ${title}`,
      `  Goal: ${goal}`,
      `  Action: ${actionName}(${pyJsonDumps(actionParams)})`,
    ];
    if (domExcerpt) {
      block.push(`  Page excerpt: ${domExcerpt}`);
    }
    block.push(`  Result: ${resultParts.join("; ")}`);
    lines.push(block.join("\n"));
  }
  return lines.join("\n\n");
}
