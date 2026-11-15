// watch 循环单测（issue #31 M1 P2）：getSnapshot/sleep/now 全注入——只测观察语义
// （增量事件、终态、超时边界、中断、runId 错配），不测真实定时。

import type { BridgeRunSnapshot } from "@tw/protocol";
import { describe, expect, it } from "vitest";
import { WatchTimeoutError, type WatchUpdate, watchTask } from "../src/index.js";

function snap(over: Partial<BridgeRunSnapshot> = {}): BridgeRunSnapshot {
  return {
    runId: "r-1",
    status: "running",
    isDone: false,
    isSuccessful: null,
    finalResult: null,
    stopReason: null,
    nSteps: 0,
    errors: [],
    lastUrl: null,
    timeline: [],
    ...over,
  };
}

const controller = (): AbortController => new AbortController();

describe("watchTask", () => {
  it("首拍即终态 → 直接返回；onUpdate 发全量时间线", async () => {
    const terminal = snap({
      isDone: true,
      status: "done",
      isSuccessful: true,
      timeline: [{ seq: 1, type: "step", summary: "a" }],
    });
    const updates: WatchUpdate[] = [];
    const result = await watchTask({
      signal: controller().signal,
      getSnapshot: async () => terminal,
      onUpdate: (u) => updates.push(u),
    });
    expect(result).toBe(terminal);
    expect(updates).toHaveLength(1);
    expect(updates[0].text).toContain("[step] a");
  });

  it("running → running → 终态：onUpdate 只发 seq 增量", async () => {
    const snapshots = [
      snap({ timeline: [{ seq: 1, type: "step", summary: "s1" }] }),
      snap({
        nSteps: 2,
        timeline: [
          { seq: 1, type: "step", summary: "s1" },
          { seq: 2, type: "step", summary: "s2" },
        ],
      }),
      snap({
        isDone: true,
        status: "done",
        timeline: [
          { seq: 1, type: "step", summary: "s1" },
          { seq: 2, type: "step", summary: "s2" },
          { seq: 3, type: "done", summary: "完成" },
        ],
      }),
    ];
    let cursor = 0;
    const updates: string[] = [];
    const sleeps: number[] = [];
    const result = await watchTask({
      signal: controller().signal,
      getSnapshot: async () => snapshots[Math.min(cursor++, snapshots.length - 1)]!,
      onUpdate: (u) => updates.push(u.text),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result.isDone).toBe(true);
    expect(updates).toEqual(["[step] s1", "[step] s2", "[done] 完成"]);
    expect(sleeps).toEqual([1000, 1000]);
  });

  it("无时间线的首拍发状态行；无 run（runId null）不判终态继续观察", async () => {
    const snapshots = [
      snap({ runId: null, status: "idle", timeline: [] }),
      snap({ isDone: true, status: "done", timeline: [{ seq: 1, type: "done", summary: "ok" }] }),
    ];
    let cursor = 0;
    const updates: string[] = [];
    await watchTask({
      signal: controller().signal,
      getSnapshot: async () => snapshots[Math.min(cursor++, 1)]!,
      onUpdate: (u) => updates.push(u.text),
      sleep: async () => {},
    });
    expect(updates[0]).toContain("idle");
    expect(updates[1]).toContain("[done] ok");
  });

  it("超时：waitTimeoutSeconds 截止 → WatchTimeoutError 携带最后快照（不杀 run 语义在调用方）", async () => {
    let clock = 5_000;
    const running = snap({ timeline: [{ seq: 1, type: "step", summary: "s1" }] });
    const attempt = watchTask({
      waitTimeoutSeconds: 10,
      signal: controller().signal,
      getSnapshot: async () => running,
      now: () => clock,
    });
    const rejection = expect(attempt).rejects.toBeInstanceOf(WatchTimeoutError);
    clock = 5_000 + 10_001; // 首拍后即过截止——不等 sleep
    await rejection;
    try {
      await attempt;
    } catch (error) {
      expect((error as WatchTimeoutError).lastSnapshot.runId).toBe("r-1");
    }
  });

  it("中断：sleep 注入 reject → 透传 INTERRUPTED；signal 透传给 getSnapshot", async () => {
    let seenSignal: AbortSignal | null = null;
    const { BridgeStateError } = await import("../src/index.js");
    const attempt = watchTask({
      signal: controller().signal,
      getSnapshot: async (signal) => {
        seenSignal = signal;
        return snap({ timeline: [{ seq: 1, type: "step", summary: "s" }] });
      },
      sleep: async () => {
        throw new BridgeStateError("INTERRUPTED", "aborted");
      },
    });
    await expect(attempt).rejects.toMatchObject({ code: "INTERRUPTED" });
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it("runId 错配 → TASK_CHANGED", async () => {
    const other = snap({ runId: "r-9", timeline: [{ seq: 1, type: "step", summary: "x" }] });
    await expect(
      watchTask({
        runId: "r-1",
        signal: controller().signal,
        getSnapshot: async () => other,
      }),
    ).rejects.toMatchObject({ code: "TASK_CHANGED" });
  });

  it("截止传导：快照请求带剩余预算；预算耗尽的请求超时 → WatchTimeoutError 携带最后快照", async () => {
    const { BridgeStateError } = await import("../src/index.js");
    let clock = 1_000;
    const running = snap({ timeline: [{ seq: 1, type: "step", summary: "s1" }] });
    const budgets: Array<number | undefined> = [];
    let call = 0;
    const attempt = watchTask({
      waitTimeoutSeconds: 10,
      signal: controller().signal,
      now: () => clock,
      sleep: async () => {
        clock += 10_000; // sleep 跨过截止
      },
      getSnapshot: async (_signal, budgetMs) => {
        budgets.push(budgetMs);
        call += 1;
        if (call === 1) return running;
        throw new BridgeStateError("BRIDGE_REQUEST_TIMEOUT", "The browser operation timed out.");
      },
    });
    const rejection = expect(attempt).rejects.toBeInstanceOf(WatchTimeoutError);
    await rejection;
    try {
      await attempt;
    } catch (error) {
      expect((error as WatchTimeoutError).lastSnapshot.runId).toBe("r-1");
    }
    expect(budgets).toEqual([10_001, 1]);
  });

  it("首拍即超预算且无历史快照 → 原样透传 BRIDGE_REQUEST_TIMEOUT（不虚报观察超时）", async () => {
    const { BridgeStateError } = await import("../src/index.js");
    await expect(
      watchTask({
        waitTimeoutSeconds: 5,
        signal: controller().signal,
        getSnapshot: async () => {
          throw new BridgeStateError("BRIDGE_REQUEST_TIMEOUT", "The browser operation timed out.");
        },
      }),
    ).rejects.toMatchObject({ code: "BRIDGE_REQUEST_TIMEOUT" });
  });

  it("无截止 → 快照请求不带预算（用单命令缺省）", async () => {
    const budgets: Array<number | undefined> = [];
    await watchTask({
      signal: controller().signal,
      getSnapshot: async (_signal, budgetMs) => {
        budgets.push(budgetMs);
        return snap({ isDone: true, status: "done" });
      },
    });
    expect(budgets).toEqual([undefined]);
  });
});
