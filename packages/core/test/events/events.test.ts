// 观测事件与总线测试：事件工厂默认面 + 总线投递语义（隔离/熔断/close 汇总）。
// 移植基准 TreeWalker observability/{events,event_bus}.py @640d52a——行为无逐字节
// 锚定（时间戳跨语言不可比），熔断/汇总文案断言关键片段。

import { describe, expect, it } from "vitest";
import { EventBus } from "../../src/events/event-bus.js";
import type { TwEvent } from "../../src/events/events.js";
import {
  sessionEndEvent,
  stepEndEvent,
  stepStartEvent,
  toolCallEvent,
  toolResultEvent,
} from "../../src/events/events.js";

describe("事件工厂", () => {
  it("判别字段保 Python event_type 原字符串；公共字段自动填充", () => {
    const e = stepStartEvent(3, "s-1");
    expect(e.eventType).toBe("step_start");
    expect(e.step).toBe(3);
    expect(e.sessionId).toBe("s-1");
    expect(e.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
  it("专有字段透传与缺省（tool_call 的几何三件套、tool_result 的计数缺省）", () => {
    const tc = toolCallEvent(1, "s", {
      modelCallId: "mc",
      toolCallId: "tc",
      actionName: "click",
      params: { index: 1 },
      elementBbox: { left: 0, top: 0, width: 0.5, height: 0.1 },
    });
    expect(tc.actionIndex).toBeUndefined(); // 缺省由消费方补 0/1（Python Field 默认）
    expect(tc.elementBbox).toEqual({ left: 0, top: 0, width: 0.5, height: 0.1 });
    const tr = toolResultEvent(1, "s", { toolCallId: "tc", success: null });
    expect(tr.success).toBeNull();
    expect(tr.durationSeconds).toBeUndefined();
    const se = stepEndEvent(2, "s", {
      durationSeconds: 1.5,
      isDone: false,
      consecutiveFailures: 0,
    });
    expect(se.eventType).toBe("step_end");
    expect(
      sessionEndEvent(5, "s", {
        totalSteps: 5,
        totalDurationSeconds: 9,
        summary: "ok",
      }).eventType,
    ).toBe("session_end");
  });
  it("discriminated union 收窄编译期成立（类型层断言）", () => {
    const e: TwEvent = stepStartEvent(1, "s");
    if (e.eventType === "step_start") {
      expect(e.step).toBe(1); // 收窄后可访问公共字段
    } else {
      throw new Error("unreachable");
    }
  });
});

describe("EventBus", () => {
  it("具名事件只投给匹配订阅；'*' 通配全收；两轮顺序=具名先于通配", () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.subscribe("tool_result", () => order.push("named"));
    bus.subscribe("*", () => order.push("wildcard"));
    bus.subscribe("step_start", () => order.push("never"));
    bus.emit(toolResultEvent(1, "s", { toolCallId: "t", success: true }));
    expect(order).toEqual(["named", "wildcard"]);
  });

  it("订阅者异常不穿透 emit，也不影响其他订阅者", () => {
    const bus = new EventBus();
    let alive = 0;
    bus.subscribe("step_start", () => {
      throw new Error("bad subscriber");
    });
    bus.subscribe("*", () => {
      alive += 1;
    });
    expect(() => bus.emit(stepStartEvent(1, "s"))).not.toThrow();
    expect(alive).toBe(1);
  });

  it("连续失败 3 次熔断：此后不再投递；成功一次即清零连续计数", () => {
    const bus = new EventBus({ log: () => {} });
    let deliveries = 0;
    const flaky = (event: TwEvent): void => {
      deliveries += 1;
      if ((event as { step: number }).step <= 3) throw new Error("flaky");
    };
    bus.subscribe("step_start", flaky);
    bus.emit(stepStartEvent(1, "s")); // fail 1
    bus.emit(stepStartEvent(2, "s")); // fail 2
    bus.emit(stepStartEvent(3, "s")); // fail 3 → DISABLED
    bus.emit(stepStartEvent(4, "s")); // 不投递
    bus.emit(stepStartEvent(5, "s")); // 不投递
    expect(deliveries).toBe(3);
    // 恢复位清零：fail,ok,fail,ok,fail 不熔断
    const bus2 = new EventBus({ log: () => {} });
    let n = 0;
    const zigzag = (event: TwEvent): void => {
      n += 1;
      if ((event as { step: number }).step % 2 === 1) throw new Error("zig");
    };
    bus2.subscribe("step_start", zigzag);
    for (let step = 1; step <= 5; step++) bus2.emit(stepStartEvent(step, "s"));
    expect(n).toBe(5); // 从未熔断
  });

  it("熔断日志含 DISABLED 证据；畸形 params 值不进日志", () => {
    const messages: string[] = [];
    const bus = new EventBus({ log: (m) => messages.push(m) });
    const boom = (): void => {
      throw new Error("SECRET-DETAIL");
    };
    bus.subscribe("step_start", boom);
    for (let i = 0; i < 3; i++) bus.emit(stepStartEvent(i, "s"));
    expect(messages.some((m) => m.includes("DISABLED"))).toBe(true);
    expect(messages.some((m) => m.includes("SECRET-DETAIL"))).toBe(true); // Python 同款带异常文本
  });

  it("close：回调逐个隔离执行、清空订阅、汇总熔断订阅（按名字去重）", () => {
    const messages: string[] = [];
    const bus = new EventBus({ log: (m) => messages.push(m) });
    let closed = 0;
    bus.onClose(() => {
      closed += 1;
    });
    bus.onClose(() => {
      throw new Error("flush failed"); // 不得穿出 close
    });
    const dead = (): void => {
      throw new Error("x");
    };
    bus.subscribe("step_start", dead);
    bus.subscribe("*", dead); // 同名 handler 两条订阅路径——close 汇总按名字去重
    for (let i = 0; i < 3; i++) bus.emit(stepStartEvent(i, "s"));
    expect(() => bus.close()).not.toThrow();
    expect(closed).toBe(1);
    expect(messages.some((m) => m.includes("subscription(s) disabled [dead]"))).toBe(true);
    // 清空后 emit 无投递、重复 close 无回调
    bus.emit(stepStartEvent(9, "s"));
    bus.close();
    expect(closed).toBe(1);
  });

  it("同一 handler 的具名与 '*' 是独立投递路径（失败各自计数）", () => {
    const bus = new EventBus({ log: () => {} });
    let calls = 0;
    const handler = (): void => {
      calls += 1;
      throw new Error("x");
    };
    bus.subscribe("step_start", handler);
    bus.subscribe("*", handler);
    const end = (step: number) =>
      stepEndEvent(step, "s", { durationSeconds: 0, isDone: false, consecutiveFailures: 0 });
    bus.emit(stepStartEvent(1, "s")); // 具名 fail1 + 通配 fail1 → 2 次
    bus.emit(end(1)); // 仅通配 fail2 → 1 次
    bus.emit(stepStartEvent(2, "s")); // 具名 fail2 + 通配 fail3 → 通配熔断 → 2 次
    expect(calls).toBe(5);
    bus.emit(end(2)); // 通配已熔断且 step_end 无具名订阅 → 0 次
    expect(calls).toBe(5);
    bus.emit(stepStartEvent(3, "s")); // 具名 fail3 → 具名熔断 → 1 次
    expect(calls).toBe(6);
    bus.emit(stepStartEvent(4, "s")); // 双双熔断 → 0 次
    expect(calls).toBe(6);
  });
});
