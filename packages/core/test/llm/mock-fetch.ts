// 测试注入夹具：MockFetch（按序回放 + 调用记录）与 FakeClock（冻结时钟）。
// 设计见 docs/implement-plan/p2/04 §2；Response 用真实 Response 构造（status/headers/body
// 走真解析路径）。rawBody 形态用于构造非 JSON 纯文本错误体（截断断言）。

export type MockResponseSpec =
  | { status: number; headers?: Record<string, string>; body?: unknown }
  /** 非 JSON 原文响应体（如 text/plain 错误页）：不做 JSON.stringify */
  | { status: number; headers?: Record<string, string>; rawBody: string }
  | { networkError: Error }
  /** 永不 resolve，直到 signal 中止才 reject AbortError（测 deadline 强杀在飞请求） */
  | { hangUntilAbort: true };

function applySpec(spec: MockResponseSpec, signal?: AbortSignal | null): Promise<Response> {
  if ("networkError" in spec) {
    return Promise.reject(spec.networkError);
  }
  if ("hangUntilAbort" in spec) {
    return new Promise((_resolve, reject) => {
      // reject(signal.reason)：真实 fetch 按 signal 的 abort reason 拒绝——
      // AbortSignal.timeout 到点的 reason 是 name="TimeoutError" 的 DOMException
      //（非 AbortError），mock 必须复刻该形态，否则分型测试与真实运行时脱节
      const onAbort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  const headers = new Headers(spec.headers ?? { "content-type": "application/json" });
  let bodyText: string;
  if ("rawBody" in spec) {
    bodyText = spec.rawBody;
  } else {
    bodyText = spec.body === undefined ? "" : JSON.stringify(spec.body);
  }
  return Promise.resolve(
    new Response(bodyText, {
      status: spec.status,
      headers,
    }),
  );
}

export class MockFetch {
  readonly calls: Array<{ url: string; init: RequestInit }> = [];
  private readonly queue: MockResponseSpec[] = [];

  readonly fetch = (url: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const u = String(url);
    this.calls.push({ url: u, init: init ?? ({} as RequestInit) });
    const next = this.queue.shift();
    if (next === undefined) {
      // 队列耗尽即测试编排错误（不是被测行为）。AbortError 形态可穿透各层分类
      //（postJson 非超时中止原样上抛 → callWithBackoff 非 LLMError 直接抛 →
      // getAction 非窗口中止穿透）——立即失败且携带 URL；普通 Error 会被分类成
      // LLMConnectionError（infra 成员）被退避/fallback 吞掉，挂到 5s 超时才暴露
      console.error(`MockFetch: unexpected request ${u}（队列已耗尽，检查用例的 queueMany 编排）`);
      throw new DOMException(`MockFetch: unexpected request ${u}`, "AbortError");
    }
    return applySpec(next, init?.signal);
  };

  /** 顺序消费（耗尽后再有请求即失败） */
  queueMany(...specs: MockResponseSpec[]): this {
    this.queue.push(...specs);
    return this;
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

/** 收敛参数：轮数上限与每轮微任务冲刷深度（具名便于调档；超限 warn 而非静默跳过） */
const MAX_ROUNDS = 6;
const MICROTASK_FLUSH = 50;

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
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      for (let i = 0; i < MICROTASK_FLUSH; i += 1) {
        await Promise.resolve();
      }
      const due = this.timers.filter((tm) => tm.due <= this.t);
      if (due.length === 0) {
        return;
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
    if (this.timers.some((tm) => tm.due <= this.t)) {
      // fail fast：未收敛时到期 sleep 永不 resolve，等 vitest 超时只会把编排问题
      // 掩蔽成 5s 挂起——直接抛出并携带 due/t 线索
      const stuck = this.timers.filter((tm) => tm.due <= this.t).map((tm) => tm.due);
      throw new Error(
        `FakeClock.advance: ${MAX_ROUNDS} 轮内未收敛，仍有到期 sleep 未触发（due=[${stuck.join(", ")}], t=${this.t}；调大 MAX_ROUNDS/MICROTASK_FLUSH 或检查链路）`,
      );
    }
  }
}
