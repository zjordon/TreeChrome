// 查询落盘族单测：三个格式化器（search_page/find_elements/node_ids——browser-use
// service.py 镜像文案锚定）+ saveOversizedResult 的阈值/降级/路径拼接。

import { SerializedDOMState } from "@tw/dom-snapshot";
import { describe, expect, it } from "vitest";
import {
  describeDropdown,
  findNodeByBackendId,
  pyRepr,
} from "../../src/tools/actions/shared/element-lookup.js";
import {
  formatFindResults,
  formatNodeIdResults,
  formatSearchResults,
  saveOversizedResult,
} from "../../src/tools/actions/shared/format.js";
import { makeNode } from "./fake-browser.js";

describe("formatSearchResults（:147-184）", () => {
  it("总数单复数 + 上下文 + element_path 定位 + 分页 footer", () => {
    const out = formatSearchResults(
      {
        matches: [
          { context: "found A here", element_path: "div>p" },
          { context: "another A", element_path: "" },
        ],
        total: 3,
        has_more: true,
        offset: 0,
      },
      "targets",
    );
    expect(out).toBe(
      'Found 3 matches for "targets" on page:\n' +
        "\n" +
        "[1] found A here (in div>p)\n" +
        "[2] another A\n" +
        "\n... showing 1–2 of 3 total matches. Call again with offset=2 for the next batch (or raise max_results).",
    );
  });
  it("单命中无分页 + 属性匹配段（含截断提示）", () => {
    const out = formatSearchResults(
      {
        matches: [{ context: "one", element_path: "" }],
        total: 1,
        has_more: false,
        offset: 0,
        attribute_matches: [
          { attribute: "href", value: "/a", element_path: "a" },
          { attribute: "src", value: "/b", element_path: "" },
        ],
        attribute_total: 3,
      },
      "q",
    );
    expect(out).toContain('Found 1 match for "q" on page:');
    expect(out).toContain('Attribute matches for "q" (3):');
    expect(out).toContain("[1] @href=/a (in a)");
    expect(out).toContain("... showing 2 of 3 attribute matches.");
  });
});

describe("formatFindResults（:187-235）", () => {
  it("元素行：文本空白折叠 120 截断 / 属性 / children / geometry / origin；分页 footer", () => {
    const longText = `${"t".repeat(130)}`;
    const out = formatFindResults(
      {
        elements: [
          {
            index: 7,
            tag: "a",
            text: `  click   ${longText}`,
            attrs: { href: "/x", class: "c" },
            children_count: 2,
            origin: " (in shadow DOM)",
          },
          {
            index: 8,
            tag: "div",
            text: "",
            attrs: {},
            children_count: 0,
            rect: { x: 1.2, y: 3.4, w: 10.6, h: 20.2 },
            visible: true,
          },
        ],
        total: 5,
        offset: 2,
        has_more: true,
      },
      "a.link",
    );
    expect(out).toContain('Found 5 elements matching "a.link":');
    expect(out).toContain(
      `[7] <a> "click ${"t".repeat(114)}..." {href="/x", class="c"} (2 children) (in shadow DOM)`,
    );
    expect(out).toContain("[8] <div> (0 children) (visible, 10x20@1,3)");
    expect(out).toContain(
      "... showing 3–4 of 5 total elements. Call again with offset=4 for the next batch (or raise max_results).",
    );
  });
});

describe("formatNodeIdResults（:238-263）", () => {
  it("backend_id 行 + 用法提示 + 分页 footer", () => {
    const out = formatNodeIdResults(
      { node_ids: [{ backend_id: 42, tag: "button" }], total: 2, offset: 0, has_more: true },
      ".btn",
    );
    expect(out).toBe(
      'Found 2 elements matching ".btn" (node ids):\n' +
        "\n" +
        "[42] <button>  (pass as index= or element_id= to click/input_text)\n" +
        "\n... showing 1–1 of 2 total elements. Call again with offset=1 for the next batch.",
    );
  });
});

describe("saveOversizedResult", () => {
  const base = { threshold: 10, outputDir: "out", prefix: "act", ext: "txt", log: () => {} };
  it("低于阈值不落盘", async () => {
    const writes: string[] = [];
    const out = await saveOversizedResult("short", {
      ...base,
      fs: {
        resolve: (p) => p,
        isFile: async () => true,
        readTextFile: async () => "",
        ensureDir: async () => {},
        writeTextFile: async (_p, c) => {
          writes.push(c);
        },
        writeBytes: async () => {},
      },
    });
    expect(out).toBeNull();
    expect(writes).toEqual([]);
  });
  it("fs 未注入 → null + 降级日志", async () => {
    const logs: string[] = [];
    const out = await saveOversizedResult("x".repeat(20), {
      ...base,
      fs: null,
      log: (m) => logs.push(m),
    });
    expect(out).toBeNull();
    expect(logs[0]).toContain("act: save skipped (no filesystem provider injected)");
  });
  it("写失败 → warning 不抛；成功返回路径（nowMs/join 注入稳定断言）", async () => {
    const ok = await saveOversizedResult("y".repeat(20), {
      ...base,
      nowMs: () => 123456,
      fs: {
        resolve: (p) => p,
        isFile: async () => true,
        readTextFile: async () => "",
        ensureDir: async () => {},
        writeTextFile: async () => {},
        writeBytes: async () => {},
      },
    });
    expect(ok).toBe("out/act_123456.txt");
    const logs: string[] = [];
    const failed = await saveOversizedResult("y".repeat(20), {
      ...base,
      fs: {
        resolve: (p) => p,
        isFile: async () => true,
        readTextFile: async () => "",
        ensureDir: async () => {
          throw new Error("disk full");
        },
        writeTextFile: async () => {},
        writeBytes: async () => {},
      },
      log: (m) => logs.push(m),
    });
    expect(failed).toBeNull();
    expect(logs[0]).toContain("act: save to file failed: disk full");
  });
});

describe("element-lookup 补充（dropdown 回显/后端 id 反查/pyRepr）", () => {
  it("describeDropdown 属性链与裸 tag 兜底", () => {
    const sel = makeNode({ backendNodeId: 3, nodeName: "SELECT", attributes: { name: "country" } });
    expect(describeDropdown(sel, 3)).toBe("[SELECT] 'country' at index 3");
    expect(describeDropdown(makeNode({ backendNodeId: 4, nodeName: "SELECT" }), 4)).toBe(
      "[SELECT] at index 4",
    );
  });
  it("findNodeByBackendId 在 selectorMap 反查；miss 返回 null", () => {
    const node = makeNode({ backendNodeId: 9, nodeName: "INPUT" });
    const state = new SerializedDOMState(null, new Map([[9, node]]), "");
    expect(findNodeByBackendId(9, state)).toBe(node);
    expect(findNodeByBackendId(8, state)).toBeNull();
    expect(findNodeByBackendId(9, null)).toBeNull();
  });
  it("pyRepr：单引号优先 / 含单引号切双引号 / 控制字符转义", () => {
    expect(pyRepr("plain")).toBe("'plain'");
    expect(pyRepr("it's")).toBe('"it\'s"');
    expect(pyRepr("a\nb")).toBe("'a\\nb'");
    expect(pyRepr("both'and\"")).toBe("'both\\'and\"'");
  });
});
