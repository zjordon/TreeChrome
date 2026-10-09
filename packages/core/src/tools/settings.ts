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

/** bytes 通道单附件体积上限缺省（评审轮 1 [1]）：全量 base64 走单条
 *  Runtime.callFunctionOn，峰值内存 ≈ host 侧 base64 + core CDP 消息拷贝（~2.7x
 *  原始体积）+ 页面端 atob/字节循环主线程占用随体积线性——32MB 封顶峰值 ~86MB、
 *  页面循环百 ms 级。仅附件分支消费（Node 路径宿主不可达，零变化声明保持）；
 *  宿主可覆盖，显式 null 解除。 */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

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
  /** 上传后页面级验证（Tools :765-767 缺省 True/1.5s/0.25s——P4b 段 2） */
  uploadVerifyEnabled?: boolean;
  uploadVerifyWaitMs?: number;
  uploadVerifyIntervalMs?: number;
  /** bytes 通道单附件体积上限（M5 段 C 评审轮 1 [1]）；缺省
   *  DEFAULT_MAX_ATTACHMENT_BYTES，显式 null 解除（仅附件分支消费） */
  maxAttachmentBytes?: number | null;
  /** wait 动作与健康检查用（缺省真实 setTimeout） */
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}
