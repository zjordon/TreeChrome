// canonical 消息不变量 + assertValidMessages 单测（docs/implement-plan/p2/01 §2.1）。
import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  ChatMessage,
  ToolResultMessage,
  UserMessage,
} from "../../src/index.js";
import { assertValidMessages, LLMProtocolViolationError } from "../../src/index.js";
import { AGENT_TOOL } from "./fixtures.js";

const user = (text: string): UserMessage => ({ role: "user", blocks: [{ kind: "text", text }] });
const assistant = (opts: {
  text?: string;
  toolCalls?: AssistantMessage["toolCalls"];
}): AssistantMessage => ({
  role: "assistant",
  blocks: opts.text === undefined ? [] : [{ kind: "text", text: opts.text }],
  toolCalls: opts.toolCalls,
});
const toolResult = (id: string, name = AGENT_TOOL.name): ToolResultMessage => ({
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
          { id: "t1", name: AGENT_TOOL.name, args: {} },
          { id: "t2", name: AGENT_TOOL.name, args: {} },
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
      assistant({ toolCalls: [{ id: "t1", name: AGENT_TOOL.name, args: {} }] }),
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

  it("空文本块（Anthropic 端点对空 text 块 400——canonical 层拦截，轮 13 #6；文案轮 25 #4 扩为「空块」涵盖 image）", () => {
    expectViolation([{ role: "user", blocks: [{ kind: "text", text: "" }] }], "含空块");
    expectViolation(
      [user("q"), { role: "assistant", blocks: [{ kind: "text", text: "" }] }],
      "含空块",
    );
  });

  it("空 image 块（空 base64 / 空 mimeType 同为端点 400 形态——canonical 层拦截，轮 25 #4）", () => {
    expectViolation(
      [
        {
          role: "user",
          blocks: [{ kind: "image", mimeType: "image/png", base64: "" }],
        },
      ],
      "含空块",
    );
    expectViolation(
      [
        {
          role: "user",
          blocks: [{ kind: "image", mimeType: "", base64: "AAAA" }],
        },
      ],
      "含空块",
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
        assistant({ toolCalls: [{ id: "t1", name: AGENT_TOOL.name, args: {} }] }),
        toolResult("other"),
      ],
      "不在紧邻 assistant 的 toolCalls 中",
    );
  });

  it("同一 toolCall 重复结果", () => {
    expectViolation(
      [
        user("q"),
        assistant({ toolCalls: [{ id: "t1", name: AGENT_TOOL.name, args: {} }] }),
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
            { id: "t1", name: AGENT_TOOL.name, args: {} },
            { id: "t1", name: AGENT_TOOL.name, args: {} },
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
        assistant({ toolCalls: [{ id: "t1", name: AGENT_TOOL.name, args: {} }] }),
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
            { id: "t1", name: AGENT_TOOL.name, args: {} },
            { id: "t2", name: AGENT_TOOL.name, args: {} },
          ],
        }),
        toolResult("t1"),
        user("next"),
      ],
      "仅收到 1 条结果",
    );
  });

  it("toolCall 零结果边界：悬空 toolCall 结尾 / 后紧跟 user（轮 32 #6——截断历史重放的真实形态）", () => {
    expectViolation(
      [user("q"), assistant({ toolCalls: [{ id: "t1", name: AGENT_TOOL.name, args: {} }] })],
      "仅收到 0 条结果",
    );
    expectViolation(
      [
        user("q"),
        assistant({ toolCalls: [{ id: "t1", name: AGENT_TOOL.name, args: {} }] }),
        user("next"),
      ],
      "仅收到 0 条结果",
    );
  });

  it('toolCall id 为空串 → 拒绝（请求侧 tool_use id="" 是端点 400 形态，轮 17 #8）', () => {
    expectViolation(
      [user("q"), assistant({ toolCalls: [{ id: "", name: AGENT_TOOL.name, args: {} }] })],
      "id 为空串",
    );
  });

  it("toolCall name 为空串 → 拒绝（Anthropic 工具名 ^[a-zA-Z0-9_-]{1,128}$ 约束，轮 18 #13）", () => {
    expectViolation(
      [user("q"), assistant({ toolCalls: [{ id: "t1", name: "", args: {} }] })],
      "name 为空串",
    );
  });

  it("toolCall signature 为空串 → 拒绝（gemini thoughtSignature 空串回传是端点 400 形态，轮 38 #4；与 id/name 空串同动机）", () => {
    expectViolation(
      [
        user("q"),
        assistant({
          toolCalls: [{ id: "t1", name: AGENT_TOOL.name, args: {}, signature: "" }],
        }),
      ],
      "signature 为空串",
    );
  });

  it("toolCall args 非普通对象（null/数组）→ 拒绝（请求侧 input/args 原样序列化出站即 400，轮 42 #4——响应侧轮 12 #13 已兜底，两方向对称；cloneWorkMessages 对非 record 原样透传，此层唯一权威）", () => {
    expectViolation(
      [
        user("q"),
        assistant({
          // JS 宿主绕过 TS 类型的宽化输入；as 过 TS2352 与既有限制用例同款
          toolCalls: [
            { id: "t1", name: AGENT_TOOL.name, args: null as unknown as Record<string, unknown> },
          ],
        }),
      ],
      "args 非普通对象",
    );
    expectViolation(
      [
        user("q"),
        assistant({
          toolCalls: [
            { id: "t1", name: AGENT_TOOL.name, args: [1, 2] as unknown as Record<string, unknown> },
          ],
        }),
      ],
      "args 非普通对象",
    );
    // Date/Map 等「typeof object 但非普通对象」（轮 43 #6）：宽谓词下经浅拷贝静默
    // 展开成 {}（整棵 args 清空）——与 null/数组同档拦截
    expectViolation(
      [
        user("q"),
        assistant({
          toolCalls: [
            {
              id: "t1",
              name: AGENT_TOOL.name,
              args: new Date() as unknown as Record<string, unknown>,
            },
          ],
        }),
      ],
      "args 非普通对象",
    );
  });

  it("toolResult 文本为空 → 拒绝（anthropic 字符串 content 直发空串是 400 形态，轮 17 #8）", () => {
    expectViolation(
      [
        user("q"),
        assistant({ toolCalls: [{ id: "t1", name: AGENT_TOOL.name, args: {} }] }),
        { role: "toolResult", toolCallId: "t1", toolName: AGENT_TOOL.name, text: "" },
      ],
      "文本为空",
    );
  });

  it("providerName 进异常的 provider 字段", () => {
    let caught: unknown;
    try {
      assertValidMessages([], "glm-anthropic");
    } catch (e) {
      caught = e;
    }
    // 先锁类型再断言字段（轮 17 #12）：不抛时 caught 为 undefined，裸 cast 访问
    // 会以 TypeError 形态失败而非清晰断言信息
    expect(caught).toBeInstanceOf(LLMProtocolViolationError);
    expect((caught as LLMProtocolViolationError).provider).toBe("glm-anthropic");
  });
});
