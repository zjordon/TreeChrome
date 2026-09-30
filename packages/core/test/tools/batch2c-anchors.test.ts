// P4b 段 3 锚定测试（batch2c.json——gen-batch2c-anchors.py venv 实跑 Python 参考实现）：
// 4 个网格 JS 体逐字节 / parseGridNumber 39 例 / footerRowRole 17 例 / 回显记忆与
// 图片抽取 / evaluate+read_grid 两 handler 全输出（FakeBrowser 队列 = Python
// StubBrowser 同形）/ 大结果落盘（路径占位 + 时间戳归一）。期望值一律取 fixture。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as GRID_JS from "../../src/browser/grid-read-js.js";
import { evalLongTermMemory, extractDataImages } from "../../src/tools/actions/evaluate.js";
import { gridFooterRowRole, parseGridNumber } from "../../src/tools/actions/grid.js";
import { FakeBrowser, makeTools } from "./fake-browser.js";
import { makeFakeFs } from "./fake-fs.js";

const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/python-anchors/batch2c.json", import.meta.url)),
    "utf8",
  ),
  // biome-ignore lint/suspicious/noExplicitAny: fixture 是外部 JSON 的弱形态读取面
) as Record<string, any>;

const normTs = (s: string): string => s.replace(/_(\d{10,})(?=\.)/, "_TS");

describe("网格四通道 JS 体（逐字节）", () => {
  for (const [name, value] of Object.entries(FIXTURE.js as Record<string, string>)) {
    it(`${name}（${value.length} 字节）`, () => {
      expect((GRID_JS as Record<string, unknown>)[name]).toBe(value);
    });
  }
});

describe("parseGridNumber（:688-728 全分支——39 例 venv 实跑）", () => {
  const inputs: unknown[] = [
    null,
    true,
    false,
    42,
    3.5,
    "42",
    " 42 ",
    "1,234",
    "1,234.5",
    "1,2345",
    "12,34",
    "1,234.5678",
    "$1,234.50",
    "€99",
    "45%",
    "50 %",
    "-42",
    "+42",
    "- $1,234.50",
    "1_000",
    "",
    "   ",
    "abc",
    "12.5.6",
    "NaN",
    "inf",
    "-inf",
    "1e3",
    "－5",
    "٣",
    "1,234 ",
    " 1,234 ",
    "$",
    "¥12,345.67",
    "12,345,678",
    "1,234,567",
    "0.005",
    "-0.5",
    "\t\r\n 42  ",
  ];
  inputs.forEach((v, i) => {
    const key = `c${i}`;
    it(`${key} ${JSON.stringify(String(v))} → ${JSON.stringify(FIXTURE.parseGridNumber[key] ?? null)}`, () => {
      expect(parseGridNumber(v)).toBe(FIXTURE.parseGridNumber[key] ?? null);
    });
  });
});

describe("gridFooterRowRole（:718-733——base/skip/None 与 skip 优先）", () => {
  const rows: Array<Record<string, unknown>> = [
    { "": "Total", amount: "150.00" },
    { "": "Grand Total" },
    { "": "总计" },
    { "": "合计" },
    { "": "totals" },
    { "": "Subtotal", amount: "10" },
    { "": "小计" },
    { "": "Tax" },
    { "": "shipping" },
    { "": "Discount" },
    { "": "freight" },
    { "": "subtotal", x: "total" },
    { "": "Net" },
    { amount: "150.00" },
    {},
    { "": "  TOTAL  " },
    { "": "Total Tax" },
  ];
  rows.forEach((frow, i) => {
    it(`c${i} ${JSON.stringify(frow)}`, () => {
      expect(gridFooterRowRole(frow)).toBe(FIXTURE.footerRowRole[`c${i}`] ?? null);
    });
  });
});

describe("evalLongTermMemory / extractDataImages", () => {
  it("短回显 / 200 边界 / 201 折叠 / 数字", () => {
    expect(evalLongTermMemory("hello")).toBe(FIXTURE.evalLongTermMemory.short);
    expect(evalLongTermMemory("x".repeat(200))).toBe(FIXTURE.evalLongTermMemory.boundary200);
    expect(evalLongTermMemory("x".repeat(201))).toBe(FIXTURE.evalLongTermMemory.over201);
    expect(evalLongTermMemory("42")).toBe(FIXTURE.evalLongTermMemory.number);
  });
  it("data:image 抽取占位", () => {
    expect(
      extractDataImages(
        "before data:image/png;base64,AAAA middle data:image/jpeg;base64,BBBB= after",
      ),
    ).toEqual(FIXTURE.extractDataImages.mixed);
    expect(extractDataImages("plain text")).toEqual(FIXTURE.extractDataImages.none);
  });
});

describe("evaluate handler（全输出锚定）", () => {
  const run = async (params: Record<string, unknown>, queue: Array<string | Error>) => {
    const browser = new FakeBrowser();
    browser.evaluateQueue = queue;
    const { tools } = makeTools();
    return tools.execute("evaluate", params, browser, null);
  };
  const cases: Array<[string, Record<string, unknown>, Array<string | Error>]> = [
    ["missingCode", {}, []],
    ["timeoutZero", { code: "1", timeout_ms: 0 }, []],
    ["timeoutOver", { code: "1", timeout_ms: 300001 }, []],
    ["timeoutOk", { code: "1", timeout_ms: 299999 }, ["ok"]],
    ["argsUnserializable", { code: "return 1", args: { s: new Set(["x"]) } }, []],
    ["elementsBadType", { code: "return 1", elements: ["a"] }, []],
    ["elementsBadShape", { code: "return 1", elements: 5 }, []],
    ["raiseCdp", { code: "return 1" }, [new Error("node detached")]],
    ["short", { code: "return document.title" }, ["My Page"]],
    ["num", { code: "return 42" }, ["42"]],
    ["boundaryEcho", { code: "return s" }, ["x".repeat(200)]],
    ["overEcho", { code: "return s" }, ["x".repeat(201)]],
    ["nodeIdEcho", { code: "return el" }, ["backendNodeId:55"]],
    [
      "extractImages",
      { code: "return s", extract_images: true },
      ["a data:image/png;base64,QUJD b"],
    ],
  ];
  for (const [name, params, queue] of cases) {
    it(name, async () => {
      const r = await run(params, queue);
      const f = FIXTURE.evaluate[name].out;
      expect(r.extractedContent).toBe(f.extracted_content);
      expect(r.longTermMemory).toBe(f.long_term_memory);
      expect(r.error).toBe(f.error);
      expect(r.metadata ?? null).toEqual(f.metadata ?? null);
    });
  }
});

describe("read_grid handler（三通道 + 聚合 + 校验 + 诊断——全输出锚定）", () => {
  const run = async (
    name: string,
    params: Record<string, unknown>,
    uiResult: Record<string, unknown>,
    channelQueue: Array<string | Record<string, unknown> | null>,
  ) => {
    const browser = new FakeBrowser();
    browser.readUiGridResult = uiResult;
    browser.gridChannelQueue = channelQueue;
    const { tools } = makeTools();
    const r = await tools.execute("read_grid", params, browser, null);
    const f = FIXTURE.readGrid[name];
    expect(r.extractedContent).toBe(f.out.extracted_content);
    expect(r.longTermMemory).toBe(f.out.long_term_memory);
    expect(r.error).toBe(f.out.error);
    expect(r.metadata ?? null).toEqual(f.out.metadata ?? null);
  };
  it("参数守卫六例", async () => {
    await run("badNamespace", { namespace: 5 }, {}, []);
    await run("badFilters", { filters: [1] }, {}, []);
    await run("badSearch", { search: 5 }, {}, []);
    await run("badPageSize", { page_size: "x" }, {}, []);
    await run("badFields", { fields: [1] }, {}, []);
    await run("blankGroup", { group_count: "  " }, {}, []);
  });
  it("通道 1 成功（元信息 + 残留清空 + partial 提示）", async () => {
    await run(
      "ch1Success",
      { namespace: "sales_order_grid" },
      {
        channel: "uiregistry",
        namespace: "sales_order_grid",
        rows: [
          { entity_id: "1", status: "complete", grand_total: "100.50" },
          { entity_id: "2", status: "pending", grand_total: "49.50" },
        ],
        rows_returned: 2,
        total_records: 42,
        applied: { sorting: { field: "entity_id", direction: "asc" } },
        active_before: { filters: { status: "pending" }, search: "foo" },
        partial: true,
      },
      [],
    );
  });
  it("sorting 解析 + page_size 钳制 + page 下限", async () => {
    await run(
      "ch1SortingParse",
      { namespace: "n", sorting: "entity_id DESC", page_size: "3000", page: "0" },
      { channel: "uiregistry", rows: [], rows_returned: 0, total_records: 0 },
      [],
    );
  });
  it("通道 2 legacy（filters/search 未应用注记）", async () => {
    await run(
      "ch2Legacy",
      { namespace: "n", filters: { status: "x" }, search: "y" },
      { channel_error: "no-grid" },
      [
        JSON.stringify({
          channel: "legacy_ajax",
          rows: [
            { ID: "1", Status: "complete" },
            { ID: "2", Status: "pending" },
          ],
          headers: ["ID", "Status"],
          rows_returned: 2,
        }),
      ],
    );
  });
  it("通道 3 DOM 兜底 / 全失败 / 异常与坏 JSON 降级", async () => {
    await run("ch3Dom", { namespace: "n" }, { channel_error: "no-requirejs" }, [
      JSON.stringify({ channel_error: "no-store" }),
      JSON.stringify({
        channel: "dom_table",
        rows: [{ Name: "A" }],
        headers: ["Name"],
        rows_returned: 1,
      }),
    ]);
    await run("allFail", { namespace: "n" }, { channel_error: "no-grid" }, [
      JSON.stringify({ channel_error: "no-store" }),
      JSON.stringify({ channel_error: "no-table" }),
    ]);
    await run("ch2EvalRaise", { namespace: "n" }, { channel_error: "no-grid" }, [
      JSON.stringify({ channel_error: "no-store" }),
      JSON.stringify({
        channel: "dom_table",
        rows: [{ Name: "A" }],
        headers: ["Name"],
        rows_returned: 1,
      }),
    ]);
    await run("ch2Unparseable", { namespace: "n" }, { channel_error: "no-grid" }, [
      "not json {",
      JSON.stringify({
        channel: "dom_table",
        rows: [{ Name: "A" }],
        headers: ["Name"],
        rows_returned: 1,
      }),
    ]);
  });
  it("group_count 三态（计数排序 / 字段缺失警示 / page-local 警示）", async () => {
    const gcRows = [
      { billing_name: "Emma Davis", entity_id: "1" },
      { billing_name: "Emma Davis", entity_id: "2" },
      { billing_name: "Bob Li", entity_id: "3" },
      { billing_name: "  ", entity_id: "4" },
      { entity_id: "5" },
    ];
    await run(
      "groupCount",
      { namespace: "n", group_count: " billing_name " },
      { channel: "uiregistry", rows: gcRows, rows_returned: 5, total_records: 40 },
      [],
    );
    await run(
      "groupCountMissing",
      { namespace: "n", group_count: "nope" },
      { channel: "uiregistry", rows: gcRows, rows_returned: 5, total_records: 5 },
      [],
    );
    await run(
      "groupCountPageLocal",
      { namespace: "n", group_count: "billing_name" },
      { channel: "dom_table", rows: gcRows, rows_returned: 5 },
      [],
    );
  });
  it("合计交叉校验五态", async () => {
    await run(
      "totalsMatch",
      { namespace: "n" },
      {
        channel: "dom_table",
        rows: [
          { Item: "A", amount: "100.50" },
          { Item: "B", amount: "49.50" },
          { Item: "C", amount: "" },
        ],
        rows_returned: 3,
        footer: [{ label: "Total", amount: "150.00" }],
      },
      [],
    );
    await run(
      "totalsMismatch",
      { namespace: "n" },
      {
        channel: "dom_table",
        rows: [
          { Item: "A", amount: "100.50" },
          { Item: "B", amount: "49.50" },
        ],
        rows_returned: 2,
        footer: [{ label: "Total", amount: "999.00" }],
      },
      [],
    );
    await run(
      "totalsSkipSubtotal",
      { namespace: "n" },
      {
        channel: "dom_table",
        rows: [{ amount: "10.00" }],
        rows_returned: 1,
        footer: [
          { label: "Subtotal", amount: "555.00" },
          { label: "Total", amount: "10.00" },
        ],
      },
      [],
    );
    await run(
      "totalsNonAdditive",
      { namespace: "n" },
      {
        channel: "dom_table",
        rows: [{ "Avg. Price": "5", amount: "10" }],
        rows_returned: 1,
        footer: [{ label: "Total", "Avg. Price": "5", amount: "10" }],
      },
      [],
    );
    await run(
      "totalsSingleRowNoLabel",
      { namespace: "n" },
      {
        channel: "dom_table",
        rows: [{ amount: "7.5" }],
        rows_returned: 1,
        footer: [{ amount: "7.5" }],
      },
      [],
    );
  });
  it("legacy 截断提示 + 三类零行诊断 + query_total", async () => {
    await run(
      "legacyTruncatedHint",
      { namespace: "n", page_size: 2 },
      { channel_error: "no-grid" },
      [
        JSON.stringify({
          channel: "legacy_ajax",
          rows: [{ amount: "100.50" }, { amount: "49.50" }],
          rows_returned: 2,
          footer: [{ label: "Total", amount: "999.00" }],
        }),
      ],
    );
    const domZero = JSON.stringify({
      channel: "dom_table",
      rows: [],
      headers: ["X"],
      rows_returned: 0,
    });
    await run(
      "domZeroRowsWithFilters",
      { namespace: "n", filters: { a: "b" } },
      { channel_error: "no-grid" },
      [JSON.stringify({ channel_error: "no-store" }), domZero],
    );
    await run("domZeroRowsPlain", { namespace: "n" }, { channel_error: "no-grid" }, [
      JSON.stringify({ channel_error: "no-store" }),
      domZero,
    ]);
    await run(
      "legacyAllEmptyRows",
      { namespace: "n", fields: ["a", "b"] },
      { channel_error: "no-grid" },
      [
        JSON.stringify({
          channel: "legacy_ajax",
          rows: [{}, {}],
          headers: ["ID", "Status"],
          rows_returned: 2,
        }),
      ],
    );
    await run(
      "uiregistryAllEmptyRows",
      { namespace: "n", fields: ["zz"] },
      { channel: "uiregistry", rows: [{}, {}], rows_returned: 2, total_records: 2 },
      [],
    );
    await run(
      "queryTotalUiregistry",
      { namespace: "n", filters: { s: "x" } },
      { channel: "uiregistry", rows: [{}], rows_returned: 1, total_records: 7 },
      [],
    );
  });
});

describe("大结果落盘（evaluate / read_grid 同款分级）", () => {
  const makeSaveTools = () => {
    const { tools, ctx } = makeTools({
      truncation: {
        evalSaveThreshold: 10,
        evalOutputDir: "/ANCHOR_TMP/out",
        evalResultMaxChars: 20,
      },
    });
    ctx.fs = makeFakeFs();
    return { tools, ctx };
  };
  it("evaluate：落盘 + 预览 + 记忆路径（时间戳归一）", async () => {
    const { tools } = makeSaveTools();
    const browser = new FakeBrowser();
    browser.evaluateQueue = ["A".repeat(30)];
    const r = await tools.execute("evaluate", { code: "return s" }, browser, null);
    expect(normTs(r.extractedContent ?? "")).toBe(FIXTURE.save.evaluateSave.extracted_content);
    expect(normTs(r.longTermMemory ?? "")).toBe(FIXTURE.save.evaluateSave.long_term_memory);
  });
  it("read_grid：json 落盘（三通道链后）", async () => {
    const { tools } = makeSaveTools();
    const browser = new FakeBrowser();
    browser.readUiGridResult = { channel_error: "no-grid" };
    browser.gridChannelQueue = [
      JSON.stringify({ channel_error: "no-store" }),
      JSON.stringify({
        channel: "dom_table",
        rows: [{ c: "v".repeat(5) }, { c: "v".repeat(5) }, { c: "v".repeat(5) }],
        rows_returned: 3,
      }),
    ];
    const r = await tools.execute("read_grid", { namespace: "n" }, browser, null);
    expect(normTs(r.extractedContent ?? "")).toBe(FIXTURE.save.gridSave.extracted_content);
    expect(normTs(r.longTermMemory ?? "")).toBe(FIXTURE.save.gridSave.long_term_memory);
  });
  it("saveOversizedResult 落盘路径形态（占位 + 时间戳 + 正斜杠）", async () => {
    const { tools } = makeSaveTools();
    const browser = new FakeBrowser();
    browser.evaluateQueue = ["B".repeat(12)];
    await tools.execute("evaluate", { code: "return s" }, browser, null);
    const fs = tools.ctx.fs;
    if (fs === null) throw new Error("fs 未注入");
    const files = (fs as unknown as { files: Map<string, string> }).files;
    const path = [...files.keys()].find((p) => p.includes("evaluate_"));
    expect(path).toMatch(/^\/ANCHOR_TMP\/out\/evaluate_\d+\.txt$/);
  });
});
