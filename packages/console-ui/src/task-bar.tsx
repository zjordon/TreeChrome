// TaskBar（m5/05 §1）：任务输入 + 附件选择/清单 + 起跑/停止。File 对象由宿主
// onPickFiles 消费（读字节/base64 编码是粘合层职责——组件零 IO）。

import type { AttachmentInfo, RunStatus } from "@tw/protocol";
import { useRef } from "react";
import { formatBytes } from "./bytes.js";
import { Button } from "./primitives.js";

const RUNNING_STATUSES: readonly RunStatus[] = [
  "running",
  "awaiting-permission",
  "awaiting-submit",
];

export interface TaskBarProps {
  task: string;
  onTaskChange: (task: string) => void;
  attachments: AttachmentInfo[];
  onPickFiles: (files: File[]) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  /** null = 无 run（空闲）；running/awaiting-* → 停止态按钮 */
  runStatus: RunStatus | null;
  onStart: () => void;
  onStop: () => void;
}

export function TaskBar({
  task,
  onTaskChange,
  attachments,
  onPickFiles,
  onRemoveAttachment,
  runStatus,
  onStart,
  onStop,
}: TaskBarProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const running = runStatus !== null && RUNNING_STATUSES.includes(runStatus);
  const canStart = !running && task.trim() !== "";
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
      <div style={{ display: "flex", gap: 8 }}>
        <Button
          disabled={running}
          onClick={() => {
            fileInput.current?.click();
          }}
        >
          📎 附件
        </Button>
        {running ? (
          <Button variant="danger" onClick={onStop}>
            ⏹ 停止
          </Button>
        ) : (
          <Button variant="primary" disabled={!canStart} onClick={onStart}>
            ▶ 开始
          </Button>
        )}
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
