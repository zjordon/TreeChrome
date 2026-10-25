// 覆盖缺口定向单元：py-repr 深层形态 / constants 判定族（isConnectionError/
// formatStepError/StepTimeoutError）/ judge 边界（空 trace、trace 截断对齐）。
import { describe, expect, it } from "vitest";
import { formatStepError, InterruptedError, isConnectionError } from "../../src/agent/constants.js";
import { JudgeEvaluator } from "../../src/agent/judge.js";
import { pyReprDeep } from "../../src/agent/py-repr.js";
import { StepTimeoutError } from "../../src/agent/step/context.js";
import { ActionResult, AgentHistory, AgentHistoryList } from "../../src/agent/views.js";

describe("pyReprDeep", () => {
  it("标量/字符串引号规则/嵌套 dict/list/空容器", () => {
    expect(pyReprDeep(null)).toBe("None");
    expect(pyReprDeep(true)).toBe("True");
    expect(pyReprDeep(3.5)).toBe("3.5");
    expect(pyReprDeep("it's")).toBe('"it\'s"');
    expect(pyReprDeep("both'and\"")).toBe("'both\\'and\"'");
    expect(pyReprDeep("a\nb")).toBe("'a\\nb'");
    expect(pyReprDeep({ b: 1, a: [true, null] })).toBe("{'b': 1, 'a': [True, None]}");
    expect(pyReprDeep({})).toBe("{}");
    expect(pyReprDeep([])).toBe("[]");
  });
});

describe("constants 判定族", () => {
  it("isConnectionError：六模式 + ConnectionError 构造名 + 非连接", () => {
    expect(isConnectionError(new Error("WebSocket connection closed"))).toBe(true);
    expect(isConnectionError(new Error("browser has been closed"))).toBe(true);
    expect(isConnectionError(new Error("No browser found"))).toBe(true);
    expect(isConnectionError(new Error("boom"))).toBe(false);
    const connErr = new Error("x");
    connErr.name = "ConnectionError";
    expect(isConnectionError(connErr)).toBe(true);
  });
  it("formatStepError：解析类标记附结构提示；普通错误原文", () => {
    expect(
      formatStepError(new Error("LLM returned no parseable response after retries")),
    ).toContain("invalid output structure");
    expect(formatStepError(new Error("Could not parse output"))).toContain(
      "Please stick to the required output format.",
    );
    expect(formatStepError(new Error("plain failure"))).toBe("plain failure");
  });
  it("StepTimeoutError/InterruptedError 构造与 name", () => {
    const t = new StepTimeoutError("LLM call timed out after 30s. Keep your output concise.");
    expect(t.name).toBe("StepTimeoutError");
    expect(new InterruptedError("user").message).toBe("user");
    expect(new InterruptedError().message).toBe("");
  });
});

describe("judge 边界", () => {
  it("空 history → judge 返 null（prompt 无法构建）", async () => {
    const judge = new JudgeEvaluator(
      {
        singleShot: async () => ({ text: "", toolCalls: [], stopReason: "stop", usage: null }),
      } as never,
      null,
    );
    expect(await judge.judge("t", new AgentHistoryList(), null)).toBeNull();
  });
  it('判词文本字段：字面 "null"（含空白/大小写变体）归 null，正常串透传（issue #9 D6）', async () => {
    const mk = (args: Record<string, unknown>) =>
      new JudgeEvaluator(
        {
          singleShot: async () => ({
            text: "",
            toolCalls: [{ name: "agent_response", args }],
            stopReason: "tool_use",
            usage: null,
          }),
        } as never,
        null,
      );
    const history = new AgentHistoryList({
      history: [
        new AgentHistory({
          stepNumber: 1,
          modelOutput: { next_goal: "g", action: { name: "wait", params: {} } } as never,
          result: [new ActionResult({ isDone: true, success: true, extractedContent: "x" })],
          stateSummary: { url: "https://x.example/1", title: "T", duration: 1 },
        }),
      ],
    });
    // prompt 示例 `"... or null"` 被模型照抄的实测形态（2026-10-25 快照实读）
    const literalNull = await mk({
      reasoning: "null",
      verdict: false,
      failure_reason: " NULL ",
      impossible_task: false,
      captcha: false,
    }).judge("t", history, null);
    expect(literalNull).toEqual({
      reasoning: null,
      verdict: false,
      failureReason: null,
      impossibleTask: false,
      captcha: false,
    });
    const passthrough = await mk({
      reasoning: "封面弹层从未打开",
      verdict: false,
      failure_reason: "证据不足",
    }).judge("t", history, null);
    expect(passthrough).toMatchObject({ reasoning: "封面弹层从未打开", failureReason: "证据不足" });
  });
  it("trace 超 traceMaxChars → 尾部截断 + Step 边界对齐 + 截断标记", () => {
    const judge = new JudgeEvaluator(null as never, {
      traceMaxChars: 400,
      enabled: true,
      model: "",
      maxHistorySteps: 20,
    });
    const history = new AgentHistoryList({
      history: [0, 1, 2, 3, 4].map(
        (n) =>
          new AgentHistory({
            stepNumber: n,
            modelOutput: { next_goal: `goal-${n}`, action: { name: "wait", params: {} } } as never,
            result: [new ActionResult({ extractedContent: "x".repeat(150) })],
            stateSummary: { url: `https://x.example/${n}`, title: "T", duration: 1 },
          }),
      ),
    });
    const prompt = judge.buildJudgePrompt("task", history, null)!;
    expect(prompt).toContain("[trace truncated, kept most recent steps]");
    expect(prompt).not.toContain("goal-0"); // 头部步被截
    // 截断后从某个 Step 边界对齐开始（保留的是尾部步，序号递增出现）
    const stepIdx = prompt
      .split("\n")
      .filter((l) => /^Step \d+:$/.test(l.trim()))
      .map((l) => Number(l.trim().slice(5, -1)));
    expect(stepIdx).toEqual([...stepIdx].sort((a, b) => a - b));
    expect(stepIdx.length).toBeGreaterThan(0);
    expect(stepIdx[stepIdx.length - 1]).toBe(4);
  });
});
