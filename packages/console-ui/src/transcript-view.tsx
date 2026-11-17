// TranscriptView（issue #35 U1b B2）：转录条目渲染——用户气泡（task 原文 + 非
// done 状态章）+ run 块（状态头 + 复用 RunTimeline 事件面 + 终态复用 FinalResult）。
// 零 chrome；事件条目的分色/折叠/未知回退由 RunTimeline 既有面承载。

import { FinalResult } from "./final-result.js";
import { Badge } from "./primitives.js";
import { RunTimeline } from "./run-timeline.js";
import type { RunBlockItem, TranscriptItem, UserTurnItem } from "./transcript.js";

const TURN_STATUS_LABEL: Record<UserTurnItem["status"], string> = {
  queued: "排队中",
  running: "运行中",
  done: "完成",
  error: "出错",
  interrupted: "已中断",
  cancelled: "已取消",
};

const RUN_STATUS_LABEL: Record<RunBlockItem["status"], string> = {
  live: "运行中",
  done: "完成",
  error: "出错",
  interrupted: "已中断",
};

function UserBubble({ item }: { item: UserTurnItem }) {
  return (
    <div className="tc-transcript-user" data-testid={`turn-${item.turnId}`}>
      <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.task}</div>
      {item.status !== "done" ? (
        <Badge tone={item.status === "error" ? "danger" : "accent"}>
          {TURN_STATUS_LABEL[item.status]}
        </Badge>
      ) : null}
      {item.attachments.length > 0 ? (
        <div className="tc-ev-muted">{item.attachments.map((a) => a.name).join(" · ")}</div>
      ) : null}
    </div>
  );
}

function RunBlock({ item }: { item: RunBlockItem }) {
  return (
    <section className="tc-card" data-testid={`run-${item.runId}`}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Badge
          tone={item.status === "error" ? "danger" : item.status === "done" ? "success" : "accent"}
        >
          {RUN_STATUS_LABEL[item.status]}
        </Badge>
      </div>
      <RunTimeline
        events={item.events}
        discardedBeforeSeq={item.discardedBeforeSeq}
        stepCount={item.stepCount}
      />
      {item.status !== "live" ? (
        // 归档无 isSuccessful 字段（快照面才有）——终态章 neutral，lastError 红字承载失败解释
        <FinalResult
          finalResult={item.finalResult}
          isSuccessful={null}
          attachments={[]}
          lastError={item.lastError}
        />
      ) : null}
    </section>
  );
}

export interface TranscriptViewProps {
  items: TranscriptItem[];
}

export function TranscriptView({ items }: TranscriptViewProps) {
  if (items.length === 0) return <p className="tc-ev-muted">（尚无对话）</p>;
  return (
    <div className="tc-transcript" data-testid="transcript-view">
      {items.map((item) =>
        item.kind === "user-turn" ? (
          <UserBubble key={item.turnId} item={item} />
        ) : (
          <RunBlock key={item.runId} item={item} />
        ),
      )}
    </div>
  );
}
