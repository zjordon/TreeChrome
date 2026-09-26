// LLMProvider 接口：一协议一适配器（Strategy，架构 §3.4）。纯类型文件。

import type { ChatRequest, ChatResponse } from "./types.js";

export type LLMProtocol = "openai-completions" | "anthropic-messages" | "gemini";

/** 能力声明（架构 §3.4：provider 卡片声明，TreeWalker 视觉白名单的泛化） */
export interface ProviderCapabilities {
  supportsTools: boolean;
  supportsVision: boolean;
  /** false = 端点不支持 forced tool_choice（vLLM 旧版等），走 prompt 约束 + JSON 兜底 */
  supportsForcedTool: boolean;
}

export interface LLMProvider {
  readonly protocol: LLMProtocol;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** 最小连通性检查（webbrain 形状）：chat("Hi", maxTokens=16) 的成败包装
   *  （16 是 o 系/gpt-5 的 max_completion_tokens 最小值，5 会被端点 400——见
   *  adapters/common.ts defaultTestConnection） */
  testConnection(): Promise<{ ok: boolean; error?: string; model?: string }>;
}
