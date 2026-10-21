// 附件注册表（m5/04 §7；issue #2 C 档改分块二进制传输）：SW 内存 Map，两态——
// pending（attachment-begin 预分配，transferId 键）→ committed（commit 转正，
// attachmentId 键）。字节经 port 结构化克隆分块写入（4MB/块，严格顺序）；run 的
// FileSystemProvider 装饰（readAttachment）按 "attachment:<id>" 引用解析，读取时
// bytes→base64（core 契约面不变）。SW 被杀=注册表丢——journal 的 attachments 字段
// 留元信息，恢复呈现时 UI 提示重选（不做字节级持久化——chrome.storage 塞大视频
// 不合理，登记有意偏离）。run 结束清表（绑 run 生命周期，pending 一并清）。

export interface AttachmentEntry {
  bytes: Uint8Array;
  name: string;
  mimeType: string;
  size: number;
}

/** 单附件/总量硬限（m5/04 §7：video 场景够用） */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 200 * 1024 * 1024;

/** base64 → bytes（atob 逐字节；块级解码——SW/页面同源 API） */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** pending 传输无活动超时（UI 断连/SW 侧残留防御；append 重置） */
export const ATTACHMENT_TRANSFER_TIMEOUT_MS = 60_000;

/** begin/commit 的结构化拒绝面（run-manager 转 attachment-rejected 广播给 UI） */
export type AttachmentReject = {
  ok: false;
  reason: "invalid" | "too-large" | "total-exceeded";
  size: number;
  limit: number;
};

interface PendingTransfer {
  name: string;
  mimeType: string;
  size: number;
  buf: Uint8Array;
  /** 下一期望块偏移（严格顺序——错位即废整传） */
  written: number;
  timer: number;
}

export class AttachmentRegistry {
  private nextId = 1;
  private readonly entries = new Map<string, AttachmentEntry>();
  private readonly pending = new Map<string, PendingTransfer>();
  private readonly maxBytes: number;
  private readonly maxTotalBytes: number;
  private readonly timeoutMs: number;

  constructor(options: { maxBytes?: number; maxTotalBytes?: number; timeoutMs?: number } = {}) {
    this.maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_ATTACHMENT_BYTES;
    this.timeoutMs = options.timeoutMs ?? ATTACHMENT_TRANSFER_TIMEOUT_MS;
  }

  /**
   * 传输开始（attachment-begin 消费端）：预检 + 预分配。拒绝面（信封层只校验 kind
   * 不校验字段类型——UI 消息字段以 unknown 形态可达，沿用评审轮 1 [3] 的 typeof 判面）：
   * - 字段坏 / size 非正整数 / transferId 重复 → "invalid"；
   * - size 超单件 → "too-large"（limit=maxBytes）；
   * - 已入表+在途总量超限 → "total-exceeded"（limit=maxTotalBytes，pending 占位——
   *   并发 begin 都过检再各自落满的竞态由此封死）。
   */
  begin(
    transferId: string,
    name: string,
    mimeType: string,
    size: number,
  ): { ok: true } | AttachmentReject {
    if (
      typeof transferId !== "string" ||
      transferId === "" ||
      this.pending.has(transferId) ||
      typeof name !== "string" ||
      name === "" ||
      typeof mimeType !== "string" ||
      mimeType === "" ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size <= 0
    ) {
      return { ok: false, reason: "invalid", size: 0, limit: 0 };
    }
    if (size > this.maxBytes) {
      return { ok: false, reason: "too-large", size, limit: this.maxBytes };
    }
    if (this.usedBytes() + size > this.maxTotalBytes) {
      return {
        ok: false,
        reason: "total-exceeded",
        size: this.usedBytes() + size,
        limit: this.maxTotalBytes,
      };
    }
    this.pending.set(transferId, {
      name,
      mimeType,
      size,
      buf: new Uint8Array(size),
      written: 0,
      timer: this.armTimeout(transferId),
    });
    return { ok: true };
  }

  /**
   * 分块写入（attachment-chunk 消费端；块载荷 base64——JSON 通道实证见 protocol
   * 注释）。严格顺序：offset 必须等于已写偏移，错位/重复/越界/未知 transferId/
   * 非字符串/非法 base64 一律废弃整条 pending 并返回 false（UI 断连重连错位时的
   * 防御——残留半传不占预算、不可 commit）。
   */
  append(transferId: string, offset: number, data: string): boolean {
    const p = this.pending.get(transferId);
    if (
      p === undefined ||
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset !== p.written ||
      typeof data !== "string" ||
      data === ""
    ) {
      this.dropPending(transferId);
      return false;
    }
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(data);
    } catch {
      this.dropPending(transferId);
      return false;
    }
    if (bytes.length === 0 || offset + bytes.length > p.size) {
      this.dropPending(transferId);
      return false;
    }
    p.buf.set(bytes, offset);
    p.written = offset + bytes.length;
    this.resetTimeout(p, transferId);
    return true;
  }

  /**
   * 转正（attachment-commit 消费端）：写满才可转——半传/未知 transferId 返回
   * {ok:false}（失败时带回 pending 元信息供 lost 拒绝广播展示；已被超时/错位清理
   * 的彻底未知则无 meta，UI 侧按 transferId 用本地记录补）。
   */
  commit(
    transferId: string,
  ):
    | { ok: true; attachmentId: string }
    | { ok: false; meta?: { name: string; mimeType: string; size: number } } {
    const p = this.pending.get(transferId);
    if (p === undefined) {
      return { ok: false };
    }
    if (p.written !== p.size) {
      const meta = { name: p.name, mimeType: p.mimeType, size: p.size };
      this.dropPending(transferId);
      return { ok: false, meta };
    }
    const attachmentId = `att_${this.nextId}`;
    this.nextId += 1;
    this.entries.set(attachmentId, {
      bytes: p.buf,
      name: p.name,
      mimeType: p.mimeType,
      size: p.size,
    });
    this.dropPending(transferId);
    return { ok: true, attachmentId };
  }

  /** 主动废弃（attachment-abort 消费端 / UI 读文件失败兜底） */
  abort(transferId: string): void {
    this.dropPending(transferId);
  }

  remove(attachmentId: string): boolean {
    return this.entries.delete(attachmentId);
  }

  /** UI 投影（attachments 广播 + journal attachments 字段）——只见 committed */
  list(): Array<{ attachmentId: string; name: string; mimeType: string; size: number }> {
    return [...this.entries.entries()].map(([attachmentId, e]) => ({
      attachmentId,
      name: e.name,
      mimeType: e.mimeType,
      size: e.size,
    }));
  }

  /** 预算投影（attachments 广播 budget 字段；usedBytes 已含在途 pending） */
  budget(): { usedBytes: number; pendingBytes: number; maxBytes: number; maxTotalBytes: number } {
    let pendingBytes = 0;
    for (const p of this.pending.values()) pendingBytes += p.size;
    return {
      usedBytes: this.committedBytes() + pendingBytes,
      pendingBytes,
      maxBytes: this.maxBytes,
      maxTotalBytes: this.maxTotalBytes,
    };
  }

  /** run 结束清表（绑 run 生命周期——下一 run 从 att_1 重新编号；pending 连计时器一并清） */
  clearForRun(): void {
    for (const transferId of this.pending.keys()) this.dropPending(transferId);
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

  private committedBytes(): number {
    let total = 0;
    for (const e of this.entries.values()) total += e.size;
    return total;
  }

  private usedBytes(): number {
    let pendingBytes = 0;
    for (const p of this.pending.values()) pendingBytes += p.size;
    return this.committedBytes() + pendingBytes;
  }

  private armTimeout(transferId: string): number {
    return setTimeout(() => this.dropPending(transferId), this.timeoutMs) as unknown as number;
  }

  private resetTimeout(p: PendingTransfer, transferId: string): void {
    clearTimeout(p.timer);
    p.timer = this.armTimeout(transferId);
  }

  private dropPending(transferId: string): void {
    const p = this.pending.get(transferId);
    if (p === undefined) return;
    clearTimeout(p.timer);
    this.pending.delete(transferId);
  }
}
