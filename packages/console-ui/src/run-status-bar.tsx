// 运行状态条（issue #20 M3，替代 StatusLine）：呼吸状态点 + 文案 + 步数·耗时 +
// 上下文用量 pill（#37 批 B）+ 停止钮。只运行期渲染（terminal 由 FinalResult 承载）
// ——呼吸动画受 base.css reduced-motion 兜底。

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

/** token 量的短写（1234 → 1.2k） */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / (1000 * 1000)).toFixed(1)}M`;
}

/** 上下文用量投影（#37 批 B 验收④口径：最近 model_result.inputTokens） */
export interface ContextUsage {
  inputTokens: number;
  /** null = 未知卡窗口（不显示比例，只显示绝对量） */
  contextWindow: number | null;
}

export interface RunStatusBarProps {
  status: RunStatus;
  stepCount: number;
  startedAt: number;
  /** null = 未结束（耗时至 now） */
  endedAt?: number | null;
  /** 耗时基准（测试注入；缺省墙上钟） */
  now?: () => number;
  /** 上下文用量 pill（缺省不渲染） */
  usage?: ContextUsage;
  onStop?: () => void;
}

export function RunStatusBar({
  status,
  stepCount,
  startedAt,
  endedAt = null,
  now = () => Date.now(),
  usage,
  onStop,
}: RunStatusBarProps) {
  const elapsed = formatSeconds((endedAt ?? now()) - startedAt);
  const waiting = status === "awaiting-permission" || status === "awaiting-submit";
  const ratio =
    usage !== undefined && usage.contextWindow !== null && usage.contextWindow > 0
      ? Math.min(1, usage.inputTokens / usage.contextWindow)
      : null;
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
      {usage !== undefined ? (
        <span
          className={`tc-runstatus-usage${ratio !== null && ratio >= 0.9 ? " tc-runstatus-usage--warn" : ""}`}
          title="最近一次模型调用的输入 token / 活跃卡上下文窗口"
        >
          上下文 {formatTokens(usage.inputTokens)}
          {ratio !== null ? ` / ${formatTokens(usage.contextWindow as number)}` : ""}
        </span>
      ) : null}
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
