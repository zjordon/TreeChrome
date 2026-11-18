// 附件粘贴/拖入守卫（issue #41 U4 批 A，验收③）：paste/drop 事件提取可受理的
// 文件——与 📎 按钮同门（!running）同源（调用方持同一 pickFiles 编排）。纯函数
// 零 chrome；返回 null 表示事件不由附件面接管（纯文本粘贴/运行中/无文件）。

/** clipboardData / dataTransfer 的可测最小面 */
export interface TransferLike {
  files: ArrayLike<File> | null;
}

/**
 * 提取待上传文件：files 非空且 !running 才接管。drop 侧的 preventDefault
 * （防面板页被导航到 file://）由调用方无条件执行，与本守卫解耦。
 */
export function intakeFiles(
  transfer: TransferLike | null,
  opts: { running: boolean },
): File[] | null {
  if (opts.running) return null;
  const files = transfer?.files;
  if (files === null || files === undefined || files.length === 0) return null;
  return Array.from(files);
}
