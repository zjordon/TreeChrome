// 附件注册表单测（m5/04 §7）：add/remove/list/clearForRun/resolve 引用解析 +
// 单附件/总量硬限拒绝面（上限可注入——不造百兆载荷）+ base64 往返。

import { describe, expect, it } from "vitest";
import { AttachmentRegistry, base64ToBytes } from "../src/host/attachment-registry.js";

const b64 = (s: string): string => btoa(s);

describe("AttachmentRegistry", () => {
  it("add → 自增 id + list 投影 + resolve base64 往返", () => {
    const reg = new AttachmentRegistry();
    const r1 = reg.add(b64("abc"), "a.mp4", "video/mp4");
    const r2 = reg.add(b64("de"), "b.png", "image/png");
    expect(r1).toEqual({ ok: true, attachmentId: "att_1" });
    expect(r2).toEqual({ ok: true, attachmentId: "att_2" });
    expect(reg.list()).toEqual([
      { attachmentId: "att_1", name: "a.mp4", mimeType: "video/mp4", size: 3 },
      { attachmentId: "att_2", name: "b.png", mimeType: "image/png", size: 2 },
    ]);
    const resolved = reg.resolve("attachment:att_1");
    expect(resolved).not.toBeNull();
    expect(base64ToBytes(resolved!.base64)).toEqual(new TextEncoder().encode("abc"));
    expect(resolved).toMatchObject({ filename: "a.mp4", mimeType: "video/mp4", size: 3 });
  });

  it("resolve：非 attachment: 前缀 / 未注册 → null（调用方回退原路径分支）", () => {
    const reg = new AttachmentRegistry();
    expect(reg.resolve("/os/path.png")).toBeNull();
    expect(reg.resolve("attachment:att_99")).toBeNull();
  });

  it("remove + clearForRun（run 结束清表、编号归 1）", () => {
    const reg = new AttachmentRegistry();
    reg.add(b64("x"), "a", "text/plain");
    expect(reg.remove("att_1")).toBe(true);
    expect(reg.remove("att_1")).toBe(false);
    expect(reg.list()).toEqual([]);
    reg.add(b64("y"), "b", "text/plain");
    reg.clearForRun();
    expect(reg.add(b64("z"), "c", "text/plain")).toEqual({ ok: true, attachmentId: "att_1" });
  });

  it("拒绝面：invalid / 单附件超限 / 总量超限（上限注入——拒绝文案带 size/limit）", () => {
    const reg = new AttachmentRegistry({ maxBytes: 10, maxTotalBytes: 15 });
    expect(reg.add("", "a", "m")).toMatchObject({ ok: false, reason: "invalid" });
    expect(reg.add(b64("x"), "", "m")).toMatchObject({ ok: false, reason: "invalid" });
    expect(reg.add(b64("x"), "a", "")).toMatchObject({ ok: false, reason: "invalid" });
    const tooLarge = reg.add(b64("0123456789x"), "big", "m");
    expect(tooLarge).toEqual({ ok: false, reason: "too-large", size: 11, limit: 10 });
    // 总量：8 + 8 > 15
    expect(reg.add(b64("12345678"), "a", "m")).toEqual({ ok: true, attachmentId: "att_1" });
    expect(reg.add(b64("12345678"), "b", "m")).toEqual({
      ok: false,
      reason: "total-exceeded",
      size: 16,
      limit: 15,
    });
  });

  it("invalid 硬化：非字符串字段 / 非法 base64（dataURL 前缀、空白）结构化拒绝不抛", () => {
    const reg = new AttachmentRegistry();
    // UI 消息信封只校验 kind——字段以 unknown 形态可达（cast 模拟运行时形态）
    expect(reg.add(undefined as never, "a", "m")).toMatchObject({ ok: false, reason: "invalid" });
    expect(reg.add(b64("x"), 123 as never, "m")).toMatchObject({ ok: false, reason: "invalid" });
    expect(reg.add(b64("x"), "a", null as never)).toMatchObject({ ok: false, reason: "invalid" });
    expect(reg.add("data:video/mp4;base64,AAAA", "a.mp4", "video/mp4")).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    // 注：atob 是 forgiving-base64——内部空白会被剥除后解码成功，不属拒绝面
    expect(reg.add("not-base64!!", "a", "m")).toMatchObject({ ok: false, reason: "invalid" });
    expect(reg.add("A", "a", "m")).toMatchObject({ ok: false, reason: "invalid" });
    expect(reg.list()).toEqual([]); // 全部未入表
  });
});
