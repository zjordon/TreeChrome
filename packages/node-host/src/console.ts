// 控制台观测（node-host 方案 §4）：EventBus 事件逐行打印 + 截断助手——
// Python 侧 `logging.basicConfig(level=INFO)` 的等价物（核心无全局日志，观测装配在宿主）。
// 从 examples/basic-agent.mjs 厚版收编。

import type { EventBus, TwEvent } from "@tw/core";

export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)} …` : s);

/**
 * 关键事件各一行（step 分隔/模型决策/动作执行/步收尾/anomaly/session 收口）；
 * model_call / skill_active 等细节事件返回 null（不打——INFO 级噪音控制）。
 */
export function describeEvent(e: TwEvent): string | null {
  switch (e.eventType) {
    case "step_start":
      return `── step ${e.step} ──`;
    case "model_result":
      return `模型 → ${e.actionName}｜目标：${e.nextGoal ?? ""}｜tokens ${e.inputTokens ?? "?"}+${e.outputTokens ?? "?"}`;
    case "tool_call": {
      const target = e.elementIndex != null ? ` #${e.elementIndex}` : "";
      const params = e.params ? ` ${clip(JSON.stringify(e.params), 120)}` : "";
      return `  → ${e.actionName}${target}${params}`;
    }
    case "tool_result": {
      const mark = e.success === false ? "✗" : "✓";
      const secs = e.durationSeconds != null ? ` (${e.durationSeconds.toFixed(1)}s)` : "";
      const err = e.error ? ` ${clip(e.error, 160)}` : "";
      return `  ${mark}${secs}${err}`;
    }
    case "step_end":
      return `  step ${e.step} 完成（${e.durationSeconds.toFixed(1)}s，连续失败 ${e.consecutiveFailures}）${e.isDone ? " —— done" : ""}`;
    case "anomaly":
      return `  ⚠ anomaly[${e.severity}] ${e.rule}：${clip(e.description, 160)}`;
    case "session_end":
      return `── session 结束：${e.totalSteps} 步 / ${e.totalDurationSeconds.toFixed(1)}s ── ${e.summary}`;
    default:
      return null;
  }
}

export interface AttachConsoleOptions {
  /** 输出行（缺省 console.log） */
  print?: (line: string) => void;
}

/** 订阅 EventBus 全量事件，关键事件打印 `[event] …` 行（收口走 bus.close()——
 *  EventBus 不提供单订阅解订，与 core 各消费方一致） */
export function attachConsole(bus: EventBus, options: AttachConsoleOptions = {}): void {
  const print = options.print ?? ((line: string) => console.log(line));
  bus.subscribe("*", (e: TwEvent) => {
    const line = describeEvent(e);
    if (line !== null) {
      print(`[event] ${line}`);
    }
  });
}
