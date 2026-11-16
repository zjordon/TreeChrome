// 扩展侧桥命令面（issue #31 M1 P4）：run_task/get_snapshot/stop_run 的 SW 实现。
// run_task 复用 RunManager 既有 control("start") 单飞互斥——sidepanel 与远程同一
// 队列，不可能并发两个 run；确认卡语义不变（远程 run 的确认卡仍走 sidepanel
// fail-closed）。get_snapshot 是 journal 只读投影（camelCase 对齐 tc run 终态口径；
// lastUrl 暂 null——journal 无该聚合，M1 登记，#32 评估从事件尾提取）。

import type { BridgeCommandRequest, BridgeRunSnapshot, RunJournalSnapshot } from "@tw/protocol";
import type { RunJournal } from "./journal.js";
import type { RunManager } from "./run-manager.js";

export interface BridgeGatewayDeps {
  runManager: RunManager;
  journal: RunJournal;
  /** 直驱会话在位 → run_task 拒（issue #32：run ↔ drive 双向互斥） */
  isDriveActive?: () => boolean;
  log?(message: string): void;
}

/** journal 快照 → 桥侧快照（camelCase 终态口径；时间线尾部 5 条紧凑摘要） */
export function projectSnapshot(snapshot: RunJournalSnapshot | null): BridgeRunSnapshot {
  if (snapshot === null) {
    return {
      runId: null,
      status: "idle",
      isDone: false,
      isSuccessful: null,
      finalResult: null,
      stopReason: null,
      nSteps: 0,
      errors: [],
      lastUrl: null,
      timeline: [],
    };
  }
  return {
    runId: snapshot.runId,
    status: snapshot.status,
    isDone: snapshot.isDone,
    isSuccessful: snapshot.isSuccessful,
    finalResult: snapshot.finalResult,
    stopReason: snapshot.isDone ? null : snapshot.lastError,
    nSteps: snapshot.stepCount,
    errors: snapshot.lastError === null ? [] : [snapshot.lastError],
    lastUrl: null,
    timeline: snapshot.events.slice(-5).map((event) => ({
      seq: event.seq,
      type: event.type,
      summary: summarize(event.data),
    })),
  };
}

function summarize(data: unknown): string {
  const text = JSON.stringify(data ?? null) ?? "null";
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

export class BridgeGatewayError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const TERMINAL_STATUS = new Set<string>(["done", "error", "interrupted"]);

/** runtime 的 dispatch 面（runtime 已过滤 cancel_request 与未知动词） */
export function createBridgeGateway(
  deps: BridgeGatewayDeps,
): (request: BridgeCommandRequest, signal: AbortSignal) => Promise<unknown> {
  return async (request, signal) => {
    if (signal.aborted) throw new BridgeGatewayError("INTERRUPTED", "aborted before dispatch");
    if (request.method === "run_task") {
      const task = typeof request.params.task === "string" ? request.params.task : "";
      if (task.trim() === "") {
        throw new BridgeGatewayError("INVALID_ARGUMENTS", "task must be a non-empty string.");
      }
      if (deps.isDriveActive?.() === true) {
        throw new BridgeGatewayError(
          "DRIVE_SESSION_ACTIVE",
          "Direct-drive session active — call session_stop first.",
        );
      }
      const current = deps.journal.current();
      if (current !== null && !TERMINAL_STATUS.has(current.status)) {
        throw new BridgeGatewayError(
          "RUN_IN_PROGRESS",
          `run ${current.runId} is ${current.status} — stop_run first or wait.`,
        );
      }
      const result = await deps.runManager.control("start", task);
      if (!result.ok) throw new BridgeGatewayError("RUN_START_FAILED", result.error);
      deps.log?.(`[bridge] run accepted: ${deps.journal.runId ?? "?"}`);
      return { accepted: true, runId: deps.journal.runId ?? "" };
    }
    if (request.method === "get_snapshot") {
      return projectSnapshot(deps.journal.current());
    }
    if (request.method === "stop_run") {
      const result = await deps.runManager.control("stop");
      if (!result.ok) throw new BridgeGatewayError("NO_ACTIVE_RUN", result.error);
      return { stopped: true };
    }
    throw new BridgeGatewayError("INVALID_ARGUMENTS", `unknown method: ${request.method}`);
  };
}
