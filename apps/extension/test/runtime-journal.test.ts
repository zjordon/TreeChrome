// RunJournal + EventForwarder 单测（m5/04 §4）：begin/record seq 编号与压缩投影/
// 环淘汰 256+discardedBeforeSeq/ack 释放（不算淘汰）/落盘预算裁剪/关键事件立即
// flush——fake scheduler 记录；EventForwarder：EventBus → journal.record → sink
// 广播 seq + 超限截断标记。

import { EventBus, toolResultEvent } from "@tw/core";
import type { RunJournalSnapshot } from "@tw/protocol";
import { describe, expect, it } from "vitest";
import { EventForwarder } from "../src/runtime/event-forwarder.js";
import {
  compactEventData,
  DebounceScheduler,
  JOURNAL_EVENT_LIMIT,
  type JournalPersistScheduler,
  RunJournal,
} from "../src/runtime/journal.js";

/** 记录型假调度器（defer/persistNow 全收录） */
function recordingScheduler() {
  const deferred: Array<{ key: string; snapshot: RunJournalSnapshot }> = [];
  const flushed: Array<{ key: string; snapshot: RunJournalSnapshot }> = [];
  const scheduler: JournalPersistScheduler = {
    defer: (key, snapshot) => deferred.push({ key, snapshot }),
    persistNow: (key, snapshot) => flushed.push({ key, snapshot }),
  };
  return { scheduler, deferred, flushed };
}

const begin = (journal: RunJournal, tabId = 7) =>
  journal.begin({ runId: "run_1", tabId, task: "T", attachments: [] });

describe("RunJournal 基本面", () => {
  it("begin → running 快照；record → seq 递增 + 压缩投影 + stepCount", () => {
    const { scheduler, deferred } = recordingScheduler();
    const journal = new RunJournal({ scheduler, now: () => 42 });
    begin(journal);
    expect(journal.current()).toMatchObject({
      runId: "run_1",
      tabId: 7,
      status: "running",
      seq: 0,
      startedAt: 42,
    });
    const entry = journal.record(
      toolResultEvent(1, "s1", {
        toolCallId: "t1",
        success: false,
        error: "x".repeat(1500),
        durationSeconds: 1.5,
      }),
    );
    expect(entry).toMatchObject({ seq: 1, type: "tool_result" });
    expect(entry?.data).toEqual({
      step: 1,
      success: false,
      error: `${`x`.repeat(1000)}…`,
      durationSeconds: 1.5,
    });
    journal.record({ eventType: "step_end", step: 1, sessionId: "s1", durationSeconds: 2 });
    expect(journal.current()?.stepCount).toBe(1);
    expect(deferred.length).toBeGreaterThanOrEqual(2);
  });

  it("compactEventData：model_result 不带 thinking；session_end.summary 截断", () => {
    expect(
      compactEventData({
        eventType: "model_result",
        step: 2,
        sessionId: "s",
        modelCallId: "m",
        actionName: "click",
        thinking: "secrets",
        nextGoal: "g",
      }),
    ).toEqual({ step: 2, actionName: "click", nextGoal: "g" });
    expect(
      compactEventData({
        eventType: "session_end",
        step: 3,
        sessionId: "s",
        totalSteps: 3,
        totalDurationSeconds: 9,
        summary: "y".repeat(3000),
      }).summary,
    ).toHaveLength(2001);
  });

  it("record 无 begin → null（非活 journal 静默）", () => {
    const journal = new RunJournal();
    expect(journal.record({ eventType: "step_start", step: 1, sessionId: "s" })).toBeNull();
    expect(journal.current()).toBeNull();
    expect(journal.status).toBeNull();
  });
});

describe("RunJournal 淘汰与 ack", () => {
  it("事件环 256：超限淘汰最老 + discardedBeforeSeq 只记真实淘汰", () => {
    const journal = new RunJournal();
    begin(journal);
    for (let i = 0; i < JOURNAL_EVENT_LIMIT + 10; i++) {
      journal.record({ eventType: "step_start", step: i + 1, sessionId: "s" });
    }
    const snap = journal.current()!;
    expect(snap.events).toHaveLength(JOURNAL_EVENT_LIMIT);
    expect(snap.seq).toBe(JOURNAL_EVENT_LIMIT + 10);
    expect(snap.discardedBeforeSeq).toBe(10);
    expect(snap.events[0]?.seq).toBe(11);
    // ack 只释放不记淘汰（webbrain 修正语义）
    journal.ack(snap.seq - 5);
    const after = journal.current()!;
    expect(after.ackedSeq).toBe(snap.seq - 5);
    expect(after.events).toHaveLength(5);
    expect(after.discardedBeforeSeq).toBe(10);
  });

  it("落盘预算：全量超预算 → 从最老丢到 retryBudget 内（真实淘汰记账）", () => {
    const { scheduler, deferred } = recordingScheduler();
    // 全量 ~1.7KB 超 budget 500 → 丢最老到 ≤620（基础 ~256 + 单事件 ~290 = 546，
    // 留 1 条）
    const journal = new RunJournal({ scheduler, budget: 500, retryBudget: 620 });
    begin(journal);
    const big = "z".repeat(200);
    for (let i = 0; i < 5; i++) {
      journal.record({
        eventType: "model_result",
        step: 1,
        sessionId: "s",
        modelCallId: "m",
        actionName: "click",
        nextGoal: big,
      });
    }
    const persisted = deferred.at(-1)!.snapshot;
    expect(JSON.stringify(persisted).length).toBeLessThanOrEqual(620 + 100);
    expect(persisted.discardedBeforeSeq).toBe(4);
    expect(persisted.events).toHaveLength(1);
    expect(persisted.events[0]?.seq).toBe(5);
  });
});

describe("RunJournal 状态与恢复", () => {
  it("setStatus 关键事件立即 flush（awaiting-* 与终态）；restore 回放", () => {
    const { scheduler, flushed } = recordingScheduler();
    const journal = new RunJournal({ scheduler, now: () => 1 });
    begin(journal);
    journal.setStatus("awaiting-permission");
    expect(flushed.at(-1)?.snapshot.status).toBe("awaiting-permission");
    journal.setStatus("running");
    journal.setStatus("done", {
      endedAt: 99,
      finalResult: "R",
      isDone: true,
      isSuccessful: true,
    });
    expect(flushed.at(-1)?.snapshot).toMatchObject({
      status: "done",
      endedAt: 99,
      finalResult: "R",
      isSuccessful: true,
    });

    const revived = new RunJournal();
    revived.restore(journal.current()!);
    expect(revived.current()?.runId).toBe("run_1");
    expect(revived.runId).toBe("run_1");
  });
});

describe("EventForwarder", () => {
  it("EventBus → journal.record + sink 广播（seq 对齐）；超限事件截断标记", async () => {
    const journal = new RunJournal({ now: () => 1 });
    begin(journal);
    const sent: Array<{ seq: number; event: unknown }> = [];
    const bus = new EventBus({ log: () => {} });
    new EventForwarder(bus, journal, (m) => {
      if (m.kind === "event") sent.push({ seq: m.seq, event: m.event });
    }).start();
    bus.emit(toolResultEvent(1, "s1", { toolCallId: "t", success: true }));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.seq).toBe(1);
    // 1MB+ 事件 → 截断标记（保 eventType/step）
    const bigEvent = {
      eventType: "model_result",
      step: 2,
      sessionId: "s1",
      modelCallId: "m",
      actionName: "click",
      nextGoal: "g".repeat(1100 * 1024),
    };
    bus.emit(bigEvent);
    const marker = sent[1]!.event as { eventType: string; step: number; truncated?: boolean };
    expect(marker).toMatchObject({ eventType: "model_result", step: 2, truncated: true });
    expect(sent[1]?.seq).toBe(2);
  });
});

describe("DebounceScheduler（真调度器：注入定时器）", () => {
  it("defer 200ms 内合并最新快照；到点 persist 一次；persistNow 立即并取消挂起", async () => {
    const persisted: Array<{ key: string; seq: number }> = [];
    const timers: Array<{ fire: () => void; cleared: boolean }> = [];
    const scheduler = new DebounceScheduler(
      async (key, snap) => {
        persisted.push({ key, seq: snap.seq });
      },
      {
        setTimeoutFn: (cb) => {
          const t = { fire: cb, cleared: false };
          timers.push(t);
          return t as never;
        },
        clearTimeoutFn: (t) => {
          (t as unknown as { cleared: boolean }).cleared = true;
        },
      },
    );
    const snap = (): RunJournalSnapshot => ({ seq: persisted.length, events: [] }) as never;
    scheduler.defer("k1", snap());
    scheduler.defer("k1", snap()); // 合并（不新增 timer）
    expect(timers).toHaveLength(1);
    scheduler.defer("k2", snap()); // 他键独立
    expect(timers).toHaveLength(2);
    timers[0]!.fire();
    await new Promise((r) => setTimeout(r, 0));
    expect(persisted.map((p) => p.key)).toEqual(["k1"]);
    // persistNow：清挂起（k2 已有挂起 timer——合并路径不新建）+ 立即落
    scheduler.defer("k2", snap());
    scheduler.persistNow("k2", snap());
    expect(timers[1]!.cleared).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(persisted.map((p) => p.key)).toEqual(["k1", "k2"]);
  });

  it("persist 抛错不外溢（清路径容错）", async () => {
    const scheduler = new DebounceScheduler(
      async () => {
        throw new Error("storage down");
      },
      { setTimeoutFn: (cb) => ({ fire: cb, cleared: false }) as never, clearTimeoutFn: () => {} },
    );
    scheduler.persistNow("k", { events: [] } as never);
    await new Promise((r) => setTimeout(r, 10));
  });
});
