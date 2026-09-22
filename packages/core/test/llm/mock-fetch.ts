// 测试注入夹具：MockFetch（按序/按模式回放 + 调用记录）与 FakeClock（冻结时钟）。
// 设计见 docs/implement-plan/p2/04 §2；Response 用真实 Response 构造（status/headers/body 走真解析路径）。

export type MockResponseSpec =
  | { status: number; headers?: Record<string, string>; body?: unknown }
  | { networkError: Error }
  /** 永不 resolve，直到 signal 中止才 reject AbortError（测 deadline 强杀在飞请求） */
  | { hangUntilAbort: true };

function applySpec(spec: MockResponseSpec, signal?: AbortSignal | null): Promise<Response> {
  if ("networkError" in spec) {
    return Promise.reject(spec.networkError);
  }
  if ("hangUntilAbort" in spec) {
    return new Promise((_resolve, reject) => {
      const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  const headers = new Headers(spec.headers ?? { "content-type": "application/json" });
  return Promise.resolve(
    new Response(spec.body === undefined ? "" : JSON.stringify(spec.body), {
      status: spec.status,
      headers,
    }),
  );
}

export class MockFetch {
  readonly calls: Array<{ url: string; init: RequestInit }> = [];
  private readonly queue: MockResponseSpec[] = [];
  private readonly expects: Array<{ pattern: RegExp; spec: MockResponseSpec }> = [];

  readonly fetch = (url: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const u = String(url);
    this.calls.push({ url: u, init: init ?? ({} as RequestInit) });
    const next = this.queue.shift();
    const spec = next !== undefined ? next : this.expectFor(u);
    return applySpec(spec, init?.signal);
  };

  /** 顺序消费（耗尽后再有请求即失败） */
  queueMany(...specs: MockResponseSpec[]): this {
    this.queue.push(...specs);
    return this;
  }

  /** 模式匹配兜底（队列空时使用） */
  expect(pattern: RegExp, spec: MockResponseSpec): this {
    this.expects.push({ pattern, spec });
    return this;
  }

  private expectFor(url: string): MockResponseSpec {
    const match = this.expects.find((e) => e.pattern.test(url));
    if (match === undefined) {
      throw new Error(`MockFetch: unexpected request ${url}`);
    }
    return match.spec;
  }

  bodyAt(index: number): Record<string, unknown> {
    return JSON.parse(String(this.calls[index].init.body)) as Record<string, unknown>;
  }

  lastBody(): Record<string, unknown> {
    return this.bodyAt(this.calls.length - 1);
  }
}

interface FakeTimer {
  due: number;
  resolve: () => void;
  reject: (e: unknown) => void;
  off?: () => void;
}

/** 假时钟：now() 手动推进；sleep 登记为可推进定时器，signal 中止立即 reject */
export class FakeClock {
  private t = 1000; // 非零起点，防「0 即缺省」类误判
  private timers: FakeTimer[] = [];

  readonly now = (): number => this.t;

  readonly sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer: FakeTimer = {
        due: this.t + ms,
        resolve,
        reject,
      };
      const onAbort = () => {
        const i = this.timers.indexOf(timer);
        if (i >= 0) {
          this.timers.splice(i, 1);
        }
        timer.off?.();
        reject(new DOMException("Aborted", "AbortError"));
      };
      timer.off = () => signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.timers.push(timer);
    });

  /**
   * 推进时钟：先冲刷微任务链（fetch→错误分类→sleep 注册…一轮可能串多次 fetch，
   * 如 fallback 切换），再触发到期 sleep；循环到无新到期定时器为止（收敛）。
   * 这保证 sleep 的 due 总以「本轮推进后的 t」注册，退避/预算断言的绝对时间可预期。
   */
  async advance(ms: number): Promise<void> {
    this.t += ms;
    for (let round = 0; round < 6; round += 1) {
      for (let i = 0; i < 50; i += 1) {
        await Promise.resolve();
      }
      const due = this.timers.filter((tm) => tm.due <= this.t);
      if (due.length === 0) {
        break;
      }
      for (const tm of due) {
        const i = this.timers.indexOf(tm);
        if (i >= 0) {
          this.timers.splice(i, 1);
        }
        tm.off?.();
        tm.resolve();
      }
    }
  }
}
