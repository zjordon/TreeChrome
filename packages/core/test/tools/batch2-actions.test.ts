// P4b 段 1 handler 集成（FakeBrowser 可编程面）：search 引擎导航 / find_elements
// 渲染+落盘+query_total / find_text 四回显 / search_page 属性合并计数 / screenshot
// 参数透传与落盘 / save_as_pdf / close_tab 后缀匹配三分支。

import { describe, expect, it } from "vitest";
import type { ActionResult } from "../../src/agent/views.js";
import { FakeBrowser, makeTools } from "./fake-browser.js";
import { makeFakeFs } from "./fake-fs.js";

async function exec(
  browser: FakeBrowser,
  action: string,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  const { tools } = makeTools();
  return tools.execute(action, params, browser);
}

describe("search", () => {
  it("引擎 URL 模板 + quote_plus + 首字母大写回显", async () => {
    const browser = new FakeBrowser();
    const r = await exec(browser, "search", { query: "hello world+test", engine: "duckduckgo" });
    expect(browser.navigations).toEqual([
      { url: "https://duckduckgo.com/?q=hello+world%2Btest", newTab: false },
    ]);
    expect(r.extractedContent).toBe("Searched Duckduckgo for 'hello world+test'");
    expect(r.longTermMemory).toBe(r.extractedContent);
  });
  it("缺 query / 未知引擎 → error", async () => {
    const browser = new FakeBrowser();
    expect((await exec(browser, "search", {})).error).toContain("string `query`");
    expect((await exec(browser, "search", { query: "x", engine: "nope" })).error).toBe(
      "Unknown search engine: nope",
    );
  });
});

describe("find_elements", () => {
  it("命中渲染 + query_total 旁路 + 参数透传", async () => {
    const browser = new FakeBrowser();
    browser.findElementsResult = {
      elements: [
        {
          index: 0,
          tag: "a",
          text: "About",
          attrs: { href: "https://a.example/about" },
          children_count: 0,
        },
      ],
      total: 1,
      showing: 1,
      offset: 0,
      has_more: false,
    };
    const r = await exec(browser, "find_elements", {
      selector: "a",
      attributes: ["href"],
      max_results: 5,
      offset: 2,
      include_text: false,
    });
    expect(r.metadata).toEqual({ query_total: 1 });
    expect(r.extractedContent).toContain(
      '[0] <a> "About" {href="https://a.example/about"} (0 children)',
    );
    const call = browser.findElementsCalls[0];
    expect(call.selector).toBe("a");
    expect(call.opts).toEqual({
      attributes: ["href"],
      maxResults: 5,
      offset: 2,
      includeText: false,
      firstOnly: false,
      includeGeometry: false,
    });
  });
  it("零结果软回显（query_total: 0）", async () => {
    const browser = new FakeBrowser();
    const r = await exec(browser, "find_elements", { selector: "div.x" });
    expect(r.error).toBeNull();
    expect(r.extractedContent).toBe('No elements found matching "div.x"');
    expect(r.metadata).toEqual({ query_total: 0 });
  });
  it("return_node_ids 变体 + 大结果落盘（阈值注入小值）", async () => {
    const browser = new FakeBrowser();
    browser.findNodeIdsResult = {
      node_ids: [{ backend_id: 42, tag: "input" }],
      total: 1,
      showing: 1,
      offset: 0,
      has_more: false,
    };
    const { tools, ctx } = makeTools({ truncation: { findElementsSaveThreshold: 5 } });
    const fs = makeFakeFs();
    ctx.fs = fs;
    const r = await tools.execute(
      "find_elements",
      { selector: "input", return_node_ids: true },
      browser,
    );
    expect(r.extractedContent).toContain("saved to find_elements_output/");
    expect(r.extractedContent).toContain('Preview: Found 1 element matching "input" (node ids)');
    expect(r.longTermMemory).toContain("(node ids)");
    expect(r.metadata).toEqual({ query_total: 1 });
    expect(fs.textWrites).toHaveLength(1);
  });
  it("CDP 失败 → Find elements failed", async () => {
    const browser = new FakeBrowser();
    browser.findElementsError = new Error("conn drop");
    const r = await exec(browser, "find_elements", { selector: "a" });
    expect(r.error).toBe("Find elements failed: conn drop");
  });
});

describe("find_text", () => {
  it("多匹配回显（match N of M）+ tag + 非默认高亮后缀", async () => {
    const browser = new FakeBrowser();
    browser.findTextResult = {
      found: true,
      method: "xpath-text",
      tag: "span",
      match_index: 2,
      visible_total: 3,
      total: 4,
      highlight: "selection",
    };
    const r = await exec(browser, "find_text", { text: "hi", nth: 2, highlight: "selection" });
    expect(r.extractedContent).toBe(
      "Scrolled to text 'hi' into view (match 2 of 3 visible, 4 total, found in <span>, via xpath-text) (selection highlight)",
    );
    expect(browser.findTextCalls[0].opts).toEqual({
      nth: 2,
      caseSensitive: false,
      highlight: "selection",
    });
  });
  it("单匹配/无 tag（js 回退形态）", async () => {
    const browser = new FakeBrowser();
    browser.findTextResult = { found: true, method: "js-treewalker", tag: null };
    const r = await exec(browser, "find_text", { text: "x" });
    expect(r.extractedContent).toBe("Scrolled to text 'x' into view (via js-treewalker)");
  });
  it("nth 越界与未命中软回显；CDP 失败硬 error", async () => {
    const browser = new FakeBrowser();
    browser.findTextResult = {
      found: false,
      reason: "nth_exceeds",
      method: "xpath-content",
      tag: null,
      requested_nth: 4,
      visible_total: 2,
      total: 5,
    };
    const exceed = await exec(browser, "find_text", { text: "y", nth: 4 });
    expect(exceed.extractedContent).toBe(
      "Text 'y' found but only 2 visible match(es) (5 total via xpath-content) — asked for match 4, try a smaller nth",
    );
    browser.findTextResult = { found: false, method: "none", tag: null };
    const miss = await exec(browser, "find_text", { text: "y" });
    expect(miss.extractedContent).toBe("Text 'y' not found on page");
    browser.findTextError = new Error("dom err");
    expect((await exec(browser, "find_text", { text: "y" })).error).toBe(
      "Find text failed: dom err",
    );
  });
});

describe("search_page", () => {
  it("命中渲染 + 属性合并计数（query_total = total + attr_total）", async () => {
    const browser = new FakeBrowser();
    browser.searchPageResult = {
      matches: [{ match_text: "q", context: "the q here", element_path: "p", char_position: 3 }],
      total: 2,
      offset: 0,
      has_more: false,
      attribute_matches: [{ attribute: "alt", value: "q-img", element_path: "img" }],
      attribute_total: 1,
    };
    const r = await exec(browser, "search_page", { query: "q", search_attributes: true });
    expect(r.metadata).toEqual({ query_total: 3 });
    expect(r.longTermMemory).toBe('Searched page for "q": 2 matches found. (+1 attribute match)');
    expect(r.extractedContent).toContain("[1] the q here (in p)");
    expect(browser.searchPageCalls[0].opts?.searchAttributes).toBe(true);
  });
  it("零结果软回显；CDP 失败硬 error；大结果落盘", async () => {
    const browser = new FakeBrowser();
    const miss = await exec(browser, "search_page", { query: "zz" });
    expect(miss.extractedContent).toBe("No matches for 'zz'");
    expect(miss.metadata).toEqual({ query_total: 0 });
    browser.searchPageError = new Error("regex bad");
    expect((await exec(browser, "search_page", { query: "(" })).error).toBe(
      "Search page failed: regex bad",
    );
    browser.searchPageError = null;
    browser.searchPageResult = {
      matches: Array.from({ length: 30 }, (_, i) => ({
        match_text: "m",
        context: `ctx ${i} ${"x".repeat(50)}`,
        element_path: "",
        char_position: i,
      })),
      total: 30,
      offset: 0,
      has_more: false,
      attribute_matches: [],
      attribute_total: 0,
    };
    const { tools, ctx } = makeTools({ truncation: { searchPageSaveThreshold: 100 } });
    const fs = makeFakeFs();
    ctx.fs = fs;
    const r = await tools.execute("search_page", { query: "m" }, browser);
    expect(r.extractedContent).toContain("saved to search_page_output/");
    expect(fs.textWrites).toHaveLength(1);
  });
});

describe("screenshot / save_as_pdf", () => {
  it("参数透传 + 无 save_path 的元信息回显", async () => {
    const browser = new FakeBrowser();
    const r = await exec(browser, "screenshot", {
      format: "jpeg",
      quality: 80,
      full_page: true,
      clip: { x: 0, y: 0, width: 100, height: 50 },
    });
    expect(browser.screenshotCalls[0]).toEqual({
      format: "jpeg",
      quality: 80,
      clip: { x: 0, y: 0, width: 100, height: 50 },
      fullPage: true,
      waitSettle: true,
    });
    expect(r.extractedContent).toBe(
      "Screenshot captured (format=jpeg, 3 bytes, full_page, clip=100x50) but not saved (no save_path).",
    );
  });
  it("save_path 落盘 + 失败分支", async () => {
    const browser = new FakeBrowser();
    const { tools, ctx } = makeTools();
    const fs = makeFakeFs();
    ctx.fs = fs;
    const r = await tools.execute("screenshot", { save_path: "/out/s.png" }, browser);
    expect(r.extractedContent).toBe("Screenshot saved to /out/s.png (3 bytes)");
    expect([...fs.files.keys()]).toContain("/out/s.png");
    browser.screenshotError = new Error("timeout guard");
    expect((await exec(browser, "screenshot", {})).error).toBe("Screenshot failed: timeout guard");
  });
  it("save_as_pdf 参数透传 + 字节回显", async () => {
    const browser = new FakeBrowser();
    const { tools, ctx } = makeTools();
    const fs = makeFakeFs();
    ctx.fs = fs;
    const r = await tools.execute(
      "save_as_pdf",
      { path: "/out/p.pdf", paper_format: "a4", landscape: true },
      browser,
    );
    expect(browser.pdfCalls[0]).toEqual({
      paperFormat: "a4",
      landscape: true,
      printBackground: true,
      scale: 1.0,
    });
    expect(r.extractedContent).toBe("PDF saved to /out/p.pdf (paper=a4, 3 bytes, landscape)");
    browser.pdfError = new Error("print failed");
    const r2 = await tools.execute("save_as_pdf", { path: "/out/q.pdf" }, browser);
    expect(r2.error).toBe("Failed to generate PDF: print failed");
  });
});

describe("参数守卫与降级分支补面", () => {
  it("find_elements 缺 selector / find_text 缺 text 的 error 守卫", async () => {
    const browser = new FakeBrowser();
    expect((await exec(browser, "find_elements", {})).error).toContain("string `selector`");
    expect((await exec(browser, "find_text", {})).error).toContain("string `text`");
  });
  it("find_text：nth 缺省 1、highlight 非法值回落 box、total=1 单匹配带 tag", async () => {
    const browser = new FakeBrowser();
    browser.findTextResult = {
      found: true,
      method: "xpath-text",
      tag: "h1",
      match_index: 1,
      visible_total: 1,
      total: 1,
      highlight: "box",
    };
    const r = await exec(browser, "find_text", { text: "t", highlight: 42 as never });
    expect(browser.findTextCalls[0].opts).toEqual({
      nth: 1,
      caseSensitive: false,
      highlight: "box",
    });
    expect(r.extractedContent).toBe(
      "Scrolled to text 't' into view (found in <h1>, via xpath-text)",
    );
  });
  it("screenshot：无 clip 的 png 默认 + save_path 而 fs 未注入 → error", async () => {
    const browser = new FakeBrowser();
    const r = await exec(browser, "screenshot", {});
    expect(browser.screenshotCalls[0]).toEqual({
      format: "png",
      quality: null,
      clip: null,
      fullPage: false,
      waitSettle: false,
    });
    expect(r.extractedContent).toBe(
      "Screenshot captured (format=png, 3 bytes) but not saved (no save_path).",
    );
    const { tools } = makeTools();
    const r2 = await tools.execute("screenshot", { save_path: "/x.png" }, browser);
    expect(r2.error).toContain("no filesystem provider injected");
  });
  it("save_as_pdf 落盘失败 → error", async () => {
    const browser = new FakeBrowser();
    const { tools, ctx } = makeTools();
    ctx.fs = {
      ...makeFakeFs(),
      writeBytes: async () => {
        throw new Error("disk full");
      },
    };
    const r = await tools.execute("save_as_pdf", { path: "/out/x.pdf" }, browser);
    expect(r.error).toBe("Failed to save PDF to /out/x.pdf: disk full");
  });
  it("search_page：缺 query error", async () => {
    const browser = new FakeBrowser();
    expect((await exec(browser, "search_page", {})).error).toContain("string `query`");
  });
});

describe("close_tab", () => {
  it("后缀唯一命中 → 关闭并回显", async () => {
    const browser = new FakeBrowser();
    browser.tabs = [
      { targetId: "AAA1111", url: "https://x/", title: "X" },
      { targetId: "BBB2222", url: "https://y/", title: "Y" },
    ];
    browser.currentTargetId = "AAA1111";
    const r = await exec(browser, "close_tab", { tab_id: "2222" });
    expect(browser.closeTabCalls).toEqual(["BBB2222"]);
    expect(r.extractedContent).toBe("Closed tab [2222] Y (https://y/)");
  });
  it("未命中列出全部；撞车要求更长后缀", async () => {
    const browser = new FakeBrowser();
    browser.tabs = [
      { targetId: "X1111", url: "https://x/", title: "X" },
      { targetId: "Y1111", url: "https://y/", title: "Y" },
    ];
    const miss = await exec(browser, "close_tab", { tab_id: "9999" });
    expect(miss.error).toContain(
      "No tab ending with '9999'. Open tabs: [1111] X (https://x/), [1111] Y (https://y/)",
    );
    const conflict = await exec(browser, "close_tab", { tab_id: "1111" });
    expect(conflict.error).toContain("Multiple tabs match '1111' (2). Use more characters");
    expect(browser.closeTabCalls).toHaveLength(0);
  });
  it("空 tab_id 关当前；关闭失败软降级", async () => {
    const browser = new FakeBrowser();
    browser.tabs = [{ targetId: "ABCD1234", url: "https://a/", title: "A" }];
    browser.currentTargetId = "ABCD1234";
    const r = await exec(browser, "close_tab", {});
    expect(browser.closeTabCalls).toEqual(["ABCD1234"]);
    expect(r.extractedContent).toBe("Closed tab [1234] A (https://a/)");
    browser.closeTabError = new Error("already gone");
    const r2 = await exec(browser, "close_tab", {});
    expect(r2.error).toBeNull();
    // 关闭后 tab 已不在列表（fake 同 Python get_tabs 语义）——标题/URL 空串回显
    expect(r2.extractedContent).toBe("Tab [1234]  () was already closed or invalid");
    const noCurrent = new FakeBrowser();
    noCurrent.currentTargetId = null;
    expect((await exec(noCurrent, "close_tab", {})).error).toBe("No current tab to close");
  });
});
