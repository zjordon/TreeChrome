// Port 客户端（m5/05 §2）：chrome.runtime.connect 封装——断线指数退避重连、
// onMessage 分发、send。connect 工厂注入（entrypoints 传 browser.runtime.connect；
// 测试传 fake port）。SW 死亡时 Port 断开是常态（MV3 idle 被杀）——重连后 hello
// 恢复快照、pendingCards 补发（port-server 面）。

import type { SwToUiMessage, UiToSwMessage } from "@tw/protocol";

/** chrome.runtime.Port 的消费面（注入形态——本模块零 chrome） */
export interface UiPort {
  postMessage(message: UiToSwMessage): void;
  onMessage: { addListener(callback: (message: unknown) => void): void };
  onDisconnect: { addListener(callback: () => void): void };
}

export type PortStatus = "connecting" | "online" | "offline";

export interface PortClientDeps {
  connect: () => UiPort;
  onMessage: (message: SwToUiMessage) => void;
  onStatus?: (status: PortStatus) => void;
  /** 退避曲线（attempt 从 1 起）；缺省 1s·2^n 封顶 30s */
  backoffMs?: (attempt: number) => number;
  /** 定时器注入（测试 fake timers）；缺省 setTimeout */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export function defaultBackoff(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 30_000);
}

export class PortClient {
  private readonly deps: PortClientDeps;
  private readonly backoffMs: (attempt: number) => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private port: UiPort | null = null;
  private attempt = 0;
  private cancelTimer: (() => void) | null = null;
  private disposed = false;

  constructor(deps: PortClientDeps) {
    this.deps = deps;
    this.backoffMs = deps.backoffMs ?? defaultBackoff;
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      });
  }

  /** 初连/重连（幂等——已连接时 no-op；被 dispose 后 no-op） */
  connect(): void {
    if (this.disposed || this.port !== null) return;
    this.deps.onStatus?.("connecting");
    const port = this.deps.connect();
    this.port = port;
    this.attempt = 0;
    port.onMessage.addListener((message) => {
      this.deps.onMessage(message as SwToUiMessage);
    });
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return; // 旧端口的迟到断连（已被替换/清理）
      this.port = null;
      if (this.disposed) return;
      this.deps.onStatus?.("offline");
      this.scheduleReconnect();
    });
    this.deps.onStatus?.("online");
  }

  private scheduleReconnect(): void {
    this.attempt += 1;
    const wait = this.backoffMs(this.attempt);
    this.cancelTimer?.();
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null;
      this.connect();
    }, wait);
  }

  /** 发送（无连接 → false，调用方自定降频/提示） */
  send(message: UiToSwMessage): boolean {
    if (this.port === null) return false;
    try {
      this.port.postMessage(message);
      return true;
    } catch {
      return false; // 端口竞态刚断——onDisconnect 随后触发重连
    }
  }

  get online(): boolean {
    return this.port !== null;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.port = null;
  }
}
