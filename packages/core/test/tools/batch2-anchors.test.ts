// batch2 段 1 纯函数锚定：三个 formatter / sniff 全 magic 分支 / textQueries /
// xpathStringLiteral / 两个 JS builder 逐字节（fixture：python-anchors/batch2.json，
// gen-batch2-anchors.py 经 venv 实跑生成）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildFindElementsJs,
  buildSearchPageJs,
  FIND_TEXT_CAP,
  type FindElementsData,
  type FindElementsNodeIdsData,
  type SearchPageData,
  textQueries,
  xpathStringLiteral,
} from "../../src/browser/search-find.js";
import { sniffFileKind } from "../../src/tools/actions/file-actions.js";
import { formatFindResults, formatNodeIdResults } from "../../src/tools/actions/find-elements.js";
import { SEARCH_ENGINE_URLS } from "../../src/tools/actions/search.js";
import { formatSearchResults } from "../../src/tools/actions/search-page.js";

const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/python-anchors/batch2.json", import.meta.url)),
    "utf8",
  ),
  // biome-ignore lint/suspicious/noExplicitAny: fixture 是外部 JSON 的弱形态读取面
) as Record<string, any>;

const enc = (hex: string): Uint8Array =>
  new Uint8Array(hex.match(/../g)!.map((h) => Number.parseInt(h, 16)));

describe("formatFindResults / formatNodeIdResults（逐字节）", () => {
  it("basic", () => {
    const data: FindElementsData = {
      elements: [
        { index: 3, tag: "a", text: "About  us", attrs: { href: "/about" }, children_count: 0 },
        { index: 7, tag: "button", text: "", attrs: {}, children_count: 2 },
      ],
      total: 2,
      showing: 2,
      offset: 0,
      has_more: false,
    };
    expect(formatFindResults(data, "a.link")).toBe(FIXTURE.formatFindResults.basic);
    const nidData: FindElementsNodeIdsData = {
      node_ids: [
        { backend_id: 1234, tag: "a" },
        { backend_id: 5678, tag: "button" },
      ],
      total: 2,
      showing: 2,
      offset: 0,
      has_more: false,
    };
    expect(formatNodeIdResults(nidData, "a.link")).toBe(FIXTURE.formatNodeIdResults.basic);
  });
  it("paginationGeometryOrigin（120 字截断/attrs/几何/origin 去括号/翻页脚注）", () => {
    const data: FindElementsData = {
      elements: [
        {
          index: 0,
          tag: "div",
          text: "x".repeat(150),
          attrs: { id: "a", class: "b c" },
          children_count: 3,
          origin: " (in shadow DOM)",
          rect: { x: 1.2, y: 3.4, w: 50.6, h: 7.8 },
          visible: true,
        },
        { index: 1, tag: "span", text: "", attrs: {}, children_count: 0, visible: false },
      ],
      total: 12,
      showing: 2,
      offset: 10,
      has_more: true,
    };
    expect(formatFindResults(data, "div.x")).toBe(
      FIXTURE.formatFindResults.paginationGeometryOrigin,
    );
    const nidData: FindElementsNodeIdsData = {
      node_ids: [{ backend_id: 9, tag: "input" }],
      total: 5,
      showing: 1,
      offset: 3,
      has_more: true,
    };
    expect(formatNodeIdResults(nidData, "input")).toBe(FIXTURE.formatNodeIdResults.pagination);
  });
});

describe("formatSearchResults（逐字节）", () => {
  it("basic / pagination / attributes", () => {
    const basic: SearchPageData = {
      matches: [
        {
          match_text: "hello",
          context: "...hello world...",
          element_path: "div > p#intro",
          char_position: 0,
        },
      ],
      total: 1,
      offset: 0,
      has_more: false,
      attribute_matches: [],
      attribute_total: 0,
    };
    expect(formatSearchResults(basic, "hello")).toBe(FIXTURE.formatSearchResults.basic);
    const paged: SearchPageData = {
      matches: [{ match_text: "m", context: "m1", element_path: "", char_position: 0 }],
      total: 9,
      offset: 4,
      has_more: true,
      attribute_matches: [],
      attribute_total: 0,
    };
    expect(formatSearchResults(paged, "m")).toBe(FIXTURE.formatSearchResults.pagination);
    const attrs: SearchPageData = {
      matches: [],
      total: 0,
      offset: 0,
      has_more: false,
      attribute_matches: [
        { attribute: "aria-label", value: "Search hello", element_path: "input#q" },
        { attribute: "alt", value: "hello img", element_path: "img" },
      ],
      attribute_total: 3,
    };
    expect(formatSearchResults(attrs, "hello")).toBe(FIXTURE.formatSearchResults.attributes);
  });
});

describe("sniffFileKind（magic 头全分支）", () => {
  const heads: Record<string, [string, string]> = {
    png: ["89504e470d0a1a0a00000000", "x.bin"],
    jpeg: ["ffd8ffe00000000000000000", "x.bin"],
    gif87a: ["474946383761000000000000", "x.bin"],
    gif89a: ["474946383961000000000000", "x.bin"],
    webp: ["524946460000000057454250", "x.bin"],
    avi: ["524946460000000041564920", "x.bin"],
    pdf: ["255044462d312e370a000000", "x.bin"],
    docx: ["504b03040000000000000000", "x.docx"],
    plainZip: ["504b03040000000000000000", "x.zip"],
    elf: ["7f454c460000000000000000", "x.bin"],
    mz: ["4d5a90000300000004000000", "x.bin"],
    gzip: ["1f8b00000000000000000000", "x.bin"],
    bzip2: ["425a68390000000000000000", "x.bin"],
    rar: ["526172211a07000000000000", "x.bin"],
    "7z": ["377abcaf271c000000000000", "x.bin"],
    text: ["6a75737420706c61696e2074", "x.bin"],
    emptyThenText: ["000001686900000000000000", "x.bin"],
  };
  for (const [name, [hex, path]] of Object.entries(heads)) {
    it(`${name} → ${FIXTURE.sniff[name]}`, () => {
      expect(sniffFileKind(enc(hex.replace(/ /g, "")), path)).toBe(FIXTURE.sniff[name]);
    });
  }
  it("FIND_TEXT_CAP = 50", () => {
    expect(FIND_TEXT_CAP).toBe(50);
  });
});

describe("textQueries / xpathStringLiteral（逐字节）", () => {
  it("xpath 字面量四形态", () => {
    expect(xpathStringLiteral("abc")).toBe(FIXTURE.xpathStringLiteral.plain);
    expect(xpathStringLiteral('a"b')).toBe(FIXTURE.xpathStringLiteral.doubleQuote);
    expect(xpathStringLiteral("a'b")).toBe(FIXTURE.xpathStringLiteral.singleQuote);
    expect(xpathStringLiteral("a\"b'c")).toBe(FIXTURE.xpathStringLiteral.both);
  });
  it("3 查询链四形态", () => {
    expect(textQueries("hello", false)).toEqual(FIXTURE.textQueries.plain);
    expect(textQueries("hello", true)).toEqual(FIXTURE.textQueries.plainSensitive);
    expect(textQueries('say "hi"', false)).toEqual(FIXTURE.textQueries.doubleQuote);
    expect(textQueries("'both' and \"kinds\"", true)).toEqual(FIXTURE.textQueries.bothQuotes);
  });
});

describe("JS builder 逐字节（用户值 var 注入，无内插）", () => {
  it("buildSearchPageJs", () => {
    expect(buildSearchPageJs("hello + world", true, false, 150, "div#main", 25, 0, true)).toBe(
      FIXTURE.searchPageJs,
    );
  });
  it("buildFindElementsJs", () => {
    expect(buildFindElementsJs("a.link", ["href", "id"], 50, true, false, 10, true)).toBe(
      FIXTURE.findElementsJs,
    );
  });
});

describe("SEARCH_ENGINE_URLS（:360-365 逐字节）", () => {
  it("四引擎模板含 udm=14", () => {
    expect(SEARCH_ENGINE_URLS).toEqual(FIXTURE.engineUrls);
  });
});
