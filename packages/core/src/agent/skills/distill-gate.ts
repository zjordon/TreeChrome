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
