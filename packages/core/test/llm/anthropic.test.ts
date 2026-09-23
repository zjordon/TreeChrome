// anthropic-messages 适配器单测（04 §5 覆盖矩阵 A 列）。
// wire 断言口径：对象级 deep-equal + 「键不存在」锁缺省字段不发（temperature 地雷）。
import { describe, expect, it } from "vitest";
import type { ChatRequest, ProviderConfig } from "../../src/index.js";
import { createAnthropicProvider } from "../../src/llm/adapters/anthropic-messages.js";
import {
  LLMAuthError,
  LLMConnectionError,
  LLMInvalidRequestError,
  LLMProtocolViolationError,
  LLMRateLimitError,
  LLMServerError,
} from "../../src/llm/errors.js";
import { AGENT_TOOL, stubDeps } from "./fixtures.js";
import { MockFetch } from "./mock-fetch.js";

const CARD: ProviderConfig = {
  name: "glm-anthropic",
  protocol: "anthropic-messages",
  baseUrl: "https://open.bigmodel.cn/api/anthropic",
  apiKey: "sk-test",
  model: "glm-5.1",
  maxTokens: 16384,
};

const TOOL = AGENT_TOOL;

function setup(over: Partial<ProviderConfig> = {}) {
  const mock = new MockFetch();
  const provider = createAnthropicProvider({ ...CARD, ...over }, stubDeps(mock));
  return { mock, provider };
}

const toolOk = (input: Record<string, unknown>) => ({
  status: 200,
  body: {
    content: [{ type: "tool_use", id: "toolu_1", name: "agent_response", input }],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 20 },
  },
});

describe("请求构造（canonical → wire）", () => {
  it("全量映射：system 独立字段、text/image 块、tool_use、连续 toolResult 折叠进一条 user", async () => {
    const { mock, provider } = setup();
    mock.queueMany(toolOk({ next_goal: "go" }));
    await provider.chat({
      systemPrompt: "You are an agent.",
      messages: [
        {
          role: "user",
          blocks: [
            { kind: "text", text: "hi" },
            { kind: "image", mimeType: "image/png", base64: "AAAA" },
          ],
        },
        {
          role: "assistant",
          blocks: [{ kind: "text", text: "ok" }],
          toolCalls: [
            { id: "t1", name: "agent_response", args: { action: "click" } },
            { id: "t2", name: "agent_response", args: { action: "type" } },
          ],
        },
        // 乱序到达：t2 在前——折叠时按 assistant.toolCalls 顺序重排为 t1、t2
        { role: "toolResult", toolCallId: "t2", toolName: "agent_response", text: "done2" },
        {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "agent_response",
          text: "done1",
          isError: true,
        },
        { role: "user", blocks: [{ kind: "text", text: "next" }] },
      ],
      tools: [TOOL],
      toolChoice: { kind: "forced", name: "agent_response" },
    });

    expect(mock.calls[0].url).toBe("https://open.bigmodel.cn/api/anthropic/v1/messages");
    expect(mock.calls[0].init.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": "sk-test",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    });
    expect(mock.lastBody()).toEqual({
      model: "glm-5.1",
      max_tokens: 16384,
      system: "You are an agent.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            { type: "tool_use", id: "t1", name: "agent_response", input: { action: "click" } },
            { type: "tool_use", id: "t2", name: "agent_response", input: { action: "type" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "done1", is_error: true },
            { type: "tool_result", tool_use_id: "t2", content: "done2" },
            // 连续同角色折叠：toolResult 折叠出的 user 与紧随的 user 观察合并
            //（Anthropic 要求角色交替，400 地雷——同 toolResult 折叠同族）
            { type: "text", text: "next" },
          ],
        },
      ],
      tools: [{ name: "agent_response", description: "respond", input_schema: TOOL.parameters }],
      tool_choice: { type: "tool", name: "agent_response" },
    });
    // 缺省不发 temperature（02 §2.2 地雷 2 同族）
    expect(mock.lastBody()).not.toHaveProperty("temperature");
  });

  it("纯工具调用回合：assistant 空 blocks → content 仅 tool_use", async () => {
    const { mock, provider } = setup();
    mock.queueMany(toolOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [
        { role: "user", blocks: [{ kind: "text", text: "q" }] },
        {
          role: "assistant",
          blocks: [],
          toolCalls: [{ id: "t1", name: "agent_response", args: { a: 1 } }],
        },
        { role: "toolResult", toolCallId: "t1", toolName: "agent_response", text: "r" },
      ],
      tools: [TOOL],
    });
    const body = mock.lastBody();
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "q" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "agent_response", input: { a: 1 } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "r" }] },
    ]);
    expect(body).not.toHaveProperty("system");
    expect(body).not.toHaveProperty("tool_choice"); // 缺省 auto → 不发
  });

  it("toolChoice auto / tools null / maxTokens 覆盖 / temperature 显式发", async () => {
    const { mock, provider } = setup();
    mock.queueMany(toolOk({}), toolOk({}));
    await provider.chat({
      systemPrompt: "s",
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: [TOOL],
      toolChoice: { kind: "auto" },
      maxTokens: 512,
      temperature: 0.2,
    });
    const auto = mock.lastBody();
    expect(auto.tool_choice).toBeUndefined();
    expect(auto.max_tokens).toBe(512);
    expect(auto.temperature).toBe(0.2);

    await provider.chat({
      systemPrompt: "s",
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    });
    const noTools = mock.lastBody();
    expect(noTools).not.toHaveProperty("tools");
    expect(noTools).not.toHaveProperty("tool_choice");
  });

  it("temperature 回退链：请求级缺省用卡片级，两级都缺省不发", async () => {
    const { mock, provider } = setup({ temperature: 0.4 });
    mock.queueMany(toolOk({}), toolOk({}), toolOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    });
    expect(mock.lastBody().temperature).toBe(0.4); // 卡片级回退
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
      temperature: 0.9,
    });
    expect(mock.lastBody().temperature).toBe(0.9); // 请求级优先
    const noCard = setup();
    noCard.mock.queueMany(toolOk({}));
    await noCard.provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    });
    expect(noCard.mock.lastBody()).not.toHaveProperty("temperature"); // 两级缺省不发
  });

  it("连续同角色消息折叠：user+user 合并 content；toolResult 折叠出的 user 与紧随 user 观察合并", async () => {
    const { mock, provider } = setup();
    mock.queueMany(toolOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [
        { role: "user", blocks: [{ kind: "text", text: "first" }] },
        { role: "user", blocks: [{ kind: "text", text: "second" }] },
        {
          role: "assistant",
          blocks: [],
          toolCalls: [{ id: "t1", name: "agent_response", args: {} }],
        },
        { role: "toolResult", toolCallId: "t1", toolName: "agent_response", text: "done" },
        { role: "user", blocks: [{ kind: "text", text: "observation" }] },
      ],
      tools: [TOOL],
    });
    const messages = mock.lastBody().messages as Array<Record<string, unknown>>;
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "agent_response", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "done" },
          { type: "text", text: "observation" },
        ],
      },
    ]);
  });

  it("extraHeaders 最后合并（可覆盖默认头）；尾斜杠 baseUrl 剥离", async () => {
    const { mock, provider } = setup({
      baseUrl: "https://api.anthropic.com/",
      extraHeaders: { "x-api-key": "override", "x-custom": "1" },
    });
    mock.queueMany(toolOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    });
    expect(mock.calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(mock.calls[0].init.headers).toMatchObject({ "x-api-key": "override", "x-custom": "1" });
  });
});

describe("响应解析（wire → canonical）", () => {
  const baseReq = (): ChatRequest => ({
    systemPrompt: null,
    messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
    tools: [TOOL],
  });

  it("thinking 块进 reasoningText、非请求工具名的 tool_use 被忽略、usage cache 字段直映", async () => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 200,
      body: {
        content: [
          { type: "thinking", thinking: "hmm", signature: "sig" },
          { type: "text", text: "answer" },
          { type: "tool_use", id: "toolu_1", name: "agent_response", input: { a: 1 } },
          { type: "tool_use", id: "toolu_2", name: "other_tool", input: {} },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
        },
      },
    });
    const res = await provider.chat({
      ...baseReq(),
      toolChoice: { kind: "forced", name: "agent_response" },
    });
    expect(res).toEqual({
      text: "answer",
      reasoningText: "hmm",
      toolCalls: [{ id: "toolu_1", name: "agent_response", args: { a: 1 } }],
      stopReason: "tool_call",
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4 },
    });
  });

  it('tool_use 缺失/空 id → 丢弃（回传历史 id="" 会被官方端点 400）', async () => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 200,
      body: {
        content: [
          { type: "tool_use", name: "agent_response", input: { a: 1 } },
          { type: "tool_use", id: "", name: "agent_response", input: { b: 2 } },
        ],
        stop_reason: "tool_use",
        usage: null,
      },
    });
    const res = await provider.chat(baseReq());
    expect(res.toolCalls).toEqual([]);
  });

  it("tools null + forced toolChoice → 不发孤立 tool_choice（ChatRequest 契约）", async () => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 200,
      body: { content: [{ type: "text", text: "t" }], stop_reason: "end_turn" },
    });
    await provider.chat({ ...baseReq(), tools: null, toolChoice: { kind: "forced", name: "x" } });
    expect(mock.lastBody()).not.toHaveProperty("tool_choice");
    expect(mock.lastBody()).not.toHaveProperty("tools");
  });

  it.each([
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["max_tokens", "length"],
    ["refusal", "other"],
  ] as const)("stop_reason %s → %s；usage 缺失 → null", async (raw, expected) => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 200,
      body: { content: [{ type: "text", text: "t" }], stop_reason: raw },
    });
    const res = await provider.chat(baseReq());
    expect(res.stopReason).toBe(expected);
    expect(res.usage).toBeNull();
  });

  it("content 缺失容错为空（text 空/toolCalls 空 → 落 R1 语义由 client 处理）", async () => {
    const { mock, provider } = setup();
    mock.queueMany({ status: 200, body: { stop_reason: "end_turn" } });
    const res = await provider.chat(baseReq());
    expect(res.text).toBe("");
    expect(res.toolCalls).toEqual([]);
  });

  it("响应不是对象 → LLMProtocolViolationError", async () => {
    const { mock, provider } = setup();
    mock.queueMany({ status: 200, body: "not-an-object" });
    await expect(provider.chat(baseReq())).rejects.toBeInstanceOf(LLMProtocolViolationError);
  });
});

describe("错误映射（状态 → 错误类 + error.message 提取 + Retry-After）", () => {
  const baseReq = (): ChatRequest => ({
    systemPrompt: null,
    messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
    tools: null,
  });

  it.each([
    [429, LLMRateLimitError],
    [401, LLMAuthError],
    [403, LLMAuthError],
    [400, LLMInvalidRequestError],
    [500, LLMServerError],
    [503, LLMServerError],
  ] as const)("HTTP %s → %s（anthropic 错误体 message 进异常）", async (status, klass) => {
    const { mock, provider } = setup();
    mock.queueMany({
      status,
      body: { type: "error", error: { type: "x", message: `boom ${status}` } },
    });
    const err = await provider.chat(baseReq()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(klass);
    expect((err as Error).message).toContain(`boom ${status}`);
  });
  // http 层单测（parseRetryAfterMs/Retry-After 头/错误体形态/截断）已抽离到 http.test.ts

  it("网络层 TypeError → LLMConnectionError（cause 保留）", async () => {
    const { mock, provider } = setup();
    const netErr = new TypeError("fetch failed");
    mock.queueMany({ networkError: netErr });
    const err = await provider.chat(baseReq()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMConnectionError);
    expect((err as LLMConnectionError).cause).toBe(netErr);
  });
});

describe("testConnection", () => {
  it("成功 → {ok, model}；失败 → {ok:false, error 含状态}", async () => {
    const ok = setup();
    ok.mock.queueMany({
      status: 200,
      body: { content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", usage: null },
    });
    await expect(ok.provider.testConnection()).resolves.toEqual({ ok: true, model: "glm-5.1" });

    const bad = setup();
    bad.mock.queueMany({ status: 401, body: { error: { message: "bad key" } } });
    const r = await bad.provider.testConnection();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("401");
    expect(r.model).toBeUndefined();
  });
});
