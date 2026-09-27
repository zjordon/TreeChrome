/**
 * CDP 错误家族：结构化替代 cdp-use 的 `RuntimeError(error_dict)`（01 §4——
 * cdp-use 把错误 dict 塞进 RuntimeError 第一参，消费方无法判别 code/message）。
 */

/** 错误→单行描述（日志与错误文案共用；避免 String(e) 产出 "[object Object]"） */
export const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** CDP 错误基类（name 恒为类名——错误断言锚点，对齐 P2 errors 惯例） */
export class CdpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpError";
  }
}

/** CDP 命令级错误：响应携带 error 信封（code/message）时拒绝 send 的形态 */
export class CdpCommandError extends CdpError {
  readonly code: number;
  readonly method: string;
  readonly rawMessage: string;

  constructor(method: string, code: number, rawMessage: string) {
    super(`CDP 命令 ${method} 失败：${rawMessage}（code=${code}）`);
    this.name = "CdpCommandError";
    this.code = code;
    this.method = method;
    this.rawMessage = rawMessage;
  }
}

/** 连接关闭杀掉的 pending 命令 / 已终态客户端的发送（01 §3 语义 6/7） */
export class CdpConnectionClosedError extends CdpError {
  constructor(message: string) {
    super(message);
    this.name = "CdpConnectionClosedError";
  }
}

/** per-call timeoutMs 到点（opt-in 超时，01 §5.1 分层决策） */
export class CdpTimeoutError extends CdpError {
  constructor(message: string) {
    super(message);
    this.name = "CdpTimeoutError";
  }
}
