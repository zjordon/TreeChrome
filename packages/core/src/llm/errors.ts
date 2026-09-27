// LLM 错误分类（分罪服务：退避谓词 isInfraError + P4 step 按类型分罪）。冻结契约见 docs/implement-plan/p2/01 §5。

export interface LLMErrorOptions {
  /** provider 卡片 name（日志/分罪用） */
  provider: string;
  /** HTTP 状态码（网络层错误无） */
  status?: number;
  /** 可解析的 Retry-After（毫秒，已封顶：http.ts RETRY_AFTER_CAP_MS = 60_000） */
  retryAfterMs?: number;
  cause?: unknown;
}

/** LLM 客户端全部异常的基类；子类即错误类别（01 §5 矩阵） */
export class LLMError extends Error {
  readonly provider: string;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, opts: LLMErrorOptions) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "LLMError";
    this.provider = opts.provider;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** fetch 网络层失败（TypeError 等：DNS/断连/CORS） */
export class LLMConnectionError extends LLMError {
  constructor(message: string, opts: LLMErrorOptions) {
    super(message, opts);
    this.name = "LLMConnectionError";
  }
}

/** AbortController 超时/窗口 deadline 到点（类型恒定，不变形——03 偏离 5） */
export class LLMTimeoutError extends LLMError {
  constructor(message: string, opts: LLMErrorOptions) {
    super(message, opts);
    this.name = "LLMTimeoutError";
  }
}

/** 429 */
export class LLMRateLimitError extends LLMError {
  constructor(message: string, opts: LLMErrorOptions) {
    super(message, opts);
    this.name = "LLMRateLimitError";
  }
}

/** 401 / 403 */
export class LLMAuthError extends LLMError {
  constructor(message: string, opts: LLMErrorOptions) {
    super(message, opts);
    this.name = "LLMAuthError";
  }
}

/** 其余 4xx（含 gemini 400 schema 拒收） */
export class LLMInvalidRequestError extends LLMError {
  constructor(message: string, opts: LLMErrorOptions) {
    super(message, opts);
    this.name = "LLMInvalidRequestError";
  }
}

/** 5xx */
export class LLMServerError extends LLMError {
  constructor(message: string, opts: LLMErrorOptions) {
    super(message, opts);
    this.name = "LLMServerError";
  }
}

/** gemini promptFeedback.blockReason 全局拦截（openai content_filter 现映射为
 * stopReason="other" 不抛本类型，见 openai-completions.ts mapFinishReason） */
export class LLMBlockedError extends LLMError {
  constructor(message: string, opts: LLMErrorOptions) {
    super(message, opts);
    this.name = "LLMBlockedError";
  }
}

/** canonical 消息不变量被破坏 / 响应形状不可解析 */
export class LLMProtocolViolationError extends LLMError {
  constructor(message: string, opts: LLMErrorOptions) {
    super(message, opts);
    this.name = "LLMProtocolViolationError";
  }
}

/**
 * extract/structuredCall 的单次内层超时（Python _extract_call 的 asyncio.wait_for →
 * asyncio.TimeoutError 等价）。**非 LLMError 家族**——Python 侧 TimeoutError 不被
 * (RateLimitError, APIError) 捕获、不触发 fallback 切换，由 _action_extract 映射为
 * "Extract timed out"；TS 保持同款不进分罪/退避轴的语义。
 */
export class LLMCallTimeoutError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "LLMCallTimeoutError";
  }
}

/**
 * 退避谓词：429、连接类与单请求级超时（对齐 Python is_llm_infra_error——
 * auth/5xx 不退避，重试无益，维持 fallback-切换-否则-抛）。
 * LLMTimeoutError 纳入（轮 13 #15）：能到达本谓词的超时只来自单请求级
 * timeoutMs（无梯子 deadline 的 600s 兜底等，网关挂起类瞬时基建故障）——
 * Python SDK 侧 APITimeoutError ⊂ APIConnectionError 同为 infra；梯子
 * deadline 的到点强杀不会以本类型到达（callWithBackoff 的 signal 预检先
 * 还原为裸 abort 上抛，getAction 层才转 LLMTimeoutError）。
 * 注意（轮 40 #11 口径收口）：http.ts 会为 5xx（LLMServerError）挂载
 * retryAfterMs（轮 38 #8），但 5xx 不在本谓词内——该字段无退避消费方，
 * 仅为宿主侧重试决策的信息挂载；勿据「retryAfterMs 存在」扩员。
 */
export function isInfraError(
  e: unknown,
): e is LLMRateLimitError | LLMConnectionError | LLMTimeoutError {
  return (
    e instanceof LLMRateLimitError ||
    e instanceof LLMConnectionError ||
    e instanceof LLMTimeoutError
  );
}
