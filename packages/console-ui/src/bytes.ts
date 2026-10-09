// 字节数格式化（1000 进制短写——UI 展示面；与任务文本 [Attachments] 的 humanSize
// 分工：那边是 SW 侧协议形态，这边是组件展示）。

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}
