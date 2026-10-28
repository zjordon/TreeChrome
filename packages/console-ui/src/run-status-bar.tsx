// 运行状态条（issue #20 M3，替代 StatusLine）：呼吸状态点 + 文案 + 步数·耗时 + 停止钮。
// 只运行期渲染（terminal 由 FinalResult 承载）——呼吸动画受 base.css reduced-motion 兜底。

import type { RunStatus } from "@tw/protocol";
import { IconButton } from "./icon-button.js";

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

export interface RunStatusBarProps {
  status: RunStatus;
  stepCount: number;
  startedAt: number;
  /** null = 未结束（耗时至 now） */
  endedAt?: number | null;
  /** 耗时基准（测试注入；缺省墙上钟） */
  now?: () => number;
  onStop?: () => void;
}

export function RunStatusBar({
  status,
  stepCount,
  startedAt,
  endedAt = null,
  now = () => Date.now(),
  onStop,
}: RunStatusBarProps) {
  const elapsed = formatSeconds((endedAt ?? now()) - startedAt);
  const waiting = status === "awaiting-permission" || status === "awaiting-submit";
  return (
    <div
      className="tc-runstatus"
      role="status"
      aria-label={`任务状态：${STATUS_LABEL[status]}，第 ${stepCount} 步，耗时 ${elapsed}`}
    >
      <span
        className={`tc-runstatus-dot${waiting ? " tc-runstatus-dot--waiting" : ""}`}
        aria-hidden="true"
      />
      <span>
        {STATUS_LABEL[status]} · 第 {stepCount} 步 · {elapsed}
      </span>
      {onStop !== undefined ? (
        <IconButton
          className="tc-runstatus-stop"
          label="停止"
          size="xs"
          variant="danger"
          onClick={onStop}
        >
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <rect x="3" y="3" width="8" height="8" rx="1.5" fill="currentColor" />
          </svg>
        </IconButton>
      ) : null}
    </div>
  );
}

export { formatSeconds };
