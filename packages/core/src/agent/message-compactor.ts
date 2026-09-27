// 长对话压缩（message_compactor.py 139 全量）：双门（步间隔 + 字符量）→
// [first, summary, tail N]；压缩输入丢图留文；可配独立压缩 LLM（singleShot 底座）。

import type { ChatMessage, ContentBlock, ToolDefinition } from "../llm/types.js";
import type { MessageCompactionSettings } from "./settings.js";

const COMPACTION_SYSTEM_PROMPT =
  "You are summarizing a browser automation agent's conversation history for context compaction.\n" +
  "Preserve: task requirements, key facts, URLs, file paths, data collected, " +
  "decisions made, errors encountered, and partial progress.\n" +
  "Be concise but complete. Omit redundant state descriptions.";

/** 压缩 LLM 面（LLMClient.singleShot 结构满足） */
export interface CompactorLLM {
  singleShot(req: {
    systemPrompt: string | null;
    userPrompt: string;
    tool?: ToolDefinition | null;
    maxTokens?: number;
  }): Promise<{ text: string }>;
}

/** 内部信封消息的内容文本（str 直通；块列表取 text 块——图片进摘要即丢） */
export function contentText(content: ContentBlock[] | string | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.kind === "text")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

/** 信封消息（kind 标记；getAction 前剥除） */
export interface EnvelopedMessage {
  message: ChatMessage;
  kind: "state" | "history" | "context" | "plain";
}

export class MessageCompactor {
  private compactedMemory: string | null = null;
  private lastCompactionStep = 0;

  constructor(
    private readonly settings: MessageCompactionSettings,
    private readonly fallbackLlm: CompactorLLM,
    private readonly llm?: CompactorLLM,
  ) {}

  /** 双门判定 + 原地压缩（messages 为信封数组） */
  async maybeCompact(messages: EnvelopedMessage[], stepNumber: number): Promise<void> {
    const settings = this.settings;
    // Gate 1: step interval
    const stepsSince = stepNumber - this.lastCompactionStep;
    if (stepsSince < settings.compactEveryNSteps) return;
    // Gate 2: character count（user/assistant 消息读 blocks 文本；toolResult 文本并入）
    const fullText = messages
      .map((m) => {
        const msg = m.message;
        if (msg.role === "toolResult") return msg.text;
        return contentText(msg.blocks);
      })
      .join("\n");
    if (fullText.length < settings.triggerCharCount) return;

    const sections: string[] = [];
    if (this.compactedMemory) {
      sections.push(
        `<previous_compacted_memory>\n${this.compactedMemory}\n</previous_compacted_memory>`,
      );
    }
    sections.push(`<conversation_history>\n${fullText}\n</conversation_history>`);
    const compactionInput = sections.join("\n\n");

    let summary: string;
    try {
      summary = await this.generateSummary(compactionInput);
    } catch {
      return; // Compaction LLM 调用失败跳过（Python warning + return 同款）
    }
    if (!summary) return;

    if (settings.summaryMaxChars !== null && summary.length > settings.summaryMaxChars) {
      summary = summary.slice(0, settings.summaryMaxChars);
    }

    const keepLast = Math.max(0, settings.keepLastItems);
    if (messages.length <= keepLast + 1) return;
    const first = messages[0];
    const tail = keepLast > 0 ? messages.slice(-keepLast) : [];
    const summaryMsg: EnvelopedMessage = {
      kind: "plain",
      message: {
        role: "user",
        blocks: [{ kind: "text", text: `[Conversation Summary]\n${summary}` }],
      },
    };
    messages.length = 0;
    messages.push(first, summaryMsg, ...tail);
    this.compactedMemory = summary;
    this.lastCompactionStep = stepNumber;
  }

  private async generateSummary(text: string): Promise<string> {
    const llm = this.llm ?? this.fallbackLlm;
    const response = await llm.singleShot({
      systemPrompt: COMPACTION_SYSTEM_PROMPT,
      userPrompt: text,
      maxTokens: 2048,
    });
    return response.text.trim();
  }
}
