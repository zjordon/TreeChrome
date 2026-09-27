/**
 * 共享类型与谓词：CdpWsOptions、transport 消费的最小 socket 面、isRecord。
 */

export interface CdpWsOptions {
  /** 直连的 ws_url（BrowserSession(ws_url=...) 形态；发现走 discoverWebSocketUrl） */
  wsUrl: string;
  /** 缺省 `new WebSocket(url)`（Node ≥22 原生 undici）；测试注入假件 */
  socketFactory?: (url: string) => SocketLike;
  /** per-call 超时，缺省 undefined = 无限——命令超时归消费方分层（01 §5.1） */
  timeoutMs?: number;
  /** 日志通道，缺省 no-op（对齐 LlmDeps.log 注入模式） */
  logger?: (message: string) => void;
}

/** 连接层关闭事件（结构化最小面；原生/undici CloseEvent 在工厂转型点收敛） */
export interface CdpCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

/**
 * transport 消费的最小 WebSocket 面。原生 WebSocket（undici/DOM）结构满足，
 * 但 lib 无 DOM 时其事件类型不可直接引用——故自定义，默认工厂处一次转型。
 */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: CdpCloseEvent) => void): void;
  addEventListener(type: "open" | "error", listener: (event: unknown) => void): void;
}

/** 宽松对象谓词（wire 消费子集哲学：容忍未知字段，只判形态） */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
