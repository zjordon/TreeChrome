// 独立 LLM Judge：执行后轨迹复核（judge.py 266 全量）。system prompt / tool schema
// 字节锚定 prompt-consts.ts；两轮尝试（空响应 nudge 重试一次）；trace 序列化保留
// 全部步、done 步带 Page excerpt、尾部截断对齐 "Step " 边界。

import type { ToolDefinition } from "../llm/types.js";
import { pyJsonDumps } from "../tools/py-json.js";
import { JUDGE_SYSTEM_PROMPT, JUDGE_TOOL_SCHEMA } from "./prompt-consts.js";
import type { JudgeSettings } from "./settings.js";
import type { AgentHistoryList } from "./views.js";

export interface JudgementResult {
  reasoning: string | null;
  verdict: boolean;
  failureReason: string | null;
  impossibleTask: boolean;
  captcha: boolean;
}

/** 强制工具调用面（LLMClient.singleShot 结构满足；judge 工具名同为 agent_response） */
export interface JudgeLLM {
  singleShot(req: {
    systemPrompt: string | null;
    userPrompt: string;
    tool?: ToolDefinition | null;
    maxTokens?: number;
  }): Promise<import("../llm/types.js").ChatResponse>;
}

export class JudgeEvaluator {
  constructor(
    private readonly llm: JudgeLLM,
    private readonly settings: JudgeSettings | null = null,
  ) {}

  async judge(
    task: string,
    history: AgentHistoryList,
    finalResult: string | null = null,
  ): Promise<JudgementResult | null> {
    const prompt = this.buildJudgePrompt(task, history, finalResult);
    if (prompt === null) return null;
    try {
      // B3-3：空响应（无 tool_use 块）先 nudge 重试一次再放弃（Python 追加一条
      // user 消息；TS 单发面以拼接等价——nudge 文案原文照搬）
      let userPrompt = prompt;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const response = await this.llm.singleShot({
          systemPrompt: JUDGE_SYSTEM_PROMPT,
          userPrompt,
          tool: JUDGE_TOOL_SCHEMA as unknown as ToolDefinition,
        });
        for (const block of response.toolCalls) {
          if (block.name === "agent_response") {
            const data = block.args as Record<string, unknown>;
            return {
              reasoning: typeof data.reasoning === "string" ? data.reasoning : null,
              verdict: data.verdict === true,
              failureReason: typeof data.failure_reason === "string" ? data.failure_reason : null,
              impossibleTask: data.impossible_task === true,
              captcha: data.captcha === true,
            };
          }
        }
        userPrompt = `${userPrompt}\nRespond now using the agent_response tool with your JSON verdict.`;
      }
      return null; // Judge 失败不挂任务（Python logger.exception + return None 同款）
    } catch {
      return null;
    }
  }

  buildJudgePrompt(
    task: string,
    history: AgentHistoryList,
    finalResult: string | null,
  ): string | null {
    let trace = this.serializeHistory(history);
    if (!trace) return null;
    const maxChars = this.settings?.traceMaxChars ?? 40000;
    if (trace.length > maxChars) {
      trace = trace.slice(-maxChars);
      const boundary = trace.indexOf("\nStep ");
      if (boundary !== -1) {
        trace = trace.slice(boundary + 1);
      }
      trace += "\n[trace truncated, kept most recent steps]";
    }
    const parts = [`## User Task\n${task}\n`, `## Execution Trace\n${trace}\n`];
    if (finalResult) {
      parts.push(`## Agent's Final Result\n${finalResult}\n`);
    }
    parts.push(
      "## Your Evaluation\n" +
        "Based on the trace above, evaluate whether the agent truly completed " +
        "the task. Cross-check the per-step URL and Page excerpt against the " +
        "agent's reported results. Respond in JSON format:\n" +
        "```json\n" +
        '{"reasoning": "...", "verdict": true/false, "failure_reason": "... or null", ' +
        '"impossible_task": false, "captcha": false}\n' +
        "```\n",
    );
    return parts.join("\n");
  }

  /** 全步序列化：URL/Title/Goal/Action(原始结果)/Result；done 步附 Page excerpt */
  serializeHistory(history: AgentHistoryList): string {
    const allSteps = history.history;
    if (allSteps.length === 0) return "";
    const lines: string[] = [];
    for (const h of allSteps) {
      const modelOut = h.modelOutput ?? {};
      const goal = typeof modelOut.next_goal === "string" ? modelOut.next_goal : "";
      const action = (modelOut.action ?? {}) as Record<string, unknown>;
      const actionName = String(action.name ?? "");
      const actionParams = (action.params ?? {}) as Record<string, unknown>;
      const summary = h.stateSummary ?? {};
      const url = String(summary.url ?? "");
      const title = String(summary.title ?? "");
      const domExcerpt = String(summary.domExcerpt ?? "");
      const resultParts: string[] = [];
      for (const r of h.result) {
        if (r.error) {
          resultParts.push(`ERROR: ${r.error}`);
        } else if (r.extractedContent) {
          resultParts.push(r.extractedContent);
        } else {
          resultParts.push(r.render());
        }
      }
      const block = [
        `Step ${h.stepNumber}:`,
        `  URL: ${url}`,
        `  Title: ${title}`,
        `  Goal: ${goal}`,
        `  Action: ${actionName}(${pyJsonDumps(actionParams)})`,
      ];
      if (domExcerpt) {
        block.push(`  Page excerpt: ${domExcerpt}`);
      }
      block.push(`  Result: ${resultParts.join("; ")}`);
      lines.push(block.join("\n"));
    }
    return lines.join("\n\n");
  }
}
