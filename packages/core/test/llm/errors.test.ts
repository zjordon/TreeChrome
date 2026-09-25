// 错误分类与 isInfraError 谓词矩阵单测（docs/implement-plan/p2/01 §5）。
import { describe, expect, it } from "vitest";
import {
  isInfraError,
  LLMAuthError,
  LLMBlockedError,
  LLMConnectionError,
  LLMError,
  LLMInvalidRequestError,
  LLMProtocolViolationError,
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
} from "../../src/llm/errors.js";

const mk = (): Array<[string, LLMError]> => [
  ["connection", new LLMConnectionError("c", { provider: "p" })],
  ["timeout", new LLMTimeoutError("t", { provider: "p" })],
  ["rateLimit", new LLMRateLimitError("r", { provider: "p", status: 429 })],
  ["auth", new LLMAuthError("a", { provider: "p", status: 401 })],
  ["invalidRequest", new LLMInvalidRequestError("i", { provider: "p", status: 400 })],
  ["server", new LLMServerError("s", { provider: "p", status: 500 })],
  ["blocked", new LLMBlockedError("b", { provider: "p" })],
  ["protocolViolation", new LLMProtocolViolationError("v", { provider: "p" })],
];

describe("错误类层级", () => {
  it("全部子类 instanceof LLMError 与 Error，且 name 各自正确", () => {
    for (const [label, err] of mk()) {
      expect(err, label).toBeInstanceOf(LLMError);
      expect(err, label).toBeInstanceOf(Error);
      expect(err.name, label).toMatch(/^LLM/);
    }
  });

  it("携带 provider/status/retryAfterMs/cause", () => {
    const cause = new Error("tcp reset");
    const err = new LLMRateLimitError("429", {
      provider: "glm",
      status: 429,
      retryAfterMs: 30_000,
      cause,
    });
    expect(err.provider).toBe("glm");
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(30_000);
    expect(err.cause).toBe(cause);
  });

  it("无 cause 时不设置 Error.cause", () => {
    const err = new LLMAuthError("401", { provider: "glm", status: 401 });
    expect(err.cause).toBeUndefined();
  });
});

describe("isInfraError（退避谓词：429 + 连接类 + 单请求级超时）", () => {
  it.each([
    ["rateLimit", true],
    ["connection", true],
    // 轮 13 #15：能到达本谓词的超时只来自单请求级 timeoutMs（挂起类瞬时基建
    // 故障，Python SDK APITimeoutError ⊂ APIConnectionError 同为 infra）；梯子
    // deadline 的到点强杀经 callWithBackoff 预检还原为裸 abort，不会以本类型到达
    ["timeout", true],
    ["auth", false],
    ["invalidRequest", false],
    ["server", false], // 5xx 不退避：重试无益，走 fallback-切换-否则-抛
    ["blocked", false],
    ["protocolViolation", false],
  ])("%s → %s", (label, expected) => {
    const err = mk().find(([l]) => l === label)![1];
    expect(isInfraError(err)).toBe(expected);
  });

  it("LLMError 基类、普通 Error、非对象一律 false", () => {
    expect(isInfraError(new LLMError("base", { provider: "p" }))).toBe(false);
    expect(isInfraError(new Error("plain"))).toBe(false);
    expect(isInfraError("rate limited")).toBe(false);
    expect(isInfraError(null)).toBe(false);
    expect(isInfraError(undefined)).toBe(false);
  });
});
