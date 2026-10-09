// StatusLine（m5/05 §1）：run 状态徽章 + 步数 + 耗时。snapshot 的概要投影——
// 全量快照在粘合层，组件只收渲染所需字段。

import type { RunStatus } from "@tw/protocol";
import { Badge, type BadgeTone } from "./primitives.js";

const STATUS_TONE: Record<RunStatus, BadgeTone> = {
  running: "accent",
  "awaiting-permission": "warning",
  "awaiting-submit": "warning",
  done: "success",
  error: "danger",
  interrupted: "warning",
};

const STATUS_LABEL: Record<RunStatus, string> = {
  running: "运行中",
  "awaiting-permission": "等待确认",
  "awaiting-submit": "等待提交确认",
  done: "完成",
  error: "出错",
  interrupted: "已中断",
};

function formatSeconds(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

export interface StatusLineProps {
  status: RunStatus;
  stepCount: number;
  startedAt: number;
  /** null = 未结束（耗时至 now） */
  endedAt?: number | null;
  /** 耗时基准（测试注入；缺省墙上钟） */
  now?: () => number;
}

export function StatusLine({
  status,
  stepCount,
  startedAt,
  endedAt = null,
  now = () => Date.now(),
}: StatusLineProps) {
  const elapsed = formatSeconds((endedAt ?? now()) - startedAt);
  return (
    <div className="tc-statusline" style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
      <span className="tc-ev-muted">步数 {stepCount}</span>
      <span className="tc-ev-muted">耗时 {elapsed}</span>
    </div>
  );
}

export { formatSeconds };
