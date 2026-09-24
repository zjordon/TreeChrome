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
    const body = this.calls[index]?.init.body;
    if (typeof body !== "string") {
      // 越界/缺 body 时 JSON.parse(String(undefined)) 只会抛无线索的 SyntaxError——
      // 与队列耗尽的显式报错对称，携带 calls 数量辅助定位编排问题
      throw new Error(
        `MockFetch.bodyAt(${index})：无对应请求记录或请求未携带 body（实际 calls=${this.calls.length}，检查 queueMany 编排或重试次数预期）`,
      );
    }
    return JSON.parse(body) as Record<string, unknown>;
  }

  lastBody(): Record<string, unknown> {
    return this.bodyAt(this.calls.length - 1);
  }
}

/**
 * 「状态行已返回、body 读取挂起至 abort」的 fetch 桩（MockFetch 的真实 Response
 * 无法构造此形态）——覆盖 postJson 的 resp.text() 分类路径。reject(signal.reason)：
 * 复刻真实 fetch 形态（超时 reason 是 TimeoutError）。
 * opts：ok/status/headers 定形态；onBodyRead 在 text() 首次调用时打点（确定性同步
 * 「恰逢读体挂起」）；rejectDelayMs 把 abort reject 推迟 N 毫秒（构造 deadline
 * watcher 先行的竞态临界，走真实定时器）。
 */
export function makeHangingBodyFetch(
  opts: {
    ok?: boolean;
    status?: number;
    headers?: Record<string, string>;
    onBodyRead?: () => void;
    rejectDelayMs?: number;
  } = {},
): typeof fetch {
  const { ok = true, status = 200, headers = {}, onBodyRead, rejectDelayMs = 0 } = opts;
  return (async (_url: unknown, init?: { signal?: AbortSignal }) => {
    return {
      ok,
      status,
      headers: new Headers(headers),
      text: () => {
        onBodyRead?.();
        return new Promise<string>((_resolve, reject) => {
          const onAbort = () =>
            setTimeout(
              () => reject(init?.signal?.reason ?? new DOMException("Aborted", "AbortError")),
              rejectDelayMs,
            );
          if (init?.signal?.aborted) {
            onAbort();
            return;
          }
          init?.signal?.addEventListener("abort", onAbort, { once: true });
        });
      },
    } as unknown as Response;
  }) as typeof fetch;
}

interface FakeTimer {
  due: number;
  resolve: () => void;
  reject: (e: unknown) => void;
  off?: () => void;
}

/** 收敛参数：轮数上限与每轮微任务冲刷深度（具名便于调档；超限直接抛错 fail fast
 * 并携带 due/t 线索——见 advance 尾部，掩蔽成 vitest 5s 挂起只会降低可诊断性） */
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
        // 透传 abort reason（与 client.defaultSleep 同款：宿主自定义 reason 不变形）
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
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
