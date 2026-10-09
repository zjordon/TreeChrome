// RunTimeline 测试：groupByStep 切组语义 + 10 类事件渲染 + 环淘汰提示 + 长文截断。

import { render, screen } from "@testing-library/react";
import type { JournalEvent } from "@tw/protocol";
import { describe, expect, it } from "vitest";
import { groupByStep, RunTimeline } from "../src/index.js";

/** JournalEvent 构造：step 并入 data（压缩投影形态——顶层无 step 字段）；畸形 data 原样透传 */
const ev = (
  seq: number,
  type: JournalEvent["type"],
  step: number,
  data: unknown,
): JournalEvent => ({
  seq,
  type,
  ts: seq * 1000,
  data:
    typeof data === "object" && data !== null
      ? { step, ...(data as Record<string, unknown>) }
      : data,
});

describe("groupByStep", () => {
  it("step_start 开组、组内事件尾随、无号前缀进首组", () => {
    const groups = groupByStep([
      ev(1, "model_call", 0, { messageCount: 6 }),
      ev(2, "step_start", 1, { step: 1 }),
      ev(3, "tool_call", 1, { actionName: "click" }),
      ev(4, "step_end", 1, { durationSeconds: 1.2 }),
      ev(5, "step_start", 2, { step: 2 }),
      ev(6, "model_result", 2, {}),
    ]);
    expect(groups.map((g) => g.step)).toEqual([null, 1, 2]);
    expect(groups[0].events.map((e) => e.seq)).toEqual([1]);
    expect(groups[1].events.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(groups[2].events.map((e) => e.seq)).toEqual([5, 6]);
  });

  it("空事件 → 空组", () => {
    expect(groupByStep([])).toEqual([]);
  });
});

describe("RunTimeline", () => {
  it("10 类事件全渲染（step 分组 + 着色 + usage 徽章 + skill 命中）", () => {
    render(
      <RunTimeline
        events={[
          ev(1, "step_start", 1, { step: 1 }),
          ev(2, "model_call", 1, { messageCount: 7 }),
          ev(3, "model_result", 1, {
            actionName: "agent_response",
            nextGoal: "点击上传按钮",
            inputTokens: 120,
            outputTokens: 30,
          }),
          ev(4, "tool_call", 1, { actionName: "click", elementIndex: 5 }),
          ev(5, "tool_result", 1, { success: true, durationSeconds: 0.4 }),
          ev(6, "tool_result", 1, { success: false, error: "元素不可见" }),
          ev(7, "skill_active", 1, { host: "douyin.com", taskSlug: "upload", skillLoaded: true }),
          ev(8, "anomaly", 1, {
            rule: "action_loop",
            severity: "warning",
            description: "重复动作",
          }),
          ev(9, "step_end", 1, { durationSeconds: 2.1 }),
          ev(10, "session_end", 1, { totalSteps: 1, summary: "完成上传" }),
        ]}
        stepCount={1}
      />,
    );
    expect(screen.getByText("第 1 步 / 共 1 步")).toBeDefined();
    expect(screen.getByText("第 1 步开始")).toBeDefined();
    expect(screen.getByText("模型调用（7 条消息）")).toBeDefined();
    expect(screen.getByText(/✦ agent_response：点击上传按钮/)).toBeDefined();
    expect(screen.getByText("⇅ 120/30")).toBeDefined();
    expect(screen.getByText("▸ click #5")).toBeDefined();
    expect(screen.getByText("✓ 动作成功（0.4s）")).toBeDefined();
    expect(screen.getByText("✗ 元素不可见")).toBeDefined();
    expect(screen.getByText(/✚ skill douyin\.com\/upload 命中/)).toBeDefined();
    expect(screen.getByText(/⚠ \[action_loop\]\(warning\) 重复动作/)).toBeDefined();
    expect(screen.getByText("第 1 步完成（2.1s）")).toBeDefined();
    expect(screen.getByText(/■ 会话结束：完成上传/)).toBeDefined();
  });

  it("环淘汰提示 + 空态", () => {
    render(<RunTimeline events={[]} discardedBeforeSeq={12} />);
    expect(screen.getByText(/seq 12 之前的事件已被淘汰/)).toBeDefined();
    const { rerender } = render(<RunTimeline events={[]} />);
    expect(screen.getByText("（尚无事件）")).toBeDefined();
    rerender(<RunTimeline events={[ev(1, "model_call", 0, {})]} />);
    expect(screen.getByText("事件流")).toBeDefined(); // 无号首组标题
  });

  it("长错误截断 1000 字符（title 存全文）", () => {
    const long = "x".repeat(1500);
    render(
      <RunTimeline
        events={[
          ev(1, "step_start", 1, {}),
          ev(2, "tool_result", 1, { success: false, error: long }),
        ]}
      />,
    );
    const line = screen.getByText(/^✗ x+/);
    expect(line.textContent?.length).toBeLessThanOrEqual(1003);
    expect(line.getAttribute("title")).toHaveLength(1500);
  });

  it("畸形 data（非对象/缺字段）不炸——防御收窄", () => {
    render(
      <RunTimeline
        events={[
          ev(1, "step_start", 1, null),
          ev(2, "tool_result", 1, "not-a-record"),
          ev(3, "unknown_future_type" as JournalEvent["type"], 1, { a: 1 }),
        ]}
      />,
    );
    expect(screen.getByText("✗ 动作失败")).toBeDefined();
    expect(screen.getByText("unknown_future_type")).toBeDefined();
  });
});
