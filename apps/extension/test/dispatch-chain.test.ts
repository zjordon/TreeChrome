// dispatch-chain 单测（issue #32 评审轮 1 [1]）：互斥命令串行（FIFO）/只读命令
// 不入链不等待/单个命令拒绝不断链。

import type { BridgeCommandRequest } from "@tw/protocol";
import { describe, expect, it, vi } from "vitest";
import { createMutatingDispatchChain } from "../src/runtime/dispatch-chain.js";

const req = (method: string): BridgeCommandRequest =>
  ({ id: "r1", method, params: {}, timeoutMs: 1_000 }) as BridgeCommandRequest;

const signal = (): AbortSignal => new AbortController().signal;

describe("createMutatingDispatchChain", () => {
  it("run_task 与 drive 串行：前一 dispatch 未完成时后一不进入（FIFO）", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const dispatch = vi.fn(async (request: BridgeCommandRequest): Promise<unknown> => {
      order.push(`start:${request.method}`);
      if (request.method === "run_task") {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      order.push(`end:${request.method}`);
      return { ok: true };
    });
    const chained = createMutatingDispatchChain(dispatch);
    const first = chained(req("run_task"), signal());
    const second = chained(req("drive"), signal());
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start:run_task"]); // drive 未进入——互斥窗口闭合
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["start:run_task", "end:run_task", "start:drive", "end:drive"]);
  });

  it("get_snapshot 不入链：mutating 挂起时只读照常派发", async () => {
    let release: (() => void) | undefined;
    const dispatch = async (request: BridgeCommandRequest): Promise<unknown> => {
      if (request.method === "drive") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { snapshot: true };
    };
    const chained = createMutatingDispatchChain(dispatch);
    const slow = chained(req("drive"), signal());
    const read = await chained(req("get_snapshot"), signal());
    expect(read).toEqual({ snapshot: true });
    release?.();
    await slow;
  });

  it("拒绝不断链：失败命令之后后续照常派发", async () => {
    let n = 0;
    const dispatch = async (request: BridgeCommandRequest): Promise<unknown> => {
      n += 1;
      if (request.method === "run_task") throw new Error("boom");
      return n;
    };
    const chained = createMutatingDispatchChain(dispatch);
    await expect(chained(req("run_task"), signal())).rejects.toThrow("boom");
    await expect(chained(req("drive"), signal())).resolves.toBe(2);
  });
});
