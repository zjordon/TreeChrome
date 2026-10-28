// TaskBar（m5/05 §1；issue #2 补拒绝明细/预算/进度）：任务输入 + 附件选择/清单 +
// 上传进度 + 预算余量 + 拒绝明细 + 起跑/停止。File 对象由宿主 onPickFiles 消费
//（读字节/分块传输是粘合层职责——组件零 IO）；budget/rejections 是 SW 广播的
// 投影，uploads 是宿主本地传输态——三者全部可选注入（M5 旧宿主可不带）。

import type {
  AttachmentBudget,
  AttachmentInfo,
  AttachmentRejection,
  RunStatus,
} from "@tw/protocol";
import { useRef } from "react";
import { formatBytes } from "./bytes.js";
import { Button } from "./primitives.js";

const RUNNING_STATUSES: readonly RunStatus[] = [
  "running",
  "awaiting-permission",
  "awaiting-submit",
];

/** 拒绝 reason → 用户可行动文案（limit 来自 SW 拒绝面——单件/总量各自的上限） */
const REJECTION_TEXT: Record<AttachmentRejection["reason"], (r: AttachmentRejection) => string> = {
  "too-large": (r) => `超单件上限 ${formatBytes(r.limit)}`,
  "total-exceeded": (r) => `超总量预算 ${formatBytes(r.limit)}`,
  invalid: () => "附件无效",
  lost: () => "传输中断，请重新选择",
};

/** 预算行警色阈值（≥90% 提示余量紧张——硬拒在 SW，此行只是余量呈现） */
const BUDGET_WARN_RATIO = 0.9;

/** 宿主本地传输态（sidepanel uploads 投影——不进 protocol） */
export interface TaskBarUpload {
  transferId: string;
  name: string;
  size: number;
  sent: number;
}

export interface TaskBarProps {
  task: string;
  onTaskChange: (task: string) => void;
  attachments: AttachmentInfo[];
  onPickFiles: (files: File[]) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  /** null = 无 run（空闲）；running/awaiting-* → 禁用输入与起跑（停止钮在 RunStatusBar——M3 迁出） */
  runStatus: RunStatus | null;
  onStart: () => void;
  /** attachments 广播携带的预算投影（null = 尚无广播——不显示预算行） */
  budget?: AttachmentBudget | null;
  /** 进行中的分块传输（非空时禁用开始——起跑会丢在途字节） */
  uploads?: TaskBarUpload[];
  /** 被拒附件明细（SW 广播 + 本地失败同位展示） */
  rejections?: AttachmentRejection[];
  onDismissRejection?: (index: number) => void;
}

export function TaskBar({
  task,
  onTaskChange,
  attachments,
  onPickFiles,
  onRemoveAttachment,
  runStatus,
  onStart,
  budget = null,
  uploads = [],
  rejections = [],
  onDismissRejection,
}: TaskBarProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const running = runStatus !== null && RUNNING_STATUSES.includes(runStatus);
  const canStart = !running && task.trim() !== "" && uploads.length === 0;
  const budgetWarn =
    budget !== null &&
    budget.maxTotalBytes > 0 &&
    budget.usedBytes / budget.maxTotalBytes >= BUDGET_WARN_RATIO;
  return (
    <section className="tc-card" data-testid="task-bar">
      <textarea
        rows={3}
        placeholder="描述任务，如：打开 douyin.com，上传视频并选择合集…"
        value={task}
        disabled={running}
        onChange={(e) => onTaskChange(e.target.value)}
      />
      {attachments.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2 }}>
          {attachments.map((a) => (
            <li key={a.attachmentId} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>
                {a.name}（{formatBytes(a.size)}）
              </span>
              <Button
                variant="danger"
                disabled={running}
                aria-label={`移除附件 ${a.name}`}
                onClick={() => onRemoveAttachment(a.attachmentId)}
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {uploads.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2 }} aria-label="附件上传中">
          {uploads.map((u) => (
            <li key={u.transferId} className="tc-ev-muted" style={{ display: "flex", gap: 6 }}>
              <span>
                {u.name}（上传中 {u.size > 0 ? Math.floor((u.sent / u.size) * 100) : 100}%）
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {budget !== null && budget.usedBytes > 0 ? (
        <p style={{ margin: 0 }} className={budgetWarn ? "tc-ev-warn" : "tc-ev-muted"}>
          附件 {formatBytes(budget.usedBytes)} / {formatBytes(budget.maxTotalBytes)}
          {budgetWarn ? "（余量紧张）" : ""}
        </p>
      ) : null}
      {rejections.length > 0 ? (
        <ul
          style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2 }}
          aria-label="附件被拒明细"
        >
          {rejections.map((r, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: 拒绝明细无稳定 id（同名可重复出现），name+序号复合 key 是务实解（同 submit-card 先例）
              key={`${r.name}-${i}`}
              className="tc-ev-err"
              style={{ display: "flex", gap: 6, alignItems: "center" }}
            >
              <span>
                ⚠ {r.name}
                {r.size > 0 ? `（${formatBytes(r.size)}）` : ""} — {REJECTION_TEXT[r.reason](r)}
              </span>
              {onDismissRejection !== undefined ? (
                <Button
                  variant="danger"
                  aria-label={`清除附件提示 ${r.name}`}
                  onClick={() => onDismissRejection(i)}
                >
                  ×
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div style={{ display: "flex", gap: 8 }}>
        <Button
          disabled={running}
          onClick={() => {
            fileInput.current?.click();
          }}
        >
          📎 附件
        </Button>
        <Button variant="primary" disabled={!canStart} onClick={onStart}>
          ▶ 开始
        </Button>
      </div>
      {/* 隐藏原生 input：组件面保持 File[] 回调，宿主不摸 DOM */}
      <input
        ref={fileInput}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) onPickFiles(files);
          e.target.value = "";
        }}
      />
    </section>
  );
}
