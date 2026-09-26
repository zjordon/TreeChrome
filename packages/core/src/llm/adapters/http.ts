// 共享 HTTP 发送层：POST JSON + 状态→错误类 + Retry-After + 超时/取消合并（02 §1）。
// URL/headers/body 组装由各适配器完成，这里只做发送与错误分型。

import {
  LLMAuthError,
  LLMConnectionError,
  type LLMError,
  LLMInvalidRequestError,
  LLMProtocolViolationError,
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
} from "../errors.js";

/** Retry-After 单次上限（Python _RETRY_AFTER_CAP=60s；02 §1 只解析秒数标量并在此封顶） */
export const RETRY_AFTER_CAP_MS = 60_000;

/** timeoutMs/延时类值的合法上限（轮 39 #7 单源导出，client.ts 同族复用）：
 *  setTimeout/AbortSignal.timeout 的平台上限是 2^31-1ms——超限 delay 被 Node/HTML
 *  规范钳为 1ms 立即触发（TimeoutOverflowWarning），「超大超时预算」被偷换成
 *  「立即超时」，与 NaN/0/负值同族（每请求超时 + 误触 fallback 切换） */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** timeoutMs 非法值判定（轮 42 #25 单源导出）：http postJson 守卫与 client 的
 *  isValidDeadlineMs 派生同一谓词——两层平行实现任一演进（如增加下限）会静默
 *  分叉，恰好违背轮 39 #7 的「防两层口径漂移」目标 */
export function isInvalidTimeoutMs(v: number): boolean {
  return !Number.isFinite(v) || v <= 0 || v > MAX_TIMEOUT_MS;
}

/** timeoutMs 非法值告警文案（轮 42 #25 单源）：http onInvalidTimeout 与 client
 *  WARNING 共用——措辞演进两处同步 */
export function invalidTimeoutMessage(timeoutMs: number, provider: string): string {
  return `timeoutMs ${timeoutMs} 非法（NaN/0/负值/超 ${MAX_TIMEOUT_MS}ms 上限），视为未设置（${provider}）`;
}

export interface PostJsonInit {
  /** 错误归因用（provider 卡片 name） */
  provider: string;
  /** 外部取消/窗口 deadline（client 组合后传入）；中止原样上抛由 client 分类 */
  signal?: AbortSignal;
  /** 单次 HTTP 超时；到点 AbortSignal.timeout 中止 → LLMTimeoutError；NaN/0/负值/
   *  超上限（MAX_TIMEOUT_MS）视为未设置并经 onInvalidTimeout 留证据（轮 37 #7，轮 39 #7 扩） */
  timeoutMs?: number;
  /** timeoutMs 非法（NaN/0/负值/超上限）的一次性告警；去重由调用方注入（makeOnceWarn） */
  onInvalidTimeout?: (message: string) => void;
}

/**
 * AbortError 判别（DOMException/各宿主 fetch 的中止形态，按 name 鸭子判别）。
 * AbortSignal.timeout 到点时 fetch 以 abort reason（name="TimeoutError" 的
 * DOMException，DOM 规范行为）拒绝——需一并识别，否则超时被误分型为
 * LLMConnectionError（infra 可重试），与 timeoutMs 的到点强杀语义相反
 */
export function isAbortError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) {
    return false;
  }
  const name = (e as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * Retry-After 解析：仅秒数标量（Number 可解析且 >0），封顶 60s。
 * HTTP-date / 非数字 / 0 / 负值 → undefined（回落指数退避，Python 容错口径）。
 */
export function parseRetryAfterMs(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  return Math.min(n * 1000, RETRY_AFTER_CAP_MS);
}

/**
 * 错误体 detail：优先 {error:{message}}（三协议官方形态），宽松兼容第三方网关的
 * {error:"纯字符串"} 与顶层 {message}；都不可用则原文。**全部路径统一截断 500 字符**
 *（网关把整页 HTML 塞进 error.message 时异常消息不无上限膨胀）。
 */
export const ERROR_DETAIL_MAX = 500;

function extractErrorMessage(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const err = (parsed as { error?: unknown }).error;
      if (typeof err === "string" && err.length > 0) {
        return err.slice(0, ERROR_DETAIL_MAX);
      }
      if (typeof err === "object" && err !== null) {
        const message = (err as { message?: unknown }).message;
        if (typeof message === "string" && message.length > 0) {
          return message.slice(0, ERROR_DETAIL_MAX);
        }
      }
      const top = (parsed as { message?: unknown }).message;
      if (typeof top === "string" && top.length > 0) {
        return top.slice(0, ERROR_DETAIL_MAX);
      }
    }
  } catch {
    // 非 JSON 错误体：原文截断
  }
  return raw.slice(0, ERROR_DETAIL_MAX);
}

function statusToError(
  status: number,
  rawBody: string,
  retryAfter: string | null,
  provider: string,
): LLMError {
  const detail = extractErrorMessage(rawBody);
  const message = `HTTP ${status}${detail.length > 0 ? `: ${detail}` : ""}`;
  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(retryAfter);
    return new LLMRateLimitError(message, {
      provider,
      status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  if (status === 401 || status === 403) {
    return new LLMAuthError(message, { provider, status });
  }
  // 408 是网关/代理上游超时的常见形态：OpenAI/Anthropic Python SDK 均映射为
  // timeout（可重试）——归入 4xx 兜底会误判不可重试（无 fallback/已切换时直接
  // 上抛、不获退避）；LLMTimeoutError 是 infra 成员自然获得退避。注意（轮 25 #2）：
  // fallback 单向切换由 client.ts 对全部 LLMError（协议违例除外）触发，408 与 4xx
  // 在切换轴上无差异——本分型只影响可重试性。Retry-After 与 429 同款解析挂载
  //（轮 36 #9）：408 响应常携带该头，退避时长与服务端指示脱钩会无谓等待
  if (status === 408) {
    const retryAfterMs = parseRetryAfterMs(retryAfter);
    return new LLMTimeoutError(message, {
      provider,
      status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  if (status >= 500) {
    // 5xx 同款解析挂载（轮 38 #8；轮 40 #11 口径修正）：503 常携带 Retry-After
    //（OpenAI/Google 均有）。注意 5xx 不在 isInfraError 谓词内（client 不退避）——
    // retryAfterMs 仅为宿主侧重试决策的信息挂载，无退避消费方（errors.ts 注释同口径）
    const retryAfterMs = parseRetryAfterMs(retryAfter);
    return new LLMServerError(message, {
      provider,
      status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  return new LLMInvalidRequestError(message, { provider, status });
}

/**
 * POST JSON 并解析响应。失败路径：
 * - 网络层（TypeError 等）→ LLMConnectionError（cause 保留）；
 * - 自身 timeoutMs 到点 → LLMTimeoutError；外部 signal 中止 → AbortError 原样上抛
 *   （client 区分外部取消与窗口 deadline，取消必须穿透不被吞）；
 * - 非 2xx → 状态分型（429/401/403/4xx/5xx），error.message 进异常消息；
 * - 2xx 但非 JSON → LLMProtocolViolationError。
 * fetch 与响应体读取（resp.text）共用同一套 abort/网络错误分类——超时若发生在
 * body 读取阶段同样分型为 LLMTimeoutError，不会漏成裸 AbortError。
 */
export async function postJson(
  fetchFn: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  init: PostJsonInit,
): Promise<unknown> {
  // timeoutMs 非法值守卫（轮 37 #7 起，轮 39 #7 补上界）：NaN/0/负值（宿主
  // parseFloat 误配产物）或超 setTimeout 平台上限（钳 1ms 立即到点）——直连
  // provider.chat 的调用方每请求 LLMTimeoutError（infra 可重试 + 误触 fallback
  // 单向切换、空转 5 轮退避）；非法值视为未设置（上界与 client.ts isValidDeadlineMs
  // 单源共享 MAX_TIMEOUT_MS）
  const timeoutMs = init.timeoutMs;
  const invalidTimeout = timeoutMs !== undefined && isInvalidTimeoutMs(timeoutMs);
  if (invalidTimeout) {
    init.onInvalidTimeout?.(invalidTimeoutMessage(timeoutMs, init.provider));
  }
  const timeoutSignal =
    !invalidTimeout && timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined;
  const signal =
    timeoutSignal !== undefined && init.signal !== undefined
      ? AbortSignal.any([init.signal, timeoutSignal])
      : (init.signal ?? timeoutSignal);

  // 超时分型统一入口（classifyFailure 与错误体读取 catch 共用，防两处模板漂移）：
  // timeoutSignal 已到点即按超时分型——真实 fetch 被超时 signal 中止时以 reason
  //（name="TimeoutError"）拒绝，靠错误名判别不可靠
  const throwIfTimedOut = (e: unknown): void => {
    if (timeoutSignal?.aborted) {
      throw new LLMTimeoutError(`请求超时（${init.timeoutMs}ms）：${url}`, {
        provider: init.provider,
        cause: e,
      });
    }
  };

  // 状态优先：先超时分型；外部中止原样上抛由 client 分类；其余按网络层失败。
  // 外部 signal 状态判别先于 name 鸭子判别（轮 27 #8）：fetch 按 spec 以 abort
  // reason（可为任意形态——宿主 controller.abort("user-stop") 等自定义 reason
  // 我们明确支持透传，#186 不变形）拒绝，name 判别对非缺省形态失效会把确定性
  // 取消分型成 LLMConnectionError（infra 可重试 + 误触 fallback 切换；直连
  // provider.chat 的宿主无 callWithBackoff 预检兜底）
  const classifyFailure: (e: unknown) => never = (e) => {
    throwIfTimedOut(e);
    if (init.signal?.aborted || isAbortError(e)) {
      throw e;
    }
    throw new LLMConnectionError(`网络层失败：${e instanceof Error ? e.message : String(e)}`, {
      provider: init.provider,
      cause: e,
    });
  };

  let resp: Response;
  // 序列化提前到 try 外（轮 27 #2）：循环引用/BigInt 等宿主数据的确定性
  // TypeError 不落入 classifyFailure 被分型为 LLMConnectionError（infra 可重试
  // + 触发 fallback 单向切换，空转 5 轮退避）——原样穿透由 client 按「编程
  // 错误原样穿透」处理，不重试不切换
  const wireBody = JSON.stringify(body);
  try {
    resp = await fetchFn(url, {
      method: "POST",
      headers,
      body: wireBody,
      signal,
    });
  } catch (e) {
    classifyFailure(e);
  }

  if (!resp.ok) {
    let raw = "";
    try {
      raw = await resp.text();
    } catch (e) {
      // 错误体读取阶段的超时仍按超时分型（LLMTimeoutError/infra 可重试）——吞成
      // 空体会把超时误报为状态码错误（4xx 不可重试且会触发 fallback 切换）。
      // 外部取消与成功体路径（classifyFailure）同口径原样上抛，不被状态码错误
      // 吞掉（取消误报为 429 还会误触发 fallback 单向切换；signal 状态判别与
      // classifyFailure 轮 27 #9 同步：自定义 abort reason 同样是取消）；其余
      // 读体失败（连接中断等）保持状态码错误优先、空体兜底
      throwIfTimedOut(e);
      if (init.signal?.aborted || isAbortError(e)) {
        throw e;
      }
      // 读体失败（连接中断等非超时/非取消）留证据（轮 36 #4）：状态码错误优先、
      // 空体兜底的既有行为保留，但 detail 并入失败原因——排障可区分「端点返回
      // 空错误体」与「读体失败」
      raw = `（错误体读取失败：${e instanceof Error ? e.message : String(e)}）`;
    }
    throw statusToError(resp.status, raw, resp.headers.get("retry-after"), init.provider);
  }
  let text: string;
  try {
    text = await resp.text();
  } catch (e) {
    classifyFailure(e);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new LLMProtocolViolationError(`响应体不是合法 JSON：${text.slice(0, ERROR_DETAIL_MAX)}`, {
      provider: init.provider,
      status: resp.status,
    });
  }
}
