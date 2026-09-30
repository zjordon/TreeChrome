// describeEvent / attachConsole / clip：控制台观测的行格式（≈ logging.basicConfig）。

import { EventBus, type TwEvent } from "@tw/core";
import { describe, expect, test } from "vitest";
import { attachConsole, clip, describeEvent } from "../src/console.js";

const base = { timestamp: "t", step: 3, sessionId: "s1" };

const events: TwEvent[] = [
  { ...base, eventType: "step_start" },
  {
    ...base,
    eventType: "model_result",
    modelCallId: "m1",
    actionName: "click",
    nextGoal: "open box",
    inputTokens: 10,
    outputTokens: 20,
  },
  {
    ...base,
    eventType: "tool_call",
    modelCallId: "m1",
    toolCallId: "t1",
    actionName: "click",
    params: { index: 7 },
    elementIndex: 7,
  },
  { ...base, eventType: "tool_result", toolCallId: "t1", success: true, durationSeconds: 1.25 },
  {
    ...base,
    eventType: "tool_result",
    toolCallId: "t2",
    success: false,
    error: "boom",
  },
  { ...base, eventType: "step_end", durationSeconds: 2.5, isDone: true, consecutiveFailures: 0 },
  { ...base, eventType: "anomaly", rule: "loop", severity: "medium", description: "d" },
  {
    ...base,
    eventType: "session_end",
    totalSteps: 4,
    totalDurationSeconds: 9.5,
    summary: "done",
  },
  { ...base, eventType: "model_call", modelCallId: "m1", messageCount: 5 },
  { ...base, eventType: "skill_active" },
];

describe("describeEvent", () => {
  test("step_start / model_result / tool_call", () => {
    expect(describeEvent(events[0])).toBe("── step 3 ──");
    expect(describeEvent(events[1])).toBe("模型 → click｜目标：open box｜tokens 10+20");
    expect(describeEvent(events[2])).toBe('  → click #7 {"index":7}');
  });

  test("tool_result 成败两态 / step_end / anomaly / session_end", () => {
    expect(describeEvent(events[3])).toBe("  ✓ (1.3s)");
    expect(describeEvent(events[4])).toBe("  ✗ boom");
    expect(describeEvent(events[5])).toBe("  step 3 完成（2.5s，连续失败 0） —— done");
    expect(describeEvent(events[6])).toBe("  ⚠ anomaly[medium] loop：d");
    expect(describeEvent(events[7])).toBe("── session 结束：4 步 / 9.5s ── done");
  });

  test("细节事件（model_call/skill_active）返回 null 不打", () => {
    expect(describeEvent(events[8])).toBeNull();
    expect(describeEvent(events[9])).toBeNull();
  });

  test("可选字段缺失走回退（问号 token/无 target/无 params/成功未知/无时长无错）", () => {
    expect(
      describeEvent({ ...base, eventType: "model_result", modelCallId: "m", actionName: "a" }),
    ).toBe("模型 → a｜目标：｜tokens ?+?");
    expect(
      describeEvent({
        ...base,
        eventType: "tool_call",
        modelCallId: "m",
        toolCallId: "t",
        actionName: "a",
      }),
    ).toBe("  → a");
    expect(
      describeEvent({ ...base, eventType: "tool_result", toolCallId: "t", success: null }),
    ).toBe("  ✓");
    expect(
      describeEvent({
        ...base,
        eventType: "step_end",
        durationSeconds: 1,
        isDone: false,
        consecutiveFailures: 2,
      }),
    ).toBe("  step 3 完成（1.0s，连续失败 2）");
  });

  test("clip 边界：恰等于 n 不截断", () => {
    expect(clip("abc", 3)).toBe("abc");
    expect(clip("abcd", 3)).toBe("abc …");
  });

  test("clip 截断带省略号", () => {
    expect(clip("abcdef", 3)).toBe("abc …");
    expect(clip("ab", 3)).toBe("ab");
  });
});

describe("attachConsole", () => {
  test("关键事件打印 [event] 行，细节事件静默（收口走 bus.close——无单订阅解订）", () => {
    const bus = new EventBus({ log: () => {} });
    const lines: string[] = [];
    attachConsole(bus, { print: (l) => lines.push(l) });
    for (const e of events) {
      bus.emit(e);
    }
    bus.close();
    expect(lines[0]).toBe("[event] ── step 3 ──");
    expect(lines.length).toBe(8); // 10 事件 - 2 细节事件
    expect(lines.at(-1)).toBe("[event] ── session 结束：4 步 / 9.5s ── done");
  });
});
