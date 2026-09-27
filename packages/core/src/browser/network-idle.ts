// Network 域 inflight 请求追踪（可选 networkidle 等待）。全量移植自
// TreeWalker browser/network_idle.py @640d52a。长连接（WebSocket/EventSource）
// 永不 loadingFinished——按 responseReceived.type 从 idle 判定剔除。
// 订阅走 transport.on（多播）：register 先解订再注册，维持单例纪律（p4/01 §3.4）；
// TS 单线程无锁（Python 的 threading.Lock 为 ws 读线程模型准备的，此处无对应物）。

import type { Logger } from "../agent/action-shape.js";
import type { CdpTransport } from "./transport.js";

/** 长连接 ResourceType（CDP 枚举，取自 responseReceived.type——必填字段） */
const LONG_CONNECTION_TYPES: ReadonlySet<string> = new Set(["WebSocket", "EventSource"]);

export interface NetworkIdleOptions {
  timeout?: number;
  stabilityWindow?: number;
  pollInterval?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export class NetworkIdleTracker {
  readonly timeout: number;
  readonly stabilityWindow: number;
  readonly pollInterval: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: Logger;
  private readonly inflight = new Set<string>();
  private readonly longConnIds = new Set<string>();
  private lastActivity: number;
  private enabled = false;
  private disposers: Array<() => void> = [];

  constructor(options: NetworkIdleOptions = {}) {
    this.timeout = options.timeout ?? 5.0;
    this.stabilityWindow = options.stabilityWindow ?? 0.5;
    this.pollInterval = options.pollInterval ?? 0.1;
    this.now = options.now ?? (() => performance.now() / 1000);
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = options.log ?? (() => {});
    this.lastActivity = this.now();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** 订阅 4 个 Network 事件（幂等：先解订旧订阅再注册）；失败降级 disabled */
  register(transport: CdpTransport): void {
    try {
      this.unsubscribe();
      this.disposers = [
        transport.on("Network.requestWillBeSent", (event) => this.onRequestWillBeSent(event)),
        transport.on("Network.responseReceived", (event) => this.onResponseReceived(event)),
        transport.on("Network.loadingFinished", (event) => this.retire(field(event, "requestId"))),
        transport.on("Network.loadingFailed", (event) => this.retire(field(event, "requestId"))),
      ];
      this.enabled = true;
    } catch (e) {
      this.log(`NetworkIdleTracker register failed (degrading to off): ${String(e)}`);
      this.enabled = false;
    }
  }

  unsubscribe(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
  }

  /** 清状态（reconnect/_connect 时；inflight 是 per-session 的） */
  reset(): void {
    this.inflight.clear();
    this.longConnIds.clear();
    this.lastActivity = this.now();
  }

  private onRequestWillBeSent(event: unknown): void {
    const rid = field(event, "requestId");
    if (!rid) return;
    // add 幂等：重定向复用 requestId 不双计
    this.inflight.add(rid);
    this.lastActivity = this.now();
  }

  private onResponseReceived(event: unknown): void {
    const rid = field(event, "requestId");
    if (!rid) return;
    // type 在 requestWillBeSent 是 NotRequired——分类必须等 responseReceived
    const rtype = field(event, "type");
    if (typeof rtype === "string" && LONG_CONNECTION_TYPES.has(rtype)) {
      this.longConnIds.add(rid);
    }
    this.lastActivity = this.now();
  }

  /** discard 幂等：失败也退役（释放 pending） */
  private retire(rid: string | undefined): void {
    if (!rid) return;
    this.inflight.delete(rid);
    this.longConnIds.delete(rid);
    this.lastActivity = this.now();
  }

  /** inflight 减长连接为空，且 stability_window 内无活动（严格判 idle） */
  isIdle(): boolean {
    return this.idleLocked(this.stabilityWindow);
  }

  private idleLocked(sw: number): boolean {
    if (!this.enabled) return true; // 降级 = 即时 idle
    for (const rid of this.inflight) {
      if (!this.longConnIds.has(rid)) return false;
    }
    return this.now() - this.lastActivity >= sw;
  }

  /** 轮询 isIdle 直到真或超时；返回是否达到 idle（超时降级——调用方照常放行） */
  async waitUntilIdle(overrides?: {
    timeout?: number;
    stabilityWindow?: number;
    pollInterval?: number;
  }): Promise<boolean> {
    if (!this.enabled) return true;
    const timeout = overrides?.timeout ?? this.timeout;
    const sw = overrides?.stabilityWindow ?? this.stabilityWindow;
    const poll = overrides?.pollInterval ?? this.pollInterval;
    const deadline = this.now() + timeout;
    while (this.now() < deadline) {
      if (this.idleLocked(sw)) return true; // 乐观早退（多数页面本就安静）
      await this.sleep(poll * 1000);
    }
    return this.idleLocked(sw);
  }
}

function field(event: unknown, key: string): string | undefined {
  if (!isRecord(event)) return undefined;
  const v = event[key];
  return typeof v === "string" && v ? v : undefined;
}
