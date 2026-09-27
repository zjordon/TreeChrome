// extract-markdown 层测试：chunk 分块边界逐条对拍 Python 实跑 fixture（表格延续/
// 硬切长行/反孤岛）；extractCleanMarkdown 不锚字节——验证空输入/门控正则/标题风格。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  chunkMarkdownByStructure,
  extractCleanMarkdown,
} from "../../src/tools/extract-markdown.js";
import { pyJsonDumps } from "../../src/tools/py-json.js";

const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/python-anchors/tools.json", import.meta.url)),
    "utf8",
  ),
) as {
  chunk: Array<{
    name: string;
    input: string;
    maxChars: number;
    output: Array<{ content: string; start: number; end: number }>;
  }>;
};

describe("chunkMarkdownByStructure（对拍 Python 实跑）", () => {
  for (const sample of FIXTURE.chunk) {
    it(`${sample.name}（maxChars=${sample.maxChars}）`, () => {
      const chunks = chunkMarkdownByStructure(sample.input, sample.maxChars);
      expect(chunks.map((c) => ({ content: c.content, start: c.start, end: c.end }))).toEqual(
        sample.output,
      );
    });
  }
  it("块序列单调连续覆盖全文", () => {
    const md = FIXTURE.chunk.find((c) => c.name === "table")!.input;
    const chunks = chunkMarkdownByStructure(md, 120);
    expect(chunks[0].start).toBe(0);
    expect(chunks[chunks.length - 1].end).toBe(md.length);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].start).toBe(chunks[i - 1].end);
    }
  });
});

describe("extractCleanMarkdown（语义验证，不锚字节）", () => {
  it("空输入返回空串", () => {
    expect(extractCleanMarkdown("")).toBe("");
    expect(extractCleanMarkdown("   ")).toBe("");
  });
  it("基础转换：标题 + 加粗 + 链接", () => {
    const md = extractCleanMarkdown('<h1>T</h1><p>Hello <b>world</b> <a href="/x">docs</a></p>');
    expect(md).toContain("# T");
    expect(md).toContain("**world**");
    expect(md).toContain("[docs](/x)");
  });
  it("extractLinks=false：链接文本保留、href 去除", () => {
    const md = extractCleanMarkdown('<p>See <a href="/x">docs</a></p>', { extractLinks: false });
    expect(md).toContain("docs");
    expect(md).not.toContain("(/x)");
  });
  it("extractImages=false：img 标签整体去除", () => {
    const withImg = extractCleanMarkdown('<p>pic</p><img src="/i.png">', { extractImages: true });
    expect(withImg.toLowerCase()).toContain("i.png");
    const noImg = extractCleanMarkdown('<p>pic</p><img src="/i.png">', { extractImages: false });
    expect(noImg.toLowerCase()).not.toContain("i.png");
  });
  it("3+ 连续换行折叠为 2", () => {
    const md = extractCleanMarkdown("<p>a</p>\n\n\n\n\n<p>b</p>");
    expect(md).not.toMatch(/\n{3,}/);
  });
});

describe("pyJsonDumps（json.dumps(ensure_ascii=False) 等价）", () => {
  it("分隔符与中文保留", () => {
    expect(pyJsonDumps({ a: 1, b: "x" })).toBe('{"a": 1, "b": "x"}');
    expect(pyJsonDumps({ 名称: "值" })).toBe('{"名称": "值"}');
    expect(pyJsonDumps([1, "a"])).toBe('[1, "a"]');
  });
  it("indent=2 缩进形态", () => {
    expect(pyJsonDumps({ total: 3 }, 2)).toBe('{\n  "total": 3\n}');
  });
  it("空对象/数组/null/嵌套", () => {
    expect(pyJsonDumps({})).toBe("{}");
    expect(pyJsonDumps([])).toBe("[]");
    expect(pyJsonDumps({ n: null, arr: [{ k: true }] })).toBe('{"n": null, "arr": [{"k": true}]}');
  });
});
