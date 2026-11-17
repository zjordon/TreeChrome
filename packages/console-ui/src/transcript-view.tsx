// TranscriptView（issue #35 U1b B2 + #37 批 D 滚动意图 + #39 批 A 复制钮）：转录
// 条目渲染——用户气泡（task 原文 + 非 done 状态章 + 复制钮）+ run 块（状态头 +
// 复用 RunTimeline 事件面 + 终态复用 FinalResult）。零 chrome；事件条目的分色/
// 折叠/未知回退由 RunTimeline 承载。

import { useEffect, useRef, useState } from "react";
import { FinalResult } from "./final-result.js";
import { CopyButton } from "./markdown.js";
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
      <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
        <div style={{ flex: 1, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.task}</div>
        <CopyButton text={item.task} label="复制任务原文" />
      </div>
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

/** 解除跟随的距底阈值（qz 同值 28px） */
export const FOLLOW_BOTTOM_THRESHOLD_PX = 28;

/** 距底判定（纯函数——jsdom 无真实布局，组件测试经此锚定语义） */
export function isAtBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = FOLLOW_BOTTOM_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

/** 滚动意图裁剪版（#37 批 D）：容器自有滚动面——尾部跟随 + 上滚解除（>28px）+
 *  回底恢复 + 解除期间新事件浮钮「↓」。跟随判定挂容器 scroll 事件与 items 变更
 *  双路径；空转录维持原占位不渲染滚动容器。 */
export function TranscriptView({ items }: TranscriptViewProps) {
  const container = useRef<HTMLDivElement>(null);
  // 初始跟随（首屏在底）；scrollTop 初始 0 且内容未超视口时 isAtBottom 恒真
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  followingRef.current = following;

  const syncFollow = (): void => {
    const el = container.current;
    if (el === null) return;
    const next = isAtBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
    if (next !== followingRef.current) setFollowing(next);
  };

  // items 增长时：跟随中则贴底（流式内容增高不跳走——qz 滚动意图的核心）。
  // items 是纯触发器（体内容由 key 稳定的子项承载）——显式消费让依赖必要性成立
  useEffect(() => {
    void items.length;
    const el = container.current;
    if (el === null || !followingRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [items]);

  if (items.length === 0) return <p className="tc-ev-muted">（尚无对话）</p>;
  return (
    <>
      <div
        ref={container}
        className="tc-transcript tc-transcript--scroll"
        data-testid="transcript-view"
        onScroll={syncFollow}
      >
        {items.map((item) =>
          item.kind === "user-turn" ? (
            <UserBubble key={item.turnId} item={item} />
          ) : (
            <RunBlock key={item.runId} item={item} />
          ),
        )}
      </div>
      {!following ? (
        <button
          type="button"
          className="tc-transcript-jump"
          data-testid="transcript-jump"
          aria-label="回到底部"
          onClick={() => {
            const el = container.current;
            if (el !== null) el.scrollTop = el.scrollHeight;
            setFollowing(true);
          }}
        >
          ↓ 新消息
        </button>
      ) : null}
    </>
  );
}
