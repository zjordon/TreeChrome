// continuity 单测（issue #35 U1a W8）：无前情 null/终态过滤/finalResult 拼接/
// 8K 预算从最老条目整条丢（保最近）/withContinuity 零行为面。

import { describe, expect, it } from "vitest";
import {
  buildContinuityBlock,
  CONTINUITY_BUDGET_CHARS,
  type ContinuityTurn,
  withContinuity,
} from "../src/runtime/continuity.js";

describe("buildContinuityBlock", () => {
  it("空/全非终态 → null（零行为面）", () => {
    expect(buildContinuityBlock([])).toBeNull();
    expect(
      buildContinuityBlock([
        { task: "进行中", finalResult: null, status: "running" },
        { task: "排队", finalResult: null, status: "queued" },
      ]),
    ).toBeNull();
  });

  it("单条 done：块形态含任务与结果；失败任务无结果时列状态", () => {
    const block = buildContinuityBlock([{ task: "查价", finalResult: "答：42", status: "done" }]);
    expect(block).toContain("[会话前情·自动注入]");
    expect(block).toContain("此前任务：查价");
    expect(block).toContain("结果：答：42");
    expect(block?.endsWith("[当前任务]")).toBe(true);
    const failed = buildContinuityBlock([{ task: "失败任务", finalResult: null, status: "error" }]);
    expect(failed).toContain("此前任务：失败任务（error，无结果）");
  });

  it("多条按时间序拼接（旧→新）", () => {
    const block = buildContinuityBlock([
      { task: "第一", finalResult: "R1", status: "done" },
      { task: "第二", finalResult: "R2", status: "done" },
    ]);
    const lines = block?.split("\n") ?? [];
    expect(lines.indexOf("此前任务：第一")).toBeLessThan(lines.indexOf("此前任务：第二"));
  });

  it("超 8K 预算：从最老条目起整条丢弃，最近上下文保住", () => {
    const turns: ContinuityTurn[] = Array.from({ length: 10 }, (_, i) => ({
      task: `任务${i}`,
      finalResult: "R".repeat(1500),
      status: "done" as const,
    }));
    const block = buildContinuityBlock(turns);
    expect(block).not.toBeNull();
    expect(block?.length ?? 0).toBeLessThanOrEqual(CONTINUITY_BUDGET_CHARS + 30);
    expect(block).toContain("此前任务：任务9"); // 最新保住
    expect(block).not.toContain("此前任务：任务0"); // 最老被整条丢
    expect(block).not.toContain("任务4"); // 中段按预算截
  });

  it("单条就超预算：至少保住一条（不为凑预算全空）", () => {
    const block = buildContinuityBlock([
      { task: "巨任务", finalResult: "R".repeat(10_000), status: "done" },
    ]);
    expect(block).not.toBeNull();
    expect(block).toContain("巨任务");
    // finalResult 自身 2000 裁剪兜底
    expect(block?.length ?? 0).toBeLessThan(3000);
  });
});

describe("withContinuity", () => {
  it("block null → 原样；有块 → 块前任务后", () => {
    expect(withContinuity("任务", null)).toBe("任务");
    const out = withContinuity("任务", "[会话前情·自动注入]\nX\n[当前任务]");
    expect(out.startsWith("[会话前情·自动注入]")).toBe(true);
    expect(out.endsWith("任务")).toBe(true);
  });
});
