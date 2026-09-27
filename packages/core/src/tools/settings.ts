// Tools 层截断/落盘阈值设置（config.py TruncationSettings:92-111 默认值照搬）。
// batch1 只消费 extract*/done_attachment_max_chars；其余字段为 batch2/4.4 消费面
// 先行入面（偏离 7：配置面先行，动作后置）。

import type { FileSystemProvider } from "./fs.js";
import type { ParamModel } from "./models.js";

export interface ToolsTruncationSettings {
  extractPageMaxChars: number;
  extractFallbackMaxChars: number;
  extractChunkMaxChars: number;
  extractSaveThreshold: number;
  extractOutputDir: string;
  /** 内层 LLM 调用超时秒（0 = 不启用） */
  extractCallTimeoutS: number;
  readFileMaxChars: number;
  evalResultMaxChars: number;
  displayMaxChars: number;
  domExcerptMaxChars: number;
  searchPageSaveThreshold: number;
  searchPageOutputDir: string;
  findElementsSaveThreshold: number;
  findElementsOutputDir: string;
  evalSaveThreshold: number;
  evalOutputDir: string;
  doneAttachmentMaxChars: number;
}

export const DEFAULT_TRUNCATION_SETTINGS: ToolsTruncationSettings = {
  extractPageMaxChars: 8000,
  extractFallbackMaxChars: 2000,
  extractChunkMaxChars: 8000,
  extractSaveThreshold: 10000,
  extractOutputDir: "extract_output",
  extractCallTimeoutS: 0.0,
  readFileMaxChars: 5000,
  evalResultMaxChars: 2000,
  displayMaxChars: 4000,
  domExcerptMaxChars: 2000,
  searchPageSaveThreshold: 10000,
  searchPageOutputDir: "search_page_output",
  findElementsSaveThreshold: 10000,
  findElementsOutputDir: "find_elements_output",
  evalSaveThreshold: 10000,
  evalOutputDir: "evaluate_output",
  doneAttachmentMaxChars: 2000,
};

/** Tools 构造选项（Python Tools.__init__ :730-745 的 batch1 消费面） */
export interface ToolsOptions {
  truncation?: Partial<ToolsTruncationSettings>;
  /** 上传/写/读路径白名单（配置面先行；upload_file/write_file 等 P4b 消费） */
  allowedUploadPaths?: string[] | null;
  allowedWritePaths?: string[] | null;
  allowedReadPaths?: string[] | null;
  displayFilesInDoneText?: boolean;
  /** 变体 B done 结构化输出模型 */
  outputModel?: ParamModel | null;
  pageSettleEnabled?: boolean;
  pageSettleTimeoutS?: number;
  pageSettlePollS?: number;
  pageSettleStablePolls?: number;
  /** 宿主文件系统能力；未注入时落盘/附件降级 */
  fs?: FileSystemProvider | null;
  /** wait 动作与健康检查用（缺省真实 setTimeout） */
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}
