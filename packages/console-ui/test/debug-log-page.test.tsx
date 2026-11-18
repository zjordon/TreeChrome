// DebugLogPage 单测（issue #39 U3 批 B）：原始事件流渲染——seq 排序折叠行、
// 快照头部态、空事件占位、未知类型/畸形 data 回退。

import { cleanup, render, screen } from "@testing-library/react";
import type { JournalEvent, RunJournalSnapshot } from "@tw/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DebugLogPage } from "../src/debug-log-page.js";

afterEach(cleanup);

const SNAP = {
  runId: "run_x",
  tabId: 7,
  status: "running",
  seq: 9,
  ackedSeq: 0,
  discardedBeforeSeq: 3,
  events: [],
  task: "t",
  startedAt: 1,
  endedAt: null,
  finalResult: null,
  isDone: false,
  isSuccessful: null,
  stepCount: 2,
  lastError: null,
  attachments: [],
} as unknown as RunJournalSnapshot;

function ev(seq: number, type: string, data: unknown, ts = 1000 + seq): JournalEvent {
  return { seq, type, ts, data } as JournalEvent;
}

describe("DebugLogPage", () => {
  it("快照头部态：run/tab/status/步数/淘汰提示", () => {
    render(<DebugLogPage events={[]} snapshot={SNAP} />);
    const text = screen.getByTestId("debug-log-page").textContent ?? "";
    expect(text).toContain("run_x");
    expect(text).toContain("7");
    expect(text).toContain("running");
    expect(text).toContain("seq 3 前已淘汰");
  });

  it("事件按 seq 排序渲染折叠行——原始 data JSON 可见", () => {
    // 乱序传入，渲染按 seq 升序
    const events = [
      ev(9, "model_result", { actionName: "click", nextGoal: "g" }),
      ev(7, "step_start", { step: 1 }),
      ev(8, "weird_future_type", { anything: { nested: true } }),
    ];
    const { container } = render(<DebugLogPage events={events} snapshot={null} />);
    const summaries = Array.from(
      container.querySelectorAll('[data-testid="debug-events"] summary'),
    );
    expect(summaries.map((s) => s.textContent)).toEqual([
      expect.stringContaining("#7 step_start"),
      expect.stringContaining("#8 weird_future_type"),
      expect.stringContaining("#9 model_result"),
    ]);
    // details 折叠是视觉的——DOM 内 pre 原样 JSON（未知类型 data 可读回退）
    const bodies = container.querySelectorAll('[data-testid="debug-events"] details pre');
    expect(bodies[0]?.textContent).toContain('"step": 1');
    expect(bodies[1]?.textContent).toContain("nested");
    expect(bodies[2]?.textContent).toContain("click");
  });

  it("空事件（无快照）——占位文案", () => {
    render(<DebugLogPage events={[]} snapshot={null} />);
    expect(screen.getByTestId("debug-log-page").textContent).toContain("尚无事件");
  });
});
