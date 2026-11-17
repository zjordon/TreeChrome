// TranscriptView 组件单测（issue #35 U1b B8）：用户气泡（非 done 状态章/附件行）/
// run 块（状态头 + 事件 + 终态结果）/空态。

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RunBlockItem, UserTurnItem } from "../src/transcript.js";
import { TranscriptView } from "../src/transcript-view.js";

const user = (over: Partial<UserTurnItem> = {}): UserTurnItem => ({
  kind: "user-turn",
  turnId: "t1",
  task: "查价",
  status: "done",
  attachments: [],
  createdAt: 1,
  ...over,
});

const run = (over: Partial<RunBlockItem> = {}): RunBlockItem => ({
  kind: "run-block",
  runId: "r1",
  turnId: "t1",
  status: "done",
  events: [{ seq: 1, type: "step_start", ts: 1, data: { step: 1 } }],
  stepCount: 1,
  startedAt: 1,
  endedAt: 2,
  finalResult: "答：42",
  lastError: null,
  discardedBeforeSeq: 0,
  ...over,
});

describe("TranscriptView", () => {
  it("空态：尚无对话", () => {
    render(<TranscriptView items={[]} />);
    expect(screen.getByText("（尚无对话）")).toBeTruthy();
  });

  it("用户气泡：task 原文；running 出状态章；附件名列出", () => {
    render(
      <TranscriptView
        items={[
          user({
            status: "running",
            attachments: [{ attachmentId: "a1", name: "v.mp4", mimeType: "video/mp4", size: 3 }],
          }),
        ]}
      />,
    );
    expect(screen.getByText("查价")).toBeTruthy();
    expect(screen.getByText("运行中")).toBeTruthy();
    expect(screen.getByText("v.mp4")).toBeTruthy();
  });

  it("run 块：状态头 + 事件行 + 终态结果；live 块无终态结果", () => {
    const { rerender } = render(<TranscriptView items={[run()]} />);
    expect(screen.getByText("完成")).toBeTruthy();
    // 步行会同时出现在分组 summary 与 step_start 行——多重命中即事件面在渲染
    expect(screen.getAllByText(/第 1 步/).length).toBeGreaterThan(0);
    expect(screen.getByText("答：42")).toBeTruthy();
    rerender(
      <TranscriptView items={[run({ status: "live", finalResult: null, endedAt: null })]} />,
    );
    expect(screen.getByText("运行中")).toBeTruthy();
    expect(screen.queryByText(/结束/)).toBeNull();
  });

  it("出错 run：错误红字面（lastError 经 FinalResult）", () => {
    render(
      <TranscriptView
        items={[run({ status: "error", finalResult: null, lastError: "连接断开" })]}
      />,
    );
    expect(screen.getByText("出错")).toBeTruthy();
    expect(screen.getByText("连接断开")).toBeTruthy();
  });
});
