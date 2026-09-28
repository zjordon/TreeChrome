// search-find session 族集成（FakeCdpTransport 脚本化）：findText 三查询链/可见性
// 探测/nth 越界/高亮三模式/清理/discard；findElementsNodeIds 窗口与 describeNode 循环；
// findElements/searchPage 的 JS 单发（发送表达式=builder 锚定产物）与 error 映射。

import { describe, expect, it } from "vitest";
import {
  buildFindElementsJs,
  buildSearchPageJs,
  findElements,
  findElementsNodeIds,
  findText,
  searchPage,
} from "../../src/browser/search-find.js";
import { makeInternals } from "./fake-transport.js";

describe("findText（3 查询链 + 可见性 + nth + 高亮）", () => {
  it("首查询命中：getSearchResults→单节点跳过探测→滚入→describeNode→box 高亮", async () => {
    const h = makeInternals();
    h.transport
      .respondOnce("DOM.performSearch", { searchId: "s1", resultCount: 1 })
      .respondOnce("DOM.getSearchResults", { nodeIds: [42] })
      .respondOnce("DOM.scrollIntoViewIfNeeded", {})
      .respondOnce("DOM.describeNode", { node: { backendNodeId: 99, nodeName: "SPAN" } });
    const r = await findText(h.s, "hello");
    expect(r).toEqual({
      found: true,
      method: "xpath-text",
      tag: "span",
      match_index: 1,
      visible_total: 1,
      total: 1,
      highlight: "box",
    });
    // 高亮走 HighlightManager（executeJs 注入路径）+ finally discard
    const methods = h.transport.sent.map((f) => f.method);
    expect(methods).toContain("DOM.discardSearchResults");
    expect(methods.filter((m) => m === "DOM.performSearch")).toHaveLength(1);
  });

  it("多匹配可见性探测：callFunctionOn bool[] 过滤 + nth 越界回显", async () => {
    const h = makeInternals();
    h.transport
      .respondOnce("DOM.performSearch", { searchId: "s1", resultCount: 3 })
      .respondOnce("DOM.getSearchResults", { nodeIds: [1, 2, 3] })
      .respond("DOM.resolveNode", (p: { nodeId: number }) => ({
        object: { objectId: `obj-${p.nodeId}` },
      }))
      .respondOnce("Runtime.callFunctionOn", { result: { value: [false, true, true] } });
    const r = await findText(h.s, "x", { nth: 5 });
    expect(r.found).toBe(false);
    expect(r.reason).toBe("nth_exceeds");
    expect(r.visible_total).toBe(2);
    expect(r.total).toBe(3);
    expect(r.requested_nth).toBe(5);
    expect(h.transport.sent.some((f) => f.method === "Runtime.callFunctionOn")).toBe(true);
  });

  it("三查询全 miss → JS TreeWalker 回退命中（method=js-treewalker）", async () => {
    const h = makeInternals();
    for (let i = 0; i < 3; i++) {
      h.transport.respondOnce("DOM.performSearch", { searchId: `s${i}`, resultCount: 0 });
    }
    h.transport.respond("Runtime.evaluate", (p: { expression: string }) => {
      expect(p.expression).toContain("createTreeWalker");
      return { result: { value: true } };
    });
    const r = await findText(h.s, "needle");
    expect(r).toEqual({ found: true, method: "js-treewalker", tag: null });
  });

  it("selection 模式：window.find 循环 nth 次（executeJs 表达式断言）", async () => {
    const h = makeInternals();
    h.transport
      .respondOnce("DOM.performSearch", { searchId: "s1", resultCount: 1 })
      .respondOnce("DOM.getSearchResults", { nodeIds: [7] })
      .respondOnce("DOM.scrollIntoViewIfNeeded", {})
      .respondOnce("DOM.describeNode", { node: { backendNodeId: 8, nodeName: "P" } })
      .respond("Runtime.evaluate", (p: { expression: string }) => {
        expect(p.expression).toContain("window.find(needle, caseSensitive");
        return { result: { value: true } };
      });
    const r = await findText(h.s, "needle", { highlight: "selection" });
    expect(r.found).toBe(true);
    expect(r.tag).toBe("p");
  });

  it("performSearch 异常 → 下一查询接力；全失败且回退 miss → method=none", async () => {
    const h = makeInternals();
    h.transport.failOn("DOM.performSearch", new Error("boom"));
    h.transport.respond("Runtime.evaluate", { result: { value: false } });
    const r = await findText(h.s, "ghost");
    expect(r).toEqual({ found: false, method: "none", tag: null });
  });

  it("可见性探测全隐 → 退首个（不失败）；describeNode 失败 → tag null", async () => {
    const h = makeInternals();
    h.transport
      .respondOnce("DOM.performSearch", { searchId: "s1", resultCount: 2 })
      .respondOnce("DOM.getSearchResults", { nodeIds: [5, 6] })
      .respond("DOM.resolveNode", (p: { nodeId: number }) => ({
        object: { objectId: `o${p.nodeId}` },
      }))
      .respondOnce("Runtime.callFunctionOn", { result: { value: [false, false] } })
      .respondOnce("DOM.scrollIntoViewIfNeeded", {})
      .respondOnce("DOM.describeNode", () => {
        throw new Error("describe boom");
      });
    const r = await findText(h.s, "hidden");
    expect(r.found).toBe(true);
    expect(r.tag).toBeNull();
    expect(r.match_index).toBe(1);
  });

  it("可见性探测异常 → 按全可见降级；window.find 抛错静默", async () => {
    const h = makeInternals();
    h.transport
      .respondOnce("DOM.performSearch", { searchId: "s1", resultCount: 2 })
      .respondOnce("DOM.getSearchResults", { nodeIds: [5, 6] })
      .respond("DOM.resolveNode", { object: { objectId: "o" } })
      .respondOnce("Runtime.callFunctionOn", () => {
        throw new Error("probe boom");
      })
      .respondOnce("DOM.scrollIntoViewIfNeeded", {})
      .respondOnce("DOM.describeNode", { node: { backendNodeId: 1, nodeName: "B" } })
      .respond("Runtime.evaluate", (p: { expression: string }) => {
        if (p.expression.includes("window.find")) throw new Error("not found err");
        return { result: { value: true } };
      });
    const r = await findText(h.s, "x", { nth: 2, highlight: "selection" });
    expect(r.found).toBe(true);
    expect(r.visible_total).toBe(2); // 探测失败按全可见
    expect(h.logs.some((l) => l.includes("window.find selection failed"))).toBe(true);
  });

  it("getSearchResults 空节点 → continue 下一查询", async () => {
    const h = makeInternals();
    h.transport
      .respondOnce("DOM.performSearch", { searchId: "s1", resultCount: 2 })
      .respondOnce("DOM.getSearchResults", { nodeIds: [] })
      .respondOnce("DOM.performSearch", { searchId: "s2", resultCount: 0 })
      .respondOnce("DOM.performSearch", { searchId: "s3", resultCount: 0 })
      .respond("Runtime.evaluate", { result: { value: false } });
    const r = await findText(h.s, "void");
    expect(r.method).toBe("none");
  });
});

describe("findElementsNodeIds（performSearch 直收 CSS + 窗口 + describeNode 循环）", () => {
  it("窗口 [offset, offset+max) 与 has_more", async () => {
    const h = makeInternals();
    h.transport
      .respondOnce("DOM.performSearch", { searchId: "sid", resultCount: 7 })
      .respondOnce("DOM.getSearchResults", { nodeIds: [10, 11, 12] })
      .respond("DOM.describeNode", (p: { nodeId: number }) => ({
        node: { backendNodeId: p.nodeId * 100, nodeName: "A" },
      }));
    const r = await findElementsNodeIds(h.s, "a.link", { maxResults: 3, offset: 2 });
    expect(r.total).toBe(7);
    expect(r.node_ids).toEqual([
      { backend_id: 1000, tag: "a" },
      { backend_id: 1100, tag: "a" },
      { backend_id: 1200, tag: "a" },
    ]);
    expect(r.has_more).toBe(true);
    expect(r.offset).toBe(2);
    const getResults = h.transport.sent.find((f) => f.method === "DOM.getSearchResults");
    expect(getResults?.params).toEqual({ searchId: "sid", fromIndex: 2, toIndex: 5 });
    expect(h.transport.sent.some((f) => f.method === "DOM.discardSearchResults")).toBe(true);
  });
  it("total=0 → 空窗且不再取结果", async () => {
    const h = makeInternals();
    h.transport.respondOnce("DOM.performSearch", { searchId: "s", resultCount: 0 });
    const r = await findElementsNodeIds(h.s, "div.none");
    expect(r).toEqual({ node_ids: [], total: 0, showing: 0, offset: 0, has_more: false });
    expect(h.transport.sent.some((f) => f.method === "DOM.getSearchResults")).toBe(false);
  });
});

describe("findElements / searchPage（单发 JS + error 映射）", () => {
  it("发送表达式 = builder 产物（防手写漂移）", async () => {
    const h = makeInternals();
    h.transport
      .respond("Runtime.evaluate", (_p: { expression: string }) => ({
        result: { value: { elements: [], total: 0, showing: 0, offset: 0, has_more: false } },
      }))
      .respondOnce("Runtime.evaluate", {
        result: {
          value: {
            matches: [],
            total: 0,
            offset: 0,
            has_more: false,
            attribute_matches: [],
            attribute_total: 0,
          },
        },
      });
    await findElements(h.s, "a", { maxResults: 5 });
    const fe = h.transport.sent.find((f) => f.method === "Runtime.evaluate");
    expect(fe?.params?.expression).toBe(buildFindElementsJs("a", null, 5, true, false, 0, false));
    await searchPage(h.s, "q");
    const sp = h.transport.sent.filter((f) => f.method === "Runtime.evaluate")[1];
    expect(sp?.params?.expression).toBe(
      buildSearchPageJs("q", false, false, 150, null, 25, 0, false),
    );
  });
  it("JS 层 {error} → 抛（动作层映射硬 error）；空返回 → no result", async () => {
    const h = makeInternals();
    h.transport.respond("Runtime.evaluate", {
      result: { value: { error: "Invalid CSS selector: bad", elements: [], total: 0 } },
    });
    await expect(findElements(h.s, "bad[[")).rejects.toThrow(
      "find_elements: Invalid CSS selector: bad",
    );
    const h2 = makeInternals();
    h2.transport.respond("Runtime.evaluate", { result: { value: null } });
    await expect(searchPage(h2.s, "q")).rejects.toThrow("search_page returned no result");
  });
  it("JS 异常（exceptionDetails）→ 抛（executeJs 通道）", async () => {
    const h = makeInternals();
    h.transport.respond("Runtime.evaluate", {
      result: {},
      exceptionDetails: { text: "SyntaxError: unexpected" },
    });
    await expect(findElements(h.s, "a")).rejects.toThrow("JS error");
  });
});
