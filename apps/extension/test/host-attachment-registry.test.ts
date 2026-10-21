// 附件注册表单测（m5/04 §7；issue #2 C 档）：begin/append/commit/abort 传输状态机 +
// remove/list/clearForRun/resolve 引用解析 + 单附件/总量硬限（上限注入——不造百兆
// 载荷，含 pending 占位竞态封死）+ 严格顺序错位防御 + 无活动超时清理。

import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentRegistry } from "../src/host/attachment-registry.js";

const enc = new TextEncoder();
const b64 = (s: string): string => btoa(s);
const b64Bytes = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};

/** 单文件完整传输：begin → 整串一块 commit（多数用例的便捷路径） */
const put = (reg: AttachmentRegistry, id: string, s: string, name = "a", mime = "m") => {
  const bytes = enc.encode(s);
  const b = reg.begin(id, name, mime, bytes.length);
  if (!b.ok) return b;
  reg.append(id, 0, b64Bytes(bytes));
  return reg.commit(id);
};

describe("AttachmentRegistry", () => {
  it("完整传输：begin → 多块顺序 append → commit 自增 id + list 投影 + resolve base64 往返", () => {
    const reg = new AttachmentRegistry();
    const bytes = enc.encode("0123456789");
    expect(reg.begin("t1", "a.mp4", "video/mp4", bytes.length)).toEqual({ ok: true });
    // 两块：4 + 6 字节（跨块边界）
    expect(reg.append("t1", 0, b64Bytes(bytes.subarray(0, 4)))).toBe(true);
    expect(reg.append("t1", 4, b64Bytes(bytes.subarray(4)))).toBe(true);
    expect(reg.commit("t1")).toEqual({ ok: true, attachmentId: "att_1" });
    expect(reg.list()).toEqual([
      { attachmentId: "att_1", name: "a.mp4", mimeType: "video/mp4", size: 10 },
    ]);
    expect(put(reg, "t2", "de", "b.png", "image/png")).toEqual({ ok: true, attachmentId: "att_2" });
    const resolved = reg.resolve("attachment:att_1");
    expect(resolved).not.toBeNull();
    expect(resolved).toMatchObject({ filename: "a.mp4", mimeType: "video/mp4", size: 10 });
    // base64 往返逐字节对拍（core readAttachment 契约面）
    expect(atob(resolved!.base64)).toBe("0123456789");
  });

  it("resolve：非 attachment: 前缀 / 未注册 → null（调用方回退原路径分支）", () => {
    const reg = new AttachmentRegistry();
    expect(reg.resolve("/os/path.png")).toBeNull();
    expect(reg.resolve("attachment:att_99")).toBeNull();
  });

  it("remove + clearForRun（run 结束清表、编号归 1；pending 连计时器一并清）", () => {
    const reg = new AttachmentRegistry();
    put(reg, "t1", "x", "a", "text/plain");
    expect(reg.remove("att_1")).toBe(true);
    expect(reg.remove("att_1")).toBe(false);
    expect(reg.list()).toEqual([]);
    // pending 中直接清表——预算同步释放
    reg.begin("t2", "b", "m", 5);
    expect(reg.budget().pendingBytes).toBe(5);
    reg.clearForRun();
    expect(reg.budget()).toMatchObject({ usedBytes: 0, pendingBytes: 0 });
    expect(reg.commit("t2")).toEqual({ ok: false });
    expect(put(reg, "t3", "z", "c", "text/plain")).toEqual({ ok: true, attachmentId: "att_1" });
  });

  it("begin 拒绝面：invalid / 单附件超限 / 总量超限（上限注入——拒绝带 size/limit）", () => {
    const reg = new AttachmentRegistry({ maxBytes: 10, maxTotalBytes: 15 });
    expect(reg.begin("", "a", "m", 1)).toMatchObject({ ok: false, reason: "invalid" });
    expect(reg.begin("t", "", "m", 1)).toMatchObject({ ok: false, reason: "invalid" });
    expect(reg.begin("t", "a", "", 1)).toMatchObject({ ok: false, reason: "invalid" });
    expect(reg.begin("t", "a", "m", 0)).toMatchObject({ ok: false, reason: "invalid" });
    expect(reg.begin("t", "a", "m", 3.5)).toMatchObject({ ok: false, reason: "invalid" });
    expect(reg.begin("t", "a", "m", -1)).toMatchObject({ ok: false, reason: "invalid" });
    expect(reg.begin("t", 123 as never, "m", 1)).toMatchObject({ ok: false, reason: "invalid" });
    expect(reg.begin("t", "a", "m", 11)).toEqual({
      ok: false,
      reason: "too-large",
      size: 11,
      limit: 10,
    });
    expect(put(reg, "t1", "12345678", "a", "m")).toEqual({ ok: true, attachmentId: "att_1" });
    // 总量：已入 8 + 新 8 > 15
    expect(reg.begin("t2", "b", "m", 8)).toEqual({
      ok: false,
      reason: "total-exceeded",
      size: 16,
      limit: 15,
    });
  });

  it("总量占位竞态封死：并发 begin 各自过单件限但 pending 也计入总量", () => {
    const reg = new AttachmentRegistry({ maxBytes: 10, maxTotalBytes: 15 });
    expect(reg.begin("t1", "a", "m", 8)).toEqual({ ok: true });
    // 无第一条 committed 也有 pending 占位：8 + 8 > 15 → 拒
    expect(reg.begin("t2", "b", "m", 8)).toEqual({
      ok: false,
      reason: "total-exceeded",
      size: 16,
      limit: 15,
    });
  });

  it("invalid 硬化：重复 transferId / size 非数结构化拒绝不抛", () => {
    const reg = new AttachmentRegistry();
    expect(reg.begin("dup", "a", "m", 3)).toEqual({ ok: true });
    expect(reg.begin("dup", "a", "m", 3)).toMatchObject({ ok: false, reason: "invalid" });
    expect(reg.begin("t", "a", "m", undefined as never)).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(reg.list()).toEqual([]); // pending 不进 list
  });

  it("append 严格顺序防御：错位/重复/越界/未知 id/非 ArrayBuffer → false 且废整条 pending", () => {
    const reg = new AttachmentRegistry();
    reg.begin("t1", "a", "m", 8);
    expect(reg.append("t1", 0, b64("0123"))).toBe(true);
    expect(reg.append("t1", 0, b64("5678"))).toBe(false); // 重复 offset
    expect(reg.append("t1", 8, b64("5678"))).toBe(false); // 越界（8+4 > 8）
    expect(reg.append("t1", 1.5 as never, b64("5678"))).toBe(false); // 非整数 offset
    expect(reg.append("tX", 0, b64("5678"))).toBe(false); // 未知 transferId
    expect(reg.append("t1", 4, "not-base64!!" as never)).toBe(false); // 非法 base64
    expect(reg.append("t1", 4, undefined as never)).toBe(false); // 非 string（信封只校验 kind）
    // 错位后整条已废：预算释放、commit 失败无 meta（彻底未知）
    expect(reg.budget().pendingBytes).toBe(0);
    expect(reg.commit("t1")).toEqual({ ok: false });
    // 干净路径上真正的错位块同样废整传
    reg.begin("t2", "b", "m", 8);
    expect(reg.append("t2", 4, b64("5678"))).toBe(false); // 首块就不从 0 开始
    expect(reg.commit("t2")).toEqual({ ok: false });
  });

  it("commit 半传 → 失败带回 meta（lost 广播展示面）；abort 主动废弃", () => {
    const reg = new AttachmentRegistry();
    reg.begin("t1", "a", "m", 8);
    reg.append("t1", 0, b64("0123"));
    expect(reg.commit("t1")).toEqual({ ok: false, meta: { name: "a", mimeType: "m", size: 8 } });
    expect(reg.budget().pendingBytes).toBe(0);
    reg.begin("t2", "b", "m", 4);
    reg.abort("t2");
    expect(reg.commit("t2")).toEqual({ ok: false });
  });

  it("budget 三态：空 → pending 占位 → committed 落定", () => {
    const reg = new AttachmentRegistry({ maxBytes: 10, maxTotalBytes: 20 });
    expect(reg.budget()).toEqual({
      usedBytes: 0,
      pendingBytes: 0,
      maxBytes: 10,
      maxTotalBytes: 20,
    });
    reg.begin("t1", "a", "m", 6);
    expect(reg.budget()).toMatchObject({ usedBytes: 6, pendingBytes: 6 });
    reg.append("t1", 0, b64("012345"));
    reg.commit("t1");
    expect(reg.budget()).toMatchObject({ usedBytes: 6, pendingBytes: 0 });
  });

  it("pending 无活动超时清理（append 重置计时）", () => {
    vi.useFakeTimers();
    const reg = new AttachmentRegistry({ timeoutMs: 1000 });
    reg.begin("t1", "a", "m", 8);
    reg.append("t1", 0, b64("0123"));
    vi.advanceTimersByTime(900);
    reg.append("t1", 4, b64("4567")); // 重置计时
    vi.advanceTimersByTime(900);
    expect(reg.commit("t1")).toEqual({ ok: true, attachmentId: "att_1" }); // 未超时
    reg.begin("t2", "b", "m", 4);
    vi.advanceTimersByTime(1000);
    expect(reg.commit("t2")).toEqual({ ok: false }); // 超时已清
    expect(reg.budget().pendingBytes).toBe(0);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
