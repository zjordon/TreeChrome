// DebugLogPage（issue #39 U3 批 B）：原始 journal 事件流 + 可读回退——转录/时间线
// 是语义投影，这里给全量原始面（调试口径：seq/type/ts/data JSON 折叠行，未知类型
// 原样呈现）。快照头部态（runId/tabId/status/stepCount）随 events 一并展示。

import type { JournalEvent, RunJournalSnapshot } from "@tw/protocol";

export interface DebugLogPageProps {
  events: JournalEvent[];
  snapshot: RunJournalSnapshot | null;
}

/** data 的稳定 JSON（键序插入序；环/undefined 由 JSON.stringify 自身语义收口） */
function prettyData(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2) ?? "null";
  } catch {
    return String(data);
  }
}

export function DebugLogPage({ events, snapshot }: DebugLogPageProps) {
  return (
    <div data-testid="debug-log-page">
      {snapshot !== null ? (
        <section className="tc-card">
          <strong>当前快照</strong>
          <div className="tc-ev-muted" style={{ fontSize: 12 }}>
            run {snapshot.runId} · tab {snapshot.tabId} · {snapshot.status} · 步数{" "}
            {snapshot.stepCount}
            {snapshot.discardedBeforeSeq > 0
              ? ` · seq ${snapshot.discardedBeforeSeq} 前已淘汰`
              : ""}
          </div>
        </section>
      ) : null}
      {events.length === 0 ? (
        <p className="tc-ev-muted">（尚无事件——运行任务后此处出现原始事件流）</p>
      ) : (
        <div className="tc-timeline" data-testid="debug-events">
          {[...events]
            .sort((a, b) => a.seq - b.seq)
            .map((e) => (
              <details key={e.seq} style={{ margin: "2px 0" }}>
                <summary style={{ cursor: "pointer", fontSize: 12 }}>
                  <span className="tc-ev-muted">#{e.seq}</span> {e.type}{" "}
                  <span className="tc-ev-muted">{new Date(e.ts).toLocaleTimeString()}</span>
                </summary>
                <pre
                  style={{
                    margin: "2px 0 6px",
                    fontSize: 11,
                    overflowX: "auto",
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                  }}
                >
                  {prettyData(e.data)}
                </pre>
              </details>
            ))}
        </div>
      )}
    </div>
  );
}
