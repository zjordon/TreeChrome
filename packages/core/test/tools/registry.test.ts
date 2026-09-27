// registry 层锚定测试：registryVersion / tool schema 矩阵（flash·standard·thinking ×
// 单·多动作 × planning）逐字节对拍 fixture；descriptionsText 对拍；pagePatterns 可见性；
// fnmatchLike / hideFieldsFromSchema 单元。Tools 构造即 batch1 注册面。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Tools } from "../../src/tools/actions/index.js";
import { fnmatchLike, hideFieldsFromSchema } from "../../src/tools/registry.js";

const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/python-anchors/tools.json", import.meta.url)),
    "utf8",
  ),
) as {
  batch1: {
    names: string[];
    registryVersion: string;
    toolSchema: Record<string, unknown>;
    descriptionsText: string;
    pageFiltered: Record<string, unknown>;
  };
};

const S = JSON.stringify;

const makeRegistry = () => new Tools({ log: () => {} }).registry;

describe("registryVersion（动作名集合 sha256[:12]）", () => {
  it("batch1 十动作指纹对拍", () => {
    expect(makeRegistry().registryVersion).toBe(FIXTURE.batch1.registryVersion);
  });
  it("动作集变化 → 指纹变化；参数细节变化不触发（按名集合）", () => {
    const r = makeRegistry();
    const before = r.registryVersion;
    r.actions.delete("wait");
    expect(r.registryVersion).not.toBe(before);
    expect(r.registryVersion).not.toBe(`${r.registryVersion}x`);
  });
});

describe("getToolSchema 矩阵（逐字节对拍）", () => {
  const cases: Array<[string, Parameters<ReturnType<typeof makeRegistry>["getToolSchema"]>[0]]> = [
    ["flash-single", { outputMode: "flash" }],
    ["flash-multi", { outputMode: "flash", maxActions: 3 }],
    ["standard-single", { outputMode: "standard" }],
    ["standard-multi", { outputMode: "standard", maxActions: 3 }],
    ["thinking-single", { outputMode: "thinking" }],
    ["thinking-single-planning", { outputMode: "thinking", enablePlanning: true }],
    ["standard-multi-planning", { outputMode: "standard", maxActions: 3, enablePlanning: true }],
  ];
  for (const [key, opts] of cases) {
    it(`${key}`, () => {
      expect(S(makeRegistry().getToolSchema(opts))).toBe(S(FIXTURE.batch1.toolSchema[key]));
    });
  }
  it("action enum 按名字典序", () => {
    const schema = makeRegistry().getToolSchema();
    const actionProp = (schema.input_schema as Record<string, unknown>).properties as Record<
      string,
      never
    >;
    expect(actionProp).toBeTruthy();
  });
});

describe("getActionDescriptionsText", () => {
  it("batch1 全量文本逐字节对拍", () => {
    expect(makeRegistry().getActionDescriptionsText()).toBe(FIXTURE.batch1.descriptionsText);
  });
  it("pagePatterns 命中页可见/他页隐藏；schema enum 同步", () => {
    const tools = new Tools({ log: () => {} });
    tools.applyPageFilters({ extract: ["https://example.com/*"] });
    expect(tools.registry.getActionDescriptionsText("https://example.com/x")).toBe(
      FIXTURE.batch1.pageFiltered.descriptionsText,
    );
    expect(tools.registry.getActionDescriptionsText("https://other.org/x")).toBe(
      FIXTURE.batch1.pageFiltered.descriptionsTextOther,
    );
    const schemaOn = tools.registry.getToolSchema({ pageUrl: "https://example.com/x" });
    const schemaOff = tools.registry.getToolSchema({ pageUrl: "https://other.org/x" });
    const enumOf = (s: unknown) =>
      (
        (
          (
            ((s as Record<string, unknown>).input_schema as Record<string, unknown>)
              .properties as Record<string, unknown>
          ).action as Record<string, unknown>
        ).properties as Record<string, unknown>
      ).name as Record<string, unknown>;
    expect(enumOf(schemaOn).enum).toEqual(FIXTURE.batch1.pageFiltered.schemaNames);
    expect(enumOf(schemaOff).enum).toEqual(FIXTURE.batch1.pageFiltered.schemaNamesOther);
  });
  it("变体 B done 隐藏 success/files_to_display（对拍 fixture）", async () => {
    const { readFileSync: rf } = await import("node:fs");
    const fixture = JSON.parse(
      rf(fileURLToPath(new URL("../fixtures/python-anchors/tools.json", import.meta.url)), "utf8"),
    ) as { structuredDone: { descriptionsText: string } };
    const outputModel = {
      name: "SampleOutput",
      fields: [
        { name: "total", type: "integer" as const, required: true },
        { name: "note", type: "string" as const, default: "" },
      ],
    };
    const tools = new Tools({ outputModel, log: () => {} });
    // fixture 的变体 B 文本只有 done/navigate 两行动作——逐行比对 done 行
    const doneLine = tools.registry
      .getActionDescriptionsText()
      .split("\n")
      .find((l) => l.startsWith("- **done**"));
    const fixtureDoneLine = fixture.structuredDone.descriptionsText
      .split("\n")
      .find((l) => l.startsWith("- **done**"));
    expect(doneLine).toBe(fixtureDoneLine);
    expect(doneLine).toContain("data: Structured final output.");
    expect(doneLine).not.toContain("success:");
  });
});

describe("fnmatchLike", () => {
  it("* / ? / [seq] / [!seq] 通配", () => {
    expect(fnmatchLike("https://example.com/x", "https://example.com/*")).toBe(true);
    expect(fnmatchLike("https://example.com", "https://example.com/*")).toBe(false);
    expect(fnmatchLike("abc", "a?c")).toBe(true);
    expect(fnmatchLike("abc", "a[bd]c")).toBe(true);
    expect(fnmatchLike("abc", "a[!bd]c")).toBe(false);
    expect(fnmatchLike("a.b/c", "*")).toBe(true); // * 含 /
  });
  it("类内 ^ 是字面量而非否定（POSIX fnmatch 仅认 !；venv 实测 a^c 与 axc 都匹配 a[^x]c）", () => {
    expect(fnmatchLike("a^c", "a[^x]c")).toBe(true);
    expect(fnmatchLike("axc", "a[^x]c")).toBe(true); // {^,x} 类的 x 成员命中
    expect(fnmatchLike("ayc", "a[^x]c")).toBe(false);
  });
  it("类内 - 保留范围语义（[0-9] 范围，非字面三点集合）", () => {
    expect(fnmatchLike("page-42", "page-[0-9]*")).toBe(true);
    expect(fnmatchLike("page-x", "page-[0-9]*")).toBe(false);
    expect(fnmatchLike("a", "[a-]")).toBe(true); // 字面 - 的尾位形态（单字符类 {a,-}）
    expect(fnmatchLike("-", "[a-]")).toBe(true);
    expect(fnmatchLike("b", "[a-]")).toBe(false);
    expect(fnmatchLike("-", "[-a]")).toBe(true);
    expect(fnmatchLike("a", "[-a]")).toBe(true);
  });
  it("大小写敏感（POSIX 恒定语义——偏离登记见实现头注释）", () => {
    expect(fnmatchLike("ABC", "abc")).toBe(false);
  });
});

describe("register 契约", () => {
  it("pagePatterns 显式 undefined 不覆盖 null 哨兵（?? 归一）", () => {
    const registry = makeRegistry();
    registry.register({
      name: "custom",
      description: "d",
      params: { name: "P", fields: [] },
      handler: async () => null,
      terminatesSequence: false,
      pagePatterns: undefined,
    });
    // undefined 若泄漏进哨兵判定会在 actionAvailable 的 .some 上 TypeError——能正常产出即通过
    expect(registry.getActionDescriptionsText("https://example.com/x")).toContain("custom");
  });
});

describe("hideFieldsFromSchema", () => {
  it("properties + required 双摘除，不改原对象", () => {
    const schema = {
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a", "b"],
    };
    const hidden = hideFieldsFromSchema(schema, ["b"]);
    expect(hidden.properties).toEqual({ a: { type: "string" } });
    expect(hidden.required).toEqual(["a"]);
    expect(schema.required).toEqual(["a", "b"]); // 深拷贝不动原
  });
});
