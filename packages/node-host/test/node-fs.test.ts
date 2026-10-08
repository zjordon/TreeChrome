// NodeFs 全九成员行为（真实 tmpdir 文件系统；不触网）。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { NodeFs } from "../src/node-fs.js";

let dir: string;
const fs = new NodeFs();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tw-node-host-fs-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("NodeFs", () => {
  test("resolve 相对路径→绝对路径", () => {
    expect(fs.resolve("a/b.txt")).toBe(join(process.cwd(), "a", "b.txt"));
  });

  test("writeTextFile + readTextFile 全读 / maxChars 窗口", async () => {
    const p = join(dir, "t1.txt");
    await fs.writeTextFile(p, "你好 abc");
    expect(await fs.readTextFile(p)).toBe("你好 abc");
    expect(await fs.readTextFile(p, 2)).toBe("你好");
  });

  test("readTextFile 严格 utf-8：非法字节 reject（非 U+FFFD 腐蚀）", async () => {
    const p = join(dir, "bin.dat");
    await fs.writeBytes(p, new Uint8Array([0x61, 0xff, 0xfe, 0x62]));
    await expect(fs.readTextFile(p)).rejects.toThrow();
  });

  test("appendTextFile：不存在则创建；追加不触既有内容", async () => {
    const p = join(dir, "t2.txt");
    await fs.appendTextFile(p, "a");
    await fs.appendTextFile(p, "b");
    expect(await fs.readTextFile(p)).toBe("ab");
    // 既有非 utf-8 字节零接触：二进制头 + 文本尾，头仍可按字节读回
    const p2 = join(dir, "t3.dat");
    await fs.writeBytes(p2, new Uint8Array([0x00, 0x01, 0x02]));
    await fs.appendTextFile(p2, "x");
    expect((await fs.readHead(p2, 3))?.join(",")).toBe("0,1,2");
  });

  test("writeBytes / readHead：n 字节头、越界=全量、缺文件=null", async () => {
    const p = join(dir, "t4.bin");
    await fs.writeBytes(p, new Uint8Array([1, 2, 3, 4, 5]));
    expect((await fs.readHead(p, 2))?.join(",")).toBe("1,2");
    expect((await fs.readHead(p, 99))?.length).toBe(5);
    expect(await fs.readHead(join(dir, "missing.bin"), 4)).toBeNull();
  });

  test("stat：存在 {size} / 缺失 null", async () => {
    const p = join(dir, "t5.txt");
    await fs.writeTextFile(p, "12345");
    expect(await fs.stat(p)).toEqual({ size: 5 });
    expect(await fs.stat(join(dir, "nope"))).toBeNull();
  });

  test("isFile / ensureDir 嵌套", async () => {
    const nested = join(dir, "a", "b", "c");
    await fs.ensureDir(nested);
    const f = join(nested, "f.txt");
    writeFileSync(f, "x");
    expect(await fs.isFile(f)).toBe(true);
    expect(await fs.isFile(nested)).toBe(false); // 目录不是文件
    expect(await fs.isFile(join(dir, "nope"))).toBe(false);
  });

  // M5 段 C 红向保真：NodeFs 不实现 readAttachment（路径宿主语义——附件句柄是
  // 扩展形态缝；Node 侧 upload_file 永走路径分支，登记出界项）
  test("readAttachment 未实现（Node 行为零变化的缝证明）", () => {
    expect((fs as Partial<Record<"readAttachment", unknown>>).readAttachment).toBeUndefined();
  });
});
