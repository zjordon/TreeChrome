// http.ts 共享发送层单测（评审轮 3 抽离：此前散在 anthropic/client 测试中顺带覆盖）。
// 直接对 postJson/parseRetryAfterMs/isAbortError 断言（不经适配器）；
// 适配器测试只保留 provider 集成路径的矩阵（状态→类型经适配器走通即可）。
import { describe, expect, it } from "vitest";
import { isAbortError, parseRetryAfterMs, postJson } from "../../src/llm/adapters/http.js";
import {
  LLMAuthError,
  LLMConnectionError,
  LLMInvalidRequestError,
  LLMProtocolViolationError,
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
} from "../../src/llm/errors.js";
import { MockFetch, makeHangingBodyFetch } from "./mock-fetch.js";

async function post(mock: MockFetch): Promise<unknown> {
  return postJson(
    mock.fetch,
    "https://unit.example/api",
    { "content-type": "application/json" },
    { ping: 1 },
    { provider: "unit" },
  );
}

describe("parseRetryAfterMs（Python 锚定容错集）", () => {
  it.each([
    ["5", 5000],
    ["1e2", 60_000], // 100 → 封顶
    ["120", 60_000],
  ] as const)("%s → %d", (raw, expected) => {
    expect(parseRetryAfterMs(raw)).toBe(expected);
  });
  it.each(["0", "-3", "abc", "", "Wed, 21 Oct 2015 07:28:00 GMT"])(
    "%s → undefined（回落指数；HTTP-date 为 Python 口径显式不支持，Number 解析为 NaN）",
    (raw) => {
      expect(parseRetryAfterMs(raw)).toBeUndefined();
    },
  );
  it("null（头缺失）→ undefined", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });
});

describe("isAbortError", () => {
  it("按 name 鸭子判别（DOMException 与各宿主形态）", () => {
    expect(isAbortError(new DOMException("Aborted", "AbortError"))).toBe(true);
    // AbortSignal.timeout 到点的 abort reason 是 name="TimeoutError" 的 DOMException
    //（DOM 规范行为）——真实 fetch 超时以此形态拒绝，必须一并识别
    expect(isAbortError(new DOMException("signal timed out", "TimeoutError"))).toBe(true);
    expect(isAbortError(new Error("x", { cause: new DOMException("a", "AbortError") }))).toBe(
      false,
    );
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
  });
});

describe("postJson 状态→错误类与错误体提取", () => {
  it.each([
    [429, LLMRateLimitError],
    [401, LLMAuthError],
    [403, LLMAuthError],
    [400, LLMInvalidRequestError],
    [408, LLMTimeoutError],
    [500, LLMServerError],
    [503, LLMServerError],
  ] as const)("HTTP %s → %s（error.message 提取 + status 归因）", async (status, klass) => {
    const mock = new MockFetch();
    mock.queueMany({ status, body: { error: { message: `boom ${status}` } } });
    const err = await post(mock).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(klass);
    expect((err as Error).message).toContain(`boom ${status}`);
    expect((err as { status?: number }).status).toBe(status);
    expect((err as { provider?: string }).provider).toBe("unit");
  });

  it("429 带 Retry-After 头 → retryAfterMs（秒数标量封顶 60s）", async () => {
    const mock = new MockFetch();
    mock.queueMany({
      status: 429,
      headers: { "retry-after": "7" },
      body: { error: { message: "slow" } },
    });
    const err = await post(mock).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMRateLimitError);
    expect((err as LLMRateLimitError).retryAfterMs).toBe(7000);
  });

  it.each([
    ["error 为纯字符串", { error: "gateway exploded" }, "gateway exploded"],
    ["顶层 message", { message: "upstream unavailable" }, "upstream unavailable"],
  ] as const)("第三方网关错误形态（%s）→ 提取进异常消息", async (_label, body, expected) => {
    const mock = new MockFetch();
    mock.queueMany({ status: 502, body });
    const err = await post(mock).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMServerError);
    expect((err as Error).message).toContain(expected);
  });

  it("非 JSON 长 error 页 → 原文截断到 500 字符（rawBody 形态）", async () => {
    const mock = new MockFetch();
    const long = "x".repeat(600);
    mock.queueMany({ status: 502, rawBody: long, headers: { "content-type": "text/plain" } });
    const err = await post(mock).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMServerError);
    expect((err as LLMServerError).message).toBe(`HTTP 502: ${long.slice(0, 500)}`);
    expect((err as LLMServerError).message.length).toBe("HTTP 502: ".length + 500);
  });

  it("空错误体（body 缺失）→ 消息只有状态码", async () => {
    const mock = new MockFetch();
    mock.queueMany({ status: 502, body: undefined, headers: { "content-type": "text/plain" } });
    const err = await post(mock).catch((e: unknown) => e);
    expect((err as LLMServerError).message).toBe("HTTP 502");
  });

  it("错误体读取阶段的外部中止 → AbortError 原样上抛（不被状态码错误吞掉误触 fallback）", async () => {
    // 状态行 429 已返回、body 读取以 AbortError 拒绝（外部取消恰逢读体）——
    // 修复前会照常抛 statusToError，把取消误报成真 429（可重试 + 触发单向切换）。
    // 复用 makeHangingBodyFetch + 已中止 signal：text() 首调即以 signal.reason
    //（= abortErr）reject，等价复刻内联桩（轮 15 #6 消除两处桩形态漂移）
    const abortErr = new DOMException("Aborted", "AbortError");
    const fetchFn = makeHangingBodyFetch({
      ok: false,
      status: 429,
      headers: { "retry-after": "5" },
    });
    const err = await postJson(
      fetchFn,
      "https://unit.example/api",
      { "content-type": "application/json" },
      { ping: 1 },
      { provider: "unit", signal: AbortSignal.abort(abortErr) },
    ).catch((e: unknown) => e);
    expect(err).toBe(abortErr);
  });
});

describe("postJson 成功与网络层", () => {
  it("2xx JSON → 原样返回解析结果", async () => {
    const mock = new MockFetch();
    mock.queueMany({ status: 200, body: { ok: true, n: 3 } });
    await expect(post(mock)).resolves.toEqual({ ok: true, n: 3 });
  });

  it("2xx 非 JSON → LLMProtocolViolationError（body 截断进消息）", async () => {
    const mock = new MockFetch();
    mock.queueMany({
      status: 200,
      rawBody: "<html>oops",
      headers: { "content-type": "text/html" },
    });
    const err = await post(mock).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMProtocolViolationError);
    expect((err as Error).message).toContain("<html>oops");
  });

  it("2xx 非 JSON 长响应体 → 消息截断在 ERROR_DETAIL_MAX=500（阈值统一，轮 22 #4；网关 200 回整页 HTML 时不无上限膨胀）", async () => {
    const mock = new MockFetch();
    mock.queueMany({
      status: 200,
      rawBody: `<html>${"x".repeat(600)}`,
      headers: { "content-type": "text/html" },
    });
    const err = await post(mock).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMProtocolViolationError);
    expect((err as Error).message.length).toBeLessThanOrEqual("响应体不是合法 JSON：".length + 500);
    expect((err as Error).message).toContain("<html>");
  });

  it("MockFetch hangUntilAbort 无 signal → 立即报错（fail-fast，防 5s 挂起，轮 13 #1）", async () => {
    const mock = new MockFetch();
    mock.queueMany({ hangUntilAbort: true });
    const err = await mock.fetch("https://unit.example/api").catch((e: unknown) => e);
    expect((err as Error).message).toContain("hangUntilAbort 需请求携带 AbortSignal");
  });

  it("网络层 TypeError → LLMConnectionError（cause 保留）", async () => {
    const mock = new MockFetch();
    const netErr = new TypeError("fetch failed");
    mock.queueMany({ networkError: netErr });
    const err = await post(mock).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMConnectionError);
    expect((err as LLMConnectionError).cause).toBe(netErr);
  });

  it("请求体按 JSON.stringify 发送，方法 POST", async () => {
    const mock = new MockFetch();
    mock.queueMany({ status: 200, body: {} });
    await post(mock);
    expect(mock.calls[0].init.method).toBe("POST");
    expect(mock.calls[0].init.body).toBe(JSON.stringify({ ping: 1 }));
  });

  it("真实超时形态回归：AbortSignal.timeout 到点 → LLMTimeoutError（reason 是 TimeoutError 非 AbortError，评审轮 4 修）", async () => {
    // hangUntilAbort 桩已改为 reject(signal.reason)——超时 signal 触发时以
    // name="TimeoutError" 的 DOMException 拒绝，复刻真实 fetch 形态；修复前
    // 此路径会被误分型为 LLMConnectionError（infra 可重试）
    const mock = new MockFetch();
    mock.queueMany({ hangUntilAbort: true });
    const err = await postJson(
      mock.fetch,
      "https://unit.example/api",
      {},
      {},
      { provider: "unit", timeoutMs: 40 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMTimeoutError);
    expect((err as LLMTimeoutError).cause).toBeInstanceOf(DOMException);
    expect((err as LLMTimeoutError).cause).toMatchObject({ name: "TimeoutError" });
  });

  it("外部 signal 为 AbortSignal.timeout 时到点 → 原样穿透，不误分型为 LLMTimeoutError（轮 24 #3）", async () => {
    // 姊妹用例：宿主 deadline 场景（外部 signal 而非自身 timeoutMs）。abort reason
    // 与自身超时同形（name="TimeoutError" 的 DOMException）——分型唯一依据是自身
    // timeoutSignal?.aborted 而非错误 name；若按 name 直觉重构，宿主取消会被吞成
    // LLMTimeoutError（infra 可重试 + 误触 fallback 单向切换）而现有用例不红
    const mock = new MockFetch();
    mock.queueMany({ hangUntilAbort: true });
    const signal = AbortSignal.timeout(40);
    const err = await postJson(
      mock.fetch,
      "https://unit.example/api",
      {},
      {},
      { provider: "unit", signal },
    ).catch((e: unknown) => e);
    expect(err).toBe(signal.reason);
    expect(err).not.toBeInstanceOf(LLMTimeoutError);
  });

  it("外部 signal 以自定义 reason（字符串）中止 → 原样穿透，不落入 ConnectionError 可重试分型（轮 27 #8）", async () => {
    // fetch 按 spec 以 abort reason（任意形态）拒绝——宿主 controller.abort("user-stop")
    // 类自定义 reason 我们明确支持透传（#186 不变形），name 鸭子判别对它失效；
    // 直连 provider.chat 的宿主无 callWithBackoff 预检兜底，取消会被当瞬时网络故障退避
    const mock = new MockFetch();
    mock.queueMany({ hangUntilAbort: true });
    const err = await postJson(
      mock.fetch,
      "https://unit.example/api",
      {},
      {},
      { provider: "unit", signal: AbortSignal.abort("user-stop") },
    ).catch((e: unknown) => e);
    expect(err).toBe("user-stop");
  });

  it("宿主病态 body（循环引用）→ 序列化 TypeError 原样穿透，不出站不重试（轮 27 #2）", async () => {
    // 序列化在 fetch try 外：确定性编程错误不落入 classifyFailure 被分型为
    // LLMConnectionError（infra 可重试 + 触发 fallback 单向切换，空转 5 轮退避）
    const mock = new MockFetch();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const err = await postJson(mock.fetch, "https://unit.example/api", {}, circular, {
      provider: "unit",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(LLMConnectionError);
    expect(mock.calls.length).toBe(0); // 序列化失败无网络出站
  });

  it("错误体读取期间外部 signal 以自定义 reason 中止 → 原样穿透，不伪造 429（轮 27 #9）", async () => {
    const fetchFn = makeHangingBodyFetch({
      ok: false,
      status: 429,
      headers: { "retry-after": "5" },
    });
    const err = await postJson(
      fetchFn,
      "https://unit.example/api",
      { "content-type": "application/json" },
      { ping: 1 },
      { provider: "unit", signal: AbortSignal.abort("user-stop") },
    ).catch((e: unknown) => e);
    expect(err).toBe("user-stop");
    expect(err).not.toBeInstanceOf(LLMRateLimitError);
  });
});
