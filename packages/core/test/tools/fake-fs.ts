// 测试公共内存 FileSystemProvider（P4b：文件三动作需要 stat/readHead/text 全文——
// readTextFile 的 maxChars 截断语义不适用于窗口分页，文件动作走 readTextFileFull）。

import type { FileSystemProvider } from "../../src/tools/fs.js";

export interface FakeFs extends FileSystemProvider {
  /** 路径 → 内容（字符串按 utf-8 字节计量；Uint8Array 原样） */
  files: Map<string, string | Uint8Array>;
  dirs: string[];
  textWrites: Array<[string, string]>;
  byteWrites: Array<[string, Uint8Array]>;
}

export function makeFakeFs(initial: Record<string, string | Uint8Array> = {}): FakeFs {
  const files = new Map(Object.entries(initial));
  return {
    files,
    dirs: [],
    textWrites: [],
    byteWrites: [],
    resolve: (p) => p,
    async isFile(p) {
      const v = files.get(p);
      return v !== undefined;
    },
    async readTextFile(p, maxChars) {
      const v = files.get(p);
      if (typeof v !== "string") return "";
      return maxChars === undefined ? v : v.slice(0, maxChars);
    },
    async ensureDir(p) {
      this.dirs.push(p);
    },
    async writeTextFile(p, content) {
      files.set(p, content);
      this.textWrites.push([p, content]);
    },
    async writeBytes(p, data) {
      files.set(p, data);
      this.byteWrites.push([p, data]);
    },
    async stat(p) {
      const v = files.get(p);
      if (v === undefined) return null;
      return { size: typeof v === "string" ? new TextEncoder().encode(v).length : v.length };
    },
    async readHead(p, n) {
      const v = files.get(p);
      if (v === undefined) return null;
      const bytes = typeof v === "string" ? new TextEncoder().encode(v) : v;
      return bytes.slice(0, n);
    },
  };
}
