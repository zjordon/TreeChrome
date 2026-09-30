// NodeFs：架构 §4 FileSystemProvider 的 node:fs 实现（node-host 方案 §4）。
// 从 examples/basic-agent.mjs 厚版收编——examples/cli/web-console 共享。
// extract 大结果落盘 / done 附件 / 文件三动作 / 截图落盘（vision 开启时）经此注入。

import * as fsp from "node:fs/promises";
import { resolve as pathResolve } from "node:path";
import type { FileSystemProvider } from "@tw/core";

export class NodeFs implements FileSystemProvider {
  resolve(path: string): string {
    return pathResolve(path);
  }

  async isFile(path: string): Promise<boolean> {
    try {
      return (await fsp.stat(path)).isFile();
    } catch {
      return false;
    }
  }

  async readTextFile(path: string, maxChars?: number): Promise<string> {
    const bytes = await fsp.readFile(path);
    // 严格 utf-8 解码（契约：非法字节 reject，等价 Python UnicodeDecodeError；
    // Buffer.toString 的 utf8 是 lenient——会静默腐蚀成 U+FFFD）
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return maxChars === undefined ? text : text.slice(0, maxChars);
  }

  async ensureDir(path: string): Promise<void> {
    await fsp.mkdir(path, { recursive: true });
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    await fsp.writeFile(path, content, "utf8");
  }

  async appendTextFile(path: string, content: string): Promise<void> {
    await fsp.appendFile(path, content, "utf8");
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    await fsp.writeFile(path, data);
  }

  async stat(path: string): Promise<{ size: number } | null> {
    try {
      const st = await fsp.stat(path);
      return { size: st.size };
    } catch {
      return null;
    }
  }

  async readHead(path: string, n: number): Promise<Uint8Array | null> {
    let fh: Awaited<ReturnType<typeof fsp.open>> | null = null;
    try {
      fh = await fsp.open(path, "r");
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, 0);
      return buf.subarray(0, bytesRead);
    } catch {
      return null;
    } finally {
      await fh?.close();
    }
  }
}
