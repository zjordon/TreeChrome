// agent 数据模型层测试：期望值锚定 Python 实跑（TreeWalker @640d52a）。
// 锚定值再生成（刻意更新基准时须在提交信息注明原因）：
//   D:/dev/git/z_jordon/evals/webarena/.venv/Scripts/python.exe packages/core/tools/gen-anchors.py
// （fixture 落 test/fixtures/python-anchors/views.json；输入键为 Python snake_case，
// 经 initFromPy 映射到 TS camelCase 构造面——序列化键的对齐在 4.4 轨迹转换层）

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ActionResultInit } from "../../src/agent/views.js";
import {
  ActionResult,
  AgentHistory,
  AgentHistoryList,
  AgentState,
  redactSensitiveString,
  StepMetadata,
} from "../../src/agent/views.js";

const anchor = JSON.parse(
  readFileSync(new URL("../fixtures/python-anchors/views.json", import.meta.url), "utf8"),
) as {
  renders: Array<{ input: Record<string, unknown>; expected: string }>;
  redact: Array<{ value: string; map: Record<string, string>; expected: string }>;
  history_normalization: {
    input_model_output: Record<string, unknown>;
    input_after_construction: Record<string, unknown>;
    constructed_model_output: Record<string, unknown>;
  };
  history_list: Record<string, unknown>;
  action_result_validator_first_line: string | null;
};

function initFromPy(py: Record<string, unknown>): ActionResultInit {
  return {
    isDone: py.is_done as boolean | undefined,
    success: py.success as boolean | null | undefined,
    error: py.error as string | null | undefined,
    extractedContent: py.extracted_content as string | null | undefined,
    longTermMemory: py.long_term_memory as string | null | undefined,
    judgement: py.judgement,
    metadata: py.metadata as Record<string, unknown> | null | undefined,
    attachments: py.attachments as string[] | null | undefined,
  };
}

describe("ActionResult.render（Python __str__ 锚定，含 True/False/None 字面量与截断标记）", () => {
  for (const [idx, c] of anchor.renders.entries()) {
    it(`render case ${idx}`, () => {
      expect(new ActionResult(initFromPy(c.input)).render()).toBe(c.expected);
    });
  }
  it("render 不含 metadata/long_term_memory（有界显示）", () => {
    const r = new ActionResult({ metadata: { q: 1 }, longTermMemory: "m" });
    expect(r.render()).toBe("OK");
  });
});

describe("ActionResult 构造校验", () => {
  it("success=true 且 isDone=false 拒绝（核心文案与 Python 一致）", () => {
    expect(() => new ActionResult({ success: true })).toThrow(
      /success=True can only be set when is_done=True/,
    );
    expect(anchor.action_result_validator_first_line).toBeTruthy();
  });
  it("success=true + isDone=true 放行；success=false 无需 isDone", () => {
    expect(() => new ActionResult({ success: true, isDone: true })).not.toThrow();
    expect(() => new ActionResult({ success: false })).not.toThrow();
  });
  it("judgement 构造后可变（Judge 回写挂点）", () => {
    const r = new ActionResult();
    r.judgement = { verdict: "pass" };
    expect(r.judgement).toEqual({ verdict: "pass" });
  });
});

describe("redactSensitiveString（Python 锚定：长度降序防前缀泄露 + 全量替换）", () => {
  for (const [idx, c] of anchor.redact.entries()) {
    it(`redact case ${idx}`, () => {
      expect(redactSensitiveString(c.value, c.map)).toBe(c.expected);
    });
  }
});

describe("AgentHistory 构造收口（拷贝归一化，Python 锚定）", () => {
  it("畸形归一化输出与 Python 全等", () => {
    const h = new AgentHistory({
      stepNumber: 1,
      modelOutput: structuredClone(anchor.history_normalization.input_model_output),
      result: [new ActionResult()],
    });
    expect(h.modelOutput).toEqual(anchor.history_normalization.constructed_model_output);
  });
  it("不腐蚀调用方传入的 model_output（拷贝归一化）", () => {
    const mo = structuredClone(anchor.history_normalization.input_model_output);
    new AgentHistory({ stepNumber: 1, modelOutput: mo, result: [new ActionResult()] });
    expect(mo).toEqual(anchor.history_normalization.input_after_construction);
  });
  it("result 数组接受 init 对象并收窄为 ActionResult", () => {
    const h = new AgentHistory({
      stepNumber: 2,
      modelOutput: { actions: [{ name: "wait" }] },
      result: [{ isDone: true, success: true, extractedContent: "x" }],
    });
    expect(h.result[0]).toBeInstanceOf(ActionResult);
    expect(h.metadata).toBeNull();
    expect(h.interactedElement).toBeNull();
    expect(h.screenshotPath).toBeNull();
  });
});

describe("AgentHistoryList 判定（runner 契约消费面，Python 锚定）", () => {
  it("finalResult/isDone/isSuccessful 与 Python 全等", () => {
    const done = new AgentHistory({
      stepNumber: 2,
      modelOutput: { actions: [{ name: "done" }] },
      result: [{ isDone: true, extractedContent: "final answer", success: true }],
    });
    const open = new AgentHistory({
      stepNumber: 1,
      modelOutput: { actions: [{ name: "wait" }] },
      result: [{ extractedContent: "still working" }],
    });
    const list = new AgentHistoryList({ history: [open, done] });
    const expected = anchor.history_list;
    expect(list.finalResult()).toBe(expected.final_result);
    expect(list.isDone()).toBe(expected.is_done);
    expect(list.isSuccessful()).toBe(expected.is_successful);
  });
});

describe("AgentState / StepMetadata 默认面", () => {
  it("AgentState 默认值（含 #194/#186/#174 计数器）", () => {
    const s = new AgentState();
    expect(s.nSteps).toBe(0);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.infraFailures).toBe(0);
    expect(s.doneGateUses).toBe(0);
    expect(s.finalizeDegradedSteps).toBe(0);
    expect(s.stopped).toBe(false);
    expect(s.paused).toBe(false);
    expect(s.downloadedFiles).toEqual([]);
    expect(s.plan).toBeNull();
  });
  it("StepMetadata.durationSeconds = end - start；可选字段缺省 null", () => {
    const m = new StepMetadata({ stepStartTime: 10, stepEndTime: 13.5, stepNumber: 1 });
    expect(m.durationSeconds).toBe(3.5);
    expect(m.stepInterval).toBeNull();
    expect(m.userPauseSeconds).toBeNull();
  });
});
