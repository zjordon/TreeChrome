// 面板 header（issue #20 M3）：标题 + 连接状态点 + 蒸馏状态 + 草稿徽标 + 设置入口。
// distillStatusText 自 ui-glue 迁入（展示文案归组件）；设置钮本期跳 options（M4 换 overlay）。

import type { DistillPhase } from "@tw/protocol";
import { IconButton } from "./icon-button.js";

export type PortStatus = "connecting" | "online" | "offline";

const PORT_LABEL: Record<PortStatus, string> = {
  connecting: "连接服务中…（SW 可能正在唤醒）",
  online: "已连接",
  offline: "连接已断开——自动重连中…",
};

export interface DistillState {
  phase: DistillPhase;
  detail?: string | null;
}

/** 蒸馏过程状态文案（issue #9 D5：failed 红字常驻到下一 run；queued/running/done 灰字） */
export function distillStatusText(d: DistillState): string {
  const detail = d.detail !== null && d.detail !== undefined ? `：${d.detail}` : "";
  switch (d.phase) {
    case "queued":
      return `蒸馏已排队——后台进行中（约 1–4 分钟）${detail}`;
    case "running":
      return `蒸馏中……${detail}`;
    case "done":
      return `蒸馏完成${detail}`;
    case "failed":
      return `蒸馏失败${detail}`;
  }
}

const DISTILL_GLYPH: Record<DistillPhase, string> = {
  queued: "⧗",
  running: "⚗",
  done: "✓",
  failed: "✗",
};

export interface RunPanelHeaderProps {
  title: string;
  /** 缺省不渲染连接状态点 */
  portStatus?: PortStatus;
  distill?: DistillState | null;
  draftCount?: number | null;
  onOpenSettings?: () => void;
  /** 草稿徽标点击（M4 接设置 overlay；缺省回退 onOpenSettings） */
  onReviewDrafts?: () => void;
}

export function RunPanelHeader({
  title,
  portStatus,
  distill,
  draftCount,
  onOpenSettings,
  onReviewDrafts,
}: RunPanelHeaderProps) {
  return (
    <>
      <span className="tc-panel-header-title">{title}</span>
      {portStatus !== undefined ? (
        <span
          className={`tc-port-dot${portStatus === "online" ? "" : ` tc-port-dot--${portStatus}`}`}
          role="status"
          title={PORT_LABEL[portStatus]}
          aria-label={`连接：${PORT_LABEL[portStatus]}`}
        />
      ) : null}
      <span className="tc-panel-header-spacer" />
      {distill !== null && distill !== undefined ? (
        <span
          className={`tc-panel-distill ${distill.phase === "failed" ? "tc-ev-err" : "tc-ev-muted"}`}
          title={distillStatusText(distill)}
        >
          {DISTILL_GLYPH[distill.phase]}
        </span>
      ) : null}
      {(draftCount ?? 0) > 0 ? (
        <button
          type="button"
          className="tc-panel-drafts"
          onClick={onReviewDrafts ?? onOpenSettings}
          title="去审阅蒸馏草稿"
        >
          📝 {draftCount} 草稿
        </button>
      ) : null}
      {onOpenSettings !== undefined ? (
        <IconButton label="设置" size="sm" variant="secondary" onClick={onOpenSettings}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3.2" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.03 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03Z" />
          </svg>
        </IconButton>
      ) : null}
    </>
  );
}
