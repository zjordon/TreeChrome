// gemini 适配器 + schema-sanitize 单测（04 §5 覆盖矩阵 G 列）。
// 无内部参考（webbrain 无 gemini provider）：断言全部锚定 02 §4 冻结的官方规格映射，
// 真机差异等有 key 实测后修订（README 风险 3——验收以 mock 为准，标注待实测）。
import { describe, expect, it } from "vitest";
import type { ChatRequest, ProviderConfig } from "../../src/index.js";
import { createGeminiProvider } from "../../src/llm/adapters/gemini.js";
import { sanitizeGeminiSchema } from "../../src/llm/adapters/schema-sanitize.js";
import { LLMBlockedError, LLMRateLimitError } from "../../src/llm/errors.js";
import { stubDeps } from "./fixtures.js";
import { MockFetch } from "./mock-fetch.js";

const CARD: ProviderConfig = {
  name: "gemini-card",
  protocol: "gemini",
  baseUrl: "https://generativelanguage.googleapis.com",
  apiKey: "g-key",
  model: "gemini-2.5-pro",
  maxTokens: 8192,
};

const TOOL = {
  name: "agent_response",
  description: "respond",
  parameters: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "object", description: "the action", additionalProperties: true },
      tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
    },
    required: ["action"],
  },
};

const SANITIZED = {
  type: "object",
  properties: {
    action: { type: "object", description: "the action" },
    tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
  },
  required: ["action"],
};

function setup(over: Partial<ProviderConfig> = {}) {
  const mock = new MockFetch();
  const provider = createGeminiProvider({ ...CARD, ...over }, stubDeps(mock));
  return { mock, provider };
}

const fnCallOk = (args: Record<string, unknown>) => ({
  status: 200,
  body: {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ functionCall: { name: "agent_response", args } }],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
  },
});

describe("sanitizeGeminiSchema（白名单递归清洗）", () => {
  it("白名单外键删除（$schema/additionalProperties/examples/$id/minimum），白名单内保留", () => {
    expect(sanitizeGeminiSchema(TOOL.parameters)).toEqual(SANITIZED);
  });

  it("嵌套 properties/items 递归清洗；type 大小写变体（Type）归一化为小写键", () => {
    const out = sanitizeGeminiSchema({
      Type: "object",
      $id: "x",
      properties: { inner: { Type: "string", examples: ["a"], enum: ["x"] } },
      items: { $schema: "y", type: "string" },
    });
    expect(out).toEqual({
      type: "object",
      properties: { inner: { type: "string", enum: ["x"] } },
      items: { type: "string" },
    });
  });

  it("联合类型 type: ['string','null'] → 首个非 null + nullable（Gemini type 只收单字符串）", () => {
    expect(
      sanitizeGeminiSchema({
        type: ["string", "null"],
        properties: { opt: { type: ["object", "null"], description: "d" } },
      }),
    ).toEqual({
      type: "string",
      nullable: true,
      properties: { opt: { type: "object", nullable: true, description: "d" } },
    });
  });

  it("非对象子项原样透传；原始 schema 不被改动", () => {
    const original = { type: "object", properties: { n: 3, s: "x", arr: [1] }, required: null };
    const snapshot = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
    expect(sanitizeGeminiSchema(original)).toEqual({
      type: "object",
      properties: { n: 3, s: "x", arr: [1] },
      required: null,
    });
    expect(original).toEqual(snapshot);
  });
});

describe("请求构造（canonical → wire）", () => {
  it("全量映射：x-goog-api-key 头、systemInstruction、user/model 角色、inlineData、functionCall 同 turn、toolResult 折叠一条 user turn、forced=ANY", async () => {
    const { mock, provider } = setup();
    mock.queueMany(fnCallOk({}));
    await provider.chat({
      systemPrompt: "You are an agent.",
      messages: [
        {
          role: "user",
          blocks: [
            { kind: "text", text: "look" },
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
        // 乱序到达：t2 在前——按前置 assistant.toolCalls 顺序重排
        { role: "toolResult", toolCallId: "t2", toolName: "agent_response", text: "done2" },
        {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "agent_response",
          text: "failed",
          isError: true,
        },
        { role: "user", blocks: [{ kind: "text", text: "next" }] },
      ],
      tools: [TOOL],
      toolChoice: { kind: "forced", name: "agent_response" },
    });

    expect(mock.calls[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
    );
    expect(mock.calls[0].init.headers).toMatchObject({
      "content-type": "application/json",
      "x-goog-api-key": "g-key",
    });
    expect(mock.lastBody()).toEqual({
      systemInstruction: { parts: [{ text: "You are an agent." }] },
      contents: [
        {
          role: "user",
          parts: [{ text: "look" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }],
        },
        {
          role: "model",
          parts: [
            { text: "ok" },
            { functionCall: { name: "agent_response", args: { action: "click" } } },
            { functionCall: { name: "agent_response", args: { action: "type" } } },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: { name: "agent_response", response: { result: "[error] failed" } },
            },
            { functionResponse: { name: "agent_response", response: { result: "done2" } } },
            // 连续同角色折叠：toolResult 折叠出的 user turn 与紧随的 user 观察合并
            //（Gemini 要求 user/model 交替，400 地雷）
            { text: "next" },
          ],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            { name: "agent_response", description: "respond", parameters: SANITIZED },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["agent_response"] },
      },
      generationConfig: { maxOutputTokens: 8192 },
    });
    expect(mock.lastBody().generationConfig).not.toHaveProperty("temperature");
  });

  it("纯工具调用 model turn（无文本 part）；auto 不发 toolConfig；tools null 不发 tools", async () => {
    const { mock, provider } = setup();
    mock.queueMany(fnCallOk({}), fnCallOk({}));
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
    const contents = mock.lastBody().contents as Array<Record<string, unknown>>;
    expect(contents[1]).toEqual({
      role: "model",
      parts: [{ functionCall: { name: "agent_response", args: { a: 1 } } }],
    });
    expect(mock.lastBody()).not.toHaveProperty("toolConfig");
    expect(mock.lastBody()).not.toHaveProperty("systemInstruction");

    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    });
    expect(mock.lastBody()).not.toHaveProperty("tools");
    expect(mock.lastBody()).not.toHaveProperty("toolConfig");
  });

  it("maxTokens 请求级覆盖与 temperature 显式", async () => {
    const { mock, provider } = setup();
    mock.queueMany(fnCallOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
      maxTokens: 77,
      temperature: 0.5,
    });
    expect(mock.lastBody().generationConfig).toEqual({ maxOutputTokens: 77, temperature: 0.5 });
  });

  it("temperature 回退链：请求级缺省用卡片级；两级缺省不发", async () => {
    const { mock, provider } = setup({ temperature: 0.3 });
    mock.queueMany(fnCallOk({}), fnCallOk({}), fnCallOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    });
    const genConfig = () => mock.lastBody().generationConfig as Record<string, unknown>;
    expect(genConfig().temperature).toBe(0.3);
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
      temperature: 0.8,
    });
    expect(genConfig().temperature).toBe(0.8);
    const noCard = setup();
    noCard.mock.queueMany(fnCallOk({}));
    await noCard.provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    });
    expect(noCard.mock.lastBody().generationConfig).not.toHaveProperty("temperature");
  });

  it("连续 user turn 折叠（canonical 允许 [user, user]，Gemini 要求交替）", async () => {
    const { mock, provider } = setup();
    mock.queueMany(fnCallOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [
        { role: "user", blocks: [{ kind: "text", text: "first" }] },
        { role: "user", blocks: [{ kind: "text", text: "second" }] },
      ],
      tools: [TOOL],
    });
    expect(mock.lastBody().contents).toEqual([
      { role: "user", parts: [{ text: "first" }, { text: "second" }] },
    ]);
  });

  it("model 路径段编码：异常字符不截断 URL（配置问题不变形为 Invalid URL/404）", async () => {
    const { mock, provider } = setup({ model: "gemini 2.5#x" });
    mock.queueMany(fnCallOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    });
    expect(mock.calls[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini%202.5%23x:generateContent",
    );
  });
});

describe("响应解析（wire → canonical）", () => {
  const baseReq = (): ChatRequest => ({
    systemPrompt: null,
    messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
    tools: [TOOL],
  });

  it("thought part 分流进 reasoningText；functionCall 合成 id；非请求名过滤；parts 推导 stopReason 优先", async () => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 200,
      body: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { text: "hmm", thought: true },
                { text: "answer" },
                { functionCall: { name: "agent_response", args: { a: 1 } } },
                { functionCall: { name: "agent_response", args: { b: 2 } } },
                { functionCall: { name: "other", args: {} } },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, cachedContentTokenCount: 3 },
      },
    });
    const res = await provider.chat(baseReq());
    expect(res).toEqual({
      text: "answer",
      reasoningText: "hmm",
      toolCalls: [
        { id: "gemini-call-0", name: "agent_response", args: { a: 1 } },
        { id: "gemini-call-1", name: "agent_response", args: { b: 2 } },
      ],
      stopReason: "tool_call",
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 },
    });
  });

  it.each([
    ["STOP", "stop"],
    ["MAX_TOKENS", "length"],
    ["SAFETY", "other"],
  ] as const)("finishReason %s（无 functionCall）→ %s", async (raw, expected) => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 200,
      body: {
        candidates: [{ content: { role: "model", parts: [{ text: "t" }] }, finishReason: raw }],
        usageMetadata: null,
      },
    });
    const res = await provider.chat(baseReq());
    expect(res.stopReason).toBe(expected);
    expect(res.usage).toBeNull();
  });

  it("candidates 缺失容错为空响应", async () => {
    const { mock, provider } = setup();
    mock.queueMany({ status: 200, body: {} });
    const res = await provider.chat(baseReq());
    expect(res).toEqual({ text: "", toolCalls: [], stopReason: "other", usage: null });
  });

  it("promptFeedback.blockReason → LLMBlockedError（全局拦截，无候选内容）", async () => {
    const { mock, provider } = setup();
    mock.queueMany({ status: 200, body: { promptFeedback: { blockReason: "SAFETY" } } });
    await expect(provider.chat(baseReq())).rejects.toBeInstanceOf(LLMBlockedError);
  });

  it("429 gemini 错误体（error.code/message/status）→ LLMRateLimitError", async () => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 429,
      body: { error: { code: 429, message: "Resource exhausted", status: "RESOURCE_EXHAUSTED" } },
    });
    const err = await provider.chat(baseReq()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMRateLimitError);
    expect((err as Error).message).toContain("Resource exhausted");
  });

  it("testConnection 两态", async () => {
    const ok = setup();
    ok.mock.queueMany({
      status: 200,
      body: {
        candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
      },
    });
    await expect(ok.provider.testConnection()).resolves.toEqual({
      ok: true,
      model: "gemini-2.5-pro",
    });

    const bad = setup();
    bad.mock.queueMany({ status: 403, body: { error: { message: "no key" } } });
    const r = await bad.provider.testConnection();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("403");
  });
});
