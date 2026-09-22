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

export interface PostJsonInit {
  /** 错误归因用（provider 卡片 name） */
  provider: string;
  /** 外部取消/窗口 deadline（client 组合后传入）；中止原样上抛由 client 分类 */
  signal?: AbortSignal;
  /** 单次 HTTP 超时；到点 AbortSignal.timeout 中止 → LLMTimeoutError */
  timeoutMs?: number;
}

/** AbortError 判别（DOMException/各宿主 fetch 的中止形态，按 name 鸭子判别） */
export function isAbortError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
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

/** 错误体 detail：三家协议都是 {error:{message}} 形态；解析失败用原文前 500 字符 */
function extractErrorMessage(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    const message = (parsed as { error?: { message?: unknown } })?.error?.message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  } catch {
    // 非 JSON 错误体：原文截断
  }
  return raw.slice(0, 500);
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
  if (status >= 500) {
    return new LLMServerError(message, { provider, status });
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
 */
export async function postJson(
  fetchFn: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  init: PostJsonInit,
): Promise<unknown> {
  const timeoutSignal =
    init.timeoutMs !== undefined ? AbortSignal.timeout(init.timeoutMs) : undefined;
  const signal =
    timeoutSignal !== undefined && init.signal !== undefined
      ? AbortSignal.any([init.signal, timeoutSignal])
      : (init.signal ?? timeoutSignal);

  let resp: Response;
  try {
    resp = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (isAbortError(e)) {
      if (timeoutSignal?.aborted) {
        throw new LLMTimeoutError(`请求超时（${init.timeoutMs}ms）：${url}`, {
          provider: init.provider,
          cause: e,
        });
      }
      throw e;
    }
    throw new LLMConnectionError(`网络层失败：${e instanceof Error ? e.message : String(e)}`, {
      provider: init.provider,
      cause: e,
    });
  }

  if (!resp.ok) {
    const raw = await resp.text().catch(() => "");
    throw statusToError(resp.status, raw, resp.headers.get("retry-after"), init.provider);
  }
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new LLMProtocolViolationError(`响应体不是合法 JSON：${text.slice(0, 200)}`, {
      provider: init.provider,
      status: resp.status,
    });
  }
}
