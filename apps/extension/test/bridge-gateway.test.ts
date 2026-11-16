// bridge-gateway 单测（issue #31 M1 P4）：run_task/get_snapshot/stop_run 三命令——
// fake RunManager/journal 注入，断言单飞互斥前置、journal 只读投影与错误码映射。
import type { BridgeCommandRequest, RunJournalSnapshot } from "@tw/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  type BridgeGatewayError,
  createBridgeGateway,
  projectSnapshot,
} from "../src/runtime/bridge-gateway.js";
import type { RunJournal } from "../src/runtime/journal.js";
import type { RunManager } from "../src/runtime/run-manager.js";

function snap(over: Partial<RunJournalSnapshot> = {}): RunJournalSnapshot {
  return {
    runId: "r-9",
    tabId: 1,
    status: "done",
    seq: 3,
    ackedSeq: 0,
    discardedBeforeSeq: 0,
    events: [
      { seq: 1, type: "step_start", ts: 1, data: { url: "https://a" } },
      { seq: 2, type: "step_end", ts: 2, data: { ok: true } },
      { seq: 3, type: "session_end", ts: 3, data: { done: true } },
    ],
    task: "查价",
    startedAt: 1,
    endedAt: 3,
    finalResult: "答：42",
    isDone: true,
    isSuccessful: true,
    stepCount: 2,
    lastError: null,
    attachments: [],
    ...over,
  };
}

function makeGateway(current: RunJournalSnapshot | null, runId = "r-9") {
  const control = vi.fn(async () => ({ ok: true as const }));
  const runManager = { control } as unknown as RunManager;
  const journal = {
    current: () => current,
    runId,
  } as unknown as RunJournal;
  const dispatch = createBridgeGateway({ runManager, journal });
  return { dispatch, control };
}

const req = (method: string, params: Record<string, unknown> = {}): BridgeCommandRequest =>
  ({ id: "q1", method, params, timeoutMs: 5_000 }) as BridgeCommandRequest;

const okSignal = (): AbortSignal => new AbortController().signal;

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as BridgeGatewayError).code;
  }
  return "(no error)";
}

describe("run_task", () => {
  it("终态/无 run 时受理：control('start', task) → {accepted, runId}", async () => {
    const { dispatch, control } = makeGateway(snap());
    const result = await dispatch(req("run_task", { task: "查价" }), okSignal());
    expect(result).toEqual({ accepted: true, runId: "r-9" });
    expect(control).toHaveBeenCalledWith("start", "查价");
  });

  it("run 进行中 → RUN_IN_PROGRESS（control 不被调——与 sidepanel 同一互斥）", async () => {
    const { dispatch, control } = makeGateway(snap({ status: "running", isDone: false }));
    expect(await errorCode(dispatch(req("run_task", { task: "x" }), okSignal()))).toBe(
      "RUN_IN_PROGRESS",
    );
    expect(control).not.toHaveBeenCalled();
  });

  it("直驱会话在位 → DRIVE_SESSION_ACTIVE（#32：run ↔ drive 双向互斥）", async () => {
    const control = vi.fn(async () => ({ ok: true as const }));
    const runManager = { control } as unknown as RunManager;
    const journal = { current: () => null, runId: null } as unknown as RunJournal;
    const dispatch = createBridgeGateway({ runManager, journal, isDriveActive: () => true });
    expect(await errorCode(dispatch(req("run_task", { task: "x" }), okSignal()))).toBe(
      "DRIVE_SESSION_ACTIVE",
    );
    expect(control).not.toHaveBeenCalled();
  });

  it("control 拒绝（如并发窗口单飞）→ RUN_START_FAILED 带原文案", async () => {
    const control = vi.fn(async () => ({ ok: false as const, error: "请先停止当前任务" }));
    const runManager = { control } as unknown as RunManager;
    const journal = { current: () => null, runId: null } as unknown as RunJournal;
    const dispatch = createBridgeGateway({ runManager, journal });
    expect(await errorCode(dispatch(req("run_task", { task: "x" }), okSignal()))).toBe(
      "RUN_START_FAILED",
    );
  });

  it("空 task → INVALID_ARGUMENTS；已中止 signal → INTERRUPTED", async () => {
    const { dispatch } = makeGateway(null);
    expect(await errorCode(dispatch(req("run_task", { task: " " }), okSignal()))).toBe(
      "INVALID_ARGUMENTS",
    );
    const controller = new AbortController();
    controller.abort();
    expect(await errorCode(dispatch(req("run_task", { task: "x" }), controller.signal))).toBe(
      "INTERRUPTED",
    );
  });
});

describe("get_snapshot", () => {
  it("无 run → idle 形态", async () => {
    const { dispatch } = makeGateway(null, "");
    const result = (await dispatch(req("get_snapshot"), okSignal())) as ReturnType<
      typeof projectSnapshot
    >;
    expect(result).toMatchObject({ runId: null, status: "idle", isDone: false, timeline: [] });
  });

  it("终态映射：finalResult/isSuccessful 透传；lastError→errors；时间线尾 5 条", async () => {
    const { dispatch } = makeGateway(
      snap({
        status: "error",
        isDone: false,
        isSuccessful: false,
        finalResult: null,
        lastError: "连接断开",
      }),
    );
    const result = (await dispatch(req("get_snapshot"), okSignal())) as ReturnType<
      typeof projectSnapshot
    >;
    expect(result).toMatchObject({
      runId: "r-9",
      status: "error",
      isDone: false,
      stopReason: "连接断开",
      errors: ["连接断开"],
      nSteps: 2,
    });
    expect(result.timeline.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("projectSnapshot：done 时 stopReason 恒 null；摘要超 160 字符截断", () => {
    const done = projectSnapshot(snap());
    expect(done.stopReason).toBeNull();
    expect(done.errors).toEqual([]);
    const long = projectSnapshot(
      snap({
        isDone: false,
        lastError: "x",
        events: [{ seq: 7, type: "model_result", ts: 1, data: { text: "长".repeat(200) } }],
      }),
    );
    const summary = long.timeline[0]?.summary ?? "";
    expect(summary.length).toBeLessThanOrEqual(160);
    expect(summary.endsWith("…")).toBe(true);
    expect(long.timeline).toHaveLength(1);
  });

  it("projectSnapshot：awaiting 状态透传（观察方可见确认卡挂起）", () => {
    expect(projectSnapshot(snap({ status: "awaiting-permission", isDone: false })).status).toBe(
      "awaiting-permission",
    );
  });
});

describe("stop_run 与未知动词", () => {
  it("stop 成功 → {stopped:true}", async () => {
    const { dispatch, control } = makeGateway(snap({ status: "running", isDone: false }));
    const result = await dispatch(req("stop_run"), okSignal());
    expect(result).toEqual({ stopped: true });
    expect(control).toHaveBeenCalledWith("stop");
  });

  it("无活动 run → NO_ACTIVE_RUN；未知动词 → INVALID_ARGUMENTS", async () => {
    const control = vi.fn(async () => ({ ok: false as const, error: "当前没有运行中的任务" }));
    const runManager = { control } as unknown as RunManager;
    const journal = { current: () => null, runId: null } as unknown as RunJournal;
    const dispatch = createBridgeGateway({ runManager, journal });
    expect(await errorCode(dispatch(req("stop_run"), okSignal()))).toBe("NO_ACTIVE_RUN");
    expect(await errorCode(dispatch(req("frob" as string), okSignal()))).toBe("INVALID_ARGUMENTS");
  });
});
