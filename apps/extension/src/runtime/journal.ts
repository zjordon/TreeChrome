// run journal（m5/04 §4.1，webbrain RunUiJournal 语义重写——字段收敛到本仓）：
// 事件环 256 + seq 编号 + ack 释放 + 真实淘汰记账（discardedBeforeSeq）+ 落盘
// 200ms debounce（关键事件立即 flush）+ 512KB/128KB 落盘预算（webbrain 数值沿用）。
// 压缩投影（对齐 webbrain compactRunUiData 取舍）：tool_result.error ≤1000、
// session_end.summary ≤2000、model_result 不带 thinking。零 chrome 依赖（persist
// 与定时器注入——单测 fake）。

import type { TwEvent } from "@tw/core";
import type { JournalEvent, RunJournalSnapshot, RunStatus } from "@tw/protocol";

export const JOURNAL_EVENT_LIMIT = 256;
export const JOURNAL_PERSIST_BUDGET = 512 * 1024;
export const JOURNAL_PERSIST_RETRY_BUDGET = 128 * 1024;
export const JOURNAL_PERSIST_DELAY_MS = 200;
/** 单事件消息体护栏（Port 消息无硬限但防御性截断——model_result 长文本） */
export const JOURNAL_EVENT_JSON_LIMIT = 1024 * 1024;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

function _isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** TwEvent → journal 压缩投影（字段级截断；未知 type 原样浅拷贝） */
export function compactEventData(event: TwEvent): Record<string, unknown> {
  const base: Record<string, unknown> = { step: event.step };
  switch (event.eventType) {
    case "tool_result":
      return {
        ...base,
        success: event.success,
        ...(event.error !== undefined && event.error !== null
          ? { error: clip(event.error, 1000) }
          : {}),
        ...(event.durationSeconds !== undefined ? { durationSeconds: event.durationSeconds } : {}),
      };
    case "model_result":
      return {
        ...base,
        actionName: event.actionName,
        ...(event.nextGoal !== undefined && event.nextGoal !== null
          ? { nextGoal: clip(event.nextGoal, 2000) }
          : {}),
        ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
        ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
      };
    case "model_call":
      return { ...base, messageCount: event.messageCount };
    case "tool_call":
      return { ...base, actionName: event.actionName, elementIndex: event.elementIndex };
    case "session_end":
      return { ...base, totalSteps: event.totalSteps, summary: clip(event.summary, 2000) };
    case "step_end":
      return { ...base, durationSeconds: event.durationSeconds };
    case "anomaly":
      return {
        ...base,
        rule: event.rule,
        severity: event.severity,
        description: clip(event.description, 1000),
      };
    case "skill_active":
      return {
        ...base,
        ...(event.host !== undefined ? { host: event.host } : {}),
        ...(event.skillLoaded !== undefined ? { skillLoaded: event.skillLoaded } : {}),
        ...(event.taskSlug !== undefined ? { taskSlug: event.taskSlug } : {}),
      };
    default:
      return { ...base, ...({ ...event } as Record<string, unknown>) };
  }
}

export interface JournalPersistScheduler {
  defer(runKey: string, snapshot: RunJournalSnapshot): void;
  persistNow(runKey: string, snapshot: RunJournalSnapshot): void;
}

/** 200ms debounce 调度器（webbrain RunUiPersistenceScheduler 模式；定时器注入） */
export class DebounceScheduler implements JournalPersistScheduler {
  private readonly delayMs: number;
  private readonly persist: (runKey: string, snapshot: RunJournalSnapshot) => Promise<void>;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (t: ReturnType<typeof setTimeout>) => void;
  private readonly pending = new Map<
    string,
    { snapshot: RunJournalSnapshot; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    persist: (runKey: string, snapshot: RunJournalSnapshot) => Promise<void>,
    options: {
      delayMs?: number;
      setTimeoutFn?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
      clearTimeoutFn?: (t: ReturnType<typeof setTimeout>) => void;
    } = {},
  ) {
    this.persist = persist;
    this.delayMs = options.delayMs ?? JOURNAL_PERSIST_DELAY_MS;
    // webbrain 教训：浏览器定时器有 receiver 检查——绑定 globalThis
    this.setTimeoutFn = options.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((t) => clearTimeout(t));
  }

  defer(runKey: string, snapshot: RunJournalSnapshot): void {
    const existing = this.pending.get(runKey);
    if (existing !== undefined) {
      existing.snapshot = snapshot;
      return;
    }
    const timer = this.setTimeoutFn(() => {
      const latest = this.pending.get(runKey);
      this.pending.delete(runKey);
      if (latest !== undefined) void this.persist(runKey, latest.snapshot).catch(() => {});
    }, this.delayMs);
    this.pending.set(runKey, { snapshot, timer });
  }

  persistNow(runKey: string, snapshot: RunJournalSnapshot): void {
    const pending = this.pending.get(runKey);
    if (pending !== undefined) {
      this.clearTimeoutFn(pending.timer);
      this.pending.delete(runKey);
    }
    void this.persist(runKey, snapshot).catch(() => {});
  }
}

export interface RunJournalOptions {
  scheduler?: JournalPersistScheduler;
  now?: () => number;
  /** 快照 JSON 长度预算（缺省 512KB/128KB——测试注入小值） */
  budget?: number;
  retryBudget?: number;
}

export class RunJournal {
  private snapshot: RunJournalSnapshot | null = null;
  private readonly scheduler: JournalPersistScheduler | null;
  private readonly now: () => number;
  private readonly budget: number;
  private readonly retryBudget: number;

  constructor(options: RunJournalOptions = {}) {
    this.scheduler = options.scheduler ?? null;
    this.now = options.now ?? (() => Date.now());
    this.budget = options.budget ?? JOURNAL_PERSIST_BUDGET;
    this.retryBudget = options.retryBudget ?? JOURNAL_PERSIST_RETRY_BUDGET;
  }

  get active(): boolean {
    return this.snapshot !== null;
  }

  get runId(): string | null {
    return this.snapshot?.runId ?? null;
  }

  get status(): RunStatus | null {
    return this.snapshot?.status ?? null;
  }

  begin(input: {
    runId: string;
    tabId: number;
    task: string;
    attachments: RunJournalSnapshot["attachments"];
  }): void {
    this.snapshot = {
      runId: input.runId,
      tabId: input.tabId,
      status: "running",
      seq: 0,
      ackedSeq: 0,
      discardedBeforeSeq: 0,
      events: [],
      task: input.task,
      startedAt: this.now(),
      endedAt: null,
      finalResult: null,
      isDone: false,
      isSuccessful: null,
      stepCount: 0,
      lastError: null,
      attachments: input.attachments,
    };
    this.persistDeferred();
  }

  /** 事件记录：seq 编号 + 压缩投影 + 环淘汰；返回 JournalEvent（转发用） */
  record(event: TwEvent): JournalEvent | null {
    const snap = this.snapshot;
    if (snap === null) return null;
    snap.seq += 1;
    const entry: JournalEvent = {
      seq: snap.seq,
      type: event.eventType,
      ts: this.now(),
      data: compactEventData(event),
    };
    snap.events.push(entry);
    if (snap.events.length > JOURNAL_EVENT_LIMIT) {
      const removed = snap.events.splice(0, snap.events.length - JOURNAL_EVENT_LIMIT);
      const last = removed[removed.length - 1];
      snap.discardedBeforeSeq = last?.seq ?? snap.discardedBeforeSeq;
    }
    if (event.eventType === "step_end") snap.stepCount = Math.max(snap.stepCount, event.step);
    this.persistDeferred();
    return entry;
  }

  /** 单事件消息体护栏：超 1MB 的事件 data 置截断标记（转发层消费） */
  static oversizedEventData(entry: JournalEvent): boolean {
    return JSON.stringify(entry).length > JOURNAL_EVENT_JSON_LIMIT;
  }

  setStatus(
    status: RunStatus,
    extra: Partial<
      Pick<RunJournalSnapshot, "endedAt" | "finalResult" | "isDone" | "isSuccessful" | "lastError">
    > = {},
  ): void {
    const snap = this.snapshot;
    if (snap === null) return;
    snap.status = status;
    Object.assign(snap, extra);
    // 关键事件立即 flush（webbrain 模式：awaiting-*/终态不等人）
    if (this.scheduler !== null && snap !== null) {
      this.scheduler.persistNow(this.persistKey(snap), this.snapshotForPersist(snap));
    }
  }

  /** UI 渲染确认 → 释放已渲染事件（ack 只释放不记淘汰——webbrain 修正语义） */
  ack(seq: number): void {
    const snap = this.snapshot;
    if (snap === null) return;
    snap.ackedSeq = Math.max(snap.ackedSeq, seq);
    snap.events = snap.events.filter((e) => e.seq > snap.ackedSeq);
  }

  current(): RunJournalSnapshot | null {
    return this.snapshot === null ? null : structuredCopy(this.snapshot);
  }

  /** SW 重启恢复（run-manager 消费：非终态且无活 run → 置 interrupted） */
  restore(snapshot: RunJournalSnapshot): void {
    this.snapshot = structuredCopy(snapshot);
  }

  /** 落盘预算裁剪：全量超预算 → 从最老事件丢到 retryBudget 内（真实淘汰记账） */
  private snapshotForPersist(snap: RunJournalSnapshot): RunJournalSnapshot {
    const full = structuredCopy(snap);
    if (JSON.stringify(full).length <= this.budget) return full;
    const trimmed = full;
    while (trimmed.events.length > 0 && JSON.stringify(trimmed).length > this.retryBudget) {
      const removed = trimmed.events.shift();
      if (removed !== undefined) trimmed.discardedBeforeSeq = removed.seq;
    }
    return trimmed;
  }

  private persistKey(snap: RunJournalSnapshot): string {
    return `tc_runUi:${snap.tabId}`;
  }

  private persistDeferred(): void {
    const snap = this.snapshot;
    if (this.scheduler === null || snap === null) return;
    this.scheduler.defer(this.persistKey(snap), this.snapshotForPersist(snap));
  }
}

function structuredCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
