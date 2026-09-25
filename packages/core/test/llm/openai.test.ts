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

/** 带日志采集的装配（丢弃类/清洗类告警断言共用；over 覆盖卡片级配置，对齐 anthropic 侧轮 21 #13） */
const setupLogs = (over: Partial<ProviderConfig> = {}) =>
  setupProviderWithLogs(createOpenAICompletionsProvider, CARD, over);
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

  it("assistant 仅含 image 块：无 toolCalls → [image omitted] 占位；带 toolCalls → content null（与 anthropic/gemini 口径对齐，轮 16 #3）", async () => {
    const { mock, provider } = setup();
    mock.queueMany(toolOk("{}"), toolOk("{}"));
    await provider.chat({
      systemPrompt: null,
      messages: [
        { role: "user", blocks: [{ kind: "text", text: "q" }] },
        { role: "assistant", blocks: [{ kind: "image", mimeType: "image/png", base64: "AAAA" }] },
        { role: "user", blocks: [{ kind: "text", text: "next" }] },
      ],
      tools: [TOOL],
    });
    const first = mock.lastBody().messages as Array<Record<string, unknown>>;
    expect(first[1]).toEqual({ role: "assistant", content: "[image omitted]" });

    await provider.chat({
      systemPrompt: null,
      messages: [
        { role: "user", blocks: [{ kind: "text", text: "q" }] },
        {
          role: "assistant",
          blocks: [{ kind: "image", mimeType: "image/png", base64: "AAAA" }],
          toolCalls: [{ id: "t1", name: "agent_response", args: {} }],
        },
        { role: "toolResult", toolCallId: "t1", toolName: "agent_response", text: "ok" },
      ],
      tools: [TOOL],
    });
    const second = mock.lastBody().messages as Array<Record<string, unknown>>;
    expect(second[1].content).toBe(null); // 图块丢弃后即纯工具调用回合（官方形态）
    expect(second[1].tool_calls).toBeDefined();
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
  // 钳制告警/maxTokens 回退的纯逻辑矩阵见 common.test.ts（轮 19 #2 收敛）；
  // 接线锚定保留在 anthropic.test.ts（三适配器注入形态一致）

  it("o 系与 gpt-5 系抑制 temperature（只接受默认温度 1，轮 14 #10 + 轮 20 #11 web 核实）；gpt-4o 照常发送", async () => {
    const oSeries = setup({ model: "o3-mini", temperature: 0.2 });
    oSeries.mock.queueMany(toolOk("{}"));
    await oSeries.provider.chat(baseReq());
    expect(oSeries.mock.lastBody()).not.toHaveProperty("temperature");

    // gpt-5 全系同样只接受默认温度（400 "Unsupported value: 'temperature' does
    // not support X with this model. Only the default (1) value is supported"）
    for (const model of ["gpt-5", "gpt-5-mini", "gpt-5-pro"]) {
      const gpt5 = setup({ model, temperature: 0.7 });
      gpt5.mock.queueMany(toolOk("{}"));
      await gpt5.provider.chat(baseReq());
      expect(gpt5.mock.lastBody()).not.toHaveProperty("temperature");
    }

    const normal = setup({ model: "gpt-4o", temperature: 0.2 });
    normal.mock.queueMany(toolOk("{}"));
    await normal.provider.chat(baseReq());
    expect(normal.mock.lastBody().temperature).toBe(0.2);
  });

  it("两清单刻意不同的分叉成员（gpt-4.1/gpt-oss）：新上限字段但温度照发（轮 27 #11）", async () => {
    // NEW_CONTRACT_PREFIX（max_completion_tokens）与 TEMPERATURE_UNSUPPORTED_PREFIX
    //（温度抑制）成员集刻意不同——锁定温度维度，防两前缀清单被「统一」重构后
    // gpt-4.1/gpt-oss 用户静默丢温控且全套无红测
    for (const model of ["gpt-4.1", "gpt-oss-120b"]) {
      const dual = setup({ model, temperature: 0.4 });
      dual.mock.queueMany(toolOk("{}"));
      await dual.provider.chat(baseReq());
      expect(dual.mock.lastBody().temperature).toBe(0.4);
      expect(dual.mock.lastBody()).toHaveProperty("max_completion_tokens");
    }
  });

  it("temperatureSuppressed 逃生门：显式 false 恢复发送 / 显式 true 强制抑制（轮 29 #3，与 maxTokensField 同款）", async () => {
    // 前缀误命中自定义/网关模型（o1-finetune 等实际支持温度）时恢复发送
    const escapeHatch = setup({
      model: "o1-finetune",
      temperature: 0.3,
      temperatureSuppressed: false,
    });
    escapeHatch.mock.queueMany(toolOk("{}"));
    await escapeHatch.provider.chat(baseReq());
    expect(escapeHatch.mock.lastBody().temperature).toBe(0.3);
    // 未入清单的新模型可显式抑制
    const forced = setup({
      model: "some-new-model",
      temperature: 0.3,
      temperatureSuppressed: true,
    });
    forced.mock.queueMany(toolOk("{}"));
    await forced.provider.chat(baseReq());
    expect(forced.mock.lastBody()).not.toHaveProperty("temperature");
  });

  it("抑制可观测：配置被忽略留一次性 WARNING，未配置零告警（轮 21 #11 + 轮 23 #4 真请求阴性对照）", async () => {
    // 配置了 temperature 却被忽略 → 一次性 WARNING（与「两级缺省不发」不同，
    // 静默忽略无线索）
    const suppressed = setupLogs({ model: "gpt-5", temperature: 0.7 });
    suppressed.mock.queueMany(toolOk("{}"), toolOk("{}"));
    await suppressed.provider.chat(baseReq());
    await suppressed.provider.chat(baseReq());
    expect(suppressed.logs.filter((m) => m.includes("只接受默认温度"))).toHaveLength(1);
    // 未配置则零告警——须真正采集日志断言（轮 23 #4）：静音 setup 的声明无回归
    // 防护，且 toHaveLength(1) 受 makeOnceWarn 去重保护测不出「无条件告警」回归
    const quiet = setupLogs({ model: "gpt-5" });
    quiet.mock.queueMany(toolOk("{}"));
    await quiet.provider.chat(baseReq());
    expect(quiet.mock.lastBody()).not.toHaveProperty("temperature");
    expect(quiet.logs.filter((m) => m.includes("只接受默认温度"))).toHaveLength(0);
  });

  it("image 块 mimeType 别名归一：image/jpg → data:image/jpeg（normalizeImageMime 单源，轮 28 #5）", async () => {
    const { mock, provider } = setup();
    mock.queueMany(toolOk("{}"));
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
      tools: [TOOL],
    });
    const wire = JSON.stringify(mock.lastBody().messages);
    expect(wire).toContain("data:image/jpeg;base64,AAAA");
  });

  it("extraHeaders 最后合并（可覆盖 authorization）——三处独立实现的接线锚定（轮 30 #8，对齐 anthropic 侧）", async () => {
    const { mock, provider } = setup({
      extraHeaders: { authorization: "Bearer override", "x-custom": "1" },
    });
    mock.queueMany(toolOk("{}"));
    await provider.chat(baseReq());
    expect(mock.calls[0].init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer override",
      "x-custom": "1",
    });
  });

  it("baseUrl 整段端点 URL 误配（以 /chat/completions 结尾）→ 如实拼接 + 一次性告警（轮 26 #2，与 anthropic /v1、gemini /v1beta 同族）", async () => {
    // 官方 curl 示例端点以 /chat/completions 结尾，整段复制进卡片拼出双重路径 → 404
    const plain = setupLogs();
    const misconfigured = setupProviderWithLogs(createOpenAICompletionsProvider, CARD, {
      baseUrl: "https://api.example.com/v1/chat/completions",
    });
    misconfigured.mock.queueMany(toolOk("{}"), toolOk("{}"));
    await misconfigured.provider.chat(baseReq());
    await misconfigured.provider.chat(baseReq());
    expect(misconfigured.mock.calls[0].url).toContain("/chat/completions/chat/completions");
    expect(misconfigured.logs.filter((m) => m.includes("整段端点 URL 误配"))).toHaveLength(1);
    // 无误配的缺省卡片不受影响：不告警（真请求采集，非静音声明）
    plain.mock.queueMany(toolOk("{}"));
    await plain.provider.chat(baseReq());
    expect(plain.logs.filter((m) => m.includes("整段端点 URL 误配"))).toHaveLength(0);
  });

  it("空串 systemPrompt 与 null 同等不发（三协议统一口径，轮 20 #13）", async () => {
    const { mock, provider } = setup();
    mock.queueMany(toolOk("{}"));
    await provider.chat({
      systemPrompt: "",
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: [TOOL],
    });
    const messages = mock.lastBody().messages as Array<Record<string, unknown>>;
    expect(messages[0].role).toBe("user"); // 不止「无 system」：首条必须是 user
    expect(messages).toHaveLength(1);
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

  it('arguments "null" 字符串兜底 {}（网关字符串化的 null args 与原生 null 同义，轮 18 #7）', async () => {
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
                {
                  id: "c1",
                  type: "function",
                  function: { name: "agent_response", arguments: "null" },
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
    expect(res.toolCalls).toEqual([{ id: "c1", name: "agent_response", args: {} }]);
    expect(res.stopReason).toBe("tool_call"); // 不再按解析失败丢弃
  });

  it('tool_call 缺失/空 id → 丢弃并留告警（回传历史 tool_call_id="" 会被官方端点 400；观测锚定轮 19 #6）', async () => {
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
    // 与 anthropic 侧同名场景的观测口径对齐：丢弃告警是区分「模型未发起调用」
    // 与「调用被丢弃」的唯一线索
    expect(logs.some((m) => m.includes("缺失 id，丢弃调用") && m.includes("agent_response"))).toBe(
      true,
    );
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

  it("message.content 存在但非 string/null/undefined → 折叠空文本但留证据；null（纯工具回合）不告警（轮 29 #8）", async () => {
    const partsForm = setupLogs();
    partsForm.mock.queueMany({
      status: 200,
      body: {
        choices: [
          {
            // 转换型网关回传 content-parts 数组形态
            message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
            finish_reason: "stop",
          },
        ],
        usage: null,
      },
    });
    const res = await partsForm.provider.chat(baseReq());
    expect(res.text).toBe(""); // 非 string 折叠为空文本
    expect(partsForm.logs.some((m) => m.includes("丢弃形态异常的 message.content"))).toBe(true);

    const nullForm = setupLogs();
    nullForm.mock.queueMany({
      status: 200,
      body: {
        choices: [
          {
            // null = 纯工具调用回合的合法形态
            message: { role: "assistant", content: null, tool_calls: [] },
            finish_reason: "tool_calls",
          },
        ],
        usage: null,
      },
    });
    await nullForm.provider.chat(baseReq());
    expect(nullForm.logs.some((m) => m.includes("丢弃形态异常的 message.content"))).toBe(false);
  });

  it("reasoning_content 存在但非 string → 折叠空串但留证据（轮 30 #5，与 content 轮 29 #8 同款）", async () => {
    const { mock, logs, provider } = setupLogs();
    mock.queueMany({
      status: 200,
      body: {
        choices: [
          {
            message: { role: "assistant", content: "ok", reasoning_content: 123 },
            finish_reason: "stop",
          },
        ],
        usage: null,
      },
    });
    const res = await provider.chat(baseReq());
    expect(res.text).toBe("ok");
    expect(res.reasoningText).toBeFalsy(); // 非 string 折叠为空（字段缺省或空串）
    expect(logs.some((m) => m.includes("丢弃形态异常的 reasoning 字段"))).toBe(true);
  });

  it("显式非 function 类型的 tool_call 丢弃留证据；缺失 type 容忍（轮 31 #4）", async () => {
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
                // function 域恰为对象——type 不查会以合法调用身份混入执行链
                { id: "c1", type: "custom", function: { name: "agent_response", arguments: "{}" } },
                // 缺失 type：vLLM/Ollama 兼容端点形态，照常解析
                { id: "c2", function: { name: "agent_response", arguments: "{}" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: null,
      },
    });
    const res = await provider.chat(baseReq());
    expect(res.toolCalls).toHaveLength(1); // 仅缺失 type 的合法项
    expect(res.toolCalls[0].name).toBe("agent_response");
    expect(logs.some((m) => m.includes("丢弃非 function 类型的 tool_call"))).toBe(true);
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

  it("tool_call name 非 string → 丢弃并留形态异常档证据（与 gemini 分档口径一致，轮 16 #12）", async () => {
    const { mock, logs, provider } = setupLogs();
    mock.queueMany({
      status: 200,
      body: {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "b1", type: "function", function: { name: 42, arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: null,
      },
    });
    const res = await provider.chat(baseReq());
    expect(res.toolCalls).toEqual([]);
    expect(logs.some((m) => m.includes("丢弃形态异常的 tool_call") && m.includes("42"))).toBe(true);
    // 畸形输出不得误标为名字失配档
    expect(logs.some((m) => m.includes("忽略非请求工具名"))).toBe(false);
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
