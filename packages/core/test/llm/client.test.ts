// LLMClient 行为层单测（04 §6）：解析优先级 / R4·R1 梯子 / 退避与预算 / fallback 单向切换 /
// 滤图 / 窗口共享 / 取消穿透 / 变换往返 / 承重墙。退避组用 FakeClock 冻结时钟；
// R4/R1 指令文案逐字符断言（Python client.py:503-506/:529-532 泛化 tool.name）。
import { describe, expect, it } from "vitest";
import type { ChatMessage, GetActionResult, ProviderConfig } from "../../src/index.js";
import {
  createLLMClient,
  createProvider,
  LLMAuthError,
  LLMConnectionError,
  LLMError,
  LLMInvalidRequestError,
  LLMProtocolViolationError,
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
} from "../../src/index.js";
// 内部决策函数的测试锚定走深层导入（不进公共导出面，同 config/types 测试惯例）
import { resolveChatHttpTimeoutMs } from "../../src/llm/client.js";
import { AGENT_TOOL, LONG_URL } from "./fixtures.js";
import { FakeClock, MockFetch, type MockResponseSpec, makeHangingBodyFetch } from "./mock-fetch.js";

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

const OPENAI_FALLBACK: ProviderConfig = {
  name: "fallback-openai",
  protocol: "openai-completions",
  baseUrl: "https://fallback.example/v1",
  apiKey: "k3",
  model: "glm-4.7",
  maxTokens: 4096,
};

/** gemini 主卡（blocked 切换用例——LLMBlockedError 只有 gemini 适配器产出） */
const GEMINI_CARD: ProviderConfig = {
  name: "gemini-primary",
  protocol: "gemini",
  baseUrl: "https://gemini.example",
  apiKey: "gk",
  model: "gemini-2.5-pro",
  maxTokens: 4096,
};

const TOOL = AGENT_TOOL;
const U0 = LONG_URL;

const toolOk = (input: Record<string, unknown>): MockResponseSpec => ({
  status: 200,
  body: {
    content: [{ type: "tool_use", id: "t", name: TOOL.name, input }],
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
const r500 = (): MockResponseSpec => ({ status: 500, body: { error: { message: "boom" } } });

const msgs = (): ChatMessage[] => [{ role: "user", blocks: [{ kind: "text", text: "hello" }] }];

/** 四工厂的公共核心（轮 19 #4）：「时钟形态 × 日志采集 × fetch 覆盖」三维正交——
 * real 时钟省略 now/sleep 走 resolveDeps 缺省，zero 时钟冻结在 0（无定时器语义）；
 * fetchOverride 供旁路用例注入挂起桩（轮 24 #7，不再内联重建 deps 字面量） */
function setupCore(
  over: Partial<ProviderConfig>,
  clock: "fake" | "zero" | "real",
  collectLogs: boolean,
  fetchOverride?: typeof fetch,
) {
  const mock = new MockFetch();
  const logs: string[] = [];
  const fake = clock === "fake" ? new FakeClock() : null;
  // 三态展开用 if/else（轮 20 #4：嵌套三元违反清单规范）
  let clockDeps: { now?: () => number; sleep?: FakeClock["sleep"] } = {};
  if (fake !== null) {
    clockDeps = { now: fake.now, sleep: fake.sleep };
  } else if (clock === "zero") {
    clockDeps = { now: () => 0, sleep: async () => {} };
  }
  const client = createLLMClient(
    { ...CARD, ...over },
    {
      fetch: fetchOverride ?? mock.fetch,
      ...clockDeps,
      log: collectLogs ? (m) => logs.push(m) : () => {},
    },
  );
  return { mock, fake, logs, client };
}

function setup(over: Partial<ProviderConfig> = {}) {
  const { mock, fake, client } = setupCore(over, "fake", false);
  if (fake === null) {
    throw new Error("unreachable");
  }
  return { mock, clock: fake, client };
}

/** setup 的日志捕获变体（冻结时钟 + logs 数组）——WARNING 类观测断言共用 */
function setupWithLogs(over: Partial<ProviderConfig> = {}) {
  const { mock, logs, client } = setupCore(over, "zero", true);
  return { mock, logs, client };
}

/** setup 的真时钟变体（缺省 now/sleep：performance.now + setTimeout 包装；log 静音
 * ——被测对象是缺省时钟/睡眠，非缺省日志，与 stubDeps 的静音理由一致） */
function setupRealClock(over: Partial<ProviderConfig> = {}) {
  const { mock, client } = setupCore(over, "real", false);
  return { mock, client };
}

/** FakeClock + 日志采集组合（预算归因类用例）——三工厂外的第 4 形态收敛 */
function setupClockWithLogs(over: Partial<ProviderConfig> = {}) {
  const { mock, fake, logs, client } = setupCore(over, "fake", true);
  if (fake === null) {
    throw new Error("unreachable");
  }
  return { mock, clock: fake, logs, client };
}

/** user → assistant(单 toolCall) → toolResult 三段式历史（轮 19 #4：6 处逐字
 * 重复收敛；args 与结果文本按用例注入） */
function historyWithToolResult(
  resultText: string,
  args: Record<string, unknown> = {},
): ChatMessage[] {
  return [
    { role: "user", blocks: [{ kind: "text", text: "q" }] },
    { role: "assistant", blocks: [], toolCalls: [{ id: "t1", name: TOOL.name, args }] },
    { role: "toolResult", toolCallId: "t1", toolName: TOOL.name, text: resultText },
  ];
}

/** 带图 user 消息夹具（轮 23 #5：三处逐字重复收敛，ImageBlock 形状演进单点改） */
function withImageMessages(text = "look"): ChatMessage[] {
  return [
    {
      role: "user",
      blocks: [
        { kind: "text", text },
        { kind: "image", mimeType: "image/png", base64: "AAAA" },
      ],
    },
  ];
}

/** 先锁 kind 再断言产物：短路写法在意外 empty 时失败信息只剩 "false to equal" */
function assertOk(r: GetActionResult): Extract<GetActionResult, { kind: "ok" }> {
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") {
    throw new Error("unreachable");
  }
  return r;
}

/** 退避梯子推进（锚定常量 2,4,8,16,30）：完整走完 5 次退避的用例共享此时钟序列 */
const drainBackoffLadder = async (clock: FakeClock): Promise<void> => {
  for (const ms of [2000, 4000, 8000, 16000, 30000]) {
    await clock.advance(ms);
  }
};

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
    expect(body.tool_choice).toEqual({ type: "tool", name: TOOL.name });
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
  it("第 1 次文本 → 追加指令 → 再次文本 → 第 3 次请求工具调用成功（断言首次追加消息逐字符）", async () => {
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
          text: `Do not explain. Call the ${TOOL.name} tool now with your evaluation, memory, next goal, and action.`,
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
    const wireMessages = second.messages as Array<Record<string, unknown>>;
    // R1 追加的 user 与原 user 折叠为一条消息（anthropic 角色交替）——指令是第二个 text 块
    expect(wireMessages.length).toBe(1);
    const content = wireMessages[0].content as Array<Record<string, unknown>>;
    expect(content[1]).toEqual({
      type: "text",
      text: `Your previous response contained no action. Respond now with the ${TOOL.name} tool, including your evaluation, memory, next goal, and action.`,
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
    const ok = assertOk(r);
    expect(ok.toolInput).toEqual({
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

  it("toolResult 文本命中敏感值 → WARNING 可观测（明文出站不静默；P5 parity 只告警不改 wire）", async () => {
    const { mock, logs, client } = setupWithLogs();
    mock.queueMany(toolOk({ done: 1 }));
    const messages = historyWithToolResult("echoed sk-secret");
    const r = await client.getAction("sys", messages, TOOL, {
      sensitiveMap: { "sk-secret": "<KEY>" },
    });
    expect(r.kind).toBe("ok");
    // wire 仍明文（P5 parity 不动）；但暴露必须可观测
    expect(JSON.stringify(mock.lastBody())).toContain("echoed sk-secret");
    expect(logs.some((m) => m.includes("WARNING") && m.includes(TOOL.name))).toBe(true);
    // 观测通道自身不得成为泄露点：WARNING 中不得出现敏感明文
    expect(logs.some((m) => m.includes("sk-secret"))).toBe(false);
  });

  it("redactToolPayloads:true → toolResult 文本占位出站（明文阻断）；模型回显占位符经还原闭合（轮 12 #4）", async () => {
    const { mock, logs, client } = setupWithLogs();
    mock.queueMany(toolOk({ next_goal: "used <KEY>", action: { name: "done" } }));
    const messages = historyWithToolResult("echoed sk-secret");
    const r = await client.getAction("sys", messages, TOOL, {
      sensitiveMap: { "sk-secret": "<KEY>" },
      redactToolPayloads: true,
    });
    const wire = JSON.stringify(mock.lastBody());
    expect(wire).not.toContain("sk-secret"); // 占位阻断，不再明文出站
    expect(wire).toContain("<KEY>");
    expect(logs.some((m) => m.includes("已占位"))).toBe(true);
    const ok = assertOk(r);
    // 模型回显占位符 → 响应 toolInput 还原为真实值（往返闭合）
    expect(ok.toolInput.next_goal).toBe("used sk-secret");
  });

  it("历史 args 含敏感值（okResult 还原回灌的泄露链）→ 缺省 WARNING / redactToolPayloads 深层占位（轮 15 #7）", async () => {
    const history = historyWithToolResult("ok", {
      creds: "sk-secret",
      nested: { token: "sk-secret" },
    });

    // 缺省：args 明文出站 + WARNING 可观测
    const plain = setupWithLogs();
    plain.mock.queueMany(toolOk({ done: 1 }));
    await plain.client.getAction("sys", history, TOOL, {
      sensitiveMap: { "sk-secret": "<KEY>" },
    });
    expect(JSON.stringify(plain.mock.lastBody().messages)).toContain("sk-secret");
    expect(plain.logs.some((m) => m.includes("WARNING") && m.includes("args"))).toBe(true);

    // opt-in：深层占位（嵌套对象内的字符串同样替换），调用方原始消息不被改动
    const redact = setupWithLogs();
    redact.mock.queueMany(toolOk({ done: 1 }));
    await redact.client.getAction("sys", history, TOOL, {
      sensitiveMap: { "sk-secret": "<KEY>" },
      redactToolPayloads: true,
    });
    const wire = JSON.stringify(redact.mock.lastBody().messages);
    expect(wire).not.toContain("sk-secret");
    expect(wire).toContain("<KEY>");
    const callerCall = history[1];
    if (callerCall.role !== "assistant") {
      throw new Error("unreachable");
    }
    expect(callerCall.toolCalls?.[0]?.args.creds).toBe("sk-secret"); // 原消息未动（副本替换）
  });

  it("R4 回显文本复用敏感值占位（Python 递归重跑 filter 的 parity 对齐，轮 12 #5）", async () => {
    const { mock, client } = setup();
    mock.queueMany(text("the secret is sk-abc here"), toolOk({ done: 1 }));
    const r = await client.getAction("sys", msgs(), TOOL, {
      sensitiveMap: { "sk-abc": "<K>" },
    });
    expect(r.kind).toBe("ok");
    const second = JSON.stringify(mock.bodyAt(1).messages);
    expect(second).not.toContain("sk-abc"); // 回显文本占位后才 push 进 work
    expect(second).toContain("<K>");
  });

  it("R4 回显被删除式 sensitiveMap 整体滤空 → [redacted] 降级（防空文本块进下一轮 wire 与误触 fallback 切换，轮 16 #14）", async () => {
    const { mock, client } = setup();
    mock.queueMany(text("topsecret"), toolOk({ done: 1 }));
    const r = await client.getAction("sys", msgs(), TOOL, {
      sensitiveMap: { topsecret: "" },
    });
    expect(r.kind).toBe("ok");
    const second = JSON.stringify(mock.bodyAt(1).messages);
    expect(second).not.toContain("topsecret");
    expect(second).toContain("[redacted]");
  });

  it("args 检测与替换同域（先替换后比较）：real 含引号/反斜杠/换行不再漏报，命中键名/number 值不再谎报（轮 16 #6）", async () => {
    // 旧 JSON.stringify(args).includes(real) 与文本替换域不一致：real 串化后为
    // 转义形态（\" \\ \n），includes 永远失配——opt-in 也既不替换也无告警
    const tricky = 'pa"ss\\w\nord';
    const history = historyWithToolResult("ok", { password: tricky });

    // 缺省：WARNING 可观测（转义形态不再漏报）
    const plain = setupWithLogs();
    plain.mock.queueMany(toolOk({ done: 1 }));
    await plain.client.getAction("sys", history, TOOL, {
      sensitiveMap: { [tricky]: "<KEY>" },
    });
    expect(plain.logs.some((m) => m.includes("WARNING") && m.includes("args"))).toBe(true);

    // opt-in：深层替换占位出站，调用方原始消息不动
    const redact = setupWithLogs();
    redact.mock.queueMany(toolOk({ done: 1 }));
    await redact.client.getAction("sys", history, TOOL, {
      sensitiveMap: { [tricky]: "<KEY>" },
      redactToolPayloads: true,
    });
    const wireMessages = redact.mock.lastBody().messages as Array<Record<string, unknown>>;
    const assistant = wireMessages.find((m) => m.role === "assistant") as Record<string, unknown>;
    const toolUse = (assistant.content as Array<Record<string, unknown>>).find(
      (b) => b.type === "tool_use",
    ) as Record<string, unknown>;
    expect(toolUse.input).toEqual({ password: "<KEY>" }); // 深层替换后的占位出站
    const callerCall = history[1];
    if (callerCall.role !== "assistant") {
      throw new Error("unreachable");
    }
    expect(callerCall.toolCalls?.[0]?.args.password).toBe(tricky);

    // 旧检测的反向谎报面：real 命中 args 键名或 number 值（串化文本包含），但
    // 深层替换只改写字符串值——先替换后比较后不再误报「包含敏感值」
    const noLeak = setupWithLogs();
    noLeak.mock.queueMany(toolOk({ done: 1 }));
    await noLeak.client.getAction(
      "sys",
      historyWithToolResult("ok", { "sk-secret": 1, code: 12345 }),
      TOOL,
      {
        sensitiveMap: { "sk-secret": "<KEY>", "12345": "<N>" },
      },
    );
    // 只排除泄露类告警：map 里的整数键 "12345" 会合法触发轮 20 #10 的配置告警
    expect(noLeak.logs.some((m) => m.includes("工具载荷") || m.includes("已占位"))).toBe(false);
  });

  it("redactToolPayloads + 删除式 sensitiveMap：toolResult 整体即敏感值 → [redacted] 降级防空 text 出站（轮 16 #7）", async () => {
    const { mock, client } = setup();
    mock.queueMany(toolOk({ done: 1 }));
    const r = await client.getAction("sys", historyWithToolResult("topsecret"), TOOL, {
      sensitiveMap: { topsecret: "" },
      redactToolPayloads: true,
    });
    expect(r.kind).toBe("ok");
    const wire = JSON.stringify(mock.lastBody().messages);
    expect(wire).not.toContain("topsecret");
    expect(wire).toContain("[redacted]");
  });

  it("同名工具多轮命中 → WARNING 载荷列表去重（轮 16 #9）", async () => {
    const { mock, logs, client } = setupWithLogs();
    mock.queueMany(toolOk({ done: 1 }));
    const r = await client.getAction(
      "sys",
      [
        { role: "user", blocks: [{ kind: "text", text: "q" }] },
        { role: "assistant", blocks: [], toolCalls: [{ id: "t1", name: TOOL.name, args: {} }] },
        { role: "toolResult", toolCallId: "t1", toolName: TOOL.name, text: "a sk-secret" },
        { role: "assistant", blocks: [], toolCalls: [{ id: "t2", name: TOOL.name, args: {} }] },
        { role: "toolResult", toolCallId: "t2", toolName: TOOL.name, text: "b sk-secret" },
      ],
      TOOL,
      { sensitiveMap: { "sk-secret": "<KEY>" } },
    );
    expect(r.kind).toBe("ok");
    // 逐字符锁定（含去重后的单次出现）
    const warn = logs.find((m) => m.includes("WARNING"));
    expect(warn).toBe(
      `[llm] WARNING: 工具载荷(${TOOL.name}) 包含敏感值，将以明文出站（toolResult/args 不在占位范围，redactToolPayloads:true 可阻断；P4 接 SecretProvider 时收口）`,
    );
  });

  it("systemPrompt 敏感命中 → 按 map 去重 WARNING 可观测（不在占位范围、明文出站由宿主自担，轮 18 #3；轮 29 #6 改按身份）", async () => {
    const { mock, logs, client } = setupWithLogs();
    mock.queueMany(toolOk({ done: 1 }), toolOk({ done: 2 }));
    const sensitiveMap = { "sk-secret": "<KEY>" };
    await client.getAction("use sk-secret wisely", msgs(), TOOL, { sensitiveMap });
    const hits = logs.filter((m) => m.includes("systemPrompt"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("WARNING");
    // systemPrompt 原样出站（占位只覆盖 messages 的 TextBlock）
    expect(JSON.stringify(mock.lastBody())).not.toContain("<KEY>");
    expect(JSON.stringify(mock.lastBody())).toContain("sk-secret");
    // 按 map 身份去重（轮 29 #6）：同一 map 对象跨调用只告警一次（新 map 各自一次
    // 的锚定见姊妹用例）
    await client.getAction("use sk-secret wisely", msgs(), TOOL, { sensitiveMap });
    expect(logs.filter((m) => m.includes("systemPrompt"))).toHaveLength(1);
    // 观测通道自身不泄露明文
    expect(logs.some((m) => m.includes("sk-secret"))).toBe(false);
  });

  it("sensitiveMap 病态配置一次性 WARNING：数组索引键重排 / 占位符冲突（轮 20 #10/#14 + 轮 21 #8/#15）", async () => {
    // canonical 数组索引键（≤10 位非负数字串）：引擎重排到枚举首位升序，
    // 含包含关系键时替换顺序不可依赖
    const intKeys = setupWithLogs();
    intKeys.mock.queueMany(toolOk({ done: 1 }));
    await intKeys.client.getAction("sys", msgs(), TOOL, {
      sensitiveMap: { "1234": "<A>", "sk-x": "<B>" },
    });
    expect(intKeys.logs.some((m) => m.includes("WARNING") && m.includes("数组索引键"))).toBe(true);

    // 超界数字串（19 位卡号）是普通字符串键恒插入序——无重排风险零告警
    //（轮 21 #15 谓词收窄的反例锚定：旧「整数形态键」说法对卡号/手机号是假阳性）
    const cardNumber = setupWithLogs();
    cardNumber.mock.queueMany(toolOk({ done: 1 }));
    await cardNumber.client.getAction("sys", msgs(), TOOL, {
      sensitiveMap: { "6222020000000000123": "<CARD>" },
    });
    expect(cardNumber.logs.some((m) => m.includes("WARNING"))).toBe(false);

    // 占位符冲突：还原侧先插入者胜，后续条目静默失效（还原结果张冠李戴）
    const conflict = setupWithLogs();
    conflict.mock.queueMany(toolOk({ done: 1 }));
    await conflict.client.getAction("sys", msgs(), TOOL, {
      sensitiveMap: { realA: "<X>", realB: "<X>" },
    });
    expect(conflict.logs.some((m) => m.includes("WARNING") && m.includes("占位符冲突"))).toBe(true);

    // 两类病态共存：各自独立告警（轮 21 #8——旧 if/else 会让整数键掩盖冲突检测）
    const both = setupWithLogs();
    both.mock.queueMany(toolOk({ done: 1 }));
    await both.client.getAction("sys", msgs(), TOOL, {
      sensitiveMap: { "42": "<N>", realA: "<X>", realB: "<X>" },
    });
    expect(both.logs.some((m) => m.includes("数组索引键"))).toBe(true);
    expect(both.logs.some((m) => m.includes("占位符冲突"))).toBe(true);

    // 正常配置零告警（反例锚定）
    const clean = setupWithLogs();
    clean.mock.queueMany(toolOk({ done: 1 }));
    await clean.client.getAction("sys", msgs(), TOOL, {
      sensitiveMap: { "sk-x": "<KEY>" },
    });
    expect(clean.logs.some((m) => m.includes("WARNING"))).toBe(false);
  });

  it("sensitiveMap 交叉冲突 / 空 real 键误报（轮 25 #3/#6）", async () => {
    // 交叉冲突：某条目的 placeholder 恰为另一条目的 real——顺序 replaceAll 形成
    // 替换链，双向静默损坏
    const cross = setupWithLogs();
    cross.mock.queueMany(toolOk({ done: 1 }));
    await cross.client.getAction("sys", msgs(), TOOL, {
      sensitiveMap: { "sk-abc": "TOKEN", TOKEN: "***" },
    });
    expect(cross.logs.some((m) => m.includes("WARNING") && m.includes("交叉冲突"))).toBe(true);

    // 空 real 键条目：全链路从不参与替换，占位符不得计入冲突集（误报还会消费
    // 一次性去重标志，让后续真病态永久静默）
    const emptyKey = setupWithLogs();
    emptyKey.mock.queueMany(toolOk({ done: 1 }));
    await emptyKey.client.getAction("sys", msgs(), TOOL, {
      sensitiveMap: { secret: "TOKEN", "": "TOKEN" },
    });
    expect(emptyKey.logs.some((m) => m.includes("WARNING"))).toBe(false);
  });

  it("sensitiveMap URL tag 撞型 / 子串交叉冲突（轮 26 #1/#4）", async () => {
    // 占位符形如 [uN]：okResult 同序还原（先 URL 后敏感）会把模型输出中的该
    // 占位符先消费成长 URL，敏感还原失配——真实值永不还原且被 URL 顶替
    const urlTag = setupWithLogs();
    urlTag.mock.queueMany(toolOk({ done: 1 }));
    await urlTag.client.getAction("sys", msgs(), TOOL, {
      sensitiveMap: { "sk-x": "[u0]" },
    });
    expect(urlTag.logs.some((m) => m.includes("WARNING") && m.includes("撞型"))).toBe(true);

    // 子串形态交叉冲突：占位符 **key** 含另一条目 real "key"——顺序替换形成
    // 替换链（先占位出的值被再次替换），精确相等检测拦不住（轮 26 #4 放宽）
    const substring = setupWithLogs();
    substring.mock.queueMany(toolOk({ done: 1 }));
    await substring.client.getAction("sys", msgs(), TOOL, {
      sensitiveMap: { "secret-key": "**key**", key: "<PIN>" },
    });
    expect(substring.logs.some((m) => m.includes("WARNING") && m.includes("交叉冲突"))).toBe(true);
  });

  it("四类病态跨调用独立去重：首调整数键不再掩蔽次调占位符冲突（轮 29 #4）", async () => {
    const { mock, client, logs } = setupWithLogs();
    mock.queueMany(toolOk({ done: 1 }), toolOk({ done: 1 }));
    await client.getAction("sys", msgs(), TOOL, {
      sensitiveMap: { "1234": "<A>" },
    });
    await client.getAction("sys", msgs(), TOOL, {
      sensitiveMap: { realA: "<X>", realB: "<X>" },
    });
    expect(logs.some((m) => m.includes("数组索引键"))).toBe(true);
    expect(logs.some((m) => m.includes("占位符冲突"))).toBe(true);
  });

  it("systemPrompt 泄露按 map 身份去重：同一 map 一次、新 map 各自一次（轮 29 #6）", async () => {
    const { mock, client, logs } = setupWithLogs();
    mock.queueMany(toolOk({ done: 1 }), toolOk({ done: 1 }), toolOk({ done: 1 }));
    const mapA = { "sk-a": "<A>" };
    await client.getAction("use sk-a here", msgs(), TOOL, { sensitiveMap: mapA });
    await client.getAction("use sk-a again", msgs(), TOOL, { sensitiveMap: mapA }); // 同 map 不重复
    await client.getAction("use sk-b here", msgs(), TOOL, { sensitiveMap: { "sk-b": "<B>" } });
    const leaks = logs.filter((m) => m.includes("systemPrompt 含 sensitiveMap 命中值"));
    expect(leaks).toHaveLength(2); // mapA 一次 + mapB 一次
  });
});

describe("退避与预算（FakeClock；常量锚定 2,4,8,16,30 共 5 次睡眠）", () => {
  it("429 ×5 → 第 6 次成功（指数退避序列推进时钟）", async () => {
    const { mock, clock, client } = setup();
    mock.queueMany(r429(), r429(), r429(), r429(), r429(), toolOk({ done: 1 }));
    const p = client.getAction("sys", msgs(), TOOL);
    await clock.advance(0); // 冲刷微任务：首请求 429 → sleep(2000)
    await drainBackoffLadder(clock);
    const r = await p;
    expect(r.kind).toBe("ok");
    expect(mock.calls.length).toBe(6);
  });

  it("429 恒败 → 抛 LLMRateLimitError（类型不变，共 6 次请求后耗尽名额）", async () => {
    const { mock, clock, client } = setup();
    mock.queueMany(r429(), r429(), r429(), r429(), r429(), r429());
    const p = client.getAction("sys", msgs(), TOOL);
    await clock.advance(0);
    await drainBackoffLadder(clock);
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
    await clock.advance(4000); // 41000: 窗口 deadline 到点（watcher abort 恰逢 r3 失败）
    // 到点恒 LLMTimeoutError（03 偏离 5）：callWithBackoff 的 signal 预检把"窗口到期
    // 恰逢失败响应"还原为取消，不再以最后错误（RateLimit）变形掩蔽到点事实；
    // "预算 gate 抛最后错误"路径由预算耗尽用例覆盖（预算 < 窗口时 gate 先触发）
    await expect(p).rejects.toBeInstanceOf(LLMTimeoutError);
    expect(mock.calls.length).toBe(3);
  });

  it("非 infra（401）不退避：无 fallback 直接抛，1 次请求", async () => {
    const { mock, client } = setup();
    mock.queueMany(r401());
    await expect(client.getAction("sys", msgs(), TOOL)).rejects.toBeInstanceOf(LLMAuthError);
    expect(mock.calls.length).toBe(1);
  });

  it("非 infra（500）不退避：无 fallback 直接抛 LLMServerError，1 次请求", async () => {
    const { mock, client } = setup();
    mock.queueMany(r500());
    await expect(client.getAction("sys", msgs(), TOOL)).rejects.toBeInstanceOf(LLMServerError);
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
    // 凭证随卡片切换的契约锚定（轮 20 #3）：防回归为沿用主卡 apiKey——那会把
    // 主卡密钥发往 fallback 主机（凭证外泄）且全量 401
    expect(mock.calls[0].init.headers).toMatchObject({ "x-api-key": "k1" });
    expect(mock.calls[1].init.headers).toMatchObject({ "x-api-key": "k2" });
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

  it("500（非 infra，5xx 独立分类）同样触发切换", async () => {
    const { mock, client } = setup({ fallback: FALLBACK });
    mock.queueMany(r500(), toolOk({ via: "fb" }));
    const r = await client.getAction("sys", msgs(), TOOL);
    expect(r.kind).toBe("ok");
    expect(mock.calls[1].url).toContain("fallback.example");
  });

  it("协议违例（2xx 畸形体）不触发切换：直接上抛、类型不变形（Python SDK APIResponseValidationError 不入 except 元组，轮 17 #9）", async () => {
    const { mock, client } = setup({ fallback: FALLBACK });
    mock.queueMany({ status: 200, rawBody: "<html>gateway oops</html>" });
    const err = await client.getAction("sys", msgs(), TOOL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMProtocolViolationError);
    expect((err as LLMProtocolViolationError).provider).toBe("primary"); // 归因主卡
    expect(mock.calls.length).toBe(1); // 不切换不重试：瞬时网关抖动不烧单向切换
    expect(mock.calls[0].url).toContain("primary.example");
  });

  it("blocked（非 infra 第三分支，gemini promptFeedback）同样触发切换且类型不变形（轮 14 #6）", async () => {
    // setupCore 的 zero 形态（轮 21 #14：不再内联重建零时钟 deps 字面量）
    const { mock, client } = setupCore({ ...GEMINI_CARD, fallback: FALLBACK }, "zero", false);
    mock.queueMany(
      { status: 200, body: { promptFeedback: { blockReason: "SAFETY" } } },
      toolOk({ via: "fb" }),
    );
    const r = await client.getAction("sys", msgs(), TOOL);
    expect(r.kind).toBe("ok");
    expect(mock.calls[0].url).toContain("gemini.example");
    expect(mock.calls[1].url).toContain("fallback.example"); // 切换发生，类型未被吞
  });

  it("跨协议切换：主 anthropic + fallback openai（完整卡片组合的独有测试点）", async () => {
    const { mock, clock, client } = setup({ fallback: OPENAI_FALLBACK });
    mock.queueMany(r429(), {
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
                  function: { name: TOOL.name, arguments: '{"via":"openai"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      },
    });
    const p = client.getAction("sys", msgs(), TOOL);
    await clock.advance(0); // 429 → 切换 → 立即以 openai wire 重发
    const r = await p;
    expect(r).toEqual({
      kind: "ok",
      toolInput: { via: "openai" },
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    expect(mock.calls[0].url).toContain("primary.example/v1/messages");
    expect(mock.calls[1].url).toContain("fallback.example/v1/chat/completions");
    // 凭证随卡片切换（跨协议形态，轮 20 #3）：authorization 而非主卡 x-api-key
    expect(mock.calls[0].init.headers).toMatchObject({ "x-api-key": "k1" });
    expect(mock.calls[1].init.headers).toMatchObject({ authorization: "Bearer k3" });
    const fb = mock.bodyAt(1);
    expect(fb.model).toBe("glm-4.7");
    expect(fb.tool_choice).toEqual({ type: "function", function: { name: TOOL.name } });
    expect(fb.max_tokens).toBe(4096);
  });

  it("单向锁：已切换后二次 429 走纯退避（1 次主 + 6 次 fallback 后抛）", async () => {
    const { mock, clock, client } = setup({ fallback: FALLBACK });
    mock.queueMany(r429(), r429(), r429(), r429(), r429(), r429(), r429());
    const p = client.getAction("sys", msgs(), TOOL);
    await clock.advance(0); // 主 429 → 切换 → fallback 429 → sleep(2000)
    await drainBackoffLadder(clock);
    await expect(p).rejects.toBeInstanceOf(LLMRateLimitError);
    expect(mock.calls.length).toBe(7);
    expect(mock.calls.filter((c) => c.url.includes("fallback.example")).length).toBe(6);
  });

  it("滤图：fallback 无视觉 → 后续请求无 image 块；调用方消息不被改动", async () => {
    const { mock, clock, client } = setup({ fallback: FALLBACK });
    const messages = withImageMessages();
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

  it("主卡显式声明 supportsVision=false → 恒滤图（声明即生效）；未声明主卡不滤（偏离 9 取舍）", async () => {
    const declared = setup({ capabilities: { supportsVision: false } });
    const withImage = withImageMessages();
    declared.mock.queueMany(toolOk({ done: 1 }));
    const r = await declared.client.getAction("sys", withImage, TOOL);
    expect(r.kind).toBe("ok");
    expect(JSON.stringify(declared.mock.lastBody().messages)).not.toContain('"image"');

    // 未声明（白名单外主卡，缺省推导 false）不滤——防 qwen-vl 等真视觉模型被误滤
    const undeclared = setup({ model: "glm-5.1" }); // 白名单外，未声明
    undeclared.mock.queueMany(toolOk({ done: 1 }));
    await undeclared.client.getAction("sys", withImage, TOOL);
    expect(JSON.stringify(undeclared.mock.lastBody().messages)).toContain('"image"');
  });

  it("滤图生效留一次 WARNING（实例级去重）；image-only 历史降级占位文本块不放大成步级失败", async () => {
    const { mock, logs, client } = setupWithLogs({
      capabilities: { supportsVision: false },
    });
    mock.queueMany(toolOk({ done: 1 }), toolOk({ done: 2 }));
    const imageOnly: ChatMessage[] = [
      { role: "user", blocks: [{ kind: "image", mimeType: "image/png", base64: "AAAA" }] },
    ];
    const r = await client.getAction("sys", imageOnly, TOOL);
    expect(r.kind).toBe("ok");
    // image-only 历史降级为占位文本块继续（Python 降级空串同精神，一次瞬时 429
    // 触发 fallback 切换不被放大成步级硬失败）
    expect(JSON.stringify(mock.bodyAt(0).messages)).toContain("[image omitted]");
    // 实例级去重的关键场景：第二次调用**仍带图**——已告警过不再重复刷屏
    //（无图调用本来就不告警，测不到去重）
    await client.getAction("sys", imageOnly, TOOL);
    expect(logs.filter((m) => m.includes("滤图生效")).length).toBe(1);
  });

  it("未声明主卡被推导为无视觉却带图出站 → 致盲 WARNING 一次（轮 13 #9，对称于滤图告警）", async () => {
    // glm-5.1 白名单外且未声明 → 推导 false、不滤（偏离 9 取舍）——图照发但可观测
    const { mock, logs, client } = setupWithLogs({ model: "glm-5.1" });
    mock.queueMany(toolOk({ done: 1 }), toolOk({ done: 2 }));
    const withImage = withImageMessages();
    const r = await client.getAction("sys", withImage, TOOL);
    expect(r.kind).toBe("ok");
    // 图未被滤（未声明不滤的取舍不变），但致盲可观测
    expect(JSON.stringify(mock.lastBody().messages)).toContain('"image"');
    expect(logs.filter((m) => m.includes("推导为无视觉的主卡")).length).toBe(1);
    await client.getAction("sys", withImage, TOOL); // 实例级去重
    expect(logs.filter((m) => m.includes("推导为无视觉的主卡")).length).toBe(1);
  });
});

describe("deadline 与取消", () => {
  it("opts.timeoutMs 到点强杀在飞请求 → LLMTimeoutError（03 偏离 5，真实时钟）", async () => {
    const { mock, client } = setupRealClock();
    mock.queueMany({ hangUntilAbort: true });
    await expect(client.getAction("sys", msgs(), TOOL, { timeoutMs: 60 })).rejects.toBeInstanceOf(
      LLMTimeoutError,
    );
  });

  it("响应体读取阶段超时 → LLMTimeoutError（resp.text() 同分类，不漏成裸 AbortError 被当外部取消）", async () => {
    const provider = createProvider(CARD, { fetch: makeHangingBodyFetch(), log: () => {} });
    await expect(
      provider.chat({
        systemPrompt: null,
        messages: msgs(),
        tools: null,
        timeoutMs: 60,
      }),
    ).rejects.toBeInstanceOf(LLMTimeoutError);
  });

  it("错误响应体读取阶段超时 → 仍按超时分型（不被状态码 400 误报为不可重试/触发切换）", async () => {
    const provider = createProvider(CARD, {
      fetch: makeHangingBodyFetch({ ok: false, status: 400 }),
      log: () => {},
    });
    await expect(
      provider.chat({
        systemPrompt: null,
        messages: msgs(),
        tools: null,
        timeoutMs: 60,
      }),
    ).rejects.toBeInstanceOf(LLMTimeoutError);
  });

  it("fallback 卡片构造失败（非法 protocol）→ LLMInvalidRequestError 且 cause 保留触发切换的原始错误", async () => {
    const { mock, clock, client } = setup({
      fallback: { ...FALLBACK, protocol: "bogus" as ProviderConfig["protocol"] },
    });
    mock.queueMany(r429());
    const p = client.getAction("sys", msgs(), TOOL);
    await clock.advance(0); // 429 → 尝试切换 → fallback 卡片构造抛
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMInvalidRequestError);
    expect((err as LLMInvalidRequestError).message).toContain("fallback 卡片初始化失败");
    expect((err as LLMInvalidRequestError).cause).toBeInstanceOf(LLMRateLimitError);
    expect(mock.calls.length).toBe(1);
  });

  it("过期窗口不清除会拖垮后续调用；setCallWindow(null) 清除后恢复", async () => {
    const stuck = setup();
    stuck.client.setCallWindow(1); // 立即过期的窗口
    stuck.mock.queueMany({ hangUntilAbort: true });
    const p = stuck.client.getAction("sys", msgs(), TOOL);
    await stuck.clock.advance(0); // 冲刷：fetch 在飞 + deadline watcher 挂起（注入时钟域）
    await stuck.clock.advance(1); // deadline 到点 → abort 在飞请求
    await expect(p).rejects.toBeInstanceOf(LLMTimeoutError);

    const cleared = setup();
    cleared.client.setCallWindow(1);
    cleared.client.setCallWindow(null); // 清除登记
    cleared.mock.queueMany(toolOk({ ok: 1 }));
    const r = await cleared.client.getAction("sys", msgs(), TOOL);
    expect(r.kind).toBe("ok");
  });

  it("过期窗口留 WARNING（含过期毫秒数）：陈旧登记从注释纪律变运行时可观测（轮 18 #4）", async () => {
    const { mock, clock, logs, client } = setupClockWithLogs();
    client.setCallWindow(1); // deadline = 1001（FakeClock 起点 1000）
    await clock.advance(5); // t = 1005 → 登记已过期 4ms
    mock.queueMany({ hangUntilAbort: true });
    const p = client.getAction("sys", msgs(), TOOL);
    await clock.advance(0); // 冲刷：WARNING + deadline watcher 立即到点强杀在飞请求
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMTimeoutError);
    // 归因实际生效的约束来源（轮 20 #8）：本用例只登记了窗口，source=window
    expect((err as LLMTimeoutError).message).toContain("source=window");
    const warn = logs.find((m) => m.includes("已过期"));
    expect(warn).toContain("setCallWindow");
    expect(warn).toContain("4ms");
  });

  it("外部 signal 恰逢错误响应体读取 → AbortError 穿透且不消耗 fallback 单向锁（评审轮 5 #12）", async () => {
    // 首请求返回 429 状态行但 body 读取挂起（真实流式读体形态）；外部取消时 http 层
    // 会把它吞成 LLMRateLimitError——修复前该假性 429 会误触发 fallback 单向切换。
    // 确定性同步：text() 首次调用即打点，await 打点后再 abort——钉死「恰逢读体挂起」
    // 的测试意图，不依赖真实定时器时序
    let markBodyRead: () => void = () => {};
    const bodyReadStarted = new Promise<void>((resolve) => {
      markBodyRead = resolve;
    });
    const hanging429BodyFetch = makeHangingBodyFetch({
      ok: false,
      status: 429,
      headers: { "retry-after": "5" },
      onBodyRead: markBodyRead,
    });
    const normal = new MockFetch();
    normal.queueMany(toolOk({ ok: 1 }));
    let firstCall = true;
    const fetchFn = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (firstCall) {
        firstCall = false;
        return hanging429BodyFetch(url, init);
      }
      return normal.fetch(url, init);
    }) as typeof fetch;
    const client = setupCore({ fallback: FALLBACK }, "zero", false, fetchFn).client;
    const ctrl = new AbortController();
    const p = client.getAction("sys", msgs(), TOOL, { signal: ctrl.signal });
    await bodyReadStarted; // 链已确定性到达错误体读取挂起
    ctrl.abort();
    const err = await p.catch((e: unknown) => e);
    expect((err as DOMException).name).toBe("AbortError");
    expect(err).not.toBeInstanceOf(LLMError);
    expect(normal.calls.length).toBe(0); // 切换未发生：没有以 fallback 名义补发请求
    // 单向锁未被消耗：后续 getAction 仍走主卡
    const r = await client.getAction("sys", msgs(), TOOL);
    expect(r.kind).toBe("ok");
    expect(normal.calls[0].url).toContain("primary.example");
  });

  it("外部取消与 deadline 到点竞态 → 外部取消优先穿透，不变形为 LLMTimeoutError（评审轮 9 #8）", async () => {
    // 拒绝经真实宏任务延迟（工厂缺省 rejectDelayMs=0）：让 FakeClock 的 deadline
    // watcher 先翻位 windowExpired，构造「外部 abort 在前、deadline 恰在异常
    // unwind 期间到点」的临界——修复前取消被变形为 LLMTimeoutError，污染 step
    // 层按异常类型分罪的依据
    const delayedAbortFetch = makeHangingBodyFetch();
    const { fake, client } = setupCore({}, "fake", false, delayedAbortFetch);
    if (fake === null) {
      throw new Error("unreachable");
    }
    client.setCallWindow(1); // deadline = t+1（watcher 经注入 sleep 注册）
    const ctrl = new AbortController();
    const p = client.getAction("sys", msgs(), TOOL, { signal: ctrl.signal });
    await fake.advance(0); // 冲刷：fetch 在飞（text 挂起）、watcher 注册（due t+1）
    ctrl.abort(); // 外部取消 → ladder signal abort → 桩安排宏任务延迟 reject
    await fake.advance(1); // watcher 到点翻位 windowExpired（reject 尚未送达）
    const err = await p.catch((e: unknown) => e);
    expect((err as DOMException).name).toBe("AbortError");
    expect(err).not.toBeInstanceOf(LLMError);
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

  it("宿主自定义 abort reason 穿透不变形（轮 10 #5；#186 取消不变形的边缘收口）", async () => {
    const { mock, clock, client } = setup();
    mock.queueMany(r429());
    const ctrl = new AbortController();
    const p = client.getAction("sys", msgs(), TOOL, { signal: ctrl.signal });
    await clock.advance(0); // sleep 挂起
    ctrl.abort("user-stop"); // 宿主以自定义 reason 区分停止来源
    const err = await p.catch((e: unknown) => e);
    expect(err).toBe("user-stop"); // 原样上抛，不被抹平为默认 AbortError
  });

  it("resolveChatHttpTimeoutMs：无 deadline → 600s 兜底；有 deadline → undefined（ladder signal 负责）", () => {
    expect(resolveChatHttpTimeoutMs(undefined)).toBe(600_000);
    expect(resolveChatHttpTimeoutMs(12345)).toBeUndefined();
  });

  it("并发 getAction → 重入哨兵显式失败（轮 12 #6；哨兵异常 TypeError 非 LLMError 家族，轮 27 #7——本地编程错误不进端点分罪轴）；完成后哨兵复位可串行复用", async () => {
    const { mock, client } = setup();
    mock.queueMany(toolOk({ ok: 1 }), toolOk({ ok: 2 }));
    const p1 = client.getAction("sys", msgs(), TOOL);
    await expect(client.getAction("sys", msgs(), TOOL)).rejects.toBeInstanceOf(TypeError);
    const r1 = await p1; // 第一个调用不受影响
    expect(r1.kind).toBe("ok");
    const r2 = await client.getAction("sys", msgs(), TOOL); // 哨兵已复位
    expect(r2.kind).toBe("ok");
  });

  it("预算耗尽日志归因实际生效约束：窗口先到标 window deadline 而非预算秒数（轮 12 #15）", async () => {
    const { mock, clock, logs, client } = setupClockWithLogs();
    // t=20s → cap=max(30s, 0.75×20s)=30s > 窗口 20s：实际生效约束是窗口
    client.setCallWindow(20_000);
    mock.queueMany(r429(), r429(), r429(), r429());
    const p = client.getAction("sys", msgs(), TOOL);
    await clock.advance(0); // 429 → sleep(2s)
    await clock.advance(2000);
    await clock.advance(4000);
    await clock.advance(8000); // t=15s；下一轮 delay 16s，15+16 > 20 → 窗口耗尽
    await expect(p).rejects.toBeInstanceOf(LLMRateLimitError);
    expect(logs.some((m) => m.includes("window deadline exhausted"))).toBe(true);
    expect(logs.some((m) => m.includes("budget (30s"))).toBe(false);
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
    await drainBackoffLadder(clock);
    await expect(p).rejects.toBeInstanceOf(LLMConnectionError);
    expect(mock.calls.length).toBe(6); // 与 429 恒败用例对称：退避名额被完整消耗
  });
});

describe("缺省 deps（真时钟：now=performance.now，sleep=setTimeout 包装）", () => {
  it("retry-after 20ms 快速路径：缺省 sleep 到点 resolve 后第二次请求成功", async () => {
    const { mock, client } = setupRealClock();
    mock.queueMany(r429("0.02"), toolOk({ done: 1 }));
    const r = await client.getAction("sys", msgs(), TOOL);
    expect(r.kind).toBe("ok");
    expect(mock.calls.length).toBe(2);
  });

  it("缺省 sleep 期间外部 abort → AbortError 穿透（可中止性）", async () => {
    const { mock, client } = setupRealClock();
    mock.queueMany(r429("5")); // 5s 退避 → 缺省 sleep 挂起
    const ctrl = new AbortController();
    const p = client.getAction("sys", msgs(), TOOL, { signal: ctrl.signal });
    // 任一宏任务边界前微任务必排空：fetch 回放（同步 resolve）到 sleep 注册全链是
    // 微任务，10ms 定时器触发时链已确定到达 sleep 挂起——不是时序赌注
    await new Promise((resolve) => setTimeout(resolve, 10));
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
      `sys\n\nIMPORTANT: You must respond by calling the tool "${TOOL.name}" with your complete answer as the tool arguments. Do not reply with plain text.`,
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
