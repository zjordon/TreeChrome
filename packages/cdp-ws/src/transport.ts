/**
 * WebSocket CDP transport（cdp-use client.py 的 TS 对等物，docs/implement-plan/p3/01）。
 * 单连接 flat 协议：命令信封带 sessionId，响应按 id 归位，事件分发到监听器列表。
 * 有意偏离（错误结构化 / 监听器列表 / opt-in 超时 / 泵加固 / connect 工厂 /
 * onClosed 暴露）见 01 §6；未列出的行为差异算缺陷。
 */
import {
  CdpCommandError,
  CdpConnectionClosedError,
  CdpTimeoutError,
  describeError,
} from "./errors.js";
import { type CdpCloseEvent, type CdpWsOptions, isRecord, type SocketLike } from "./types.js";

export type CdpEventListener = (params: unknown, sessionId: string | undefined) => void;
export type CdpClosedListener = (event: CdpCloseEvent) => void;

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  method: string;
  timer?: ReturnType<typeof setTimeout>;
}

// 唯一的原生耦合点：Node ≥22 原生 WebSocket（undici）。lib 无 DOM 时其事件类型
// 不可引用，在此一次转型收敛到 SocketLike（01 §2 socketFactory 语义）。
const defaultSocketFactory = (url: string): SocketLike =>
  new WebSocket(url) as unknown as SocketLike;

const snippet = (s: string): string => (s.length > 200 ? `${s.slice(0, 200)}…` : s);

export class CdpWsClient {
  private readonly socket: SocketLike;
  private readonly timeoutMs: number | undefined;
  private readonly log: (message: string) => void;
  private readonly pending = new Map<number, PendingEntry>();
  private readonly eventListeners = new Map<string, Set<CdpEventListener>>();
  private readonly closedListeners = new Set<CdpClosedListener>();
  private nextId = 0;
  private closed = false;
  private stopped = false;

  private constructor(opts: CdpWsOptions) {
    this.timeoutMs = opts.timeoutMs;
    this.log = opts.logger ?? (() => {});
    this.socket = (opts.socketFactory ?? defaultSocketFactory)(opts.wsUrl);
    this.socket.addEventListener("message", (event) => {
      this.handleMessage(event);
    });
    this.socket.addEventListener("close", (event) => {
      this.handleClose(event);
    });
    this.socket.addEventListener("error", (event) => {
      const message = isRecord(event) && typeof event.message === "string" ? event.message : "";
      this.log(`[cdp-ws] WebSocket error：${message}`);
    });
  }

  /** 握手完成后才返回实例——不存在「未 start 就 send」的状态面（01 §6 偏离 5） */
  static async connect(opts: CdpWsOptions): Promise<CdpWsClient> {
    const client = new CdpWsClient(opts);
    await client.waitOpen();
    return client;
  }

  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string | null,
  ): Promise<T> {
    if (this.closed || this.stopped) {
      return Promise.reject(new CdpConnectionClosedError(`客户端已关闭，无法发送 ${method}`));
    }
    const id = ++this.nextId;
    // 信封对齐 cdp-use send_raw：params 归一 {}、sessionId 仅真值携带（null/undefined 不发）
    const envelope: Record<string, unknown> = { id, method, params: params ?? {} };
    if (sessionId) {
      envelope.sessionId = sessionId;
    }
    return new Promise<unknown>((resolve, reject) => {
      const entry: PendingEntry = { resolve, reject, method };
      if (this.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          // 身份比较防竞态：响应已清理则此定时器是残留，不动作
          if (this.pending.get(id) === entry) {
            this.pending.delete(id);
            reject(new CdpTimeoutError(`CDP 命令 ${method} 超时（${this.timeoutMs}ms）`));
          }
        }, this.timeoutMs);
      }
      this.pending.set(id, entry);
      try {
        this.socket.send(JSON.stringify(envelope));
      } catch (e) {
        this.pending.delete(id);
        if (entry.timer !== undefined) {
          clearTimeout(entry.timer);
        }
        reject(new CdpConnectionClosedError(`CDP 命令 ${method} 发送失败：${describeError(e)}`));
      }
    }) as Promise<T>;
  }

  /** 事件订阅（监听器列表 + disposer——cdp-use 单回调覆盖式的超集，01 §5.2） */
  on(method: string, listener: CdpEventListener): () => void {
    let set = this.eventListeners.get(method);
    if (set === undefined) {
      set = new Set();
      this.eventListeners.set(method, set);
    }
    set.add(listener);
    return () => {
      const current = this.eventListeners.get(method);
      if (current === undefined) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.eventListeners.delete(method);
      }
    };
  }

  /** 连接层关闭的感知面；重连决策归上层（01 §6 偏离 6） */
  onClosed(listener: CdpClosedListener): () => void {
    this.closedListeners.add(listener);
    return () => {
      this.closedListeners.delete(listener);
    };
  }

  /** 幂等：拒绝全部 pending → 关 socket（对齐 cdp-use stop 的 ws None 检查） */
  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.closed = true;
    this.failAllPending(new CdpConnectionClosedError("客户端正在停止"));
    try {
      this.socket.close();
    } catch {
      // 已断开的 socket 再 close 抛错属实现细节，吞掉（状态已置位）
    }
  }

  private waitOpen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      this.socket.addEventListener("open", () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      });
      this.socket.addEventListener("close", (event) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(
          new CdpConnectionClosedError(
            `连接失败（close code=${event.code}${event.reason === "" ? "" : ` ${event.reason}`}）：` +
              "Chrome 重启后旧 ws_url 失效是常态——用 discoverWebSocketUrl(host, port) 重新发现后重建客户端",
          ),
        );
      });
    });
  }

  private handleMessage(event: { data: unknown }): void {
    if (typeof event.data !== "string") {
      this.log("[cdp-ws] 非 text 帧（binary/异形 data），跳过");
      return;
    }
    const raw = event.data;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      // 泵加固（01 §3 语义 8）：cdp-use 单帧解析失败会杀泵并全量 reject——坏帧不该有炸弹半径
      this.log(`[cdp-ws] 帧解析失败（非 JSON），跳过：${snippet(raw)}`);
      return;
    }
    if (!isRecord(message)) {
      this.log(`[cdp-ws] 未预期消息形态（非对象帧），跳过：${snippet(raw)}`);
      return;
    }
    if (typeof message.id === "number") {
      const entry = this.pending.get(message.id);
      if (entry === undefined) {
        this.log(`[cdp-ws] 迟到/重复响应 id=${message.id}，跳过`);
        return;
      }
      this.pending.delete(message.id);
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
      }
      if ("error" in message) {
        const error = isRecord(message.error) ? message.error : {};
        const code = typeof error.code === "number" ? error.code : 0;
        const rawMessage =
          typeof error.message === "string" ? error.message : JSON.stringify(message.error);
        entry.reject(new CdpCommandError(entry.method, code, rawMessage));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      const listeners = this.eventListeners.get(message.method);
      if (listeners === undefined) {
        return;
      }
      const params = message.params ?? {};
      const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
      for (const listener of [...listeners]) {
        try {
          listener(params, sessionId);
        } catch (e) {
          // 监听器异常隔离（01 §3 语义 9，对齐 cdp-use registry 吞+log）
          this.log(`[cdp-ws] 事件 ${message.method} 监听器异常（隔离）：${describeError(e)}`);
        }
      }
      return;
    }
    this.log(`[cdp-ws] 未预期消息形态（既无 id 也无 method），跳过：${snippet(raw)}`);
  }

  private handleClose(event: CdpCloseEvent): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.failAllPending(new CdpConnectionClosedError("WebSocket 连接已关闭"));
    for (const listener of [...this.closedListeners]) {
      try {
        listener(event);
      } catch (e) {
        this.log(`[cdp-ws] onClosed 监听器异常（隔离）：${describeError(e)}`);
      }
    }
  }

  private failAllPending(error: CdpConnectionClosedError): void {
    for (const entry of this.pending.values()) {
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
      }
      entry.reject(error);
    }
    this.pending.clear();
  }
}
