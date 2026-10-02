// models 层锚定测试：25 动作 schema/description/terminates 逐字节对拍 Python 实跑
// fixture（gen-tools-anchors.py）；validateParams 错误文案对拍 pydantic 样例；
// 变体 B（makeStructuredDoneParams）schema 与描述文本；lax 强转语义。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACTION_DEFINITIONS,
  compactModelSchema,
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
  /** 用例键形如 "click-both-missing"——按段前缀还原动作名（find_elements 等下划线动作取多段） */
  const actionOf = (key: string): string => {
    const segs = key.split("-");
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
        return norm;
      }
    }
    return "";
  };
  for (const [key, anchor] of Object.entries(FIXTURE.validate)) {
    it(`${key}`, () => {
      const action = actionOf(key);
      expect(action).not.toBe("");
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
  it("布尔字段 lax 数值强转：1/0/1.0 接受，2 报 bool_parsing 分档文案（venv 实测）", () => {
    const nav = ACTION_DEFINITIONS.navigate.params;
    expect(validateParams(nav, { url: "https://x", new_tab: 1 }).ok).toBe(true);
    expect(validateParams(nav, { url: "https://x", new_tab: 0 }).ok).toBe(true);
    expect(validateParams(nav, { url: "https://x", new_tab: 1.0 }).ok).toBe(true);
    const bad = validateParams(nav, { url: "https://x", new_tab: 2 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors).toEqual([
        "new_tab: Input should be a valid boolean, unable to interpret input",
      ]);
    }
    const badObj = validateParams(nav, { url: "https://x", new_tab: {} });
    if (!badObj.ok) {
      expect(badObj.errors).toEqual(["new_tab: Input should be a valid boolean"]);
    }
  });
  it("数组 integer 元素 lax 强转值回写（清洗值 = [42, 7]，venv 实测对齐）", () => {
    const model: ParamModel = {
      name: "Ids",
      fields: [{ name: "ids", type: "array", items: { type: "integer" }, defaultEmptyList: true }],
    };
    const r = validateParams(model, { ids: ["42", 7] });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.ids).toEqual([42, 7]);
    const bad = validateParams(model, { ids: ["42", "x"] });
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(bad.errors).toEqual([
        "ids.1: Input should be a valid integer, unable to parse string as an integer",
      ]);
  });
  it("容器本层类型错误 loc 单级（`{loc}: {msg}`，非 `.` 拼接——venv 实测 pydantic 形态）", () => {
    const done = ACTION_DEFINITIONS.done.params;
    const r = validateParams(done, { text: "ok", files_to_display: "report.pdf" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual(["files_to_display: Input should be a valid list"]);
    const shot = ACTION_DEFINITIONS.screenshot.params;
    const r2 = validateParams(shot, { clip: "0,0,100,200" });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errors).toEqual(["clip: Input should be a valid dictionary"]);
    // 嵌套子层错误仍走 `.` 形态（fixture 锚定 screenshot-clip-nested）
    const r3 = validateParams(shot, { clip: { x: 0, y: 0, width: -1, height: 10 } });
    if (!r3.ok) expect(r3.errors).toEqual(["clip.width: Input should be greater than 0"]);
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

describe("compactModelSchema（变体 B 文本注入，偏离 F9.3）", () => {
  it("structured-output 的 Posts 形态：list[Post] 嵌套逐字段展开", () => {
    const Post: ParamModel = {
      name: "Post",
      fields: [
        { name: "post_title", type: "string", required: true },
        { name: "post_url", type: "string", required: true },
        { name: "num_comments", type: "integer", required: true },
        { name: "hours_since_post", type: "integer", required: true },
      ],
    };
    const Posts: ParamModel = {
      name: "Posts",
      fields: [{ name: "posts", type: "array", required: true, refModel: Post }],
    };
    expect(compactModelSchema(Posts)).toBe(
      '{"posts": [{"post_title": string, "post_url": string, ' +
        '"num_comments": integer, "hours_since_post": integer}]}',
    );
  });

  it("可选 `?` / 可空 `|null` / 标量数组 / 枚举 / 直接 ref / items 缺省 any", () => {
    const Inner: ParamModel = {
      name: "Inner",
      fields: [{ name: "x", type: "integer", required: true }],
    };
    const m: ParamModel = {
      name: "M",
      fields: [
        { name: "opt", type: "string" },
        { name: "nul", type: "string", required: true, nullable: true },
        { name: "tags", type: "array", required: true, items: { type: "string" } },
        { name: "anyItems", type: "array", required: true, items: {} },
        { name: "mode", type: "literal", required: true, enumValues: ["a", "b"] },
        { name: "inner", type: "ref", required: true, refModel: Inner },
      ],
    };
    expect(compactModelSchema(m)).toBe(
      '{"opt": string?, "nul": string|null, "tags": [string], ' +
        '"anyItems": [any], "mode": a|b, "inner": {"x": integer}}',
    );
  });
});
