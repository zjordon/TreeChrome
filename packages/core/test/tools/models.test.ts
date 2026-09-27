// models 层锚定测试：25 动作 schema/description/terminates 逐字节对拍 Python 实跑
// fixture（gen-tools-anchors.py）；validateParams 错误文案对拍 pydantic 样例；
// 变体 B（makeStructuredDoneParams）schema 与描述文本；lax 强转语义。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACTION_DEFINITIONS,
  makeStructuredDoneParams,
  type ParamModel,
  paramJsonSchema,
  validateParams,
} from "../../src/tools/models.js";

const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/python-anchors/tools.json", import.meta.url)),
    "utf8",
  ),
) as {
  actions: Record<
    string,
    { className: string; description: string; terminates: boolean; schema: unknown }
  >;
  structuredDone: { className: string; schema: unknown; descriptionsText: string };
  validate: Record<string, { error: string | null; input: unknown }>;
};

const stableStringify = (v: unknown): string => JSON.stringify(v);

describe("ACTION_DEFINITIONS schema 锚定（25 动作逐字节）", () => {
  const pyNames = Object.keys(FIXTURE.actions);
  it("动作名集合与键序与 Python 一致", () => {
    expect(Object.keys(ACTION_DEFINITIONS)).toEqual(pyNames);
  });
  for (const name of pyNames) {
    it(`${name}：schema/description/terminates 对拍`, () => {
      const def = ACTION_DEFINITIONS[name];
      const anchor = FIXTURE.actions[name];
      expect(def.params.name).toBe(anchor.className);
      expect(def.description).toBe(anchor.description);
      expect(def.terminatesSequence).toBe(anchor.terminates);
      expect(stableStringify(paramJsonSchema(def.params))).toBe(stableStringify(anchor.schema));
    });
  }
});

describe("capability 映射（04 §1.1 batch1 面）", () => {
  it("batch1 十动作的 capability 符合冻结表", () => {
    expect(ACTION_DEFINITIONS.navigate.capability).toEqual(["NAVIGATE"]);
    expect(ACTION_DEFINITIONS.click.capability).toEqual(["CLICK"]);
    expect(ACTION_DEFINITIONS.input_text.capability).toEqual(["TYPE"]);
    expect(ACTION_DEFINITIONS.scroll.capability).toEqual(["READ"]);
    expect(ACTION_DEFINITIONS.extract.capability).toEqual(["READ"]);
    expect(ACTION_DEFINITIONS.wait.capability).toEqual(["READ"]);
    expect(ACTION_DEFINITIONS.go_back.capability).toEqual(["NAVIGATE"]);
    expect(ACTION_DEFINITIONS.switch_tab.capability).toEqual(["NAVIGATE"]);
    expect(ACTION_DEFINITIONS.send_keys.capability).toEqual(["CLICK", "TYPE"]); // 按键型分流
    expect(ACTION_DEFINITIONS.done.capability).toEqual([]); // 不过门
  });
  it("terminates=True 共 6 个（navigate/search/switch_tab/go_back/evaluate/read_grid）", () => {
    const terminating = Object.entries(ACTION_DEFINITIONS)
      .filter(([, d]) => d.terminatesSequence)
      .map(([n]) => n);
    expect(terminating.sort()).toEqual([
      "evaluate",
      "go_back",
      "navigate",
      "read_grid",
      "search",
      "switch_tab",
    ]);
  });
});

describe("validateParams 错误文案锚定（pydantic v2 实跑样例）", () => {
  const modelOf = (name: string): ParamModel => ACTION_DEFINITIONS[name].params;
  for (const [key, anchor] of Object.entries(FIXTURE.validate)) {
    const [actionName, ...rest] = key.split("-");
    // 用例键形如 "click-both-missing"——还原动作名（含下划线动作取最后一段反查）
    it(`${key}`, () => {
      // 动作名 = 去掉最后一段后的前缀（click-both-missing → click；find-elements-max-range → find_elements）
      const segs = key.split("-");
      const candidates = [
        "find_elements",
        "select_dropdown",
        "sendkeys",
        "switchtab",
        "navigate",
        "click",
        "scroll",
        "extract",
        "wait",
        "dropdown",
        "done",
        "screenshot",
        "evaluate",
      ];
      let action = "";
      for (let i = segs.length - 1; i >= 1; i--) {
        const prefix = segs.slice(0, i).join("-");
        const norm =
          prefix === "find-elements"
            ? "find_elements"
            : prefix === "dropdown"
              ? "select_dropdown"
              : prefix === "sendkeys"
                ? "send_keys"
                : prefix === "switchtab"
                  ? "switch_tab"
                  : prefix;
        if (ACTION_DEFINITIONS[norm] !== undefined) {
          action = norm;
          break;
        }
      }
      expect(action).not.toBe("");
      void rest;
      const result = validateParams(modelOf(action), anchor.input);
      if (anchor.error === null) {
        expect(result.ok).toBe(true);
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.errors.join("; ")).toBe(anchor.error);
        }
      }
    });
  }
});

describe("validateParams 语义补充（fixture 外的关键边界）", () => {
  const click = ACTION_DEFINITIONS.click.params;
  it("extra 字段在字段错误之后仍收报", () => {
    const r = validateParams(click, { index: "abc", foo: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toEqual([
        "index: Input should be a valid integer, unable to parse string as an integer",
        "foo: Extra inputs are not permitted",
      ]);
    }
  });
  it("模型级校验器在字段错误存在时不运行（pydantic mode=after 语义）", () => {
    const r = validateParams(click, { index: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("exactly one"))).toBe(false);
  });
  it("数值字段 lax 强转：数字串/浮点整数通过", () => {
    const scroll = ACTION_DEFINITIONS.scroll.params;
    expect(validateParams(scroll, { amount: "3" }).ok).toBe(true);
    expect(validateParams(scroll, { amount: 3.0 }).ok).toBe(true);
    expect(validateParams(scroll, { amount: 3.5 }).ok).toBe(false);
  });
  it("布尔字段 lax 强转：'true'/'off' 等", () => {
    const nav = ACTION_DEFINITIONS.navigate.params;
    expect(validateParams(nav, { url: "https://x", new_tab: "true" }).ok).toBe(true);
    expect(validateParams(nav, { url: "https://x", new_tab: "off" }).ok).toBe(true);
    const ok = validateParams(nav, { url: "https://x", new_tab: "true" });
    expect(ok.ok && ok.value.new_tab).toBe(true);
  });
  it("缺省补齐：可选字段填 default/[]，返回清洗值", () => {
    const nav = ACTION_DEFINITIONS.navigate.params;
    const r = validateParams(nav, { url: "https://x" });
    expect(r.ok && r.value).toEqual({ url: "https://x", new_tab: false });
    const done = ACTION_DEFINITIONS.done.params;
    const r2 = validateParams(done, { text: "hi" });
    expect(r2.ok && r2.value.files_to_display).toEqual([]);
    expect(r2.ok && r2.value.success).toBe(true);
  });
  it("already_collected 滤空项、全空归 null（_drop_empty_items）", () => {
    const extract = ACTION_DEFINITIONS.extract.params;
    const r = validateParams(extract, { query: "q", already_collected: ["", " a ", "b"] });
    expect(r.ok && r.value.already_collected).toEqual([" a ", "b"]);
    const r2 = validateParams(extract, { query: "q", already_collected: ["", "  "] });
    expect(r2.ok && r2.value.already_collected).toBe(null);
  });
  it("非对象输入整体拒绝", () => {
    const r = validateParams(ACTION_DEFINITIONS.wait.params, "nope" as unknown);
    expect(r.ok).toBe(false);
  });
});

describe("makeStructuredDoneParams（变体 B）", () => {
  const sampleOutput: ParamModel = {
    name: "SampleOutput",
    fields: [
      { name: "total", type: "integer", required: true },
      { name: "note", type: "string", default: "" },
    ],
  };
  it("schema 对拍 fixture（$defs 嵌套 + data 直接 $ref）", () => {
    const structured = makeStructuredDoneParams(sampleOutput);
    expect(structured.name).toBe(FIXTURE.structuredDone.className);
    expect(stableStringify(paramJsonSchema(structured))).toBe(
      stableStringify(FIXTURE.structuredDone.schema),
    );
  });
  it("data 缺失 → Field required；非法 data 类型嵌套路径报错", () => {
    const structured = makeStructuredDoneParams(sampleOutput);
    const r = validateParams(structured, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual(["data: Field required"]);
    const r2 = validateParams(structured, { data: { total: "x" } });
    expect(r2.ok).toBe(false);
    if (!r2.ok)
      expect(r2.errors.join("; ")).toBe(
        "data.total: Input should be a valid integer, unable to parse string as an integer",
      );
  });
});
