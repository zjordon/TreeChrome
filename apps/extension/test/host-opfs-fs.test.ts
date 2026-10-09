// OpfsFs 单测（m5/04 §6）：fake 目录句柄树（内存 Map 化 OPFS）——resolve 归一 /
// write+read（严格 utf-8：非法字节 reject）/ append 字节级 / stat / readHead /
// ensureDir 嵌套。

import { describe, expect, it } from "vitest";
import {
  type DirHandleLike,
  type FileHandleLike,
  type FileLike,
  OpfsFs,
  type WritableLike,
} from "../src/host/opfs-fs.js";

class NotFoundError extends Error {
  constructor() {
    super("NotFoundError");
    this.name = "NotFoundError";
  }
}

/** 内存文件（getDirectoryHandle 仅支持单段名——OpfsFs 逐段走） */
function makeFakeOpfs(): DirHandleLike {
  const files = new Map<string, Uint8Array>(); // "a/b/c.txt" → bytes

  const keyOf = (segs: string[], name: string): string => [...segs, name].join("/");
  const hasPrefix = (key: string): boolean => {
    for (const k of files.keys()) if (k === key || k.startsWith(`${key}/`)) return true;
    return false;
  };

  const makeFile = (bytes: Uint8Array): FileLike => ({
    size: bytes.length,
    async text() {
      return new TextDecoder().decode(bytes);
    },
    async arrayBuffer() {
      return bytes.slice().buffer as ArrayBuffer;
    },
    slice(start, end) {
      return makeFile(bytes.slice(start, end));
    },
  });

  const makeHandle = (key: string): FileHandleLike => ({
    async getFile() {
      const bytes = files.get(key);
      if (bytes === undefined) throw new NotFoundError();
      return makeFile(bytes);
    },
    async createWritable(opts) {
      const initial = opts?.keepExistingData === true ? files.get(key) : undefined;
      let buffer = initial !== undefined ? new Uint8Array(initial) : new Uint8Array(0);
      let position = 0;
      const writable: WritableLike = {
        async write(data) {
          if (typeof data === "object" && !(data instanceof Uint8Array) && "type" in data) {
            position = data.position;
            return;
          }
          const chunk =
            typeof data === "string" ? new TextEncoder().encode(data) : (data as Uint8Array);
          const next = new Uint8Array(Math.max(buffer.length, position + chunk.length));
          next.set(buffer.subarray(0, Math.min(buffer.length, next.length)));
          next.set(chunk, position);
          buffer = next;
          position += chunk.length;
        },
        async close() {
          files.set(key, buffer);
        },
      };
      return writable;
    },
  });

  const makeDir = (segs: string[]): DirHandleLike => ({
    async getDirectoryHandle(name, opts) {
      const child = [...segs, name];
      const exists = hasPrefix(child.join("/"));
      if (!exists && opts?.create !== true) throw new NotFoundError();
      return makeDir(child);
    },
    async getFileHandle(name, opts) {
      const key = keyOf(segs, name);
      const exists = files.has(key);
      if (!exists && opts?.create !== true) throw new NotFoundError();
      if (!exists) files.set(key, new Uint8Array(0));
      return makeHandle(key);
    },
  });

  return makeDir([]);
}

describe("OpfsFs", () => {
  // 单根复用（getRoot 每次调用返回同一根——write 与后续 read 共享同一文件树）
  const make = () => {
    const root = makeFakeOpfs();
    return new OpfsFs(async () => root);
  };

  it("resolve：反斜杠/空段/./.. 归一（恒以 / 开头）", () => {
    const fs = make();
    expect(fs.resolve("a\\b\\c")).toBe("/a/b/c");
    expect(fs.resolve("./a//b")).toBe("/a/b");
    expect(fs.resolve("/a/b/../c")).toBe("/a/c");
    expect(fs.resolve("..")).toBe("/");
  });

  it("writeTextFile + readTextFile 全读/maxChars + isFile/stat/readHead", async () => {
    const fs = make();
    await fs.writeTextFile("/out/a.txt", "你好 abc");
    expect(await fs.isFile("/out/a.txt")).toBe(true);
    expect(await fs.isFile("/out/ghost")).toBe(false);
    expect(await fs.readTextFile("/out/a.txt")).toBe("你好 abc");
    expect(await fs.readTextFile("/out/a.txt", 2)).toBe("你好");
    expect(await fs.stat("/out/a.txt")).toEqual({ size: 10 }); // 2×3 中文 + 空格 + 3 ASCII
    expect(await fs.stat("/out/ghost")).toBeNull();
    expect(await fs.readHead("/out/a.txt", 3)).toEqual(new TextEncoder().encode("你"));
    expect(await fs.readHead("/out/ghost", 3)).toBeNull();
  });

  it("readTextFile 严格 utf-8：非法字节 reject（core 契约——不腐蚀成 U+FFFD）", async () => {
    const fs = make();
    await fs.writeBytes("/bad.bin", new Uint8Array([0xff, 0xfe, 0x00]));
    await expect(fs.readTextFile("/bad.bin")).rejects.toThrow();
  });

  it("appendTextFile：不存在创建；既有内容后接（字节级——二进制不被重解码）", async () => {
    const fs = make();
    await fs.appendTextFile("/log.txt", "a=");
    await fs.appendTextFile("/log.txt", "b");
    expect(await fs.readTextFile("/log.txt")).toBe("a=b");
    await fs.writeBytes("/bin.dat", new Uint8Array([1, 2]));
    await fs.appendTextFile("/bin.dat", "x");
    expect(await fs.readHead("/bin.dat", 10)).toEqual(new Uint8Array([1, 2, 0x78]));
  });

  it("ensureDir 嵌套 + 根路径写入拒绝", async () => {
    const fs = make();
    await fs.ensureDir("/x/y/z");
    await fs.writeTextFile("/x/y/z/f.txt", "v");
    expect(await fs.readTextFile("/x/y/z/f.txt")).toBe("v");
    await expect(fs.writeTextFile("/", "x")).rejects.toThrow("不可为根");
  });
});
