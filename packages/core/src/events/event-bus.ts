// 同步事件总线：进程内轻量 pub/sub。移植自 TreeWalker observability/event_bus.py
// （@640d52a 全量）。单线程事件循环假设天然满足（Python 侧设计为 agent 循环同线程
// 同步调用）；日志经构造注入（缺省静默——库不写死宿主控制台，P2 LLMDeps.log 同惯例）。

import type { TwEvent } from "./events.js";

/** 一次 subscribe 调用的投递状态：失败计数/熔断按「订阅」键控而非按 handler 对象 */
interface Subscription {
  handler: (event: TwEvent) => void;
  name: string;
  failures: number;
  disabled: boolean;
}

function subscriptionName(handler: (event: TwEvent) => void): string {
  return handler.name || "anonymous";
}

export interface EventBusOptions {
  /** 观测日志通道（订阅熔断/close 汇总）；缺省静默 */
  log?: (message: string) => void;
}

export class EventBus {
  /** per-subscription 连续失败达到该次数后熔断该投递路径（死订阅者不再每事件刷错） */
  static readonly MAX_SUBSCRIPTION_FAILURES = 3;

  private readonly subscribers = new Map<string, Subscription[]>();
  private readonly closeCallbacks: Array<() => void> = [];
  private readonly log: (message: string) => void;

  constructor(options: EventBusOptions = {}) {
    this.log = options.log ?? (() => {});
  }

  /** 订阅；eventType 用 "*" 通配接收全部事件 */
  subscribe(eventType: string, handler: (event: TwEvent) => void): void {
    let subs = this.subscribers.get(eventType);
    if (!subs) {
      subs = [];
      this.subscribers.set(eventType, subs);
    }
    subs.push({ handler, name: subscriptionName(handler), failures: 0, disabled: false });
  }

  /**
   * 发布到全部匹配订阅者（具名事件一轮 + "*" 一轮）。per-subscription 隔离：
   * 订阅者异常不得穿透 emit——emit 调用点遍布 step 流程（含 finally 内），穿透即
   * 杀死整个 run；坏订阅者只记错，连续失败达上限熔断，close 时汇总显形。
   */
  emit(event: TwEvent): void {
    for (const sub of this.subscribers.get(event.eventType) ?? []) {
      this.call(sub, event);
    }
    for (const sub of this.subscribers.get("*") ?? []) {
      this.call(sub, event);
    }
  }

  private call(sub: Subscription, event: TwEvent): void {
    if (sub.disabled) return;
    try {
      sub.handler(event);
      sub.failures = 0; // 恢复则清零连续计数
    } catch (e) {
      sub.failures += 1;
      if (sub.failures >= EventBus.MAX_SUBSCRIPTION_FAILURES) {
        sub.disabled = true;
        this.log(
          `event subscriber ${sub.name} failed on ${event.eventType} ` +
            `(${sub.failures}/${EventBus.MAX_SUBSCRIPTION_FAILURES}) — DISABLED for the ` +
            "rest of this session (obs data from it is truncated from here)",
        );
      } else {
        this.log(
          `event subscriber ${sub.name} failed on ${event.eventType} ` +
            `(${sub.failures}/${EventBus.MAX_SUBSCRIPTION_FAILURES}): ${String(e)}`,
        );
      }
    }
  }

  /** 注册 close 时执行的回调（recorder flush 等） */
  onClose(callback: () => void): void {
    this.closeCallbacks.push(callback);
  }

  /**
   * 执行全部 close 回调并清空订阅。回调与 emit 同样逐个隔离——收尾 flush 失败不得
   * 穿出 run() finally 替换掉 return history；熔断/失败订阅在此汇总显形（按订阅
   * 计数、按名字去重；failing 排除已 disabled 的，避免双重报告）。
   */
  close(): void {
    for (const cb of this.closeCallbacks) {
      try {
        cb();
      } catch (e) {
        this.log(`event bus close callback ${subscriptionName(cb)} failed: ${String(e)}`);
      }
    }
    const allSubs = [...this.subscribers.values()].flat();
    const disabled = allSubs.filter((s) => s.disabled);
    const failing = allSubs.filter((s) => s.failures > 0 && !s.disabled);
    if (disabled.length > 0 || failing.length > 0) {
      const names = [...new Set(disabled.map((s) => s.name))].sort();
      this.log(
        `event bus close: ${disabled.length} subscription(s) disabled [${names.join(", ")}], ` +
          `${failing.length} subscription(s) with recent failures — session observation ` +
          "data may be truncated/incomplete",
      );
    }
    this.closeCallbacks.length = 0;
    this.subscribers.clear();
  }
}
