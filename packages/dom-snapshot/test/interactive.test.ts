/**
 * isInteractive 14 规则瀑布单测。
 * 期望值锚定 Python 参考实跑（dom_snapshot.interactive.is_interactive，
 * 探针脚本 2026-09-22 实跑 26 用例全记录，见 models.test.ts 头部方法论）。
 */
import { describe, expect, it } from "vitest";
import { isInteractive } from "../src/interactive.js";
import {
  DOMRect,
  type EnhancedAXNode,
  EnhancedDOMTreeNode,
  type EnhancedSnapshotNode,
  NodeType,
} from "../src/types.js";

function mk(
  name: string,
  kw: Partial<{
    nid: number;
    bid: number;
    attributes: Record<string, string>;
    js: boolean;
    bounds: [number, number, number, number];
    cursor: string;
    axRole: string | null;
    axProps: [string, string | boolean | number | null][];
    children: EnhancedDOMTreeNode[];
  }> = {},
): EnhancedDOMTreeNode {
  const n = new EnhancedDOMTreeNode({
    nodeId: kw.nid ?? 1,
    backendNodeId: kw.bid ?? 1,
    nodeType: NodeType.ELEMENT_NODE,
    nodeName: name,
    nodeValue: "",
    attributes: kw.attributes ?? {},
    childrenNodes: kw.children ?? null,
  });
  n.hasJsClickListener = kw.js ?? false;
  if (kw.bounds || kw.cursor) {
    const snap: EnhancedSnapshotNode = {
      is_clickable: null,
      cursor_style: kw.cursor ?? null,
      bounds: kw.bounds ? new DOMRect(...kw.bounds) : null,
      clientRects: null,
      scrollRects: null,
      computed_styles: null,
      paint_order: null,
      stacking_contexts: null,
    };
    n.snapshotNode = snap;
  }
  if (kw.axProps || kw.axRole !== undefined) {
    const ax: EnhancedAXNode = {
      ax_node_id: "a",
      ignored: false,
      role: kw.axRole ?? null,
      name: null,
      description: null,
      properties: (kw.axProps ?? []).map(([name, value]) => ({ name, value })),
      child_ids: null,
    };
    n.axNode = ax;
  }
  for (const child of kw.children ?? []) child.parentNode = n;
  return n;
}

describe("isInteractive（Python 参考值锚定）", () => {
  it("规则 1/2：非 ELEMENT 与 html/body 排除", () => {
    const textNode = new EnhancedDOMTreeNode({
      nodeId: 1,
      backendNodeId: 1,
      nodeType: NodeType.TEXT_NODE,
      nodeName: "#text",
      nodeValue: "x",
      attributes: {},
    });
    expect(isInteractive(textNode)).toBe(false);
    expect(isInteractive(mk("BODY"))).toBe(false);
  });

  it("规则 3：JS click listener 最强信号", () => {
    expect(isInteractive(mk("SPAN", { js: true }))).toBe(true);
  });

  it("规则 4：iframe >100x100 交互；小尺寸否", () => {
    expect(isInteractive(mk("IFRAME", { bounds: [0, 0, 200, 150] }))).toBe(true);
    expect(isInteractive(mk("IFRAME", { bounds: [0, 0, 80, 50] }))).toBe(false);
  });

  it("规则 5：label[for] 短路 False（先于后代检查）；包裹 input 的 label True", () => {
    expect(isInteractive(mk("LABEL", { attributes: { for: "x" } }))).toBe(false);
    expect(
      isInteractive(
        mk("LABEL", { attributes: { for: "x" }, children: [mk("INPUT", { nid: 2, bid: 2 })] }),
      ),
    ).toBe(false);
    expect(isInteractive(mk("LABEL", { children: [mk("INPUT", { nid: 2, bid: 2 })] }))).toBe(true);
  });

  it("规则 6：span 包裹表单控件 True（maxDepth=2 内）；纯 span False；depth-3 仍可检出", () => {
    expect(isInteractive(mk("SPAN", { children: [mk("SELECT", { nid: 2, bid: 2 })] }))).toBe(true);
    expect(isInteractive(mk("SPAN"))).toBe(false);
    // span → em → input：em 层递归仍在 maxDepth 预算内（Python 实跑 True）
    expect(
      isInteractive(
        mk("SPAN", {
          children: [mk("EM", { nid: 2, bid: 2, children: [mk("INPUT", { nid: 3, bid: 3 })] })],
        }),
      ),
    ).toBe(true);
  });

  it("规则 7：搜索关键词（class/id/data-* 子串）", () => {
    expect(isInteractive(mk("DIV", { attributes: { class: "my search-box" } }))).toBe(true);
    expect(isInteractive(mk("DIV", { attributes: { id: "global-find" } }))).toBe(true);
    expect(isInteractive(mk("DIV", { attributes: { "data-testid": "magnify-glass" } }))).toBe(true);
  });

  it("规则 8：AX 属性（disabled/hidden 短路；focusable 需真值；checked 只看名；keyshortcuts）", () => {
    expect(isInteractive(mk("INPUT", { axProps: [["disabled", true]] }))).toBe(false);
    expect(isInteractive(mk("INPUT", { axProps: [["hidden", true]] }))).toBe(false);
    // focusable=False 不命中（需真值）；input 走规则 9 前，规则 8 无真值属性 → False
    expect(isInteractive(mk("DIV", { axProps: [["focusable", false]] }))).toBe(false);
    // checked 即使值为 False 也命中（Python 只查属性名）
    expect(isInteractive(mk("DIV", { axProps: [["checked", false]] }))).toBe(true);
    // required 空串为假值不命中
    expect(isInteractive(mk("DIV", { axProps: [["required", ""]] }))).toBe(false);
    expect(isInteractive(mk("DIV", { axProps: [["keyshortcuts", "Enter"]] }))).toBe(true);
  });

  it("规则 9-12：交互标签 / 内联事件 / HTML role / AX role", () => {
    expect(isInteractive(mk("BUTTON"))).toBe(true);
    expect(isInteractive(mk("DIV", { attributes: { onclick: "f()" } }))).toBe(true);
    expect(isInteractive(mk("DIV", { attributes: { role: "menuitem" } }))).toBe(true);
    expect(isInteractive(mk("DIV", { axRole: "slider" }))).toBe(true);
  });

  it("规则 13/14：图标尺寸 + 交互属性；cursor pointer 兜底", () => {
    expect(isInteractive(mk("I", { bounds: [0, 0, 30, 30], attributes: { class: "ico" } }))).toBe(
      true,
    );
    expect(isInteractive(mk("I", { bounds: [0, 0, 30, 30] }))).toBe(false);
    expect(isInteractive(mk("DIV", { bounds: [0, 0, 200, 40], cursor: "pointer" }))).toBe(true);
  });
});
