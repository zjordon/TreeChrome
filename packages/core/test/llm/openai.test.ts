// openai-completions 适配器单测（04 §5 覆盖矩阵 O 列）。重点专项：
// maxTokens 双轨（新契约前缀/卡片覆盖）、arguments guard-parse（截断样本丢弃）、
// 纯文本 user 走字符串 content、toolResult 独立消息 + [error] 前缀约定。
import { describe, expect, it } from "vitest";
import type { ChatRequest, ProviderConfig } from "../../src/index.js";
import { createOpenAICompletionsProvider } from "../../src/llm/adapters/openai-completions.js";
import { LLMAuthError, LLMProtocolViolationError } from "../../src/llm/errors.js";
import { AGENT_TOOL, setupProvider, setupProviderWithLogs } from "./fixtures.js";
import type { MockResponseSpec } from "./mock-fetch.js";

const CARD: ProviderConfig = {
  name: "glm-openai",
  protocol: "openai-completions",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-test",
  model: "glm-4.7",
  maxTokens: 8192,
};

const TOOL = AGENT_TOOL;

const setup = (over: Partial<ProviderConfig> = {}) =>
  setupProvider(createOpenAICompletionsProvider, CARD, over);

const toolOk = (args: string): MockResponseSpec => ({
  status: 200,
  body: {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "agent_response", arguments: args },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  },
});

function baseReq(): ChatRequest {
  return {
    systemPrompt: null,
    messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
    tools: [TOOL],
  };
}

/** 带日志采集的装配（丢弃类/清洗类告警断言共用） */
const setupLogs = () => setupProviderWithLogs(createOpenAICompletionsProvider, CARD);
describe("请求构造（canonical → wire）", () => {
  it("全量映射：system 首条、纯文本 user 字符串、含图 user 数组 data-URL、tool_calls 字符串化、toolResult 独立消息", async () => {
    const { mock, provider } = setup();
    mock.queueMany(toolOk("{}"));
    await provider.chat({
      systemPrompt: "You are an agent.",
      messages: [
        { role: "user", blocks: [{ kind: "text", text: "hi" }] },
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
        {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "agent_response",
          text: "done",
          isError: true,
        },
        { role: "toolResult", toolCallId: "t2", toolName: "agent_response", text: "done2" },
      ],
      tools: [TOOL],
      toolChoice: { kind: "forced", name: "agent_response" },
    });

    expect(mock.calls[0].url).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
    expect(mock.calls[0].init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer sk-test",
    });
    expect(mock.lastBody()).toEqual({
      model: "glm-4.7",
      messages: [
        { role: "system", content: "You are an agent." },
        { role: "user", content: "hi" },
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
        {
          role: "assistant",
          content: "ok",
          tool_calls: [
            {
              id: "t1",
              type: "function",
              function: { name: "agent_response", arguments: '{"action":"click"}' },
            },
            {
              id: "t2",
              type: "function",
              function: { name: "agent_response", arguments: '{"action":"type"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "t1", content: "[error] done" },
        { role: "tool", tool_call_id: "t2", content: "done2" },
      ],
      max_tokens: 8192,
      tools: [
        {
          type: "function",
          function: { name: "agent_response", description: "respond", parameters: TOOL.parameters },
        },
      ],
      tool_choice: { type: "function", function: { name: "agent_response" } },
    });
    expect(mock.lastBody()).not.toHaveProperty("temperature");
    expect(mock.lastBody()).not.toHaveProperty("max_completion_tokens");
  });

  it("纯工具调用回合：assistant content 为 null", async () => {
    const { mock, provider } = setup();
    mock.queueMany(toolOk("{}"));
    await provider.chat({
      systemPrompt: null,
      messages: [
        { role: "user", blocks: [{ kind: "text", text: "q" }] },
        {
          role: "assistant",
          blocks: [],
          toolCalls: [{ id: "t1", name: "agent_response", args: {} }],
        },
        { role: "toolResult", toolCallId: "t1", toolName: "agent_response", text: "r" },
      ],
      tools: [TOOL],
    });
    const messages = mock.lastBody().messages as Array<Record<string, unknown>>;
    expect(messages[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "t1", type: "function", function: { name: "agent_response", arguments: "{}" } },
      ],
    });
    expect(mock.lastBody()).not.toHaveProperty("tool_choice"); // auto 缺省不发
  });

  it("maxTokens 双轨：新契约前缀自动切 max_completion_tokens；卡片声明优先；兼容模型用 max_tokens", async () => {
    const legacy = setup({ model: "gpt-4o" });
    legacy.mock.queueMany(toolOk("{}"));
    await legacy.provider.chat(baseReq());
    expect(legacy.mock.lastBody()).toHaveProperty("max_tokens");
    expect(legacy.mock.lastBody()).not.toHaveProperty("max_completion_tokens");

    const newContract = setup({ model: "gpt-5" });
    newContract.mock.queueMany(toolOk("{}"));
    await newContract.provider.chat(baseReq());
    expect(newContract.mock.lastBody()).toHaveProperty("max_completion_tokens");
    expect(newContract.mock.lastBody()).not.toHaveProperty("max_tokens");

    // 本地/网关新契约模型：前缀命中但卡片显式声明旧字段（webbrain local/lmstudio 场景）。
    // 反向断言锁定「声明覆盖启发式」：两字段并存会被新契约网关拒收
    const declared = setup({ model: "gpt-5", maxTokensField: "max_tokens" });
    declared.mock.queueMany(toolOk("{}"));
    await declared.provider.chat(baseReq());
    expect(declared.mock.lastBody()).toHaveProperty("max_tokens");
    expect(declared.mock.lastBody()).not.toHaveProperty("max_completion_tokens");

    // gpt-oss 系（reasoning 模型，2025-08 起在售）同样拒收 max_tokens——轮 9 补入前缀
    const oss = setup({ model: "gpt-oss-120b" });
    oss.mock.queueMany(toolOk("{}"));
    await oss.provider.chat(baseReq());
    expect(oss.mock.lastBody()).toHaveProperty("max_completion_tokens");
    expect(oss.mock.lastBody()).not.toHaveProperty("max_tokens");

    // 前缀清单其余成员逐个锁定（轮 12 #10）：正则被误改（误删成员/误拼写）在此处红，
    // 回归面不再直接落在端点 400
    for (const model of ["gpt-4.1-mini", "o1", "o3-mini", "o4-mini"]) {
      const s = setup({ model });
      s.mock.queueMany(toolOk("{}"));
      await s.provider.chat(baseReq());
      expect(s.mock.lastBody()).toHaveProperty("max_completion_tokens");
      expect(s.mock.lastBody()).not.toHaveProperty("max_tokens");
    }
  });

  it("tools null / temperature 显式 / maxTokens 请求级覆盖", async () => {
    const { mock, provider } = setup();
    mock.queueMany(toolOk("{}"));
    await provider.chat({ ...baseReq(), tools: null, temperature: 0.3, maxTokens: 99 });
    const body = mock.lastBody();
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(99);
  });

  it("temperature 回退链：请求级缺省用卡片级；两级缺省不发（新契约模型由宿主自担）", async () => {
    const { mock, provider } = setup({ temperature: 0.6 });
    mock.queueMany(toolOk("{}"), toolOk("{}"));
    await provider.chat(baseReq());
    expect(mock.lastBody().temperature).toBe(0.6);
    await provider.chat({ ...baseReq(), temperature: 0.1 });
    expect(mock.lastBody().temperature).toBe(0.1);

    const noCard = setup();
    noCard.mock.queueMany(toolOk("{}"));
    await noCard.provider.chat(baseReq());
    expect(noCard.mock.lastBody()).not.toHaveProperty("temperature");
  });

  it("temperature 按协议上限钳制（openai 0-2）：误配 2.5 钳到 2（轮 12 #7）", async () => {
    const { mock, provider } = setup({ temperature: 2.5 });
    mock.queueMany(toolOk("{}"));
    await provider.chat(baseReq());
    expect(mock.lastBody().temperature).toBe(2);
  });

  it("o 系模型抑制 temperature（只接受默认温度，轮 14 #10）；gpt-4o 照常发送", async () => {
    const oSeries = setup({ model: "o3-mini", temperature: 0.2 });
    oSeries.mock.queueMany(toolOk("{}"));
    await oSeries.provider.chat(baseReq());
    expect(oSeries.mock.lastBody()).not.toHaveProperty("temperature");

    const normal = setup({ model: "gpt-4o", temperature: 0.2 });
    normal.mock.queueMany(toolOk("{}"));
    await normal.provider.chat(baseReq());
    expect(normal.mock.lastBody().temperature).toBe(0.2);
  });

  it("tools null + forced toolChoice → 不发孤立 tool_choice（ChatRequest 契约）", async () => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 200,
      body: { choices: [{ message: { role: "assistant", content: "t" }, finish_reason: "stop" }] },
    });
    await provider.chat({
      ...baseReq(),
      tools: null,
      toolChoice: { kind: "forced", name: "x" },
    });
    expect(mock.lastBody()).not.toHaveProperty("tool_choice");
    expect(mock.lastBody()).not.toHaveProperty("tools");
  });

  it("tools 空数组 → 不发 tools/tool_choice（部分兼容端点 vLLM/Ollama 400；forced 一并抑制）", async () => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 200,
      body: { choices: [{ message: { role: "assistant", content: "t" }, finish_reason: "stop" }] },
    });
    await provider.chat({
      ...baseReq(),
      tools: [],
      toolChoice: { kind: "forced", name: "x" },
    });
    expect(mock.lastBody()).not.toHaveProperty("tool_choice");
    expect(mock.lastBody()).not.toHaveProperty("tools");
  });
});

describe("响应解析（wire → canonical）", () => {
  it("arguments guard-parse：字符串/对象形态直收；截断 JSON 丢弃该调用并留告警（不带病 args 进 canonical）", async () => {
    const { mock, logs, provider } = setupLogs();
    mock.queueMany(toolOk('{"action": {"name": "click"}}'), {
      status: 200,
      body: {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "agent_response", arguments: { direct: 1 } },
                },
                {
                  id: "c2",
                  type: "function",
                  function: { name: "agent_response", arguments: '{"trunc' },
                },
                { id: "c3", type: "function", function: { name: "other_tool", arguments: "{}" } },
              ],
            },
            finish_reason: "length",
          },
        ],
        usage: null,
      },
    });
    const ok = await provider.chat(baseReq());
    expect(ok.toolCalls).toEqual([
      { id: "call_1", name: "agent_response", args: { action: { name: "click" } } },
    ]);
    expect(ok.stopReason).toBe("tool_call");

    const guarded = await provider.chat(baseReq());
    expect(guarded.toolCalls).toEqual([{ id: "c1", name: "agent_response", args: { direct: 1 } }]);
    // 保留的调用推导优先（三协议统一）：c1 在 → tool_call 压过 finish_reason=length
    expect(guarded.stopReason).toBe("tool_call");
    // 观测口径锁定（轮 12 #9）：截断丢弃与非请求名丢弃都留告警——排障时区分
    // 「模型未发起调用」与「调用被丢弃」的唯一线索
    expect(
      logs.some((m) => m.includes("arguments 解析失败，丢弃调用") && m.includes("agent_response")),
    ).toBe(true);
    expect(logs.some((m) => m.includes("忽略非请求工具名") && m.includes("other_tool"))).toBe(true);
  });

  it('tool_call 缺失/空 id → 丢弃（回传历史 tool_call_id="" 会被官方端点 400）', async () => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 200,
      body: {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { type: "function", function: { name: "agent_response", arguments: "{}" } },
                { id: "", type: "function", function: { name: "agent_response", arguments: "{}" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: null,
      },
    });
    const res = await provider.chat(baseReq());
    expect(res.toolCalls).toEqual([]);
    expect(res.stopReason).toBe("other"); // 全部被丢弃：不置 tool_call（与 gemini 口径一致）
  });

  it("形态异常的 tool_call（item 合法但 function 非对象 / item 非对象）→ 丢弃并留告警（轮 12 #8）", async () => {
    const { mock, logs, provider } = setupLogs();
    mock.queueMany({
      status: 200,
      body: {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "bad1", type: "function", function: "not-an-object" }, 42],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: null,
      },
    });
    const res = await provider.chat(baseReq());
    expect(res.toolCalls).toEqual([]);
    expect(logs.some((m) => m.includes("丢弃形态异常的 tool_call") && m.includes("bad1"))).toBe(
      true,
    );
  });

  it("arguments 缺失/null/空串兜底 {}（兼容端点无参工具形态，与 anthropic/gemini 口径对齐）", async () => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 200,
      body: {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "c1", type: "function", function: { name: "agent_response" } },
                { id: "c2", type: "function", function: { name: "agent_response", arguments: "" } },
                {
                  id: "c3",
                  type: "function",
                  function: { name: "agent_response", arguments: null },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: null,
      },
    });
    const res = await provider.chat(baseReq());
    expect(res.toolCalls).toEqual([
      { id: "c1", name: "agent_response", args: {} },
      { id: "c2", name: "agent_response", args: {} },
      { id: "c3", name: "agent_response", args: {} },
    ]);
    expect(res.stopReason).toBe("tool_call");
  });

  it("响应不是对象 → LLMProtocolViolationError（provider 归因到卡片 name，fallback 双卡可区分）", async () => {
    const { mock, provider } = setup();
    mock.queueMany({ status: 200, body: "not-an-object" });
    const err = await provider.chat(baseReq()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMProtocolViolationError);
    expect((err as LLMProtocolViolationError).provider).toBe("glm-openai");
  });

  it("非请求工具名的 tool_call 丢弃并留告警（与 anthropic/gemini 观测口径一致）", async () => {
    const { mock, logs, provider } = setupLogs();
    mock.queueMany({
      status: 200,
      body: {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "h1",
                  type: "function",
                  function: { name: "hallucinated_tool", arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: null,
      },
    });
    const res = await provider.chat(baseReq());
    expect(res.toolCalls).toEqual([]);
    expect(
      logs.some((m) => m.includes("忽略非请求工具名") && m.includes("hallucinated_tool")),
    ).toBe(true);
  });

  it("content 文本 + reasoning_content 捕获；usage cached_tokens 可选", async () => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 200,
      body: {
        choices: [
          {
            message: { role: "assistant", content: "answer", reasoning_content: "thinking..." },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      },
    });
    const res = await provider.chat(baseReq());
    expect(res).toEqual({
      text: "answer",
      reasoningText: "thinking...",
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 },
    });
  });

  it.each([
    ["stop", "stop"],
    ["length", "length"],
    ["content_filter", "other"], // 不抛 LLMBlockedError，文本照常返回
  ] as const)("finish_reason %s → %s", async (raw, expected) => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 200,
      body: {
        choices: [{ message: { role: "assistant", content: "t" }, finish_reason: raw }],
        usage: null,
      },
    });
    const res = await provider.chat(baseReq());
    expect(res.stopReason).toBe(expected);
    expect(res.text).toBe("t");
  });

  it("choices 缺失容错为空响应；响应非对象抛违例", async () => {
    const tolerant = setup();
    tolerant.mock.queueMany({ status: 200, body: {} });
    const res = await tolerant.provider.chat(baseReq());
    expect(res).toEqual({ text: "", toolCalls: [], stopReason: "other", usage: null });

    const bad = setup();
    bad.mock.queueMany({ status: 200, body: "str" });
    await expect(bad.provider.chat(baseReq())).rejects.toBeInstanceOf(LLMProtocolViolationError);
  });
});

describe("错误映射与 testConnection", () => {
  it("401 openai 错误体 → LLMAuthError（error.message 提取）", async () => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 401,
      body: { error: { message: "Incorrect API key", type: "invalid_request_error" } },
    });
    const err = await provider.chat(baseReq()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMAuthError);
    expect((err as Error).message).toContain("Incorrect API key");
  });

  it("testConnection 两态", async () => {
    const ok = setup();
    ok.mock.queueMany({
      status: 200,
      body: { choices: [{ message: { content: "hi" }, finish_reason: "stop" }] },
    });
    await expect(ok.provider.testConnection()).resolves.toEqual({ ok: true, model: "glm-4.7" });

    const bad = setup();
    bad.mock.queueMany({ status: 401, body: { error: { message: "no" } } });
    const r = await bad.provider.testConnection();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("401");
  });
});
