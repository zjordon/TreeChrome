/**
 * 测试假件：脚本化 FakeWebSocket（docs/implement-plan/p3/03 §1 注入面）。
 * 实现 SocketLike 消费面 + 服务端控制（响应规则 / 事件注入 / 坏帧 / 关闭）。
 * open 走 queueMicrotask 复刻原生异步事件语义——transport 构造后才挂监听器，
 * 同步 open 会丢事件。
 */
import { isRecord, type SocketLike } from "../src/types.js";

interface ResponseRule {
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
  once?: boolean;
}

type Listener = (event: unknown) => void;

export class FakeWebSocket {
  readonly sentFrames: string[] = [];
  /** 置 true 后 send() 同步抛（复刻原生对非 OPEN 状态 send 的 InvalidStateError） */
  throwOnSend = false;
  openOnConnect = true;
  failHandshake = false;
  private readonly listeners = new Map<string, Set<Listener>>();
  private rules: ResponseRule[] = [];

  constructor(readonly url: string) {
    queueMicrotask(() => {
      if (this.failHandshake) {
        this.dispatch("error", { message: "WebSocket opening handshake was rejected" });
        this.serverClose(1006, "rejected");
      } else if (this.openOnConnect) {
        this.dispatch("open", {});
      }
    });
  }

  // ── SocketLike 消费面（经 factory 一次转型交付） ─────────────────────
  send(data: string): void {
    if (this.throwOnSend) {
      throw new Error("InvalidStateError: WebSocket is already in CLOSING/CLOSED state");
    }
    this.sentFrames.push(data);
    const parsed: unknown = JSON.parse(data);
    const id = isRecord(parsed) && typeof parsed.id === "number" ? parsed.id : undefined;
    const method =
      isRecord(parsed) && typeof parsed.method === "string" ? parsed.method : undefined;
    for (let i = 0; i < this.rules.length; i++) {
      const rule = this.rules[i];
      if (rule === undefined || rule.method !== method) {
        continue;
      }
      if (rule.once) {
        this.rules.splice(i, 1);
      }
      const frame: Record<string, unknown> =
        rule.error === undefined ? { id, result: rule.result ?? {} } : { id, error: rule.error };
      this.dispatch("message", { data: JSON.stringify(frame) });
      return;
    }
  }

  close(): void {
    // 客户端主动关：transport 自身已置终态，这里不发事件
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  // ── 服务端控制 ─────────────────────────────────────────────────────
  /** 注册「收到 method 命令即回 result」规则（可叠加，先注册先匹配） */
  respond(method: string, result: unknown): void {
    this.rules.push({ method, result });
  }

  /** 注册「收到 method 命令即回 error」规则 */
  fail(method: string, code: number, message: string): void {
    this.rules.push({ method, error: { code, message } });
  }

  /** 注入事件帧 */
  emit(method: string, params?: unknown, sessionId?: string): void {
    const frame: Record<string, unknown> = { method, params: params ?? {} };
    if (sessionId !== undefined) {
      frame.sessionId = sessionId;
    }
    this.dispatch("message", { data: JSON.stringify(frame) });
  }

  /** 直接灌原始文本（坏帧测试） */
  emitRaw(text: string): void {
    this.dispatch("message", { data: text });
  }

  /** 灌非 text 帧（binary/异形 data 测试） */
  emitNonText(value: unknown): void {
    this.dispatch("message", { data: value });
  }

  serverClose(code = 1005, reason = ""): void {
    this.dispatch("close", { code, reason, wasClean: true });
  }

  private dispatch(type: string, event: unknown): void {
    const set = this.listeners.get(type);
    if (set === undefined) {
      return;
    }
    for (const listener of [...set]) {
      listener(event);
    }
  }
}

export interface FakeSocketHandle {
  socket: FakeWebSocket;
  factory: (url: string) => SocketLike;
}

/** 造一个假件 + 对应 factory（单 socket 复用；url 断言用 captureUrl 变体） */
export function createFakeSocket(): FakeSocketHandle {
  const socket = new FakeWebSocket("ws://fake.test/devtools/browser/uuid");
  return {
    socket,
    factory: () => socket as unknown as SocketLike,
  };
}

/** 造一个捕获 factory 收到的 url 的假件（wsUrl 透传断言） */
export function createCapturingSocket(): FakeSocketHandle & { capturedUrl: () => string } {
  const socket = new FakeWebSocket("ws://placeholder");
  let url = "";
  return {
    socket,
    factory: (u: string) => {
      url = u;
      return socket as unknown as SocketLike;
    },
    capturedUrl: () => url,
  };
}
