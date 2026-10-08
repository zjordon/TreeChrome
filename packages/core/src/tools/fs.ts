// 宿主文件系统能力接口（架构 §4 五接口之一）。核心包禁 fs——extract 大结果落盘 /
// done 附件存在性与内联读取 / P4b 文件三动作（嗅探与窗口计量）经此注入；未注入时
// 调用方降级（跳过落盘 + metadata 标注 / 附件跳过存在性校验），见 p4/02 偏离 6。

/** 附件载荷（扩展形态，M5 段 C：用户在侧边栏亲手选文件，SW 持 bytes） */
export interface AttachmentPayload {
  /** 文件字节（SW 侧由用户手势读得） */
  base64: string;
  filename: string;
  mimeType: string;
  /** 字节数（upload 空文件校验复用） */
  size: number;
}

export interface FileSystemProvider {
  /** os.path.abspath 等价（白名单前缀比对前归一化） */
  resolve(path: string): string;
  isFile(path: string): Promise<boolean>;
  /** 读文本：maxChars 省略 = 全读（窗口分页在动作层做，宿主不得自带默认截断）。
   *  严格 utf-8 解码——含非法字节必须 reject（映射 Python UnicodeDecodeError，由
   *  handler 包成 error、文件不动）；禁止 lenient 解码成 U+FFFD（静默腐蚀源字节） */
  readTextFile(path: string, maxChars?: number): Promise<string>;
  ensureDir(path: string): Promise<void>;
  writeTextFile(path: string, content: string): Promise<void>;
  /** 追加写（Python open(path, "a") 等价，write_file append 用）：utf-8 编码追加、
   *  O(1) 非原子（Python 刻意选择）；不读不重写既有内容——对既有二进制/非 utf-8
   *  字节零接触；文件不存在则创建 */
  appendTextFile(path: string, content: string): Promise<void>;
  /** 二进制写（截图落盘 step_NNN.png） */
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  /** 文件字节量（P4b read/write/replace 的窗口计量与回显；读失败返回 null） */
  stat(path: string): Promise<{ size: number } | null>;
  /** 头部字节读取（P4b read_file 的 magic 嗅探——Python _sniff_file_kind 只读 12
   *  字节头；读失败返回 null） */
  readHead(path: string, n: number): Promise<Uint8Array | null>;
  /** 附件句柄解析（扩展形态，M5 段 C）：ref 形如 "attachment:att_1"；不识别/未注册 →
   *  null。可选方法——不实现即纯路径宿主（NodeFs 不实现，Node 行为零变化） */
  readAttachment?(ref: string): Promise<AttachmentPayload | null>;
}
