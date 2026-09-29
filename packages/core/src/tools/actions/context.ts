// Tools 实例上下文：handler 闭包依赖的显式形态（Python self 的 TS 化——
// 构造注入，不做服务定位器）。cachedBrowserState 由 execute() 生命周期写入/清空。

import type { BrowserStateSummary } from "../../browser/views.js";
import type { FileSystemProvider } from "../fs.js";
import type { ParamModel } from "../models.js";
import type { ToolsTruncationSettings } from "../settings.js";

/** extract 动作消费的 LLM 面（LLMClient.extract 结构满足；4.4 agent 接线） */
export interface ExtractClientFace {
  extract(
    prompt: string,
    content: string,
    opts?: {
      maxContentChars?: number;
      outputSchema?: Record<string, unknown> | null;
      alreadyCollected?: string[] | null;
      callTimeoutMs?: number | null;
    },
  ): Promise<string>;
}

/** handler 工厂共享上下文 */
export interface ToolsContext {
  truncation: ToolsTruncationSettings;
  allowedUploadPaths: string[] | null;
  allowedWritePaths: string[] | null;
  allowedReadPaths: string[] | null;
  displayFilesInDoneText: boolean;
  /** 变体 B done 结构化输出模型（null = 变体 A） */
  outputModel: ParamModel | null;
  pageSettleEnabled: boolean;
  pageSettleTimeoutS: number;
  pageSettlePollS: number;
  pageSettleStablePolls: number;
  fs: FileSystemProvider | null;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  /** extract 动作的 LLM 客户端（Python _extract_llm，setattr 接线 → TS 公开字段） */
  extractClient: ExtractClientFace | null;
  /** extract 结构化输出 schema（Python _extraction_schema） */
  extractionSchema: Record<string, unknown> | null;
  /** 上传后页面级验证（canvas/img/bg 预览 delta 轮询；Tools :765-767 缺省照搬） */
  uploadVerifyEnabled: boolean;
  uploadVerifyWaitMs: number;
  uploadVerifyIntervalMs: number;
  /** execute() 帧内缓存（Python _cached_browser_state） */
  cachedBrowserState: BrowserStateSummary | null;
}
