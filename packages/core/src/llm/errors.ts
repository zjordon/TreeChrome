// LLM 错误分类（分罪服务：退避谓词 isInfraError + P4 step 按类型分罪）。冻结契约见 docs/implement-plan/p2/01 §5。

export interface LLMErrorOptions {
  /** provider 卡片 name（日志/分罪用） */
  provider: string;
  /** HTTP 状态码（网络层错误无） */
  status?: number;
  /** 可解析的 Retry-After（毫秒，已封顶 RETRY_AFTER_CAP_SEC=60s） */
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

/** gemini promptFeedback.blockReason 全局拦截 /（保留）openai content_filter 全拦形态 */
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
 * 退避谓词：仅 429 与连接类（对齐 Python is_llm_infra_error——
 * auth/5xx 不退避，重试无益，维持 fallback-切换-否则-抛）。
 */
export function isInfraError(e: unknown): e is LLMRateLimitError | LLMConnectionError {
  return e instanceof LLMRateLimitError || e instanceof LLMConnectionError;
}
