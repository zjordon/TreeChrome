// AgentSettings/JudgeSettings/MessageCompactionSettings（config.py 字段面；
// 偏离 7：不读 env，rerun_*/record_upload_dir/save_conversation_path 重放与
// 审计族不入 P4）。默认值口径 = load_settings() 无 env 时的产出（运营默认——
// examples/runner 实跑口径），不等于 dataclass 裸默认；对拍 fixture 见
// test/fixtures/python-anchors/settings-defaults.json（node-host 方案 §5.1）。
// 已知运营≠dataclass 的分歧键：enable_planning（dataclass :163 False / env 缺省
// "true" :501）——按运营默认取 true。

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
  /** submit 预确认（M5 段 C，架构 §5.3）：click 命中 submit 特征且表单有变更字段
   *  → 二道门 confirmSubmit。可选键缺省视为 false（评测/examples 行为不变）；
   *  不进 DEFAULT_AGENT_SETTINGS——Python 对拍 fixture 零变化（m5/03 §2.2） */
  submitConfirmEnabled?: boolean;
  /** 附件数据通道单附件上限（M5 段 D 评审轮 1 [4]：宿主附件注册表与 core 上限
   *  对齐的透传线——扩展侧 100MB，缺省 Tools 的 32MB；语义同 ToolsSettings
   *  同名键：undefined=缺省、显式 null=解除）。可选键不进 DEFAULT_AGENT_SETTINGS
   *  （对拍 fixture 零变化） */
  maxAttachmentBytes?: number | null;
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
  // 运营默认 true（config.py:501 env 缺省 "true"；dataclass :163 为 False——Python
  // examples/runner 实跑即开着 PlanManager，初始规划 + replan nudge）
  enablePlanning: true,
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
  // 运营默认 1.5（config.py:538 env 缺省与 dataclass :239 同为 1.5；此前误取 rerun
  // 家族的 rerun_actionability_timeout=2.0——node-host 方案 §5.1 对账修正）
  explorationActionabilityTimeout: 1.5,
  explorationActionabilityPoll: 0.3,
  // 运营默认 true（config.py:540 env 缺省 "true"，dataclass :241 同 true；此前误为
  // false = 探索端 L1/L2 receives-events 检查默认跳过——对账修正）
  explorationActionabilityReceivesEvents: true,
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
