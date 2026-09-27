// 宿主文件系统能力接口（架构 §4 五接口之一的最小 P4 面）。核心包禁 fs——
// extract 大结果落盘 / done 附件存在性与内联读取经此注入；未注入时调用方降级
// （跳过落盘 + metadata 标注 / 附件跳过存在性校验），见 p4/02 偏离 6。

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
}
