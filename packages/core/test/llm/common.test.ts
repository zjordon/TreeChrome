// common.ts 共享小件的纯函数单测（轮 19 #2）：temperatureEntry/resolveMaxTokens/
// makeOnceWarn/stringifyForLog 的行为矩阵在此一处锁定——此前只经三适配器测试
// 间接覆盖，同一逻辑近乎逐字复制三份（协议上限表、告警文案调整需三处同步）。
// 适配器侧仅保留 anthropic 一份接线锚定（wire 落点 + 实例去重经 provider 生效）。
import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "../../src/index.js";
import {
  isRecord,
  makeOnceWarn,
  resolveMaxTokens,
  stringifyForLog,
  stripTrailingSlash,
  temperatureEntry,
} from "../../src/llm/adapters/common.js";
import type { ChatRequest } from "../../src/llm/types.js";

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
  it("有限正值直通；请求级覆盖卡片级", () => {
    const c = card("openai-completions", { maxTokens: 512 });
    expect(resolveMaxTokens(req(), c, () => {})).toBe(512);
    expect(resolveMaxTokens(req({ maxTokens: 64 }), c, () => {})).toBe(64);
  });

  it.each([Number.NaN, 0, -3, Number.POSITIVE_INFINITY, 1024.5])(
    "非法值 %s → 回退 DEFAULT_MAX_TOKENS 并回调（三协议上限字段均整型，轮 20 #12）",
    (bad) => {
      const invalid: string[] = [];
      expect(
        resolveMaxTokens(req({ maxTokens: bad }), card("gemini"), (m) => invalid.push(m)),
      ).toBe(16384);
      expect(invalid).toEqual([`maxTokens 非正整数值（${bad}），回退 16384（unit-card）`]);
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

  it("超长输入截断 500（与 http.ts ERROR_DETAIL_MAX 同源）", () => {
    const long = "x".repeat(600);
    expect(stringifyForLog(long)).toHaveLength(500);
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
