// browser 层测试假件：FakeCdpTransport（脚本化规则 + 事件发射）与 makeInternals
// （模块级测试的 SessionInternals 假上下文——假 sleep 记录毫秒序列、假时钟可控）。

import type { Logger } from "../../src/agent/action-shape.js";
import { CircuitBreaker } from "../../src/browser/circuit-breaker.js";
import { HighlightManager } from "../../src/browser/highlight.js";
import { NetworkIdleTracker } from "../../src/browser/network-idle.js";
import type {
  CdpEventListener,
  CdpTransport,
  SessionInternals,
} from "../../src/browser/transport.js";
import type { BrowserSessionSettings } from "../../src/browser/views.js";
import { DEFAULT_BROWSER_SESSION_SETTINGS } from "../../src/browser/views.js";

export interface SentFrame {
  method: string;
  params: Record<string, unknown> | undefined;
  sessionId?: string;
}

type Responder = (params: Record<string, unknown> | undefined) => unknown;

export class FakeCdpTransport implements CdpTransport {
  readonly sent: SentFrame[] = [];
  closed = false;
  private readonly rules = new Map<string, Responder>();
  private readonly onceRules: Array<{ method: string; respond: Responder }> = [];
  private readonly listeners = new Map<string, Set<CdpEventListener>>();

  /** 持久响应规则：值或函数（函数抛错即 reject） */
  respond(method: string, respond: unknown): this {
    this.rules.set(method, typeof respond === "function" ? (respond as Responder) : () => respond);
    return this;
  }

  /** 一次性规则（按入队顺序消费；耗尽后回落持久规则/默认） */
  respondOnce(method: string, respond: unknown): this {
    this.onceRules.push({
      method,
      respond: typeof respond === "function" ? (respond as Responder) : () => respond,
    });
    return this;
  }

  failOn(method: string, error: unknown): this {
    return this.respond(method, () => {
      throw error instanceof Error ? error : new Error(String(error));
    });
  }

  send<T>(method: string, params?: object, sessionId?: string): Promise<T> {
    this.sent.push({
      method,
      params: params as Record<string, unknown> | undefined,
      sessionId,
    });
    if (this.closed) return Promise.reject(new Error("transport closed"));
    const onceIdx = this.onceRules.findIndex((r) => r.method === method);
    if (onceIdx >= 0) {
      const rule = this.onceRules.splice(onceIdx, 1)[0];
      return this.settle<T>(method, rule.respond, params);
    }
    const rule = this.rules.get(method);
    if (rule) return this.settle<T>(method, rule, params);
    return Promise.reject(new Error(`FakeCdpTransport: 未脚本化 ${method}`));
  }

  private settle<T>(method: string, respond: Responder, params?: object): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      try {
        resolve(respond(params as Record<string, unknown> | undefined) as T);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(`${method} failed: ${String(e)}`));
      }
    });
  }

  on(method: string, listener: CdpEventListener): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(listener);
    return () => {
      this.listeners.get(method)?.delete(listener);
    };
  }

  emit(method: string, params: unknown, sessionId?: string): void {
    for (const listener of this.listeners.get(method) ?? []) {
      listener(params, sessionId);
    }
  }

  listenerCount(method: string): number {
    return this.listeners.get(method)?.size ?? 0;
  }

  stop(): void {
    this.closed = true;
  }

  /** 便捷断言：按 method 过滤已发帧 */
  framesOf(method: string): SentFrame[] {
    return this.sent.filter((f) => f.method === method);
  }
}

export function scriptConnect(transport: FakeCdpTransport, sessionId = "S1"): void {
  transport
    .respond("Target.getTargets", {
      targetInfos: [{ type: "page", targetId: "T1", url: "https://a/", title: "A" }],
    })
    .respond("Target.attachToTarget", { sessionId })
    .respond("Page.enable", {})
    .respond("DOM.enable", {})
    .respond("Overlay.enable", {})
    .respond("Network.enable", {})
    .respond("Target.setAutoAttach", {})
    .respond("Page.setInterceptFileChooserDialog", {});
}

export interface InternalsHandle {
  s: SessionInternals;
  transport: FakeCdpTransport;
  logs: string[];
  sleeps: number[];
  clock: { value: number };
  settings: BrowserSessionSettings;
}

export function makeInternals(
  settingsOverride: Partial<BrowserSessionSettings> = {},
): InternalsHandle {
  const transport = new FakeCdpTransport();
  const logs: string[] = [];
  const sleeps: number[] = [];
  const clock = { value: 0 };
  const settings: BrowserSessionSettings = {
    ...DEFAULT_BROWSER_SESSION_SETTINGS,
    ...settingsOverride,
    highlight: {
      ...DEFAULT_BROWSER_SESSION_SETTINGS.highlight,
      ...(settingsOverride.highlight ?? {}),
    },
  };
  const log: Logger = (message) => logs.push(message);
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    clock.value += ms / 1000;
  };
  const send = <T>(method: string, params?: object) =>
    transport.send<T>(method, params, s.currentSessionId ?? undefined);
  const networkIdle = new NetworkIdleTracker({
    timeout: settings.networkIdleTimeout,
    stabilityWindow: settings.networkIdleStabilityWindow,
    pollInterval: settings.networkIdlePollInterval,
    now: () => clock.value,
    sleep,
    log,
  });
  const highlight = new HighlightManager(settings.highlight, {
    executeJs: (code) =>
      send("Runtime.evaluate", { expression: code, returnByValue: true }).then(() => undefined),
    send: null,
    log,
  });
  const s: SessionInternals = {
    settings,
    log,
    get transport() {
      return transport;
    },
    currentTargetId: "T1",
    currentSessionId: "S1",
    send,
    networkIdle,
    domCircuitBreaker: new CircuitBreaker({
      failureThreshold: settings.circuitBreakerThreshold,
      recoveryTimeout: settings.circuitBreakerRecoveryS,
      now: () => clock.value,
      log,
    }),
    highlight,
    highlightSettings: settings.highlight,
    autoDialogEnabled: settings.autoHandleJsDialog,
    recentEventsEnabled: false,
    recentEvents: [],
    pendingDownloads: new Map(),
    completedDownloads: [],
    lastFileChooser: null,
    fileChooserInterceptEnabled: false,
    fileChooserListenerDispose: null,
    eventDisposers: [],
    gridNoGridUrls: new Set(),
    sleep,
    now: () => clock.value,
    clearSelectorMapCaches: () => {
      cleared.push("caches");
    },
  };
  const cleared: string[] = [];
  return { s, transport, logs, sleeps, clock, settings };
}
