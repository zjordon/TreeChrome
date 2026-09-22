/**
 * 绘制顺序过滤单测：Rect/RectUnionPure 几何差集 + PaintOrderRemover 遮挡标记。
 * 几何期望值锚定 Python 参考实跑（dom_snapshot.paint_order，2026-09-22 探针）。
 */
import { describe, expect, it } from "vitest";
import { PaintOrderRemover, Rect, RectUnionPure } from "../src/paint-order.js";
import {
  DOMRect,
  EnhancedDOMTreeNode,
  type EnhancedSnapshotNode,
  NodeType,
  SimplifiedNode,
} from "../src/types.js";

describe("RectUnionPure（Python 参考值锚定）", () => {
  it("去重与重叠合并：并集增长才 True；覆盖判定跨矩形拼接", () => {
    const u = new RectUnionPure();
    expect(u.add(new Rect(0, 0, 10, 10))).toBe(true);
    expect(u.add(new Rect(0, 0, 10, 10))).toBe(false); // 已覆盖
    expect(u.add(new Rect(5, 0, 15, 10))).toBe(true); // 部分新区域
    expect(u.contains(new Rect(6, 2, 9, 8))).toBe(true);
    expect(u.contains(new Rect(2, 2, 13, 6))).toBe(true); // 跨两块拼接覆盖
    expect(u.contains(new Rect(20, 20, 25, 25))).toBe(false);
    expect(u.contains(new Rect(8, 2, 14, 8))).toBe(true); // 在 [0,15]x[0,10] 并集内
  });

  it("L 形并集：拼接域包含、缺口不包含", () => {
    const v = new RectUnionPure();
    v.add(new Rect(0, 0, 10, 5));
    v.add(new Rect(0, 5, 5, 10));
    expect(v.contains(new Rect(1, 1, 4, 9))).toBe(true);
    expect(v.contains(new Rect(6, 6, 9, 9))).toBe(false);
  });

  it("MAX_RECTS=5000 安全上限：超限后 add 保守拒绝", () => {
    const w = new RectUnionPure();
    let added = 0;
    for (let i = 0; i < 5100; i++) {
      if (w.add(new Rect(i * 3, 0, i * 3 + 2, 2))) added += 1;
    }
    expect(added).toBe(5000);
  });
});

describe("Rect 基础几何", () => {
  it("intersects/contains 边界（共边不算相交）", () => {
    const a = new Rect(0, 0, 10, 10);
    expect(a.intersects(new Rect(10, 0, 20, 10))).toBe(false); // 仅共边
    expect(a.intersects(new Rect(9, 9, 11, 11))).toBe(true);
    expect(a.contains(new Rect(0, 0, 10, 10))).toBe(true);
    expect(a.contains(new Rect(-1, 0, 5, 5))).toBe(false);
    expect(a.area()).toBe(100);
  });
});

// ── PaintOrderRemover ───────────────────────────────────────────────────

function nodeWith(name: string, nid: number, snap: Partial<EnhancedSnapshotNode>): SimplifiedNode {
  const el = new EnhancedDOMTreeNode({
    nodeId: nid,
    backendNodeId: nid,
    nodeType: NodeType.ELEMENT_NODE,
    nodeName: name,
    nodeValue: "",
    attributes: {},
  });
  el.snapshotNode = {
    is_clickable: null,
    cursor_style: null,
    bounds: null,
    clientRects: null,
    scrollRects: null,
    computed_styles: null,
    paint_order: null,
    stacking_contexts: null,
    ...snap,
  };
  return new SimplifiedNode(el, []);
}

const OPAQUE_WHITE = { "background-color": "rgb(255, 255, 255)", opacity: "1" };

describe("PaintOrderRemover", () => {
  it("高 paintOrder 前景完全遮挡低层：标记 simplified 与 original 双侧", () => {
    const fg = nodeWith("DIV", 1, {
      bounds: new DOMRect(0, 0, 200, 100),
      paint_order: 10,
      computed_styles: OPAQUE_WHITE,
    });
    const bg = nodeWith("DIV", 2, {
      bounds: new DOMRect(10, 10, 50, 30),
      paint_order: 1,
      computed_styles: { "background-color": "rgb(0,0,0)" },
    });
    const root = new SimplifiedNode(
      new EnhancedDOMTreeNode({
        nodeId: 0,
        backendNodeId: 0,
        nodeType: NodeType.ELEMENT_NODE,
        nodeName: "HTML",
        nodeValue: "",
        attributes: {},
      }),
      [fg, bg],
    );
    new PaintOrderRemover(root).calculatePaintOrder();
    expect(bg.ignoredByPaintOrder).toBe(true);
    expect(bg.originalNode.ignoredByPaintOrder).toBe(true);
    expect(fg.ignoredByPaintOrder).toBe(false);
  });

  it("透明背景（rgba(0,0,0,0)）与低不透明度（<0.8）不遮挡", () => {
    const transparent = nodeWith("DIV", 1, {
      bounds: new DOMRect(0, 0, 200, 100),
      paint_order: 10,
      computed_styles: { "background-color": "rgba(0, 0, 0, 0)" },
    });
    const semi = nodeWith("DIV", 2, {
      bounds: new DOMRect(0, 200, 200, 100),
      paint_order: 10,
      computed_styles: { "background-color": "rgb(255,255,255)", opacity: "0.5" },
    });
    const bg1 = nodeWith("SPAN", 3, {
      bounds: new DOMRect(10, 10, 50, 30),
      paint_order: 1,
      computed_styles: { "background-color": "rgb(0,0,0)" },
    });
    const bg2 = nodeWith("SPAN", 4, {
      bounds: new DOMRect(10, 210, 50, 30),
      paint_order: 1,
      computed_styles: { "background-color": "rgb(0,0,0)" },
    });
    const root = new SimplifiedNode(
      new EnhancedDOMTreeNode({
        nodeId: 0,
        backendNodeId: 0,
        nodeType: NodeType.ELEMENT_NODE,
        nodeName: "HTML",
        nodeValue: "",
        attributes: {},
      }),
      [transparent, semi, bg1, bg2],
    );
    new PaintOrderRemover(root).calculatePaintOrder();
    expect(bg1.ignoredByPaintOrder).toBe(false);
    expect(bg2.ignoredByPaintOrder).toBe(false);
  });

  it("部分遮挡不标记；无 paint_order 数据的节点跳过", () => {
    const fg = nodeWith("DIV", 1, {
      bounds: new DOMRect(0, 0, 100, 100),
      paint_order: 10,
      computed_styles: OPAQUE_WHITE,
    });
    const partial = nodeWith("SPAN", 2, {
      bounds: new DOMRect(50, 50, 150, 50),
      paint_order: 1,
      computed_styles: { "background-color": "rgb(0,0,0)" },
    });
    const noData = nodeWith("SPAN", 3, {});
    const root = new SimplifiedNode(
      new EnhancedDOMTreeNode({
        nodeId: 0,
        backendNodeId: 0,
        nodeType: NodeType.ELEMENT_NODE,
        nodeName: "HTML",
        nodeValue: "",
        attributes: {},
      }),
      [fg, partial, noData],
    );
    new PaintOrderRemover(root).calculatePaintOrder();
    expect(partial.ignoredByPaintOrder).toBe(false);
    expect(noData.ignoredByPaintOrder).toBe(false);
  });

  it("同 paintOrder 组内先判定后批量入并集（组内不互相遮挡）", () => {
    // 两块同序（5）拼合覆盖第三块同序区域：同组节点判定发生在本组矩形入并集前
    const a = nodeWith("DIV", 1, {
      bounds: new DOMRect(0, 0, 100, 50),
      paint_order: 5,
      computed_styles: OPAQUE_WHITE,
    });
    const b = nodeWith("DIV", 2, {
      bounds: new DOMRect(0, 50, 100, 50),
      paint_order: 5,
      computed_styles: OPAQUE_WHITE,
    });
    const c = nodeWith("SPAN", 3, {
      bounds: new DOMRect(10, 10, 80, 80),
      paint_order: 5,
      computed_styles: { "background-color": "rgb(0,0,0)" },
    });
    // 低序块则被上组拼合覆盖
    const low = nodeWith("SPAN", 4, {
      bounds: new DOMRect(10, 10, 80, 80),
      paint_order: 4,
      computed_styles: { "background-color": "rgb(0,0,0)" },
    });
    const root = new SimplifiedNode(
      new EnhancedDOMTreeNode({
        nodeId: 0,
        backendNodeId: 0,
        nodeType: NodeType.ELEMENT_NODE,
        nodeName: "HTML",
        nodeValue: "",
        attributes: {},
      }),
      [a, b, c, low],
    );
    new PaintOrderRemover(root).calculatePaintOrder();
    expect(c.ignoredByPaintOrder).toBe(false); // 同组：判定先于入并集
    expect(low.ignoredByPaintOrder).toBe(true); // 低组：被 a+b 拼合覆盖
  });
});
