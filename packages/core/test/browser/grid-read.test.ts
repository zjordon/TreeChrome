// grid-read session 层（FakeCdpTransport）：readUiGrid 四形态（JSON 串/对象/不可解析/
// evaluate 失败→channel_error）+ evalGridChannel 三形态（可解析/坏串 null/异常 null）。
// JS 体逐字节在 batch2c-anchors.test.ts 锚定；handler 全输出锚定同文件。

import { describe, expect, it } from "vitest";
import { evalGridChannel, readUiGrid } from "../../src/browser/grid-read.js";
import { GRID_READ_JS } from "../../src/browser/grid-read-js.js";
import { makeInternals } from "./fake-transport.js";

const payload = {
  namespace: "ns",
  filters: null,
  search: null,
  sorting: null,
  paging: { pageSize: 200, current: 1 },
  fields: null,
  fresh: true,
  waitMs: 8000,
};

describe("readUiGrid（:3114-3131 四形态）", () => {
  it("JSON 串 → dict；非 dict → unexpected-result", async () => {
    const h = makeInternals();
    h.transport
      .respond("DOM.getDocument", { root: { nodeId: 7 } })
      .respond("DOM.resolveNode", { object: { objectId: "doc-obj" } })
      .respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
        expect(p.functionDeclaration).toContain("function(...a){");
        expect(p.arguments).toEqual([{ value: payload }]);
        return { result: { value: JSON.stringify({ channel: "uiregistry", rows: [] }) } };
      });
    const r = await readUiGrid(h.s, payload);
    expect(r).toEqual({ channel: "uiregistry", rows: [] });
    const h2 = makeInternals();
    h2.transport
      .respond("DOM.getDocument", { root: { nodeId: 7 } })
      .respond("DOM.resolveNode", { object: { objectId: "doc-obj" } })
      .respond("Runtime.callFunctionOn", { result: { value: JSON.stringify([1, 2]) } });
    expect(await readUiGrid(h2.s, payload)).toEqual({ channel_error: "unexpected-result" });
  });
  it("不可解析串 → unparseable（前 120 字符）；evaluate 异常 → evaluate-failed", async () => {
    const h = makeInternals();
    h.transport
      .respond("DOM.getDocument", { root: { nodeId: 7 } })
      .respond("DOM.resolveNode", { object: { objectId: "doc-obj" } })
      .respond("Runtime.callFunctionOn", { result: { value: "not json {" } });
    expect(await readUiGrid(h.s, payload)).toEqual({
      channel_error: "unparseable: not json {",
    });
    const h2 = makeInternals();
    h2.transport
      .respond("DOM.getDocument", { root: { nodeId: 7 } })
      .respond("DOM.resolveNode", { object: { objectId: "doc-obj" } })
      .respond("Runtime.callFunctionOn", () => {
        throw new Error("cdp boom");
      });
    expect(await readUiGrid(h2.s, payload)).toEqual({ channel_error: "evaluate-failed: cdp boom" });
  });
  it("GRID_READ_JS 作为 code 传入（args 编组）", async () => {
    const h = makeInternals();
    h.transport
      .respond("DOM.getDocument", { root: { nodeId: 7 } })
      .respond("DOM.resolveNode", { object: { objectId: "doc-obj" } })
      .respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
        // functionDeclaration = function(...a){\n<GRID_READ_JS>\n}
        expect(String(p.functionDeclaration)).toContain(GRID_READ_JS.slice(0, 40));
        return { result: { value: "{}" } };
      });
    await readUiGrid(h.s, payload);
  });
});

describe("evalGridChannel（:3125-3139 三形态）", () => {
  it("可解析 dict → dict；坏串/非 dict → null；异常 → null + 日志", async () => {
    const h = makeInternals();
    h.transport
      .respond("DOM.getDocument", { root: { nodeId: 7 } })
      .respond("DOM.resolveNode", { object: { objectId: "doc-obj" } })
      .respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
        expect(p.awaitPromise).toBe(true);
        return { result: { value: JSON.stringify({ channel: "dom_table", rows: [{}] }) } };
      });
    expect(await evalGridChannel(h.s, "/*js*/", payload)).toEqual({
      channel: "dom_table",
      rows: [{}],
    });
    const h2 = makeInternals();
    h2.transport
      .respond("DOM.getDocument", { root: { nodeId: 7 } })
      .respond("DOM.resolveNode", { object: { objectId: "doc-obj" } })
      .respond("Runtime.callFunctionOn", { result: { value: "garbage" } });
    expect(await evalGridChannel(h2.s, "/*js*/", payload)).toBeNull();
    const h3 = makeInternals();
    h3.transport
      .respond("DOM.getDocument", { root: { nodeId: 7 } })
      .respond("DOM.resolveNode", { object: { objectId: "doc-obj" } })
      .respond("Runtime.callFunctionOn", { result: { value: "[1,2]" } });
    expect(await evalGridChannel(h3.s, "/*js*/", payload)).toBeNull();
    const h4 = makeInternals();
    h4.transport
      .respond("DOM.getDocument", { root: { nodeId: 7 } })
      .respond("DOM.resolveNode", { object: { objectId: "doc-obj" } })
      .respond("Runtime.callFunctionOn", () => {
        throw new Error("timeout");
      });
    expect(await evalGridChannel(h4.s, "/*js*/", payload)).toBeNull();
    expect(h4.logs.some((l) => l.includes("grid channel evaluate failed"))).toBe(true);
  });
});

describe("补面：readUiGrid timeoutMs 透传", () => {
  it("显式 timeoutMs 进入求值请求（callFunctionOn 路径忽略——Python 同款限制）", async () => {
    const h = makeInternals();
    h.transport
      .respond("DOM.getDocument", { root: { nodeId: 7 } })
      .respond("DOM.resolveNode", { object: { objectId: "doc-obj" } })
      .respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
        expect(p.timeout).toBeUndefined(); // callFunctionOn 无 timeout 参数
        return { result: { value: "{}" } };
      });
    await readUiGrid(h.s, payload, 5000);
  });
});
