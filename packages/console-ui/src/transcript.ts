// 转录投影（issue #35 U1b B1）：SessionRecord（归档真相源）+ 活动 run 快照 +
// UI 侧已合并的事件流 → 转录条目序列。纯函数零 chrome（双宿主与测试的共同锚点
// ——方案 §5.5）。活动 run 事件源 = 调用方 state.events（hello 尾巴合并 + live
// 去重已在 reducer 完成——D8，投影不自行合并防双源分叉）。

import type {
  AttachmentInfo,
  JournalEvent,
  RunJournalSnapshot,
  SessionRecord,
  SessionTurn,
  TerminalRunStatus,
} from "@tw/protocol";

/** 用户 turn 气泡（task 原文——前情块等 prompt 拼接不在此面） */
export interface UserTurnItem {
  kind: "user-turn";
  turnId: string;
  task: string;
  status: SessionTurn["status"];
  attachments: AttachmentInfo[];
  createdAt: number;
}

/** run 块：状态头 + 事件时间线 + 终态结果。live = 活动 run（终态字段随快照） */
export interface RunBlockItem {
  kind: "run-block";
  runId: string;
  turnId: string;
  status: TerminalRunStatus | "live";
  events: JournalEvent[];
  stepCount: number;
  startedAt: number;
  endedAt: number | null;
  finalResult: string | null;
  lastError: string | null;
  discardedBeforeSeq: number;
}

export type TranscriptItem = UserTurnItem | RunBlockItem;

/**
 * 投影（turn 序为主序）：每 turn 出用户气泡；终态 turn 配对 RunArchive 出
 * run 块；running turn 若是活动 run（snapshot.runId 匹配且同会话）出 live 块
 * （事件取 liveEvents）；无归档且非活动（跨 SW 生死的残留 running）只出气泡
 * ——状态章呈现「运行中」，record 刷新（恢复对账置 interrupted）后自然收口。
 */
export function projectTranscript(
  record: SessionRecord | null,
  snapshot: RunJournalSnapshot | null,
  liveEvents: JournalEvent[],
): TranscriptItem[] {
  if (record === null) return [];
  const items: TranscriptItem[] = [];
  for (const turn of record.turns) {
    items.push({
      kind: "user-turn",
      turnId: turn.turnId,
      task: turn.task,
      status: turn.status,
      attachments: turn.attachments,
      createdAt: turn.createdAt,
    });
    const isActive =
      snapshot !== null &&
      snapshot.runId === turn.runId &&
      (snapshot.sessionId === undefined || snapshot.sessionId === record.meta.sessionId);
    if (isActive && snapshot !== null) {
      items.push({
        kind: "run-block",
        runId: snapshot.runId,
        turnId: turn.turnId,
        status: "live",
        events: liveEvents,
        stepCount: snapshot.stepCount,
        startedAt: snapshot.startedAt,
        endedAt: snapshot.endedAt,
        finalResult: snapshot.finalResult,
        lastError: snapshot.lastError,
        discardedBeforeSeq: snapshot.discardedBeforeSeq,
      });
      continue;
    }
    const archive =
      record.runs.find((r) => r.turnId === turn.turnId) ??
      record.runs.find((r) => r.runId === turn.runId) ??
      null;
    if (archive !== null) {
      items.push({
        kind: "run-block",
        runId: archive.runId,
        turnId: archive.turnId,
        status: archive.status,
        events: archive.events,
        stepCount: archive.events.filter((e) => e.type === "step_end").length,
        startedAt: archive.startedAt,
        endedAt: archive.endedAt,
        finalResult: archive.finalResult,
        lastError: archive.lastError,
        discardedBeforeSeq: archive.discardedBeforeSeq,
      });
    }
  }
  return items;
}
