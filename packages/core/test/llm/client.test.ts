// LLMClient 行为层单测（04 §6）：解析优先级 / R4·R1 梯子 / 退避与预算 / fallback 单向切换 /
// 滤图 / 窗口共享 / 取消穿透 / 变换往返 / 承重墙。退避组用 FakeClock 冻结时钟；
// R4/R1 指令文案逐字符断言（Python client.py:503-506/:529-532 泛化 tool.name）。
import { describe, expect, it } from "vitest";
import type { ChatMessage, ProviderConfig } from "../../src/index.js";
import {
  createLLMClient,
  LLMAuthError,
  LLMConnectionError,
  LLMError,
  LLMRateLimitError,
  LLMTimeoutError,
} from "../../src/index.js";
import { FakeClock, MockFetch, type MockResponseSpec } from "./mock-fetch.js";

const CARD: ProviderConfig = {
  name: "primary",
  protocol: "anthropic-messages",
  baseUrl: "https://primary.example",
  apiKey: "k1",
  model: "glm-4.5v", // 视觉模型（滤图组依赖）
  maxTokens: 4096,
};

const FALLBACK: ProviderConfig = {
  name: "fallback",
  protocol: "anthropic-messages",
  baseUrl: "https://fallback.example",
  apiKey: "k2",
  model: "glm-5.1", // 非视觉（滤图组依赖）
  maxTokens: 2048,
};

const TOOL = {
  name: "agent_response",
  description: "d",
  parameters: { type: "object", properties: { action: { type: "object" } } },
};

const U0 = `https://example.com/${"a".repeat(90)}`;

const toolOk = (input: Record<string, unknown>): MockResponseSpec => ({
  status: 200,
  body: {
    content: [{ type: "tool_use", id: "t", name: "agent_response", input }],
    stop_reason: "tool_use",
    usage: { input_tokens: 5, output_tokens: 7 },
  },
});
const text = (t: string): MockResponseSpec => ({
  status: 200,
  body: { content: [{ type: "text", text: t }], stop_reason: "end_turn", usage: null },
});
const empty = (): MockResponseSpec => ({
  status: 200,
  body: { content: [{ type: "thinking", thinking: "..." }], stop_reason: "end_turn" },
});
const r429 = (retryAfter?: string): MockResponseSpec => ({
  status: 429,
  headers: retryAfter === undefined ? undefined : { "retry-after": retryAfter },
  body: { error: { message: "rate limited" } },
});
const r401 = (): MockResponseSpec => ({ status: 401, body: { error: { message: "bad key" } } });

const msgs = (): ChatMessage[] => [{ role: "user", blocks: [{ kind: "text", text: "hello" }] }];

function setup(over: Partial<ProviderConfig> = {}) {
  const mock = new MockFetch();
  const clock = new FakeClock();
  const client = createLLMClient(
    { ...CARD, ...over },
    { fetch: mock.fetch, now: clock.now, sleep: clock.sleep },
  );
  return { mock, clock, client };
}

describe("解析优先级与公共面", () => {
  it("createLLMClient 导出可用；强制工具调用直通 toolInput + usage", async () => {
    expect(typeof createLLMClient).toBe("function");
    const { mock, client } = setup();
    mock.queueMany(toolOk({ evaluation_previous_goal: "e", action: { name: "done" } }));
    const r = await client.getAction("sys", msgs(), TOOL);
    expect(r).toEqual({
      kind: "ok",
      toolInput: { evaluation_previous_goal: "e", action: { name: "done" } },
      usage: { inputTokens: 5, outputTokens: 7 },
    });
    const body = mock.lastBody();
    expect(body.tool_choice).toEqual({ type: "tool", name: "agent_response" });
    expect(body.max_tokens).toBe(4096); // 缺省走卡片 maxTokens
    expect(body.system).toBe("sys");
  });

  it("无工具调用但有文本 JSON → tryParseJson 兜底命中", async () => {
    const { mock, client } = setup();
    mock.queueMany(text('{"action": {"name": "done"}, "next_goal": "g"}'));
    const r = await client.getAction("sys", msgs(), TOOL);
    expect(r).toEqual({
      kind: "ok",
      toolInput: { action: { name: "done" }, next_goal: "g" },
      usage: null,
    });
  });

  it("testConnection 委托 provider（成功/失败两态）", async () => {
    const ok = setup();
    ok.mock.queueMany({
      status: 200,
      body: { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" },
    });
    await expect(ok.client.testConnection()).resolves.toMatchObject({
      ok: true,
      model: "glm-4.5v",
    });

    const bad = setup();
    bad.mock.queueMany(r401());
    await expect(bad.client.testConnection()).resolves.toMatchObject({ ok: false });
  });
});

describe("R4 text-not-tool 梯子（Python _TEXT_RETRY_MAX=2）", () => {
  it("第 1 次文本 → 追加指令 → 第 2 次工具调用成功（断言追加消息逐字符）", async () => {
    const { mock, client } = setup();
    mock.queueMany(text("I think we should click."), text("explaining again"), toolOk({ ok: 1 }));
    const r = await client.getAction("sys", msgs(), TOOL);
    expect(r.kind).toBe("ok");
    expect(mock.calls.length).toBe(3);
    const second = mock.bodyAt(1);
    const wireMessages = second.messages as unknown[];
    expect(wireMessages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "I think we should click." }],
    });
    expect(wireMessages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "Do not explain. Call the agent_response tool now with your evaluation, memory, next goal, and action.",
        },
      ],
    });
  });

  it("连续 3 次文本 → {kind:'empty'}（第 3 次不再重试）", async () => {
    const { mock, client } = setup();
    mock.queueMany(text("one"), text("two"), text("three"));
    const r = await client.getAction("sys", msgs(), TOOL);
    expect(r).toEqual({ kind: "empty" });
    expect(mock.calls.length).toBe(3);
  });
});

describe("R1 空响应梯子（thinking-only 同桶）", () => {
  it("空 → 追加指令一次 → 成功（断言 R1 文案逐字符）", async () => {
    const { mock, client } = setup();
    mock.queueMany(empty(), toolOk({ ok: 1 }));
    const r = await client.getAction("sys", msgs(), TOOL);
    expect(r.kind).toBe("ok");
    const second = mock.bodyAt(1);
    const wireMessages = second.messages as unknown[];
    expect(wireMessages[1]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "Your previous response contained no action. Respond now with the agent_response tool, including your evaluation, memory, next goal, and action.",
        },
      ],
    });
  });

  it("仍空 → {kind:'empty'}，且只重试一次", async () => {
    const { mock, client } = setup();
    mock.queueMany(empty(), empty());
    const r = await client.getAction("sys", msgs(), TOOL);
    expect(r).toEqual({ kind: "empty" });
    expect(mock.calls.length).toBe(2);
  });

  it("R4 与 R1 计数独立：text→R4、empty→R1、text→R4、成功（共 4 次请求）", async () => {
    const { mock, client } = setup();
    mock.queueMany(text("t1"), empty(), text("t2"), toolOk({ ok: 1 }));
    const r = await client.getAction("sys", msgs(), TOOL);
    expect(r.kind).toBe("ok");
    expect(mock.calls.length).toBe(4);
  });
});

describe("变换往返（URL 缩写 + 敏感值）", () => {
  it("请求侧占位（wire 无真实值），响应侧 toolInput 递归还原", async () => {
    const { mock, client } = setup();
    const messages: ChatMessage[] = [
      { role: "user", blocks: [{ kind: "text", text: `open ${U0} with sk-secret` }] },
    ];
    mock.queueMany(toolOk({ next_goal: "open [u0] with <KEY>", action: { url: "[u0]" } }));
    const r = await client.getAction("sys", messages, TOOL, {
      sensitiveMap: { "sk-secret": "<KEY>" },
    });
    const wire = JSON.stringify(mock.lastBody());
    expect(wire).toContain("[u0]");
    expect(wire).toContain("<KEY>");
    expect(wire).not.toContain("sk-secret");
    expect(wire).not.toContain(U0);
    expect(r.kind === "ok" && r.toolInput).toEqual({
      next_goal: `open ${U0} with sk-secret`,
      action: { url: U0 },
    });
  });

  it("empty 路径无产物不还原", async () => {
    const { mock, client } = setup();
    mock.queueMany(empty(), empty());
    const messages: ChatMessage[] = [
      { role: "user", blocks: [{ kind: "text", text: `open ${U0}` }] },
    ];
    const r = await client.getAction("sys", messages, TOOL);
    expect(r).toEqual({ kind: "empty" });
  });
});

describe("退避与预算（FakeClock；常量锚定 2,4,8,16,30,30）", () => {
  it("429 ×5 → 第 6 次成功（指数退避序列推进时钟）", async () => {
    const { mock, clock, client } = setup();
    mock.queueMany(r429(), r429(), r429(), r429(), r429(), toolOk({ done: 1 }));
    const p = client.getAction("sys", msgs(), TOOL);
    await clock.advance(0); // 冲刷微任务：首请求 429 → sleep(2000)
    await clock.advance(2000);
    await clock.advance(4000);
    await clock.advance(8000);
    await clock.advance(16000);
    await clock.advance(30000);
    const r = await p;
    expect(r.kind).toBe("ok");
    expect(mock.calls.length).toBe(6);
  });

  it("429 恒败 → 抛 LLMRateLimitError（类型不变，共 6 次请求后耗尽名额）", async () => {
    const { mock, clock, client } = setup();
    mock.queueMany(r429(), r429(), r429(), r429(), r429(), r429());
    const p = client.getAction("sys", msgs(), TOOL);
    await clock.advance(0);
    await clock.advance(2000);
    await clock.advance(4000);
    await clock.advance(8000);
    await clock.advance(16000);
    await clock.advance(30000);
    await expect(p).rejects.toBeInstanceOf(LLMRateLimitError);
    expect(mock.calls.length).toBe(6);
  });

  it("Retry-After 覆盖指数（5s 而非 2s；Python 锚定 '5'→5.0）", async () => {
    const { mock, clock, client } = setup();
    mock.queueMany(r429("5"), toolOk({ done: 1 }));
    const p = client.getAction("sys", msgs(), TOOL);
    await clock.advance(0);
    await clock.advance(2000); // 指数路径此时应已发第二请求；retry-after 路径未到点
    expect(mock.calls.length).toBe(1);
    await clock.advance(3000); // 满 5s → 第二请求
    const r = await p;
    expect(r.kind).toBe("ok");
    expect(mock.calls.length).toBe(2);
  });

  it("墙钟预算耗尽 → 立即抛最后错误（setCallWindow(40s)：cap=30s，5 次请求后 31000+30000>31000）", async () => {
    const { mock, clock, client } = setup();
    client.setCallWindow(40_000);
    mock.queueMany(r429(), r429(), r429(), r429(), r429());
    const p = client.getAction("sys", msgs(), TOOL);
    await clock.advance(0);
    await clock.advance(2000);
    await clock.advance(4000);
    await clock.advance(8000);
    await clock.advance(16000);
    await expect(p).rejects.toBeInstanceOf(LLMRateLimitError);
    expect(mock.calls.length).toBe(5);
  });

  it("窗口跨 getAction 共享：时钟推进 34s 后新调用预算只剩窗口尾部（3 次后耗尽）", async () => {
    const { mock, clock, client } = setup();
    client.setCallWindow(40_000); // deadline=41000（t0=1000）
    await clock.advance(34_000); // t=35000，模拟前一次调用耗掉大半窗口
    mock.queueMany(r429(), r429(), r429());
    const p = client.getAction("sys", msgs(), TOOL);
    await clock.advance(0); // 35000: 429 → 2000 → 37000 ≤ 41000 → sleep
    await clock.advance(2000); // 37000: 429 → 4000 → 41000 ≤ 41000 → sleep
    await clock.advance(4000); // 41000: 429 → 8000 → 49000 > 41000 → 抛
    await expect(p).rejects.toBeInstanceOf(LLMRateLimitError);
    expect(mock.calls.length).toBe(3);
  });

  it("非 infra（401）不退避：无 fallback 直接抛，1 次请求", async () => {
    const { mock, client } = setup();
    mock.queueMany(r401());
    await expect(client.getAction("sys", msgs(), TOOL)).rejects.toBeInstanceOf(LLMAuthError);
    expect(mock.calls.length).toBe(1);
  });

  it("网络层失败同样走退避（ConnectionError 是 infra 谓词成员）", async () => {
    const { mock, clock, client } = setup();
    mock.queueMany({ networkError: new TypeError("fetch failed") }, toolOk({ done: 1 }));
    const p = client.getAction("sys", msgs(), TOOL);
    await clock.advance(0);
    await clock.advance(2000);
    const r = await p;
    expect(r.kind).toBe("ok");
  });
});

describe("fallback 单向切换（完整卡片，可跨协议）", () => {
  it("429 触发切换：不占退避名额（无 sleep 直发），请求参数刷新为 fallback 卡片", async () => {
    const { mock, clock, client } = setup({ fallback: FALLBACK });
    mock.queueMany(r429(), toolOk({ via: "fb" }));
    const p = client.getAction("sys", msgs(), TOOL);
    await clock.advance(0); // 429 → 切换 → 立即重发（不 sleep）
    const r = await p;
    expect(r.kind).toBe("ok");
    expect(mock.calls.length).toBe(2);
    expect(mock.calls[0].url).toContain("primary.example");
    expect(mock.calls[1].url).toContain("fallback.example");
    const fb = mock.bodyAt(1);
    expect(fb.model).toBe("glm-5.1");
    expect(fb.max_tokens).toBe(2048);
  });

  it("401（非 infra）也触发切换（Python 外层 APIError 同语义）", async () => {
    const { mock, client } = setup({ fallback: FALLBACK });
    mock.queueMany(r401(), toolOk({ via: "fb" }));
    const r = await client.getAction("sys", msgs(), TOOL);
    expect(r.kind).toBe("ok");
    expect(mock.calls[1].url).toContain("fallback.example");
  });

  it("单向锁：已切换后二次 429 走纯退避（1 次主 + 6 次 fallback 后抛）", async () => {
    const { mock, clock, client } = setup({ fallback: FALLBACK });
    mock.queueMany(r429(), r429(), r429(), r429(), r429(), r429(), r429());
    const p = client.getAction("sys", msgs(), TOOL);
    await clock.advance(0); // 主 429 → 切换 → fallback 429 → sleep(2000)
    await clock.advance(2000);
    await clock.advance(4000);
    await clock.advance(8000);
    await clock.advance(16000);
    await clock.advance(30000);
    await expect(p).rejects.toBeInstanceOf(LLMRateLimitError);
    expect(mock.calls.length).toBe(7);
    expect(mock.calls.filter((c) => c.url.includes("fallback.example")).length).toBe(6);
  });

  it("滤图：fallback 无视觉 → 后续请求无 image 块；调用方消息不被改动", async () => {
    const { mock, clock, client } = setup({ fallback: FALLBACK });
    const messages: ChatMessage[] = [
      {
        role: "user",
        blocks: [
          { kind: "text", text: "look" },
          { kind: "image", mimeType: "image/png", base64: "AAAA" },
        ],
      },
    ];
    mock.queueMany(r429(), toolOk({ done: 1 }));
    const p = client.getAction("sys", messages, TOOL);
    await clock.advance(0);
    const r = await p;
    expect(r.kind).toBe("ok");
    expect(JSON.stringify(mock.bodyAt(0).messages)).toContain('"image"'); // 主模型（视觉）带图
    expect(JSON.stringify(mock.bodyAt(1).messages)).not.toContain('"image"'); // fallback 滤图
    const callerMsg = messages[0];
    if (callerMsg.role !== "user") {
      throw new Error("unreachable");
    }
    expect(callerMsg.blocks.length).toBe(2); // 原消息未被就地改动（03 偏离 1）
  });
});

describe("deadline 与取消", () => {
  it("opts.timeoutMs 到点强杀在飞请求 → LLMTimeoutError（03 偏离 5，真实时钟）", async () => {
    const mock = new MockFetch();
    const client = createLLMClient(CARD, { fetch: mock.fetch });
    mock.queueMany({ hangUntilAbort: true });
    await expect(client.getAction("sys", msgs(), TOOL, { timeoutMs: 60 })).rejects.toBeInstanceOf(
      LLMTimeoutError,
    );
  });

  it("外部 signal 在退避 sleep 期间 abort → AbortError 原样穿透（不吞、不变形、不重试）", async () => {
    const { mock, clock, client } = setup();
    mock.queueMany(r429());
    const ctrl = new AbortController();
    const p = client.getAction("sys", msgs(), TOOL, { signal: ctrl.signal });
    await clock.advance(0); // 429 → sleep(2000, signal) 挂起
    ctrl.abort();
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
    expect(err).not.toBeInstanceOf(LLMError);
    expect(mock.calls.length).toBe(1);
  });

  it("网络层失败未被重试耗尽时类型保持 ConnectionError（分罪不变形）", async () => {
    const { mock, clock, client } = setup();
    mock.queueMany(
      { networkError: new TypeError("e0") },
      { networkError: new TypeError("e1") },
      { networkError: new TypeError("e2") },
      { networkError: new TypeError("e3") },
      { networkError: new TypeError("e4") },
      { networkError: new TypeError("e5") },
    );
    const p = client.getAction("sys", msgs(), TOOL);
    await clock.advance(0);
    await clock.advance(2000);
    await clock.advance(4000);
    await clock.advance(8000);
    await clock.advance(16000);
    await clock.advance(30000);
    await expect(p).rejects.toBeInstanceOf(LLMConnectionError);
  });
});

describe("缺省 deps（真时钟：now=performance.now，sleep=setTimeout 包装）", () => {
  it("retry-after 20ms 快速路径：缺省 sleep 到点 resolve 后第二次请求成功", async () => {
    const mock = new MockFetch();
    const client = createLLMClient(CARD, { fetch: mock.fetch });
    mock.queueMany(r429("0.02"), toolOk({ done: 1 }));
    const r = await client.getAction("sys", msgs(), TOOL);
    expect(r.kind).toBe("ok");
    expect(mock.calls.length).toBe(2);
  });

  it("缺省 sleep 期间外部 abort → AbortError 穿透（可中止性）", async () => {
    const mock = new MockFetch();
    const client = createLLMClient(CARD, { fetch: mock.fetch });
    mock.queueMany(r429("5")); // 5s 退避 → 缺省 sleep 挂起
    const ctrl = new AbortController();
    const p = client.getAction("sys", msgs(), TOOL, { signal: ctrl.signal });
    await new Promise((resolve) => setTimeout(resolve, 10)); // 让链跑到 sleep
    ctrl.abort();
    const err = await p.catch((e: unknown) => e);
    expect((err as DOMException).name).toBe("AbortError");
    expect(err).not.toBeInstanceOf(LLMError);
    expect(mock.calls.length).toBe(1);
  });
});

describe("承重墙（02 §6：不支持 forced tool_choice / 不支持 tools）", () => {
  it("supportsForcedTool:false → tools 照发、tool_choice 不发、systemPrompt 追加约束段；文本 JSON 兜底命中", async () => {
    const { mock, client } = setup({ capabilities: { supportsForcedTool: false } });
    mock.queueMany(text('{"action": {"name": "done"}}'));
    const r = await client.getAction("sys", msgs(), TOOL);
    expect(r.kind).toBe("ok");
    const body = mock.lastBody();
    expect(body).toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body.system).toBe(
      'sys\n\nIMPORTANT: You must respond by calling the tool "agent_response" with your complete answer as the tool arguments. Do not reply with plain text.',
    );
  });

  it("supportsTools:false → 请求无 tools、schema 进 systemPrompt、JSON 兜底命中", async () => {
    const { mock, client } = setup({
      capabilities: { supportsTools: false, supportsForcedTool: false },
    });
    mock.queueMany(text('{"a": 1}'));
    const r = await client.getAction("sys", msgs(), TOOL);
    expect(r.kind).toBe("ok");
    const body = mock.lastBody();
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body.system).toContain(
      "IMPORTANT: You must respond with only a JSON object matching this schema:",
    );
    expect(body.system).toContain('"type": "object"');
    expect(body.system).toContain("Do not reply with plain text.");
  });
});
