// 任务文本的附件清单拼接（m5/04 §2 + 段 C §1.4 宿主装配形态）：注册表有附件时
// 追加 [Attachments] 段——用法说明写给模型（path 参数填 attachment:<id>，不是
// 文件路径）。core 不感知扩展，此处是 SW 粘合层的 prompt 契约面。

import type { AttachmentInfo } from "@tw/protocol";

/** 人类可读字节量（12.3 MB / 456 KB / 89 B） */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** 附件条目行（`- att_1: video.mp4 (12.3 MB, video/mp4)`） */
export function attachmentLine(item: AttachmentInfo): string {
  return `- ${item.attachmentId}: ${item.name} (${humanSize(item.size)}, ${item.mimeType})`;
}

/** 拼接（无附件原样返回 task——零行为面） */
export function attachTaskText(task: string, attachments: AttachmentInfo[]): string {
  if (attachments.length === 0) return task;
  const lines = [
    "",
    "[Attachments]",
    ...attachments.map(attachmentLine),
    '使用 upload_file 动作上传附件：path 参数填 "attachment:<id>"（不是文件路径）。',
  ];
  return `${task}\n${lines.join("\n")}`;
}
