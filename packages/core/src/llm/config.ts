// Provider 卡片（ProviderConfig）与能力解析：TreeWalker 视觉白名单的泛化（架构 §3.4）。
// 移植自 tree_walker/config.py 的 model_supports_vision（:25-43）与 LLMSettings 默认值。

import type { LlmProtocol, ProviderCapabilities } from "./provider.js";

/**
 * TreeWalker 教训（config.py:279-283）：max_tokens=4096 时 thinking 可写满输出额度，
 * 只剩空响应猝死。16384 是全项目缺省输出上限（anthropic 协议 max_tokens 必填）。
 */
export const DEFAULT_MAX_TOKENS = 16384;

/** provider 卡片：宿主把配置源（chrome.storage / env）映射成此对象传入（架构 §3.4 的 TS 形态） */
export interface ProviderConfig {
  /** 卡片名（展示/日志用，如 "glm-anthropic"） */
  name: string;
  protocol: LlmProtocol;
  /** 无尾斜杠；openai 形态含 /v1 前缀 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 输出上限；缺省值参考 DEFAULT_MAX_TOKENS=16384 */
  maxTokens: number;
  temperature?: number;
  /** 缺省走启发式（resolveCapabilities）。注意：fallback 卡未声明时按白名单推导
   *  supportsVision——白名单外的真视觉卡（gpt-4o/qwen-vl/gemini 等）作 fallback
   *  会被推导为 false 而滤图，须显式声明 supportsVision:true（滤图生效有 WARNING） */
  capabilities?: Partial<ProviderCapabilities>;
  /** 观测用（P4 消息裁剪消费），本阶段透传 */
  contextWindow?: number;
  /** openai 专属：输出上限字段名。缺省 "max_tokens"；
   *  OpenAI 新契约模型（gpt-5/4.1/o 系）须声明 "max_completion_tokens" */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** 宿主注入（代理/网关） */
  extraHeaders?: Record<string, string>;
  /** fallback 卡片：完整独立 ProviderConfig（可跨协议），单向切换，至多一档 */
  fallback?: ProviderConfig | null;
}

/**
 * 已知视觉模型家族判定（移植 config.py:25-43 model_supports_vision，逐分支对齐）。
 *
 * P0 实测：智谱端点对「文本模型 + image block」不报错——模型自述「无法查看图片」
 * 照常回答（静默致盲）。因此视觉能力判定必须在客户端做名单，不能依赖 API 报错兜底：
 *   - claude-*（Anthropic 全系支持视觉输入）
 *   - glm-<n>[.n]*v* 家族（glm-4v / 4.1v / 4.5v / 4.6v / 5v…）
 *   - glm-5.3-flash（GLM-5 系列首个原生多模态）
 * 名单外（glm-5.1 / 5.2 / 5.3、glm-4.x 无 v 等）一律 false。
 *
 * 与 Python 的唯一偏离（评审轮 2）：v / flash 后加 (?![a-z0-9]) 边界——Python 无此
 * 断言，glm-4voice 类伪型号会误判为视觉（跳过滤图 → 静默致盲）。真实型号不受影响。
 */
export function modelSupportsVision(model: string | null | undefined): boolean {
  const m = (model ?? "").trim().toLowerCase();
  if (!m) {
    return false;
  }
  if (m.startsWith("claude-")) {
    return true;
  }
  // 边界断言是 TS 侧收紧（评审轮 2）：Python 无 (?![a-z0-9])，glm-4voice 类伪型号会被
  // 误判为视觉 → 跳过滤图把 image 发给文本模型（智谱静默致盲）。真实型号（v 后为
  // 结尾或连字符，如 glm-4v / glm-4.5v-plus / glm-4v-flash）匹配不受影响
  if (/^glm-\d+(\.\d+)*v(?![a-z0-9])/.test(m)) {
    return true;
  }
  return /^glm-5\.3-flash(?![a-z0-9])/.test(m);
}

/**
 * 能力缺省启发式：supportsTools / supportsForcedTool 缺省 true（主流端点均支持，
 * 不支持由卡片显式关闭——声明优于猜测）；supportsVision 缺省走视觉白名单。
 */
export function resolveCapabilities(config: ProviderConfig): ProviderCapabilities {
  const declared = config.capabilities ?? {};
  return {
    supportsTools: declared.supportsTools ?? true,
    supportsForcedTool: declared.supportsForcedTool ?? true,
    supportsVision: declared.supportsVision ?? modelSupportsVision(config.model),
  };
}
