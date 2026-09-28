// ScriptedLLMProvider（05 §1 假件）：实现 P2 LLMProvider——预编 chat() 应答序列
// （agent_response 形态），驱动**真 LLMClient**（解析梯子/适配器全真，只换 provider）。
// decide 回调按收到的 state 文本自适应决策（从 element_tree_text 解析目标编号，避免
// brittle 硬编码）；judge 调用（systemPrompt 等值 JUDGE_SYSTEM_PROMPT）回放 verdict。
// 记录收到的 systemPrompt/user 文本/tool 名供断言。

import { JUDGE_SYSTEM_PROMPT } from "../../src/agent/prompt-consts.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import type { ChatRequest, ChatResponse, ToolCall } from "../../src/llm/types.js";

/** 单步决策：入参 = 最近 user 消息（state 内容）全文，出参 = agent_response toolInput */
export type ScriptedDecision = (stateText: string) => Record<string, unknown>;

export interface ScriptedCallRecord {
  systemPrompt: string | null;
  userText: string;
  toolNames: string[];
}

export class ScriptedLLMProvider implements LLMProvider {
  readonly protocol = "openai-completions" as const;
  readonly model: string;
  readonly capabilities = {
    supportsTools: true,
    supportsVision: false,
    supportsForcedTool: true,
  };

  readonly requests: ScriptedCallRecord[] = [];
  private readonly queue: ScriptedDecision[];
  private callSeq = 0;

  /** model 可注入：真机 smoke 传白名单前缀名（如 claude-smoke）开 vision 门（截图观察） */
  constructor(script: ScriptedDecision[], model = "scripted-agent") {
    this.queue = [...script];
    this.model = model;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const userText = req.messages
      .filter((m) => m.role === "user")
      .map((m) => m.blocks.map((b) => ("text" in b ? b.text : "")).join(""))
      .join("\n");
    this.requests.push({
      systemPrompt: req.systemPrompt,
      userText,
      toolNames: (req.tools ?? []).map((t) => t.name),
    });

    // judge 复核：verdict=pass 固定回放（smoke 契约：judgement 落末步 done）
    if (req.systemPrompt === JUDGE_SYSTEM_PROMPT) {
      return {
        text: "",
        toolCalls: [this.agentResponseCall({ reasoning: "task verified", verdict: true })],
        stopReason: "tool_call",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }

    const decide = this.queue.shift();
    if (decide === undefined) {
      throw new Error("ScriptedLLMProvider: 剧本耗尽（步数超出预期）");
    }
    const toolInput = decide(userText);
    return {
      text: "",
      toolCalls: [this.agentResponseCall(toolInput)],
      stopReason: "tool_call",
      usage: { inputTokens: 100, outputTokens: 100 },
    };
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; model?: string }> {
    return { ok: true, model: this.model };
  }

  private agentResponseCall(args: Record<string, unknown>): ToolCall {
    this.callSeq += 1;
    return { id: `scripted-${this.callSeq}`, name: "agent_response", args };
  }
}

/** 便捷构造：单动作步（done 变体由调用方直传完整 toolInput） */
export function singleActionStep(
  partial: Record<string, unknown>,
  actionName: string,
  params: Record<string, unknown>,
): ScriptedDecision {
  return () => ({
    evaluation_previous_goal: partial.evaluation_previous_goal ?? "",
    memory: partial.memory ?? "",
    next_goal: partial.next_goal ?? actionName,
    action: { name: actionName, params },
    actions: [{ name: actionName, params }],
  });
}
