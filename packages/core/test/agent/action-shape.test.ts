// 动作形态叶子模块测试：期望值锚定 Python 实跑（TreeWalker @640d52a）。
// 锚定值再生成（刻意更新基准时须在提交信息注明原因）：
//   D:/dev/git/z_jordon/evals/webarena/.venv/Scripts/python.exe packages/core/tools/gen-anchors.py
// （入库工具，对齐 dom-snapshot gen_fixtures.py 惯例；fixture 落 test/fixtures/python-anchors/action-shape.json）

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  actionsOf,
  describeActionEntry,
  honestDoneAction,
  isHonestFailureAction,
  nameOf,
  normalizeActionsList,
  normalizeModelOutput,
  paramsOf,
} from "../../src/agent/action-shape.js";

interface NormalizeCase {
  input: Record<string, unknown>;
  context: "live" | "history";
  known: string[] | null;
  output: Record<string, unknown>;
}

const anchor = JSON.parse(
  readFileSync(new URL("../fixtures/python-anchors/action-shape.json", import.meta.url), "utf8"),
) as {
  normalize: NormalizeCase[];
  accessors: {
    inputs: Record<string, Array<Record<string, unknown>>>;
    expected: Record<string, unknown[]>;
  };
};

describe("normalizeModelOutput（Python 锚定）", () => {
  for (const [idx, c] of anchor.normalize.entries()) {
    it(`case ${idx}: ${JSON.stringify(c.input).slice(0, 60)} @${c.context ?? "live"}`, () => {
      const work = structuredClone(c.input);
      const ret = normalizeModelOutput(work, {
        context: c.context ?? "live",
        knownNames: c.known ? new Set(c.known) : undefined,
      });
      expect(ret).toBe(work); // 原地修改并返回同一对象
      expect(work).toEqual(c.output);
    });
  }
});

describe("访问器（Python 锚定）", () => {
  it("nameOf", () => {
    for (const [i, c] of anchor.accessors.inputs.name_of.entries()) {
      expect(nameOf(c.action)).toEqual(anchor.accessors.expected.name_of[i]);
    }
  });
  it("paramsOf", () => {
    for (const [i, c] of anchor.accessors.inputs.params_of.entries()) {
      expect(paramsOf(c.action)).toEqual(anchor.accessors.expected.params_of[i]);
    }
  });
  it("actionsOf", () => {
    for (const [i, c] of anchor.accessors.inputs.actions_of.entries()) {
      expect(actionsOf(c.mo)).toEqual(anchor.accessors.expected.actions_of[i]);
    }
  });
  it("describeActionEntry", () => {
    for (const [i, c] of anchor.accessors.inputs.describe_action_entry.entries()) {
      expect(describeActionEntry(c.entry)).toEqual(
        anchor.accessors.expected.describe_action_entry[i],
      );
    }
  });
});

describe("带外标记与策略表行为（fixture 之外的不可序列化语义）", () => {
  it("honest-done 按对象身份判定，结构克隆/JSON 往返即丢失标记", () => {
    const honest = honestDoneAction();
    expect(isHonestFailureAction(honest)).toBe(true);
    expect(isHonestFailureAction({ ...honest })).toBe(false);
    expect(isHonestFailureAction(JSON.parse(JSON.stringify(honest)))).toBe(false);
    expect(isHonestFailureAction({ name: "done", params: {} })).toBe(false);
  });

  it("normalizeActionsList 单元素非字符串（live）产出带标记的诚实失败 done", () => {
    const list: unknown[] = [123];
    normalizeActionsList(list, { context: "live" });
    expect(isHonestFailureAction(list[0])).toBe(true);
    expect(list[0]).toEqual({
      name: "done",
      params: { text: "Invalid action shape", success: false },
    });
  });

  it("known_names 归一化幂等：幸存者二次归一化 no-op", () => {
    const known = new Set(["click", "done"]);
    const mo = structuredClone({
      actions: [{ name: "click", params: "bad" }, { name: "ghost" }],
    });
    normalizeModelOutput(mo, { knownNames: known });
    const once = structuredClone(mo);
    normalizeModelOutput(mo, { knownNames: known });
    expect(mo).toEqual(once);
  });

  it("dropUnregistered 原地 splice（数组引用不变；缺省 params 补 {} 与 Python 同款）", () => {
    const list: unknown[] = [{ name: "click" }, { name: "ghost" }, { name: "done" }];
    const ref = list;
    normalizeActionsList(list, { knownNames: new Set(["click", "done"]) });
    expect(ref).toBe(list);
    expect(list).toEqual([
      { name: "click", params: {} },
      { name: "done", params: {} },
    ]);
  });

  it("畸形日志只记类型不记值（params 真值不进日志）", () => {
    const messages: string[] = [];
    normalizeActionsList([{ name: "click", params: "SECRET" }], {
      context: "live",
      log: (m) => messages.push(m),
    });
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m) => m.includes("SECRET"))).toBe(false);
    expect(messages.some((m) => m.includes("params malformed (str)"))).toBe(true);
  });
});
