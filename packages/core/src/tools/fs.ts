// 宿主文件系统能力接口（架构 §4 五接口之一）。核心包禁 fs——extract 大结果落盘 /
// done 附件存在性与内联读取 / P4b 文件三动作（嗅探与窗口计量）经此注入；未注入时
// 调用方降级（跳过落盘 + metadata 标注 / 附件跳过存在性校验），见 p4/02 偏离 6。

export interface FileSystemProvider {
  /** os.path.abspath 等价（白名单前缀比对前归一化） */
  resolve(path: string): string;
  isFile(path: string): Promise<boolean>;
  /** 读文本（maxChars 截断；displayFilesInDoneText 内联用） */
  readTextFile(path: string, maxChars?: number): Promise<string>;
  ensureDir(path: string): Promise<void>;
  writeTextFile(path: string, content: string): Promise<void>;
  /** 二进制写（截图落盘 step_NNN.png） */
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  /** 文件字节量（P4b read/write/replace 的窗口计量与回显；读失败返回 null） */
  stat(path: string): Promise<{ size: number } | null>;
  /** 头部字节读取（P4b read_file 的 magic 嗅探——Python _sniff_file_kind 只读 12
   *  字节头；读失败返回 null） */
  readHead(path: string, n: number): Promise<Uint8Array | null>;
}
