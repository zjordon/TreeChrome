// common.ts 共享小件的纯函数单测（轮 19 #2）：temperatureEntry/resolveMaxTokens/
// makeOnceWarn/stringifyForLog 的行为矩阵在此一处锁定——此前只经三适配器测试
// 间接覆盖，同一逻辑近乎逐字复制三份（协议上限表、告警文案调整需三处同步）。
// 适配器侧仅保留 anthropic 一份接线锚定（wire 落点 + 实例去重经 provider 生效）。
import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "../../src/index.js";
import {
  assertToolContract,
  collectToolResults,
  isRecord,
  makeOnceWarn,
  normalizeImageMime,
  resolveMaxTokens,
  stringifyForLog,
  stripTrailingSlash,
  TEST_CONNECTION_MAX_TOKENS,
  TEST_CONNECTION_TIMEOUT_MS,
  temperatureEntry,
} from "../../src/llm/adapters/common.js";
import { ERROR_DETAIL_MAX } from "../../src/llm/adapters/http.js";
import { DEFAULT_MAX_TOKENS } from "../../src/llm/config.js";
import { LLMProtocolViolationError } from "../../src/llm/errors.js";
import type {
  ChatMessage,
  ChatRequest,
  ToolCall,
  ToolDefinition,
  ToolResultMessage,
} from "../../src/llm/types.js";

const card = (
  protocol: ProviderConfig["protocol"],
  over: Partial<ProviderConfig> = {},
): ProviderConfig => ({
  name: "unit-card",
  protocol,
  baseUrl: "https://unit.example",
  apiKey: "k",
  model: "m",
  maxTokens: 1000,
  ...over,
});

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  systemPrompt: null,
  messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
  tools: null,
  ...over,
});

describe("temperatureEntry", () => {
  it("两级缺省不发；请求级覆盖卡片级；卡片级兜底", () => {
    expect(temperatureEntry(req(), card("openai-completions"))).toEqual({});
    const c = card("openai-completions", { temperature: 0.4 });
    expect(temperatureEntry(req({ temperature: 0.1 }), c)).toEqual({ temperature: 0.1 });
    expect(temperatureEntry(req(), c)).toEqual({ temperature: 0.4 });
  });

  it("协议上限钳制矩阵：anthropic 0-1、openai/gemini 0-2、下界同钳", () => {
    expect(temperatureEntry(req({ temperature: 1.5 }), card("anthropic-messages"))).toEqual({
      temperature: 1,
    });
    expect(temperatureEntry(req({ temperature: 2.5 }), card("openai-completions"))).toEqual({
      temperature: 2,
    });
    expect(temperatureEntry(req({ temperature: 3 }), card("gemini"))).toEqual({ temperature: 2 });
    expect(temperatureEntry(req({ temperature: -0.5 }), card("anthropic-messages"))).toEqual({
      temperature: 0,
    });
  });

  it("NaN 与 Infinity 同为非有限数值不发（序列化 null/溢出是端点 400）", () => {
    expect(temperatureEntry(req({ temperature: Number.NaN }), card("openai-completions"))).toEqual(
      {},
    );
    expect(
      temperatureEntry(req({ temperature: Number.POSITIVE_INFINITY }), card("gemini")),
    ).toEqual({});
  });

  it("钳制发生才回调 onClamp（消息含原值/钳后值/卡片名），区间内不回调", () => {
    const clamped: string[] = [];
    const c = card("anthropic-messages", { name: "card-x" });
    temperatureEntry(req({ temperature: 1.5 }), c, (m) => clamped.push(m));
    temperatureEntry(req({ temperature: 0.5 }), c, (m) => clamped.push(m)); // 区间内静默
    expect(clamped).toEqual(["temperature 1.5 超出协议范围 [0, 1]，已钳制为 1（card-x）"]);
  });

  it("NaN/Infinity 不发也经 onClamp 留证据（轮 26 #3：与钳制/回退同观测口径）；缺省不回调", () => {
    const warned: string[] = [];
    const c = card("openai-completions", { name: "card-x" });
    temperatureEntry(req({ temperature: Number.NaN }), c, (m) => warned.push(m));
    temperatureEntry(req({ temperature: Number.POSITIVE_INFINITY }), c, (m) => warned.push(m));
    temperatureEntry(req(), c, (m) => warned.push(m)); // 未配置不回调
    expect(warned).toEqual([
      "temperature NaN 非有限数值（NaN/Infinity），不发送（card-x）",
      "temperature Infinity 非有限数值（NaN/Infinity），不发送（card-x）",
    ]);
  });
});

describe("resolveMaxTokens", () => {
  it("有限正值直通且不回调；请求级覆盖卡片级（轮 27 #10 合法值零回调阴性对照）", () => {
    const c = card("openai-completions", { maxTokens: 512 });
    const warned: string[] = [];
    expect(resolveMaxTokens(req(), c, (m) => warned.push(m))).toBe(512);
    expect(resolveMaxTokens(req({ maxTokens: 64 }), c, (m) => warned.push(m))).toBe(64);
    // 合法值零回调（与 temperatureEntry「区间内不回调」同口径）：onInvalid 被误改
    // 为无条件调用时，此处是唯一能红的断言（接线锚定经 makeOnceWarn 去重测不出）
    expect(warned).toEqual([]);
  });

  it.each([Number.NaN, 0, -3, Number.POSITIVE_INFINITY, 1024.5])(
    "非法值 %s → 回退 DEFAULT_MAX_TOKENS 并回调（三协议上限字段均整型，轮 20 #12；回退值引用常量，轮 27 #4）",
    (bad) => {
      const invalid: string[] = [];
      expect(
        resolveMaxTokens(req({ maxTokens: bad }), card("gemini"), (m) => invalid.push(m)),
      ).toBe(DEFAULT_MAX_TOKENS);
      expect(invalid).toEqual([
        `maxTokens 非正整数值（${bad}），回退 ${DEFAULT_MAX_TOKENS}（unit-card）`,
      ]);
    },
  );
});

describe("makeOnceWarn", () => {
  it("首条带 WARNING 前缀放行，后续静默；各实例独立", () => {
    const out: string[] = [];
    const warn = makeOnceWarn((m) => out.push(m));
    warn("first");
    warn("second");
    const other = makeOnceWarn((m) => out.push(m));
    other("third");
    expect(out).toEqual(["[llm] WARNING: first", "[llm] WARNING: third"]);
  });
});

describe("stringifyForLog", () => {
  it("undefined 安全（JSON.stringify 返回非字符串不能直挂 .slice）", () => {
    expect(stringifyForLog(undefined)).toBe("undefined");
  });

  it(`超长输入截断到 ERROR_DETAIL_MAX（${ERROR_DETAIL_MAX}，常量单源轮 29 #9）`, () => {
    const long = "x".repeat(ERROR_DETAIL_MAX + 100);
    expect(stringifyForLog(long)).toHaveLength(ERROR_DETAIL_MAX);
  });

  it("BigInt/循环引用不抛——String 兜底（轮 37 #6：schema 清洗的删除上报以宿主程序化构造的 parameters 原值为入参，非 JSON-only 来源）", () => {
    expect(stringifyForLog(10n)).toBe("10");
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(stringifyForLog(circular)).toBe("[object Object]");
  });
});

describe("连通性探测常量（轮 35 #12 导出锚定）", () => {
  it("16 是全协议安全最小值（o 系 max_completion_tokens 下限）；10s 兜底超时", () => {
    expect(TEST_CONNECTION_MAX_TOKENS).toBe(16);
    expect(TEST_CONNECTION_TIMEOUT_MS).toBe(10_000);
  });
});

describe("normalizeImageMime", () => {
  it("别名映射 + 小写归一（轮 28 #3 起源，轮 34 #4 扩表）：jpg/x-png/大小写变体收口，规范值原样", () => {
    expect(normalizeImageMime("image/jpg")).toBe("image/jpeg");
    expect(normalizeImageMime("image/x-png")).toBe("image/png");
    expect(normalizeImageMime("IMAGE/JPG")).toBe("image/jpeg");
    expect(normalizeImageMime("Image/PNG")).toBe("image/png"); // 小写化但不别名
    expect(normalizeImageMime("image/webp")).toBe("image/webp"); // 已规范值不动
  });
});

describe("isRecord / stripTrailingSlash", () => {
  it("基础谓词", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(stripTrailingSlash("https://x.example///")).toBe("https://x.example");
  });
});

describe("collectToolResults（轮 37 #10 单源：anthropic/gemini 折叠骨架的行为矩阵）", () => {
  const call = (id: string): ToolCall => ({ id, name: `t-${id}`, args: {} });
  const tr = (id: string, text = `r-${id}`): ToolResultMessage => ({
    role: "toolResult",
    toolCallId: id,
    toolName: `t-${id}`,
    text,
  });

  it("收集紧随段并按 toolCalls 顺序重排（乱序到达）；next 指向段后首条", () => {
    const calls = [call("a"), call("b")];
    const messages: ChatMessage[] = [
      { role: "assistant", blocks: [], toolCalls: calls },
      tr("b"),
      tr("a"),
      { role: "user", blocks: [{ kind: "text", text: "obs" }] },
    ];
    const { pairs, next } = collectToolResults(messages, 1, calls);
    expect(pairs.map((p) => p.call.id)).toEqual(["a", "b"]);
    expect(pairs.map((p) => p.result.text)).toEqual(["r-a", "r-b"]);
    expect(next).toBe(3);
  });

  it("段首非 toolResult → 空收集且 next 不前进；配对过滤：id 不匹配任何 call 的结果不进 pairs（防御分支）", () => {
    const user: ChatMessage = { role: "user", blocks: [{ kind: "text", text: "q" }] };
    expect(collectToolResults([user], 0, [])).toEqual({ pairs: [], next: 0 });
    const messages: ChatMessage[] = [
      { role: "assistant", blocks: [], toolCalls: [call("a")] },
      tr("zzz"),
      tr("a"),
    ];
    const { pairs, next } = collectToolResults(messages, 1, [call("a")]);
    expect(pairs.map((p) => p.result.toolCallId)).toEqual(["a"]);
    expect(next).toBe(3);
  });

  it("防御分支留证据（轮 38 #16）：未匹配结果与 calls 缺结果分别上报；完备配对零上报", () => {
    const logged: string[] = [];
    // 段内 zzz 未匹配任何 call + calls 的 b 缺结果（wire 将缺 tool_result）
    const messages: ChatMessage[] = [
      { role: "assistant", blocks: [], toolCalls: [call("a"), call("b")] },
      tr("zzz"),
      tr("a"),
    ];
    const { pairs } = collectToolResults(messages, 1, [call("a"), call("b")], (m) => {
      logged.push(m);
    });
    expect(pairs.map((p) => p.result.toolCallId)).toEqual(["a"]);
    expect(logged).toEqual([
      "[llm] toolResult（zzz）未匹配前置 assistant 的 toolCalls，丢弃（canonical 校验漂移的防御分支）",
      "[llm] assistant 的 2 个 toolCall 仅配对 1 条结果（wire 将缺失对应 tool_result，端点 400 形态）",
    ]);
    // 完备配对零上报（阴性对照）
    const clean: string[] = [];
    const ok = collectToolResults([tr("a"), tr("b")], 0, [call("a"), call("b")], (m) => {
      clean.push(m);
    });
    expect(ok.pairs).toHaveLength(2);
    expect(clean).toEqual([]);
  });
});

describe("assertToolContract 工具名唯一性（轮 37 #14）", () => {
  const tool = (name: string): ToolDefinition => ({
    name,
    description: "d",
    parameters: { type: "object" },
  });

  it("重名 → LLMProtocolViolationError；唯一名（含 forced 匹配）放行", () => {
    const c = card("anthropic-messages");
    expect(() => assertToolContract(req({ tools: [tool("dup"), tool("dup")] }), c)).toThrow(
      LLMProtocolViolationError,
    );
    expect(() => assertToolContract(req({ tools: [tool("dup"), tool("other")] }), c)).not.toThrow();
  });

  it("空串名（轮 36 #8）在共享层同样拦截", () => {
    expect(() => assertToolContract(req({ tools: [tool("")] }), card("gemini"))).toThrow(
      LLMProtocolViolationError,
    );
  });
});
