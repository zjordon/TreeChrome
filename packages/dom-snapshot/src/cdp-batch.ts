/**
 * CDP 并行批调用的两阶段超时 + 选择性重试 —— dom-snapshot cdp_timeout.py 的 TS 移植。
 *
 *   Phase 1: 全部源并发，统一首批截止时间（first_timeout）
 *   Phase 2: 仅对超时/失败的源用新协程重试，重试截止 retry_timeout
 *
 * 与 Python 的差异：JS 无法取消 Promise，超时源的底层调用允许在后台完成，
 * 结果被丢弃——本库的 CDP 调用均为只读观察，无副作用差异。
 * 永不抛异常：调用方检查 CdpBatchResult 的逐源状态后自行降级。
 */

/** 单个 CDP 源的批次结局（对齐 Python CDPSourceStatus） */
export enum CdpSourceStatus {
  Ok = "ok",
  Timeout = "timeout",
  Failed = "failed",
  RetriedOk = "retried_ok",
}

/** 一个 CDP 源在两阶段超时+重试后的结果（对齐 Python CDPSourceResult） */
export class CdpSourceResult {
  constructor(
    public name: string,
    public status: CdpSourceStatus,
    public value: unknown = null,
    public error: string | null = null,
    public firstAttemptMs = 0,
    public retryAttemptMs = 0,
  ) {}
}

/** 一批 CDP 源的汇总结果（对齐 Python CDPBatchResult） */
export class CdpBatchResult {
  readonly sources = new Map<string, CdpSourceResult>();
  totalMs = 0;

  get failedNames(): string[] {
    const names: string[] = [];
    for (const [name, r] of this.sources) {
      if (r.status === CdpSourceStatus.Timeout || r.status === CdpSourceStatus.Failed) {
        names.push(name);
      }
    }
    return names;
  }

  /** 取成功（含重试成功）源的值，否则 default（对齐 Python CDPBatchResult.get） */
  get(name: string, defaultValue: unknown = null): unknown {
    const r = this.sources.get(name);
    if (r && (r.status === CdpSourceStatus.Ok || r.status === CdpSourceStatus.RetriedOk)) {
      return r.value;
    }
    return defaultValue;
  }
}

/** 单次调用工厂并施加截止时间；绝不 reject（对齐 Python _extract_result 的容错） */
async function attempt(
  factory: () => Promise<unknown>,
  deadlineMs: number,
): Promise<{ status: CdpSourceStatus; value: unknown; error: string | null }> {
  // 同步抛错的工厂也归一为 failed（比 Python 更严：create_task 会同步炸出）
  let underlying: Promise<unknown>;
  try {
    underlying = factory();
  } catch (e) {
    return {
      status: CdpSourceStatus.Failed,
      value: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  // 落败在后的底层 Promise 显式吞掉异常，避免超时丢弃后触发 unhandledRejection
  underlying.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), deadlineMs);
  });
  try {
    const value = await Promise.race([underlying, deadline]);
    return { status: CdpSourceStatus.Ok, value, error: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // 超时判定看截止计时器是否触发：工厂自身抛错同路径进来是 failed
    const timedOut = message === "timed out";
    return {
      status: timedOut ? CdpSourceStatus.Timeout : CdpSourceStatus.Failed,
      value: null,
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 按名字并发调用 CDP 工厂，带两阶段超时与选择性重试（对齐 Python run_cdp_batch）。
 *
 * @param factories 源名 → 每次调用创建新 Promise 的工厂（首批与重试共用）
 * @param firstTimeout 首批统一截止时间（秒）
 * @param retryTimeout 重试截止时间（秒）
 */
export async function runCdpBatch(
  factories: ReadonlyMap<string, () => Promise<unknown>>,
  opts: { firstTimeout: number; retryTimeout: number },
): Promise<CdpBatchResult> {
  const batchStart = Date.now();
  const batch = new CdpBatchResult();
  const firstMs = opts.firstTimeout * 1000;
  const retryMs = opts.retryTimeout * 1000;

  // Phase 1：全部源并发，统一截止；完成即记录，未完成记 timeout
  const pendingNames = new Set<string>();
  await Promise.all(
    [...factories].map(async ([name, factory]) => {
      const r = await attempt(factory, firstMs);
      batch.sources.set(
        name,
        new CdpSourceResult(name, r.status, r.value, r.error, Date.now() - batchStart),
      );
      if (r.status !== CdpSourceStatus.Ok) pendingNames.add(name);
    }),
  );

  if (pendingNames.size === 0) {
    batch.totalMs = Date.now() - batchStart;
    return batch;
  }

  // Phase 2：仅失败/超时源用新工厂重试；成功则升级为 retried_ok
  await Promise.all(
    [...pendingNames].map(async (name) => {
      const factory = factories.get(name);
      if (!factory) return;
      const prev = batch.sources.get(name);
      const r = await attempt(factory, retryMs);
      const retryAttemptMs = Date.now() - batchStart - (prev?.firstAttemptMs ?? 0);
      batch.sources.set(
        name,
        new CdpSourceResult(
          name,
          r.status === CdpSourceStatus.Ok ? CdpSourceStatus.RetriedOk : r.status,
          r.value,
          r.error,
          prev?.firstAttemptMs ?? firstMs,
          retryAttemptMs,
        ),
      );
    }),
  );

  batch.totalMs = Date.now() - batchStart;
  return batch;
}

/** 给单次调用施加截止时间（Python asyncio.wait_for 的近似；超时后底层调用继续但不被等待） */
export async function withTimeoutMs<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
  });
  promise.catch(() => {}); // 超时丢弃后不产生 unhandledRejection
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
