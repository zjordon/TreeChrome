// canonical 消息不变量 + assertValidMessages 单测（docs/implement-plan/p2/01 §2.1）。
import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  ChatMessage,
  ToolResultMessage,
  UserMessage,
} from "../../src/index.js";
import { LLMProtocolViolationError } from "../../src/index.js";
import { assertValidMessages } from "../../src/llm/types.js";

const user = (text: string): UserMessage => ({ role: "user", blocks: [{ kind: "text", text }] });
const assistant = (opts: {
  text?: string;
  toolCalls?: AssistantMessage["toolCalls"];
}): AssistantMessage => ({
  role: "assistant",
  blocks: opts.text === undefined ? [] : [{ kind: "text", text: opts.text }],
  toolCalls: opts.toolCalls,
});
const toolResult = (id: string, name = "agent_response"): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  text: "ok",
});

describe("assertValidMessages · 合法序列", () => {
  it("最小序列：单条 user", () => {
    expect(() => assertValidMessages([user("hi")])).not.toThrow();
  });

  it("完整回合：user → assistant(文本+双 toolCall) → 乱序双 toolResult → user(图)", () => {
    const msgs: ChatMessage[] = [
      user("look"),
      assistant({
        text: "thinking...",
        toolCalls: [
          { id: "t1", name: "agent_response", args: {} },
          { id: "t2", name: "agent_response", args: {} },
        ],
      }),
      toolResult("t2"),
      toolResult("t1"),
      { role: "user", blocks: [{ kind: "image", mimeType: "image/png", base64: "AAAA" }] },
    ];
    expect(() => assertValidMessages(msgs)).not.toThrow();
  });

  it("纯工具调用回合（blocks 空、toolCalls 非空）合法", () => {
    const msgs: ChatMessage[] = [
      user("q"),
      assistant({ toolCalls: [{ id: "t1", name: "agent_response", args: {} }] }),
      toolResult("t1"),
    ];
    expect(() => assertValidMessages(msgs)).not.toThrow();
  });

  it("不带 toolCalls 的 assistant 合法（纯文本回合）", () => {
    const msgs: ChatMessage[] = [user("q"), assistant({ text: "a" }), user("next")];
    expect(() => assertValidMessages(msgs)).not.toThrow();
  });
});

describe("assertValidMessages · 违例序列", () => {
  const expectViolation = (msgs: ChatMessage[], reason: string) => {
    let caught: unknown;
    try {
      assertValidMessages(msgs);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LLMProtocolViolationError);
    expect((caught as LLMProtocolViolationError).message).toContain(reason);
  };

  it("空序列", () => {
    expectViolation([], "消息为空");
  });

  it("首条非 user（assistant / toolResult）", () => {
    expectViolation([assistant({ text: "a" })], "首条消息必须 user");
    expectViolation([toolResult("t1")], "首条消息必须 user");
  });

  it("user.blocks 为空", () => {
    expectViolation([{ role: "user", blocks: [] }], "user.blocks 为空");
  });

  it("空文本块（Anthropic 端点对空 text 块 400——canonical 层拦截，轮 13 #6）", () => {
    expectViolation([{ role: "user", blocks: [{ kind: "text", text: "" }] }], "含空文本块");
    expectViolation(
      [user("q"), { role: "assistant", blocks: [{ kind: "text", text: "" }] }],
      "含空文本块",
    );
  });

  it("assistant 的 blocks 与 toolCalls 同时为空", () => {
    expectViolation([user("q"), assistant({})], "同时为空");
  });

  it("孤儿 toolResult（紧跟不带 toolCalls 的 assistant）", () => {
    expectViolation([user("q"), assistant({ text: "a" }), toolResult("t1")], "孤儿 toolResult");
  });

  it("toolResult 的 id 不在紧邻 assistant 的 toolCalls 中", () => {
    expectViolation(
      [
        user("q"),
        assistant({ toolCalls: [{ id: "t1", name: "agent_response", args: {} }] }),
        toolResult("other"),
      ],
      "不在紧邻 assistant 的 toolCalls 中",
    );
  });

  it("同一 toolCall 重复结果", () => {
    expectViolation(
      [
        user("q"),
        assistant({ toolCalls: [{ id: "t1", name: "agent_response", args: {} }] }),
        toolResult("t1"),
        toolResult("t1"),
      ],
      "重复结果",
    );
  });

  it("assistant 的 toolCalls 存在重复 id → 拒绝（Set 去重会假性通过恰好配对）", () => {
    expectViolation(
      [
        user("q"),
        assistant({
          toolCalls: [
            { id: "t1", name: "agent_response", args: {} },
            { id: "t1", name: "agent_response", args: {} },
          ],
        }),
        toolResult("t1"),
      ],
      "重复 id",
    );
  });

  it("toolResult 的 toolName 与配对 toolCall 的 name 不一致 → 拒绝（gemini 按 name 关联）", () => {
    expectViolation(
      [
        user("q"),
        assistant({ toolCalls: [{ id: "t1", name: "agent_response", args: {} }] }),
        { role: "toolResult", toolCallId: "t1", toolName: "other_tool", text: "ok" },
      ],
      "不一致",
    );
  });

  it("toolCall 缺结果（2 个调用只回 1 条）", () => {
    expectViolation(
      [
        user("q"),
        assistant({
          toolCalls: [
            { id: "t1", name: "agent_response", args: {} },
            { id: "t2", name: "agent_response", args: {} },
          ],
        }),
        toolResult("t1"),
        user("next"),
      ],
      "仅收到 1 条结果",
    );
  });

  it("providerName 进异常的 provider 字段", () => {
    let caught: unknown;
    try {
      assertValidMessages([], "glm-anthropic");
    } catch (e) {
      caught = e;
    }
    expect((caught as LLMProtocolViolationError).provider).toBe("glm-anthropic");
  });
});
