// QueueStrip（#37 U2 批 A）：排队消息条——当前会话 queued turns 的可操作列表
// （任务摘要 + 逐条撤销）。数据源是 session-open 应答（sessionRecord.turns 过滤
// queued）；转录里的排队气泡（状态章）是同一数据的只读投影。零 chrome。

import type { SessionTurn } from "@tw/protocol";
import { Button } from "./primitives.js";

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export interface QueueStripProps {
  turns: Array<Pick<SessionTurn, "turnId" | "task">>;
  /** 撤销排队（开跑前有效——running turn 不可撤销由数据面保证） */
  onRemove: (turnId: string) => void;
}

export function QueueStrip({ turns, onRemove }: QueueStripProps) {
  if (turns.length === 0) return null;
  return (
    <section className="tc-card" data-testid="queue-strip" aria-label="排队中的任务">
      <div className="tc-ev-muted" style={{ fontSize: 11 }}>
        排队中（{turns.length}）——本轮结束后自动依次执行
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2 }}>
        {turns.map((t) => (
          <li key={t.turnId} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
              ⧗ {clip(t.task, 60)}
            </span>
            <Button
              variant="danger"
              aria-label={`撤销排队 ${clip(t.task, 20)}`}
              onClick={() => onRemove(t.turnId)}
            >
              ×
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
