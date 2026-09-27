// AgentSettings/JudgeSettings/MessageCompactionSettings（config.py 字段面；
// 偏离 7：不读 env，rerun_*/record_upload_dir/save_conversation_path 重放与
// 审计族不入 P4）。默认值逐一对照 @640d52a。

import type { ParamModel } from "../tools/models.js";
import type { ToolsTruncationSettings } from "../tools/settings.js";

/** config.py MessageCompactionSettings:82-88 */
export interface MessageCompactionSettings {
  enabled: boolean;
  compactEveryNSteps: number;
  /** 触发压缩的对话字符数阈值 */
  triggerCharCount: number;
  keepLastItems: number;
  summaryMaxChars: number | null;
}

export const DEFAULT_MESSAGE_COMPACTION_SETTINGS: MessageCompactionSettings = {
  enabled: false,
  compactEveryNSteps: 10,
  triggerCharCount: 40000,
  keepLastItems: 4,
  summaryMaxChars: null,
};

/** config.py JudgeSettings:114-119 */
export interface JudgeSettings {
  enabled: boolean;
  /** 独立评审模型卡；空串 = 复用主 llm */
  model: string;
  maxHistorySteps: number;
  traceMaxChars: number;
}

export const DEFAULT_JUDGE_SETTINGS: JudgeSettings = {
  enabled: true,
  model: "",
  maxHistorySteps: 20,
  traceMaxChars: 40000,
};

/** 敏感数据条目：全局（字符串）或 URL 过滤（{value, urls}）——归一化前兼容两形态 */
export type SensitiveDataSpec = string | { value?: string; urls?: string[] | null };

/** config.py AgentSettings:121-260 的 P4 面（重放/审计族出界） */
export interface AgentSettings {
  maxSteps: number;
  maxFailures: number;
  /** #194：LLM 基建失败连续上限（与 maxFailures 能力止损分罪） */
  maxInfraFailures: number;
  /** #186 现象②：done(success=True) 不确定标记门禁（每 run 封顶 2 次） */
  doneUncertaintyGate: boolean;
  maxActionsPerStep: number;
  /** 秒；包住整个 Think 阶段（含澄清重试梯） */
  llmTimeout: number;
  /** 秒；单动作执行超时 */
  actionTimeout: number;
  /** 秒；浏览器重连等待上限 */
  reconnectTimeout: number;
  sensitiveData: Record<string, SensitiveDataSpec> | null;
  trackDownloads: boolean;
  messageCompaction: MessageCompactionSettings | null;
  enableMessageTyping: boolean;
  enablePageStats: boolean;
  enableGridMeta: boolean;
  enableSensitiveDescription: boolean;
  enableSkillInjection: boolean;
  /** <agent_history> 滑动窗口（compactor 启用时自动降到 5） */
  maxHistoryItems: number;
  enableRecentEvents: boolean;
  /** LLM 视觉通道：每步 state 附降采样截图（需模型在视觉名单内） */
  useVision: boolean;
  /** 降采样目标 [w,h]；null = 视觉模型默认 [1400,850] */
  llmScreenshotSize: [number, number] | null;
  truncation: ToolsTruncationSettings;
  enablePlanning: boolean;
  explorationThreshold: number;
  replanFailureThreshold: number;
  enableDecisionAttribution: boolean;
  actionPageFilters: Record<string, string[]> | null;
  allowedUploadPaths: string[] | null;
  allowedWritePaths: string[] | null;
  allowedReadPaths: string[] | null;
  displayFilesInDoneText: boolean;
  judge: JudgeSettings;
  /** extract 工具结构化抽取 schema（null = free-text） */
  extractionSchema: Record<string, unknown> | null;
  /** 任务级 skill 注入（默认关——评测红线；TreeChrome 默认经此配置表达） */
  enableTaskSkillInjection: boolean;
  /** P0 探索 actionability：click/input_text/select_dropdown 前等元素就绪 */
  explorationActionabilityCheck: boolean;
  explorationActionabilityTimeout: number;
  explorationActionabilityPoll: number;
  explorationActionabilityReceivesEvents: boolean;
  explorationActionabilityRuntimeOcclusion: boolean;
  explorationActionabilityStable: boolean;
  explorationActionabilityStableInterval: number;
  explorationActionabilityStableTolerance: number;
  /** 探索端页面级 settle（B3-1，传 Tools） */
  explorationPageSettle: boolean;
  explorationPageSettleTimeout: number;
  explorationPageSettlePoll: number;
  explorationPageSettleStablePolls: number;
  /** 变体 B done 结构化输出模型（Python output_model 构造参数的 settings 化） */
  outputModel: ParamModel | null;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  maxSteps: 100,
  maxFailures: 5,
  maxInfraFailures: 8,
  doneUncertaintyGate: true,
  maxActionsPerStep: 5,
  llmTimeout: 120,
  actionTimeout: 30,
  reconnectTimeout: 30,
  sensitiveData: null,
  trackDownloads: false,
  messageCompaction: null,
  enableMessageTyping: true,
  enablePageStats: true,
  enableGridMeta: true,
  enableSensitiveDescription: true,
  enableSkillInjection: true,
  maxHistoryItems: 10,
  enableRecentEvents: false,
  useVision: false,
  llmScreenshotSize: null,
  truncation: {
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
  },
  enablePlanning: false,
  explorationThreshold: 5,
  replanFailureThreshold: 3,
  enableDecisionAttribution: false,
  actionPageFilters: null,
  allowedUploadPaths: null,
  allowedWritePaths: null,
  allowedReadPaths: null,
  displayFilesInDoneText: false,
  judge: { ...DEFAULT_JUDGE_SETTINGS },
  extractionSchema: null,
  enableTaskSkillInjection: false,
  explorationActionabilityCheck: true,
  explorationActionabilityTimeout: 2.0,
  explorationActionabilityPoll: 0.3,
  explorationActionabilityReceivesEvents: false,
  explorationActionabilityRuntimeOcclusion: false,
  explorationActionabilityStable: false,
  explorationActionabilityStableInterval: 0.1,
  explorationActionabilityStableTolerance: 1.0,
  explorationPageSettle: true,
  explorationPageSettleTimeout: 10.0,
  explorationPageSettlePoll: 0.5,
  explorationPageSettleStablePolls: 4,
  outputModel: null,
};

/** 构造时合并部分覆盖（浅合并 + truncation/judge 子对象合并） */
export function resolveAgentSettings(
  overrides: Partial<AgentSettings> | null | undefined,
): AgentSettings {
  const base = DEFAULT_AGENT_SETTINGS;
  if (!overrides) return { ...base };
  const { truncation, judge, ...rest } = overrides;
  return {
    ...base,
    ...rest,
    truncation: truncation ? { ...base.truncation, ...truncation } : base.truncation,
    judge: judge ? { ...base.judge, ...judge } : base.judge,
  };
}
