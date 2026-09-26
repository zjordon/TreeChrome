// anthropic-messages 适配器单测（04 §5 覆盖矩阵 A 列）。
// wire 断言口径：对象级 deep-equal + 「键不存在」锁缺省字段不发（temperature 地雷）。
import { describe, expect, it } from "vitest";
import type { ChatRequest, ProviderConfig } from "../../src/index.js";
import { createAnthropicProvider } from "../../src/llm/adapters/anthropic-messages.js";
import { DEFAULT_MAX_TOKENS } from "../../src/llm/config.js";
import {
  LLMAuthError,
  LLMConnectionError,
  LLMInvalidRequestError,
  LLMProtocolViolationError,
  LLMRateLimitError,
  LLMServerError,
} from "../../src/llm/errors.js";
import { AGENT_TOOL, setupProvider, setupProviderWithLogs } from "./fixtures.js";

const CARD: ProviderConfig = {
  name: "glm-anthropic",
  protocol: "anthropic-messages",
  baseUrl: "https://open.bigmodel.cn/api/anthropic",
  apiKey: "sk-test",
  model: "glm-5.1",
  // ≠ DEFAULT_MAX_TOKENS(16384)：与「NaN 回退 DEFAULT」用例形成「卡片直通 vs 回退缺省」区分度（轮 21 #1）
  maxTokens: 4096,
};

const TOOL = AGENT_TOOL;

const setup = (over: Partial<ProviderConfig> = {}) =>
  setupProvider(createAnthropicProvider, CARD, over);

const toolOk = (input: Record<string, unknown>) => ({
  status: 200,
  body: {
    content: [{ type: "tool_use", id: "toolu_1", name: "agent_response", input }],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 20 },
  },
});

/** 带日志采集的装配（丢弃类/清洗类告警断言共用；over 覆盖卡片级配置，轮 21 #13） */
const setupLogs = (over: Partial<ProviderConfig> = {}) =>
  setupProviderWithLogs(createAnthropicProvider, CARD, over);
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
      max_tokens: 4096,
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
    mock.queueMany(toolOk({}), toolOk({}));
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

  it("temperature 按协议上限钳制（anthropic 0-1）：误配 1.5 不再每请求硬 400（轮 12 #7）", async () => {
    const { mock, provider } = setup({ temperature: 1.5 });
    mock.queueMany(toolOk({}), toolOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    });
    expect(mock.lastBody().temperature).toBe(1);
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
      temperature: -0.5,
    });
    expect(mock.lastBody().temperature).toBe(0); // 下界同钳
  });

  it("temperature NaN → 不发（Math 钳制对 NaN 透传会序列化成 null 被端点 400，轮 13 #5）", async () => {
    const { mock, provider } = setup({ temperature: Number.NaN });
    mock.queueMany(toolOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    });
    expect(mock.lastBody()).not.toHaveProperty("temperature");
  });

  it("temperature 钳制发生留 WARNING 且实例级去重（轮 16 #4；三适配器接线锚定——纯逻辑矩阵见 common.test.ts，轮 19 #2）", async () => {
    const { mock, logs, provider } = setupLogs({ temperature: 1.5 });
    const req: ChatRequest = {
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    };
    mock.queueMany(toolOk({}), toolOk({}));
    await provider.chat(req);
    await provider.chat(req);
    expect(mock.bodyAt(0).temperature).toBe(1);
    expect(mock.bodyAt(1).temperature).toBe(1);
    const warnings = logs.filter((m) => m.includes("钳制"));
    expect(warnings).toHaveLength(1); // 每请求都在钳制，告警只一次
    expect(warnings[0]).toContain("1.5");
    expect(warnings[0]).toContain("glm-anthropic"); // 卡片归因
  });

  it("maxTokens 非有限数值回退 DEFAULT_MAX_TOKENS 并留一次性 WARNING（轮 18 #10；三适配器接线锚定，纯逻辑见 common.test.ts）", async () => {
    const { mock, logs, provider } = setupLogs({ maxTokens: Number.NaN });
    mock.queueMany(toolOk({}), toolOk({}));
    const req: ChatRequest = {
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    };
    await provider.chat(req);
    await provider.chat(req);
    expect(mock.bodyAt(0).max_tokens).toBe(DEFAULT_MAX_TOKENS); // NaN 序列化 null 是端点硬 400
    expect(mock.bodyAt(1).max_tokens).toBe(DEFAULT_MAX_TOKENS);
    const warnings = logs.filter((m) => m.includes("maxTokens"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("glm-anthropic");
  });

  it("空串 systemPrompt 与 null 同等不发（空 system 文本是端点 400 形态，轮 20 #13）", async () => {
    const { mock, provider } = setup();
    mock.queueMany(toolOk({}));
    await provider.chat({
      systemPrompt: "",
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    });
    expect(mock.lastBody()).not.toHaveProperty("system");
  });

  it("baseUrl 以 /v1 结尾 → 一次性 WARNING（OpenAI 形态误配 /v1/v1/messages → 404 的根因留证据，轮 23 #1）", async () => {
    const { mock, logs, provider } = setupLogs({
      baseUrl: "https://open.bigmodel.cn/api/paas/v4/v1",
    });
    mock.queueMany(toolOk({}), toolOk({}));
    const req: ChatRequest = {
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    };
    await provider.chat(req);
    await provider.chat(req);
    expect(mock.calls[0].url).toContain("/v1/v1/messages"); // 误配形态如实拼接
    expect(logs.filter((m) => m.includes("疑似 OpenAI 形态误配"))).toHaveLength(1);
    // 阴性对照（轮 27 #3，与 gemini 轮 25 #1、openai 轮 23 #4 同族口径）：无误配
    // 的缺省卡片不告警——makeOnceWarn 去重下 toHaveLength(1) 测不出「误改为无条件」
    const plain = setupLogs();
    plain.mock.queueMany(toolOk({}));
    await plain.provider.chat(req);
    expect(plain.logs.filter((m) => m.includes("疑似 OpenAI 形态误配"))).toHaveLength(0);
  });

  it("baseUrl 以 /v1/messages 结尾（官方 curl 全端点整段复制）→ 如实拼接 + 一次性告警（轮 34 #9，与 openai /chat/completions 同族）", async () => {
    const misconfigured = setupLogs({
      baseUrl: "https://api.anthropic.com/v1/messages",
    });
    misconfigured.mock.queueMany(toolOk({}), toolOk({}));
    const req: ChatRequest = {
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    };
    await misconfigured.provider.chat(req);
    await misconfigured.provider.chat(req);
    expect(misconfigured.mock.calls[0].url).toContain("/v1/messages/v1/messages");
    expect(misconfigured.logs.filter((m) => m.includes("疑似整段端点 URL 误配"))).toHaveLength(1);
  });

  it("assistant 历史 image 块静默丢弃（assistant 角色只收 text/tool_use，官方端点 400 形态，轮 13 #13）", async () => {
    const { mock, provider } = setup();
    mock.queueMany(toolOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [
        { role: "user", blocks: [{ kind: "text", text: "q" }] },
        {
          role: "assistant",
          blocks: [{ kind: "image", mimeType: "image/png", base64: "AAAA" }],
          toolCalls: [{ id: "t1", name: TOOL.name, args: {} }],
        },
        { role: "toolResult", toolCallId: "t1", toolName: TOOL.name, text: "ok" },
      ],
      tools: [TOOL],
    });
    const wire = JSON.stringify(mock.lastBody().messages);
    expect(wire).not.toContain('"image"');
    expect(wire).toContain('"tool_use"');
  });

  it("image 块 mimeType 别名归一：image/jpg → image/jpeg（官方 media_type 封闭枚举，裸透传即 400，轮 27 #1）", async () => {
    const { mock, provider } = setup();
    mock.queueMany(toolOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [
        {
          role: "user",
          blocks: [
            { kind: "text", text: "look" },
            { kind: "image", mimeType: "image/jpg", base64: "AAAA" },
          ],
        },
      ],
      tools: null,
    });
    const messages = mock.lastBody().messages as Array<Record<string, unknown>>;
    const content = messages[0].content as Array<Record<string, unknown>>;
    const image = content.find((b) => b.type === "image") as Record<string, unknown>;
    expect((image.source as Record<string, unknown>).media_type).toBe("image/jpeg");
  });

  it("image-only 且无 toolCalls 的 assistant → 过滤后空 content 以 [image omitted] 占位（空 content 是硬 400，轮 14 #8）", async () => {
    const { mock, provider } = setup();
    mock.queueMany(toolOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [
        { role: "user", blocks: [{ kind: "text", text: "q" }] },
        { role: "assistant", blocks: [{ kind: "image", mimeType: "image/png", base64: "AAAA" }] },
        { role: "user", blocks: [{ kind: "text", text: "next" }] },
      ],
      tools: [TOOL],
    });
    const messages = mock.lastBody().messages as Array<Record<string, unknown>>;
    expect(messages[1].content).toEqual([{ type: "text", text: "[image omitted]" }]);
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
    expect(mock.calls[0].init.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": "override",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "x-custom": "1",
    });
  });

  it("tools null + forced toolChoice → 不发孤立 tool_choice（ChatRequest 契约）", async () => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 200,
      body: { content: [{ type: "text", text: "t" }], stop_reason: "end_turn" },
    });
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
      toolChoice: { kind: "forced", name: "x" },
    });
    expect(mock.lastBody()).not.toHaveProperty("tool_choice");
    expect(mock.lastBody()).not.toHaveProperty("tools");
  });

  it("tools 空数组 → 不发 tools/tool_choice（官方端点对空 tools 列表 400；forced 一并抑制）", async () => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 200,
      body: { content: [{ type: "text", text: "t" }], stop_reason: "end_turn" },
    });
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: [],
      toolChoice: { kind: "forced", name: "x" },
    });
    expect(mock.lastBody()).not.toHaveProperty("tool_choice");
    expect(mock.lastBody()).not.toHaveProperty("tools");
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
    expect(res.stopReason).toBe("other"); // 全部被丢弃：不置 tool_call（与 gemini 口径一致）
  });

  it("丢弃类事件留告警：缺失 id / 非请求名 / input 病态非对象（轮 12 #11/#13 观测口径锁定）", async () => {
    const { mock, logs, provider } = setupLogs();
    mock.queueMany({
      status: 200,
      body: {
        content: [
          { type: "tool_use", name: "agent_response", input: { a: 1 } }, // 缺失 id
          { type: "tool_use", id: "x1", name: "other_tool", input: {} }, // 非请求名
          // input 病态非对象（与 gemini args / openai arguments 的丢弃口径对齐）
          { type: "tool_use", id: "x2", name: "agent_response", input: "weird" },
          // 合法无参形态（input 缺失）兜底 {} 保留
          { type: "tool_use", id: "x3", name: "agent_response" },
        ],
        stop_reason: "tool_use",
        usage: null,
      },
    });
    const res = await provider.chat(baseReq());
    expect(res.toolCalls).toEqual([{ id: "x3", name: "agent_response", args: {} }]);
    expect(logs.some((m) => m.includes("缺失 id，丢弃调用") && m.includes("agent_response"))).toBe(
      true,
    );
    expect(logs.some((m) => m.includes("忽略非请求工具名") && m.includes("other_tool"))).toBe(true);
    expect(logs.some((m) => m.includes("丢弃 input 非对象的 tool_use"))).toBe(true);
  });

  it("顶层 content 存在但非数组 → 归空留证据（轮 32 #8）", async () => {
    const { mock, logs, provider } = setupLogs();
    mock.queueMany({
      status: 200,
      body: { content: "gateway junk", stop_reason: "end_turn", usage: null },
    });
    const res = await provider.chat(baseReq());
    expect(res.text).toBe("");
    expect(logs.some((m) => m.includes("丢弃形态异常的顶层 content"))).toBe(true);
  });

  it("tool_use name 非 string → 丢弃并留形态异常档证据（与 gemini 分档口径一致，轮 16 #11）", async () => {
    const { mock, logs, provider } = setupLogs();
    mock.queueMany({
      status: 200,
      body: {
        content: [
          { type: "tool_use", id: "b1", name: 42, input: {} },
          { type: "tool_use", id: "x1", name: "other_tool", input: {} },
        ],
        stop_reason: "tool_use",
        usage: null,
      },
    });
    const res = await provider.chat(baseReq());
    expect(res.toolCalls).toEqual([]);
    expect(logs.some((m) => m.includes("丢弃形态异常的 tool_use") && m.includes("42"))).toBe(true);
    // 同响应内两档证据各归各位：畸形→形态异常档，字符串失配→非请求名档
    expect(logs.some((m) => m.includes("忽略非请求工具名") && m.includes("other_tool"))).toBe(true);
  });

  it("type:text 但 text 非 string 的畸形块 → 丢弃留证据（原先内联条件静默吞，轮 29 #1）；非对象项/未知 type/畸形 thinking 同款（轮 30 #3/#10）", async () => {
    const { mock, logs, provider } = setupLogs();
    mock.queueMany({
      status: 200,
      body: {
        content: [
          42, // 非对象项（网关畸形）
          { type: "text", text: 123 },
          { type: "text", text: "ok" },
          { type: "thinking", thinking: 456 }, // 已知 type 的畸形 thinking 域
          { type: "redacted_thinking", data: "x" }, // 未知 type（官方类型）
        ],
        stop_reason: "end_turn",
        usage: null,
      },
    });
    const res = await provider.chat(baseReq());
    expect(res.text).toBe("ok"); // 合法块不受影响，畸形块不进拼接
    expect(logs.some((m) => m.includes("丢弃形态异常的 text 块"))).toBe(true);
    expect(logs.some((m) => m.includes("丢弃非对象形态的 content 块"))).toBe(true);
    expect(logs.some((m) => m.includes("丢弃形态异常的 thinking 块"))).toBe(true);
    expect(logs.some((m) => m.includes("丢弃未知 type 的 content 块"))).toBe(true);
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

  it("响应不是对象 → LLMProtocolViolationError（provider 归因到卡片 name，fallback 双卡可区分）", async () => {
    const { mock, provider } = setup();
    mock.queueMany({ status: 200, body: "not-an-object" });
    const err = await provider.chat(baseReq()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMProtocolViolationError);
    expect((err as LLMProtocolViolationError).provider).toBe("glm-anthropic");
  });
});

describe("错误映射（状态 → 错误类 + error.message 提取 + Retry-After）", () => {
  const baseReq = (): ChatRequest => ({
    systemPrompt: null,
    messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
    tools: null,
  });

  // 状态→分类矩阵与 http.test.ts 的 postJson 矩阵同源——适配器层只锁定
  // 「状态→类型经适配器走通」（instanceof）；message 提取属 http 层职责，
  // 仅在 429 单点抽样验证经适配器走通（与 gemini/openai 的单点抽样形态对齐）
  it.each([
    [429, LLMRateLimitError],
    [401, LLMAuthError],
    [403, LLMAuthError],
    [400, LLMInvalidRequestError],
    [500, LLMServerError],
    [503, LLMServerError],
  ] as const)("HTTP %s → %s", async (status, klass) => {
    const { mock, provider } = setup();
    mock.queueMany({
      status,
      body: { type: "error", error: { type: "x", message: `boom ${status}` } },
    });
    const err = await provider.chat(baseReq()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(klass);
    if (status === 429) {
      expect((err as Error).message).toContain(`boom ${status}`);
    }
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
