// gemini 适配器 + schema-sanitize 单测（04 §5 覆盖矩阵 G 列）。
// 无内部参考（webbrain 无 gemini provider）：断言全部锚定 02 §4 冻结的官方规格映射，
// 真机差异等有 key 实测后修订（README 风险 3——验收以 mock 为准，标注待实测）。
import { describe, expect, it } from "vitest";
import type { ChatRequest, ProviderConfig } from "../../src/index.js";
import { createGeminiProvider } from "../../src/llm/adapters/gemini.js";
import { sanitizeGeminiSchema } from "../../src/llm/adapters/schema-sanitize.js";
import {
  LLMBlockedError,
  LLMProtocolViolationError,
  LLMRateLimitError,
} from "../../src/llm/errors.js";
import { setupProvider, stubDeps } from "./fixtures.js";
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
      // minimum 数值约束键：官方 Schema 支持的约束键（轮 10 起白名单收录，透传保留）
      action: { type: "object", description: "the action", additionalProperties: true, minimum: 1 },
      tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
    },
    required: ["action"],
  },
};

const SANITIZED = {
  type: "object",
  properties: {
    action: { type: "object", description: "the action", minimum: 1 },
    tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
  },
  required: ["action"],
};

const setup = (over: Partial<ProviderConfig> = {}) =>
  setupProvider(createGeminiProvider, CARD, over);

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
  it("白名单外键删除（$schema/additionalProperties/examples/$id），约束键（minimum）保留透传", () => {
    expect(sanitizeGeminiSchema(TOOL.parameters)).toEqual(SANITIZED);
  });

  it("官方约束键透传：minimum/maximum/pattern/minItems 保留，多词键按官方 camelCase 发射", () => {
    expect(
      sanitizeGeminiSchema({
        type: "object",
        minimum: 0,
        Maximum: 10,
        pattern: "^a",
        MinLength: 1,
        maxlength: 20,
        minItems: 0,
        MaxItems: 5,
      }),
    ).toEqual({
      type: "object",
      minimum: 0,
      maximum: 10,
      pattern: "^a",
      minLength: 1,
      maxLength: 20,
      minItems: 0,
      maxItems: 5,
    });
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

  it("边界 type: ['null'] → 兜底合法 type 枚举（不产出无 type 的 schema）", () => {
    expect(sanitizeGeminiSchema({ type: ["null"] })).toEqual({ type: "string", nullable: true });
  });

  it("单值 type:'null' 与数组含非字符串病态元素 → 同一兜底路径收口（'null' 不在 Gemini 枚举内）", () => {
    expect(sanitizeGeminiSchema({ type: "null" })).toEqual({ type: "string", nullable: true });
    expect(sanitizeGeminiSchema({ type: ["null", 5] })).toEqual({ type: "string", nullable: true });
    expect(sanitizeGeminiSchema({ type: [5, "object", "null"] })).toEqual({
      type: "object",
      nullable: true,
    });
  });

  it("非对象子 schema（含 draft-06+ 布尔 schema）归一为空 schema、required 非 string[] 删除——原样透传会被端点 400；原始 schema 不被改动", () => {
    const original = { type: "object", properties: { n: 3, s: "x", ok: true }, required: null };
    const snapshot = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
    const issues: string[] = [];
    expect(sanitizeGeminiSchema(original, (d) => issues.push(d))).toEqual({
      type: "object",
      properties: { n: {}, s: {}, ok: {} },
      // required: null 已被删除（官方只收 string[]）
    });
    expect(original).toEqual(snapshot);
    expect(issues).toEqual([
      "属性「n」子 schema 非对象，归一为空 schema",
      "属性「s」子 schema 非对象，归一为空 schema",
      "属性「ok」子 schema 非对象，归一为空 schema",
      "required 非 string[]，删除该键",
    ]);
  });

  it("type 联合多成员窄化 + items 元组/非对象收口 → 上报清洗事件（与删键同观测口径）", () => {
    const issues: string[] = [];
    const out = sanitizeGeminiSchema(
      {
        type: ["string", "number"],
        items: [{ type: "string" }, { type: "number" }],
      },
      (d) => issues.push(d),
    );
    expect(out).toEqual({ type: "string", items: { type: "string" } });
    const nonRecordItems = sanitizeGeminiSchema({ items: "x" }, (d) => issues.push(d));
    expect(nonRecordItems).toEqual({ items: {} });
    expect(issues).toEqual([
      "type 联合窄化 string|number → string",
      "items 元组形态窄化为首元素",
      "items 非对象形态归一为空 schema",
    ]);
  });

  it("onSchemaIssue：删键时按归一化键名上报（顶层与嵌套递归），约束键不报", () => {
    const issues: string[] = [];
    const out = sanitizeGeminiSchema(
      {
        type: "object",
        $schema: "x",
        ExclusiveMinimum: 1,
        properties: { inner: { examples: [1], type: "string", minimum: 0 } },
      },
      (d) => issues.push(d),
    );
    expect(out).toEqual({
      type: "object",
      properties: { inner: { type: "string", minimum: 0 } },
    });
    expect(issues).toEqual([
      "删除白名单外键「$schema」",
      "删除白名单外键「exclusiveminimum」",
      "删除白名单外键「examples」",
    ]);
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
    expect(mock.calls[0].init.headers).toEqual({
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

  it("tools null + forced toolChoice → 不发孤立 toolConfig（ChatRequest 契约，三协议一致）", async () => {
    const { mock, provider } = setup();
    mock.queueMany(fnCallOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
      toolChoice: { kind: "forced", name: "agent_response" },
    });
    expect(mock.lastBody()).not.toHaveProperty("tools");
    expect(mock.lastBody()).not.toHaveProperty("toolConfig");
  });

  it("tools 空数组 → 不发 tools/toolConfig（空 functionDeclarations 是端点 400 形态；forced 一并抑制）", async () => {
    const { mock, provider } = setup();
    mock.queueMany(fnCallOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: [],
      toolChoice: { kind: "forced", name: "agent_response" },
    });
    expect(mock.lastBody()).not.toHaveProperty("tools");
    expect(mock.lastBody()).not.toHaveProperty("toolConfig");
  });

  it("schema 清洗事件告警在 provider 实例级去重（同 schema 逐请求固定，重复只有噪音）", async () => {
    const mock = new MockFetch();
    const logs: string[] = [];
    const provider = createGeminiProvider(CARD, { ...stubDeps(mock), log: (m) => logs.push(m) });
    const req: ChatRequest = {
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: [TOOL],
    };
    mock.queueMany(fnCallOk({}), fnCallOk({}));
    await provider.chat(req);
    await provider.chat(req);
    // 契约：删键事件按首现序各告警一次、键名以归一化（小写）口径上报。
    // 注：关键词「白名单外键」与「」引号包裹格式是本断言契约的一部分（并非完全
    // 文案解耦）——措辞的其余部分可自由调整：
    // $schema（顶层）、additionalproperties（顶层+嵌套 action 同名）
    const droppedKeys = logs
      .filter((m) => m.includes("白名单外键"))
      .map((m) => m.match(/「([^」]+)」/)?.[1] ?? "");
    expect(droppedKeys).toEqual(["$schema", "additionalproperties"]);
  });

  it("去重集条数上限（128）：动态 schema 的无界增长封顶——上限后新事件静默", async () => {
    const mock = new MockFetch();
    const logs: string[] = [];
    const provider = createGeminiProvider(CARD, { ...stubDeps(mock), log: (m) => logs.push(m) });
    // 130 个唯一属性名（各产生一条唯一清洗事件）→ 仅前 128 条告警
    const dynamicProps: Record<string, unknown> = {};
    for (let i = 0; i < 130; i += 1) {
      dynamicProps[`p${i}`] = i; // 非对象子 schema → 每属性一条唯一事件
    }
    const tool = { ...TOOL, parameters: { type: "object", properties: dynamicProps } };
    mock.queueMany(fnCallOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: [tool],
    });
    expect(logs.length).toBe(128);
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
    mock.queueMany(fnCallOk({}), fnCallOk({}));
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

  it("thoughtSignature：解析捕获进 ToolCall.signature，回传时随 functionCall part 原样写回（2.5/3 thinking 模型硬要求，不回传即 400）", async () => {
    const { mock, provider } = setup();
    mock.queueMany(
      {
        status: 200,
        body: {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: { name: "agent_response", args: { a: 1 } },
                    thoughtSignature: "sig-1",
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: null,
        },
      },
      fnCallOk({}),
    );
    const first = await provider.chat(baseReq());
    expect(first.toolCalls).toEqual([
      { id: "gemini-call-0", name: "agent_response", args: { a: 1 }, signature: "sig-1" },
    ]);
    await provider.chat({
      systemPrompt: null,
      messages: [
        { role: "user", blocks: [{ kind: "text", text: "q" }] },
        { role: "assistant", blocks: [], toolCalls: first.toolCalls },
        { role: "toolResult", toolCallId: "gemini-call-0", toolName: "agent_response", text: "ok" },
      ],
      tools: [TOOL],
    });
    const contents = mock.lastBody().contents as Array<Record<string, unknown>>;
    expect(contents[1]).toEqual({
      role: "model",
      parts: [
        { functionCall: { name: "agent_response", args: { a: 1 } }, thoughtSignature: "sig-1" },
      ],
    });
    // 双携带（轮 10 #9）：签名同时随下一回合的 functionResponse part 回传——官方
    // 两处口径并存（错误文案指 functionCall part、SDK 组装指 functionResponse），
    // 真机核验后收敛（README 风险 3）
    expect(contents[2]).toEqual({
      role: "user",
      parts: [
        {
          functionResponse: { name: "agent_response", response: { result: "ok" } },
          thoughtSignature: "sig-1",
        },
      ],
    });
  });

  it("合成 id 跨响应持续自增（宿主可能以 toolCallId 作跨回合键，不碰撞）", async () => {
    const { mock, provider } = setup();
    mock.queueMany(fnCallOk({}), fnCallOk({}));
    const first = await provider.chat(baseReq());
    const second = await provider.chat(baseReq());
    expect(first.toolCalls[0]?.id).toBe("gemini-call-0");
    expect(second.toolCalls[0]?.id).toBe("gemini-call-1");
  });

  it("只有被丢弃的 functionCall（非请求名）→ stopReason 按 finishReason 归一，不因丢弃变形", async () => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 200,
      body: {
        candidates: [
          {
            content: { role: "model", parts: [{ functionCall: { name: "other", args: {} } }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: null,
      },
    });
    const res = await provider.chat(baseReq());
    expect(res.toolCalls).toEqual([]);
    expect(res.stopReason).toBe("stop"); // 从保留的调用推导（toolCalls 空不报 tool_call）
  });

  it("无参 functionCall（args 被 proto3 JSON 省略 / 转换型网关 args:null）→ 兜底 {} 保留（与 anthropic input 口径对齐）", async () => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 200,
      body: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { functionCall: { name: "agent_response" } },
                { functionCall: { name: "agent_response", args: null } },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: null,
      },
    });
    const res = await provider.chat(baseReq());
    expect(res.toolCalls).toEqual([
      { id: "gemini-call-0", name: "agent_response", args: {} },
      { id: "gemini-call-1", name: "agent_response", args: {} },
    ]);
  });

  it("响应不是对象 → LLMProtocolViolationError（provider 归因到卡片 name，fallback 双卡可区分）", async () => {
    const { mock, provider } = setup();
    mock.queueMany({ status: 200, body: "not-an-object" });
    const err = await provider.chat(baseReq()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMProtocolViolationError);
    expect((err as LLMProtocolViolationError).provider).toBe("gemini-card");
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

  it("promptFeedback.blockReason → LLMBlockedError（全局拦截，无候选内容；provider 归因到卡片 name）", async () => {
    const { mock, provider } = setup();
    mock.queueMany({ status: 200, body: { promptFeedback: { blockReason: "SAFETY" } } });
    const err = await provider.chat(baseReq()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMBlockedError);
    expect((err as LLMBlockedError).provider).toBe("gemini-card");
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
