// 会话前情块（issue #35 U1a W4）：同 session follow-up 新 run 的任务文本拼接——
// 此前终态 turn 的任务与 finalResult 压成 [会话前情·自动注入] 块，置于 [当前任务]
// 之前。core 零改动（prompt 契约面在 SW 粘合层——attachTaskText 同款先例）；
// bridge run_task 走同一受理面免费受益。纯函数零依赖。

/** 前情块总预算（硬编码起步——后续有需求再进设置「高级」区；方案 §5.2） */
export const CONTINUITY_BUDGET_CHARS = 8192;

/** 单条 finalResult 截断（长结果先裁再拼——前情是摘要不是全文） */
const RESULT_CLIP = 2000;

/** 前情素材：终态 turn 的投影（finalResult=null 的失败任务只列任务行） */
export interface ContinuityTurn {
  task: string;
  finalResult: string | null;
  status: "done" | "error" | "interrupted" | "cancelled" | "queued" | "running";
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

function renderTurn(turn: ContinuityTurn): string {
  const task = turn.task.replace(/\s+/g, " ").trim();
  if (turn.finalResult !== null && turn.finalResult !== "") {
    return `此前任务：${clip(task, 400)}\n结果：${clip(turn.finalResult, RESULT_CLIP)}`;
  }
  return `此前任务：${clip(task, 400)}（${turn.status}，无结果）`;
}

/**
 * 拼前情块（验收①：超 8K 预算从最老条目起整条丢弃——保最近上下文的语义优先，
 * 不做逐条半截）。无可用前情（空/全非终态）返回 null——调用方零行为面。
 */
export function buildContinuityBlock(priorTurns: ContinuityTurn[]): string | null {
  const turns = priorTurns.filter(
    (t) => t.status === "done" || t.status === "error" || t.status === "interrupted",
  );
  if (turns.length === 0) return null;
  const rendered: string[] = [];
  let used = 0;
  // 最近的优先保住：从最新往回收集，装不下的（更老的）整条丢
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const line = renderTurn(turns[i] as ContinuityTurn);
    if (used + line.length > CONTINUITY_BUDGET_CHARS && rendered.length > 0) break;
    rendered.unshift(line);
    used += line.length;
    if (used > CONTINUITY_BUDGET_CHARS) break;
  }
  if (rendered.length === 0) return null;
  return `[会话前情·自动注入]\n${rendered.join("\n")}\n[当前任务]`;
}

/** 前情块 + 用户任务组装（block 为 null 时原样返回——零行为面） */
export function withContinuity(task: string, block: string | null): string {
  if (block === null) return task;
  return `${block}\n${task}`;
}
