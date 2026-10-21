// 附件分块上传编排（issue #2 C 档）：单文件 begin → 等 SW attachment-begun 回执 →
// 顺序 chunk（slice 流式读，不整载内存）→ commit。块载荷 base64——e2e 实证
// chrome.runtime 消息通道是 JSON 序列化（ArrayBuffer 克隆不可用），分块把单条
// 消息压到块级（≈5.3MB 字符串），整串大消息撞限值与瞬时双份内存的风险消除。
// 失败面全部显式化：begin 被拒（SW 已广播 attachment-rejected，此处只停止不重复
// 展示）、begun 超时、读文件失败（本地组装拒绝明细同位展示 + abort 兜底——替换
// 旧 fileToBase64 的静默 unhandled rejection）。commit 乐观收尾：成功回执是后续
// attachments 广播，失败回 attachment-rejected(lost)——上传记录的清理由调用方在
// Promise 收尾统一做。

import type { AttachmentRejection, UiToSwMessage } from "@tw/protocol";

/** 分块大小（源字节粒度；base64 后 ≈5.3MB——远低于任何已知 port 消息限值） */
export const ATTACHMENT_CHUNK_BYTES = 4 * 1024 * 1024;

/** begun 回执等待上限（SW 未唤醒/端口断连兜底——不留悬挂传输） */
export const BEGUN_TIMEOUT_MS = 10_000;

/** 字节 → base64（0x8000 分块展开——整块 String.fromCharCode 炸调用栈；旧
 *  attachment-file.ts 编码核的块级复用，文件粒度退役） */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** waitForBegun 信号：begun=预检通过；rejected=SW 已广播拒绝；timeout=回执未达 */
export type BegunSignal = "begun" | "rejected" | "timeout";

/** File 的最小消费面（slice 返回 ArrayBuffer——组态层从 File 适配，测试可注入假件） */
export interface UploadFile {
  name: string;
  mimeType: string;
  size: number;
  slice(offset: number, end: number): Promise<ArrayBuffer>;
}

export interface UploadDeps {
  send: (message: UiToSwMessage) => void;
  waitForBegun: (transferId: string, timeoutMs: number) => Promise<BegunSignal>;
  onProgress: (transferId: string, sent: number) => void;
  onLocalRejection: (rejection: AttachmentRejection) => void;
  generateTransferId?: () => string;
  chunkBytes?: number;
  begunTimeoutMs?: number;
}

export async function uploadAttachment(file: UploadFile, deps: UploadDeps): Promise<void> {
  const chunkBytes = deps.chunkBytes ?? ATTACHMENT_CHUNK_BYTES;
  const transferId = deps.generateTransferId?.() ?? crypto.randomUUID();
  const failLocal = (): void => {
    deps.onLocalRejection({
      transferId,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      reason: "lost",
      limit: 0,
    });
  };

  deps.send({
    kind: "attachment-begin",
    transferId,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
  });
  const signal = await deps.waitForBegun(transferId, deps.begunTimeoutMs ?? BEGUN_TIMEOUT_MS);
  if (signal !== "begun") {
    if (signal === "timeout") {
      failLocal();
      deps.send({ kind: "attachment-abort", transferId });
    }
    // rejected：SW 已广播明细（reducer 已入列），只停止
    return;
  }

  try {
    for (let off = 0; off < file.size; off += chunkBytes) {
      const end = Math.min(off + chunkBytes, file.size);
      deps.send({
        kind: "attachment-chunk",
        transferId,
        offset: off,
        data: bytesToBase64(new Uint8Array(await file.slice(off, end))),
      });
      deps.onProgress(transferId, end);
    }
  } catch {
    failLocal();
    deps.send({ kind: "attachment-abort", transferId });
    return;
  }
  deps.send({ kind: "attachment-commit", transferId });
}
