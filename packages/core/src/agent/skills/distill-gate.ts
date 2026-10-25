// 蒸馏门控与 host 判定（issue #5 S4，自 node-host distill-run.ts 纯函数下放——
// 双宿主同源：扩展 worker 与 node 钩子共用同一判据）。平台无关纯函数。

import { extractHostWithPort } from "../url-utils.js";
import type { AgentHistoryList } from "../views.js";

/** 门控判据（架构 §6.3：done(success) 且 Judge 复核通过）。judgement 缺失（judge
 *  被配置关闭/调用失败返 null）= 不蒸馏——严格读法，宽松化留实测后再议（D1） */
export function passesDistillGate(history: AgentHistoryList): boolean {
  if (!history.isSuccessful()) return false;
  const last = history.history[history.history.length - 1];
  const judgement = last?.result.find((r) => r.isDone)?.judgement;
  return (judgement as { verdict?: unknown } | null | undefined)?.verdict === true;
}

/** 门控未过的归因（issue #10 D4：双宿主日志单源）。null = 门控通过。三态区分
 *  judgement=null（未执行/调用失败——judge.ts 的 D2 日志可进一步定位）与
 *  verdict=false（复核拒绝）——此前混为一句致诊断误导（2026-10-24 实录） */
export function gateFailureReason(history: AgentHistoryList): string | null {
  if (passesDistillGate(history)) return null;
  const last = history.history[history.history.length - 1];
  const done = last?.result.find((r) => r.isDone);
  if (done === undefined || done.success !== true) {
    return "任务未成功完成（无 done 步或未标记成功）";
  }
  if (done.judgement == null) return "judge 未执行或调用失败（judgement=null，非复核拒绝）";
  return "judge 复核拒绝（verdict=false）";
}

/** 轨迹主导 host（步 URL 多数票；skill 目录 key 形态，含端口 localhost_7780）。
 *  平票取先出现者；无 http URL → null（跳过蒸馏） */
export function dominantHostOf(history: AgentHistoryList): string | null {
  const counts = new Map<string, number>();
  for (const h of history.history) {
    const url = String(h.stateSummary?.url ?? "");
    if (!url.startsWith("http")) continue;
    const host = extractHostWithPort(url);
    if (host === null || host === "") continue;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [host, count] of counts) {
    if (count > bestCount) {
      best = host;
      bestCount = count;
    }
  }
  return best;
}
