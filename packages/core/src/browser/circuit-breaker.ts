// DOM 管线 CDP 调用熔断器：closed → open → half_open 三态。全量移植自
// TreeWalker browser/circuit_breaker.py @640d52a；时钟注入（测试冻结用）。

import type { Logger } from "../agent/action-shape.js";

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  recoveryTimeout?: number;
  now?: () => number;
  log?: Logger;
}

export class CircuitBreaker {
  readonly failureThreshold: number;
  readonly recoveryTimeout: number;
  private readonly now: () => number;
  private readonly log: Logger;
  private consecutiveFailures = 0;
  private lastFailureTime = 0.0;
  private state: "closed" | "open" | "half_open" = "closed";

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.recoveryTimeout = options.recoveryTimeout ?? 30.0;
    this.now = options.now ?? (() => performance.now() / 1000);
    this.log = options.log ?? (() => {});
  }

  /** 是否应拒绝调用；open 且恢复期已过自动转 half_open（放一次探测） */
  get isOpen(): boolean {
    if (this.state === "closed") return false;
    if (this.state === "open") {
      if (this.now() - this.lastFailureTime >= this.recoveryTimeout) {
        this.state = "half_open";
        this.log("Circuit breaker transitioning to half_open");
        return false;
      }
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    if (this.state !== "closed") {
      this.log("Circuit breaker resetting to closed after success");
    }
    this.consecutiveFailures = 0;
    this.state = "closed";
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    this.lastFailureTime = this.now();
    if (this.state === "half_open") {
      this.log("Circuit breaker probe failed, reopening");
      this.state = "open";
      return;
    }
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      this.log(`Circuit breaker opened after ${this.consecutiveFailures} consecutive failures`);
    }
  }

  /** 强制复位（reconnect 时） */
  reset(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
    this.log("Circuit breaker reset to closed");
  }
}
