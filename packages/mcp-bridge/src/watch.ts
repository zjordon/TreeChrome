// watch_task 观察循环（issue #31 M1 P2，决策点 2 修订新增）：桥侧反复入队
// get_snapshot——入队即唤醒扩展长轮询（节奏亚秒级），终态即返回完整快照；stream
// 时逐事件经 MCP progress 通知外发。只读观察边界（qz waitForTask 同款）：超时/中断
// 只结束本地观察、绝不杀 run；观察器从不重发任务消息。

import type { BridgeRunSnapshot } from "@tw/protocol";
import { BridgeStateError } from "./state.js";

export const DEFAULT_WATCH_POLL_INTERVAL_MS = 1_000;

/** 观察超时：携带最后快照——任务仍在跑，调用方可稍后再 watch 或改轮询 */
export class WatchTimeoutError extends Error {
  readonly lastSnapshot: BridgeRunSnapshot;

  constructor(lastSnapshot: BridgeRunSnapshot) {
    super("Stopped watching after waitTimeoutSeconds. The browser task may still be running.");
    this.lastSnapshot = lastSnapshot;
  }
}

export interface WatchUpdate {
  snapshot: BridgeRunSnapshot;
  /** 增量事件的单行摘要（progress 通知的 message 载荷） */
  text: string;
}

export interface WatchOptions {
  /** 限定观察的 run；与当前快照 runId 不符 → TASK_CHANGED */
  runId?: string;
  /** 秒；null/缺省 = 无截止（挂到终态——调用方自担） */
  waitTimeoutSeconds?: number | null;
  signal: AbortSignal;
  /** budgetMs：本次快照请求的预算上限（截止剩余量）——扩展失联时不越截止挂满缺省超时 */
  getSnapshot(signal: AbortSignal, budgetMs?: number): Promise<BridgeRunSnapshot>;
  onUpdate?(update: WatchUpdate): void;
  pollIntervalMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?(): number;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const finish = (error?: unknown): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = (): void =>
      finish(new BridgeStateError("INTERRUPTED", "The watch was interrupted."));
    const timer = setTimeout(() => finish(), ms);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });

/**
 * 观察至终态。onUpdate 语义：首拍发全量时间线（无 run 时发状态行），此后只发
 * seq 增量——调用方拿到的 progress 流是「新发生了什么」而非全量重放。
 */
export async function watchTask(options: WatchOptions): Promise<BridgeRunSnapshot> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WATCH_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline =
    options.waitTimeoutSeconds == null ? null : now() + options.waitTimeoutSeconds * 1_000;
  let lastSeq = -1;
  let first = true;
  let lastSnapshot: BridgeRunSnapshot | undefined;

  for (;;) {
    const remainingMs = deadline === null ? Number.POSITIVE_INFINITY : deadline - now();
    let snapshot: BridgeRunSnapshot;
    try {
      // 快照请求受剩余预算约束：截止前必返回（扩展失联时挂到期即出，不吃满缺省 180s）
      snapshot = await options.getSnapshot(
        options.signal,
        Number.isFinite(remainingMs) ? Math.max(1, Math.ceil(remainingMs) + 1) : undefined,
      );
    } catch (error) {
      // 预算耗尽的快照超时转写为观察超时（携最后快照续接）；无历史快照则原样透传——
      // 「连一拍都拿不到」是桥路事实，不虚报观察超时
      if (
        lastSnapshot !== undefined &&
        deadline !== null &&
        deadline - now() <= 0 &&
        error instanceof BridgeStateError &&
        error.code === "BRIDGE_REQUEST_TIMEOUT"
      ) {
        throw new WatchTimeoutError(lastSnapshot);
      }
      throw error;
    }
    lastSnapshot = snapshot;
    if (
      options.runId !== undefined &&
      snapshot.runId !== null &&
      snapshot.runId !== options.runId
    ) {
      throw new BridgeStateError(
        "TASK_CHANGED",
        `Current run is ${snapshot.runId}, not ${options.runId}. Re-check with get_snapshot.`,
      );
    }
    if (options.onUpdate !== undefined) {
      const fresh = first ? snapshot.timeline : snapshot.timeline.filter((e) => e.seq > lastSeq);
      if (fresh.length > 0) {
        options.onUpdate({
          snapshot,
          text: fresh.map((e) => `[${e.type}] ${e.summary}`).join(" | "),
        });
      } else if (first) {
        options.onUpdate({ snapshot, text: `run ${snapshot.runId ?? "-"} ${snapshot.status}` });
      }
    }
    first = false;
    const tail = snapshot.timeline.at(-1);
    if (tail !== undefined) lastSeq = tail.seq;
    if (snapshot.isDone) return snapshot;
    const remaining = deadline === null ? Number.POSITIVE_INFINITY : deadline - now();
    if (remaining <= 0) throw new WatchTimeoutError(snapshot);
    await sleep(Math.min(pollIntervalMs, remaining), options.signal);
  }
}
