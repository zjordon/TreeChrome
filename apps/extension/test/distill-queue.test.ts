// 蒸馏队列单测（issue #5 S4，D9）：入队幂等/上限溢出丢最老/peek-ack 逐条/
// attempts 记账与超限丢弃/坏形态防御——fake StorageArea。

import { describe, expect, it } from "vitest";
import type { StorageArea } from "../src/host/chrome-apis.js";
import {
  DISTILL_MAX_ATTEMPTS,
  DISTILL_QUEUE_KEY,
  DISTILL_QUEUE_MAX,
  type DistillJobInput,
  DistillQueue,
} from "../src/runtime/distill-queue.js";

function fakeArea(initial: unknown = undefined): StorageArea & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  if (initial !== undefined) map.set(DISTILL_QUEUE_KEY, initial);
  return {
    map,
    async get(key) {
      return key === DISTILL_QUEUE_KEY
        ? Object.fromEntries(map.has(key) ? [[key, map.get(key)]] : [])
        : {};
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) map.set(k, v);
    },
  } as unknown as StorageArea & { map: Map<string, unknown> };
}

const job = (runId: string): DistillJobInput => ({
  runId,
  task: "查报表",
  host: "a.example",
  traceText: "Step 1:\n  URL: https://a.example/r",
  stepCount: 1,
});

describe("DistillQueue", () => {
  it("enqueue/peek/ack：FIFO 逐条；runId 幂等", async () => {
    const area = fakeArea();
    const queue = new DistillQueue(area);
    await queue.enqueue(job("r1"), 100);
    await queue.enqueue(job("r1"), 200); // 幂等——不重复
    await queue.enqueue(job("r2"), 300);
    expect(await queue.size()).toBe(2);
    expect((await queue.peek())?.runId).toBe("r1"); // 最老在前
    await queue.ack("r1");
    expect((await queue.peek())?.runId).toBe("r2");
    expect((await queue.peek())?.attempts).toBe(0);
  });

  it("上限溢出丢最老（D9：蒸馏不挤爆 storage 配额）", async () => {
    const area = fakeArea();
    const queue = new DistillQueue(area);
    for (let i = 0; i < DISTILL_QUEUE_MAX + 2; i++) await queue.enqueue(job(`r${i}`), i);
    expect(await queue.size()).toBe(DISTILL_QUEUE_MAX);
    expect((await queue.peek())?.runId).toBe("r2"); // r0/r1 被挤掉
  });

  it("fail 记账：首次失败 retry 保留；达 attempts 上限 dropped 移除", async () => {
    const area = fakeArea();
    const queue = new DistillQueue(area);
    await queue.enqueue(job("r1"));
    expect(await queue.fail("r1")).toBe("retry");
    expect((await queue.peek())?.attempts).toBe(1);
    expect(await queue.size()).toBe(1); // job 保留
    expect(await queue.fail("r1")).toBe("dropped"); // attempts+1 ≥ DISTILL_MAX_ATTEMPTS
    expect(await queue.size()).toBe(0);
    expect(await queue.fail("ghost")).toBe("dropped"); // 不存在——幂等 dropped
    expect(DISTILL_MAX_ATTEMPTS).toBe(2);
  });

  it("坏形态防御：非数组/缺字段条目静默丢弃（不抛）", async () => {
    const area = fakeArea([
      {
        runId: "ok",
        task: "t",
        host: "h",
        traceText: "x",
        stepCount: 1,
        enqueuedAt: 1,
        attempts: 0,
      },
      "junk",
      { runId: 42, task: "t" }, // runId 类型错——整条丢
      null,
    ]);
    const queue = new DistillQueue(area);
    expect(await queue.size()).toBe(1);
    expect((await queue.peek())?.runId).toBe("ok");
    const nonArray = fakeArea("garbage");
    expect(await new DistillQueue(nonArray).size()).toBe(0);
  });
});
