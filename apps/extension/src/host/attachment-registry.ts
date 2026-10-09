// 附件注册表（m5/04 §7）：SW 内存 Map（attachmentId → bytes/元信息）。用户在
// 侧边栏选文件（attachment-add，base64 → bytes）入表；run 的 FileSystemProvider
// 装饰（readAttachment）按 "attachment:<id>" 引用解析。SW 被杀=注册表丢——journal
// 的 attachments 字段留元信息，恢复呈现时 UI 提示重选（不做字节级持久化——
// chrome.storage 塞大视频不合理，登记有意偏离）。run 结束清表（绑 run 生命周期）。

export interface AttachmentEntry {
  bytes: Uint8Array;
  name: string;
  mimeType: string;
  size: number;
}

/** 单附件/总量硬限（m5/04 §7：video 场景够用） */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 200 * 1024 * 1024;

/** base64 → bytes（atob 逐字节；SW/页面同源 API） */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export class AttachmentRegistry {
  private nextId = 1;
  private readonly entries = new Map<string, AttachmentEntry>();
  private readonly maxBytes: number;
  private readonly maxTotalBytes: number;

  constructor(options: { maxBytes?: number; maxTotalBytes?: number } = {}) {
    this.maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_ATTACHMENT_BYTES;
  }

  /**
   * 入表（attachment-add 消费端）。拒绝面：
   * - 空 payload（base64/name/mimeType 任一非字符串或空）→ "invalid"；
   * - 单附件超限 → "too-large"；
   * - 总量超限 → "total-exceeded"。
   * 成功返回新 attachmentId（att_1 自增）。
   */
  add(
    base64: string,
    name: string,
    mimeType: string,
  ):
    | { ok: true; attachmentId: string }
    | {
        ok: false;
        reason: "invalid" | "too-large" | "total-exceeded";
        size: number;
        limit: number;
      } {
    // 信封层只校验 kind 不校验字段类型——UI 消息字段以 unknown 形态可达
    //（评审轮 1 [3]）：typeof 判面 + atob 非法字符（dataURL 前缀/空白）结构化拒绝
    if (
      typeof base64 !== "string" ||
      base64 === "" ||
      typeof name !== "string" ||
      name === "" ||
      typeof mimeType !== "string" ||
      mimeType === ""
    ) {
      return { ok: false, reason: "invalid", size: 0, limit: 0 };
    }
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(base64);
    } catch {
      return { ok: false, reason: "invalid", size: 0, limit: 0 };
    }
    if (bytes.length > this.maxBytes) {
      return { ok: false, reason: "too-large", size: bytes.length, limit: this.maxBytes };
    }
    let total = bytes.length;
    for (const e of this.entries.values()) total += e.size;
    if (total > this.maxTotalBytes) {
      return { ok: false, reason: "total-exceeded", size: total, limit: this.maxTotalBytes };
    }
    const attachmentId = `att_${this.nextId}`;
    this.nextId += 1;
    this.entries.set(attachmentId, { bytes, name, mimeType, size: bytes.length });
    return { ok: true, attachmentId };
  }

  remove(attachmentId: string): boolean {
    return this.entries.delete(attachmentId);
  }

  /** UI 投影（attachments 广播 + journal attachments 字段） */
  list(): Array<{ attachmentId: string; name: string; mimeType: string; size: number }> {
    return [...this.entries.entries()].map(([attachmentId, e]) => ({
      attachmentId,
      name: e.name,
      mimeType: e.mimeType,
      size: e.size,
    }));
  }

  /** run 结束清表（绑 run 生命周期——下一 run 从 att_1 重新编号） */
  clearForRun(): void {
    this.entries.clear();
    this.nextId = 1;
  }

  /**
   * "attachment:att_1" 引用解析（FileSystemProvider.readAttachment 装饰消费）。
   * 非 attachment: 前缀 / 未注册 → null（调用方回退原路径分支）。
   */
  resolve(
    ref: string,
  ): { base64: string; filename: string; mimeType: string; size: number } | null {
    if (!ref.startsWith("attachment:")) return null;
    const entry = this.entries.get(ref.slice("attachment:".length));
    if (entry === undefined) return null;
    let binary = "";
    for (let i = 0; i < entry.bytes.length; i++) binary += String.fromCharCode(entry.bytes[i]);
    return {
      base64: btoa(binary),
      filename: entry.name,
      mimeType: entry.mimeType,
      size: entry.size,
    };
  }
}
