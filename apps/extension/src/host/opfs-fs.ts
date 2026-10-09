// OPFS FileSystemProvider（m5/04 §6）：navigator.storage.getDirectory() 根 =
// 虚拟工作区（write_file/read_file/replace_file/截图落盘/done 附件全链可用）。
// resolve() = OPFS 名空间内路径归一（无 OS abspath 语义——白名单前缀比对在
// OPFS 名空间内自洽）。readAttachment 不实现（附件走注册表——段 C 缝在
// ToolsOptions.fs 之外单注）。
// 登记偏离：done 附件（files_to_display）扩展形态只入 journal（UI 可点击预览），
// 不出 OS 文件系统；write 的 OS 落盘（downloads 目录）后置 M6。
//
// 注入面：构造收 getRoot（缺省真 OPFS；单测注入 fake 目录句柄树）。

/** OPFS 目录句柄消费面（lib.dom FileSystemDirectoryHandle 的结构子集） */
export interface DirHandleLike {
  getFileHandle(name: string): Promise<FileHandleLike>;
  getFileHandle(name: string, opts: { create: true }): Promise<FileHandleLike>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandleLike>;
}

export interface FileLike {
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  slice(start: number, end: number): FileLike;
  readonly size: number;
}

export interface FileHandleLike {
  getFile(): Promise<FileLike>;
  createWritable(opts?: { keepExistingData?: boolean }): Promise<WritableLike>;
}

export interface WritableLike {
  write(data: string | Uint8Array | { type: "seek"; position: number }): Promise<void>;
  close(): Promise<void>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

async function isNotFound(e: unknown): Promise<boolean> {
  // DOMException 名称判断跨环境不稳定——NotFoundError 形态即可（OPFS 语义：
  // get*Handle 只在条目不存在时抛 NotFoundError）
  return e instanceof Error || isRecord(e)
    ? String((e as { name?: unknown }).name ?? e) === "NotFoundError"
    : false;
}

export class OpfsFs {
  private readonly getRoot: () => Promise<DirHandleLike>;

  constructor(getRoot?: () => Promise<DirHandleLike>) {
    this.getRoot =
      getRoot ??
      (() => {
        const nav = navigator as unknown as {
          storage?: { getDirectory?: () => Promise<DirHandleLike> };
        };
        const dir = nav.storage?.getDirectory;
        if (dir === undefined) throw new Error("OPFS unavailable (navigator.storage.getDirectory)");
        return dir.call(nav.storage);
      });
  }

  /** OPFS 名空间归一：反斜杠 → /、去空段与 "."、".." 回退一级、恒以 / 开头 */
  resolve(path: string): string {
    const parts: string[] = [];
    for (const seg of path.replaceAll("\\", "/").split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        parts.pop();
        continue;
      }
      parts.push(seg);
    }
    return `/${parts.join("/")}`;
  }

  private async dirFor(segments: string[], create: boolean): Promise<DirHandleLike> {
    let dir = await this.getRoot();
    for (const seg of segments) {
      dir = await dir.getDirectoryHandle(seg, create ? { create: true } : undefined);
    }
    return dir;
  }

  private async segmentsOf(path: string): Promise<{ dir: string[]; name: string }> {
    const norm = this.resolve(path);
    const parts = norm
      .slice(1)
      .split("/")
      .filter((s) => s !== "");
    if (parts.length === 0) throw new Error(`OPFS: 路径不可为根：${path}`);
    const name = parts[parts.length - 1];
    return { dir: parts.slice(0, -1), name };
  }

  async isFile(path: string): Promise<boolean> {
    try {
      const { dir, name } = await this.segmentsOf(path);
      await (await this.dirFor(dir, false)).getFileHandle(name);
      return true;
    } catch (e) {
      if (await isNotFound(e)) return false;
      throw e;
    }
  }

  /** 严格 utf-8（core 契约：非法字节 reject——File.text() 是 lenient 不用） */
  async readTextFile(path: string, maxChars?: number): Promise<string> {
    const { dir, name } = await this.segmentsOf(path);
    const file = await (await this.dirFor(dir, false)).getFileHandle(name).then((h) => h.getFile());
    const buf = await file.arrayBuffer();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return maxChars === undefined ? text : text.slice(0, maxChars);
  }

  async ensureDir(path: string): Promise<void> {
    const parts = this.resolve(path)
      .slice(1)
      .split("/")
      .filter((s) => s !== "");
    await this.dirFor(parts, true);
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    const { dir, name } = await this.segmentsOf(path);
    const handle = await (await this.dirFor(dir, true)).getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(content);
    } finally {
      await writable.close();
    }
  }

  /** 追加写（Python open(path,"a") 等价）：keepExistingData + seek 到旧尾——
   *  既有二进制按字节拼接，O(1) 非原子；不存在则创建（keepExistingData 对缺文件无害） */
  async appendTextFile(path: string, content: string): Promise<void> {
    const { dir, name } = await this.segmentsOf(path);
    const handle = await (await this.dirFor(dir, true)).getFileHandle(name, { create: true });
    const existing = await handle.getFile();
    const writable = await handle.createWritable({ keepExistingData: true });
    try {
      await writable.write({ type: "seek", position: existing.size });
      await writable.write(content);
    } finally {
      await writable.close();
    }
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    const { dir, name } = await this.segmentsOf(path);
    const handle = await (await this.dirFor(dir, true)).getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(data);
    } finally {
      await writable.close();
    }
  }

  async stat(path: string): Promise<{ size: number } | null> {
    try {
      const { dir, name } = await this.segmentsOf(path);
      const file = await (await this.dirFor(dir, false))
        .getFileHandle(name)
        .then((h) => h.getFile());
      return { size: file.size };
    } catch (e) {
      if (await isNotFound(e)) return null;
      throw e;
    }
  }

  async readHead(path: string, n: number): Promise<Uint8Array | null> {
    try {
      const { dir, name } = await this.segmentsOf(path);
      const file = await (await this.dirFor(dir, false))
        .getFileHandle(name)
        .then((h) => h.getFile());
      return new Uint8Array(await file.slice(0, n).arrayBuffer());
    } catch (e) {
      if (await isNotFound(e)) return null;
      throw e;
    }
  }
}
