/**
 * 公共入口与未覆盖分支的补充测试（覆盖率目标 > 85%，见根 AGENTS.md）。
 * 期望值同样锚定 Python 参考实现或 types.ts 内 documented 行为。
 */
import { describe, expect, it } from "vitest";
import {
  createEmptyDomState,
  DOMRect,
  DOMTreeSerializer,
  EnhancedDOMTreeNode,
  NodeType,
  roundHalfEven,
  SerializedDOMState,
  SimplifiedNode,
} from "../src/index.js";

function el(
  name: string,
  nid: number,
  bid: number,
  extra: Partial<{
    attributes: Record<string, string>;
    parentNode: EnhancedDOMTreeNode | null;
    childrenNodes: EnhancedDOMTreeNode[] | null;
    snapshotNode: import("../src/index.js").EnhancedSnapshotNode | null;
  }> = {},
): EnhancedDOMTreeNode {
  return new EnhancedDOMTreeNode({
    nodeId: nid,
    backendNodeId: bid,
    nodeType: NodeType.ELEMENT_NODE,
    nodeName: name,
    nodeValue: "",
    attributes: extra.attributes ?? {},
    parentNode: extra.parentNode ?? null,
    childrenNodes: extra.childrenNodes ?? null,
    snapshotNode: extra.snapshotNode ?? null,
  });
}

describe("createEmptyDomState", () => {
  it("空态的 LLM 表述固定", () => {
    const s = createEmptyDomState();
    expect(s.root).toBeNull();
    expect(s.selectorMap.size).toBe(0);
    expect(s.llmRepresentation()).toBe(
      "Empty DOM tree (you might have to wait for the page to load)",
    );
  });
});

describe("DOMTreeSerializer（移植占位）", () => {
  it("构造器保存参数并填充默认选项", () => {
    const root = el("HTML", 1, 101);
    const s = new DOMTreeSerializer(root);
    expect(s.rootNode).toBe(root);
    expect(s.options.enableBboxFiltering).toBe(true);
    expect(s.options.paintOrderFiltering).toBe(true);
    expect(s.options.sessionId).toBeNull();
  });

  it("serializeTree 明确抛出未移植错误", () => {
    const s = new DOMTreeSerializer(el("HTML", 1, 101));
    expect(() => s.serializeTree(null, [])).toThrow(/尚未移植/);
  });
});

describe("SimplifiedNode.toJson", () => {
  it("剔除 children_nodes/shadow_roots，递归清理 content_document", () => {
    const innerDoc = el("DIV", 9, 109, { childrenNodes: [el("SPAN", 10, 110)] });
    const orig = el("DIV", 3, 103, {
      childrenNodes: [el("SPAN", 4, 104)],
      snapshotNode: {
        is_clickable: true,
        cursor_style: "pointer",
        bounds: new DOMRect(1, 2, 30, 40),
        clientRects: null,
        scrollRects: null,
        computed_styles: { overflow: "auto" },
        paint_order: 3,
        stacking_contexts: null,
      },
    });
    orig.contentDocument = innerDoc;
    orig.shadowRoots = [el("TEMPLATE", 5, 105)];
    const simplifiedChild = new SimplifiedNode(el("SPAN", 4, 104), []);
    simplifiedChild.highlightIndex = 7;
    simplifiedChild.isInteractive = true;
    const node = new SimplifiedNode(orig, [simplifiedChild]);
    node.ignoredByPaintOrder = true;

    const j = node.toJson();
    // 自身与 content_document 都被清理
    expect(j.children_nodes).toBeUndefined();
    expect(j.shadow_roots).toBeUndefined();
    expect(j.original_node).not.toHaveProperty("children_nodes");
    expect(j.original_node).not.toHaveProperty("shadow_roots");
    const cd = j.original_node as Record<string, unknown>;
    const inner = cd.content_document as Record<string, unknown>;
    expect(inner).not.toHaveProperty("children_nodes");
    expect(inner.node_id).toBe(9);
    // snapshot_node 投影
    const snap = cd.snapshot_node as Record<string, unknown>;
    expect(snap.bounds).toEqual({ x: 1, y: 2, width: 30, height: 40 });
    // 标志位与子节点
    expect(j.ignored_by_paint_order).toBe(true);
    expect(j.children).toHaveLength(1);
    expect((j.children as Record<string, unknown>[])[0].highlight_index).toBe(7);
  });
});

describe("几何便捷属性", () => {
  it("点击中心取 bounds，缺失时回落 clientRects，再缺则 0", () => {
    const withBounds = el("A", 1, 1, {
      snapshotNode: {
        is_clickable: null,
        cursor_style: null,
        bounds: new DOMRect(10, 20, 100, 40),
        clientRects: new DOMRect(0, 0, 1, 1),
        scrollRects: null,
        computed_styles: null,
        paint_order: null,
        stacking_contexts: null,
      },
    });
    expect(withBounds.x).toBe(60);
    expect(withBounds.y).toBe(40);
    expect(withBounds.width).toBe(100);
    expect(withBounds.height).toBe(40);

    const withClientOnly = el("A", 2, 2, {
      snapshotNode: {
        is_clickable: null,
        cursor_style: null,
        bounds: null,
        clientRects: new DOMRect(0, 10, 50, 20),
        scrollRects: null,
        computed_styles: null,
        paint_order: null,
        stacking_contexts: null,
      },
    });
    expect(withClientOnly.x).toBe(25);
    expect(withClientOnly.y).toBe(20);

    expect(el("A", 3, 3).x).toBe(0);
  });
});

describe("childrenAndShadowRoots / 文本深度限制", () => {
  it("children 与 shadowRoots 拼接", () => {
    const host = el("DIV", 1, 1, { childrenNodes: [el("SPAN", 2, 2)] });
    host.shadowRoots = [el("#document-fragment", 3, 3)];
    expect(host.childrenAndShadowRoots).toHaveLength(2);
  });

  it("getAllChildrenText 的 maxDepth 截断", () => {
    const leaf = new EnhancedDOMTreeNode({
      nodeId: 3,
      backendNodeId: 3,
      nodeType: NodeType.TEXT_NODE,
      nodeName: "#text",
      nodeValue: "deep",
      attributes: {},
    });
    const mid = el("P", 2, 2, { childrenNodes: [leaf] });
    const top = el("DIV", 1, 1, { childrenNodes: [mid] });
    // collect 语义：depth > maxDepth 即截断——div(0)→p(1)→text(2)
    expect(top.getAllChildrenText(2)).toBe("deep");
    expect(top.getAllChildrenText(1)).toBe("");
    expect(top.getAllChildrenText(0)).toBe("");
    expect(top.getAllChildrenText()).toBe("deep"); // 默认 -1 不限深
  });
});

describe("xpath 边界", () => {
  it("父节点是 iframe 时停止（自身段不输出）", () => {
    const iframe = el("IFRAME", 1, 101);
    const inner = el("BUTTON", 2, 102, { parentNode: iframe });
    expect(inner.xpath).toBe("");
  });

  it("DOCUMENT_FRAGMENT_NODE 段被跳过", () => {
    const frag = new EnhancedDOMTreeNode({
      nodeId: 9,
      backendNodeId: 9,
      nodeType: NodeType.DOCUMENT_FRAGMENT_NODE,
      nodeName: "#document-fragment",
      nodeValue: "",
      attributes: {},
    });
    const host = el("DIV", 1, 101);
    const btn = el("BUTTON", 2, 102, { parentNode: frag });
    frag.parentNode = host;
    expect(btn.xpath).toBe("div/button");
  });
});

describe("isActuallyScrollable 回落分支", () => {
  it("无 computed_styles 时按标签白名单判定", () => {
    const mk = (tag: string) =>
      el(tag, 1, 1, {
        snapshotNode: {
          is_clickable: null,
          cursor_style: null,
          bounds: null,
          clientRects: new DOMRect(0, 0, 100, 100),
          scrollRects: new DOMRect(0, 0, 300, 300),
          computed_styles: null,
          paint_order: null,
          stacking_contexts: null,
        },
      });
    expect(mk("div").isActuallyScrollable).toBe(true);
    expect(mk("span").isActuallyScrollable).toBe(false);
    // 尺寸未超出不可滚动
    const no = el("div", 2, 2, {
      snapshotNode: {
        is_clickable: null,
        cursor_style: null,
        bounds: null,
        clientRects: new DOMRect(0, 0, 300, 300),
        scrollRects: new DOMRect(0, 0, 300, 300),
        computed_styles: null,
        paint_order: null,
        stacking_contexts: null,
      },
    });
    expect(no.isActuallyScrollable).toBe(false);
    // 不可滚动节点 scrollInfo 为 null
    expect(el("div", 3, 3).scrollInfo).toBeNull();
  });
});

describe("roundHalfEven（Python round 对齐）", () => {
  it("银行家舍入与浮点噪声行为", () => {
    expect(roundHalfEven(2.5, 0)).toBe(2);
    expect(roundHalfEven(3.5, 0)).toBe(4);
    expect(roundHalfEven(-2.5, 0)).toBe(-2);
    expect(roundHalfEven(-3.5, 0)).toBe(-4);
    expect(roundHalfEven(1.05, 1)).toBe(1.1); // 1.05 的二进制值略大于 1.05，与 Python 一致向上
    expect(roundHalfEven(2.675, 2)).toBe(2.67); // 二进制略小于，与 Python 一致向下
  });
});

describe("含 class 属性的哈希（Python 参考值）", () => {
  it("stable 过滤动态类 / elementHash 保留原样 / 纯动态类被跳过", () => {
    const html = el("HTML", 1, 101);
    const body = el("BODY", 2, 102, { parentNode: html });
    html.childrenNodes = [body];
    const d1 = el("DIV", 3, 103, {
      attributes: { class: "btn focus primary", id: "submit-btn" },
      parentNode: body,
    });
    const d2 = el("DIV", 4, 104, { attributes: { class: "hover" }, parentNode: body });
    body.childrenNodes = [d1, d2];

    expect(d1.computeStableHash()).toBe(5011874368265053442n);
    expect(d1.elementHash).toBe(2254049951074699082n);
    // class="hover" 过滤后为空 → stable 哈希与完全没有 class 等价（该属性被跳过）
    expect(d2.computeStableHash()).toBe(583316059621962216n);
  });
});

describe("NodeType 枚举转录（反向映射）", () => {
  it("12 个成员与 DOM 规范值一致", () => {
    const expected: Record<number, string> = {
      1: "ELEMENT_NODE",
      2: "ATTRIBUTE_NODE",
      3: "TEXT_NODE",
      4: "CDATA_SECTION_NODE",
      5: "ENTITY_REFERENCE_NODE",
      6: "ENTITY_NODE",
      7: "PROCESSING_INSTRUCTION_NODE",
      8: "COMMENT_NODE",
      9: "DOCUMENT_NODE",
      10: "DOCUMENT_TYPE_NODE",
      11: "DOCUMENT_FRAGMENT_NODE",
      12: "NOTATION_NODE",
    };
    for (const [v, name] of Object.entries(expected)) {
      expect(NodeType[Number(v)]).toBe(name);
    }
  });
});

describe("SerializedDOMState.llmRepresentation", () => {
  it("有根时返回 elementTreeText 原文", () => {
    const root = new SimplifiedNode(el("HTML", 1, 101), []);
    const s = new SerializedDOMState(root, new Map(), "[1]<button>OK");
    expect(s.llmRepresentation()).toBe("[1]<button>OK");
    expect(createEmptyDomState().llmRepresentation()).toContain("Empty DOM tree");
  });
});

// ── 分支覆盖补充（期望值锚定 Python 或 documented 行为） ────────────────

describe("roundHalfEven 输入域边界", () => {
  it("非有限值与负位数原样返回", () => {
    expect(roundHalfEven(Number.NaN, 0)).toBeNaN();
    expect(roundHalfEven(1.5, -1)).toBe(1.5);
  });
  it("整数输入（e >= 0 的规格化路径）", () => {
    expect(roundHalfEven(5, 0)).toBe(5);
    expect(roundHalfEven(10, 1)).toBe(10);
    expect(roundHalfEven(0, 1)).toBe(0);
  });
});

describe("子节点访问的空路径", () => {
  it("children/childrenAndShadowRoots 在 childrenNodes 为 null 时", () => {
    const bare = el("DIV", 1, 1);
    expect(bare.children).toEqual([]);
    const host = el("DIV", 2, 2);
    host.shadowRoots = [el("#document-fragment", 3, 3)];
    expect(host.childrenAndShadowRoots).toHaveLength(1);
  });
});

describe("几何回退链", () => {
  const nullRectSnap = {
    is_clickable: null,
    cursor_style: null,
    bounds: null,
    clientRects: null,
    scrollRects: null,
    computed_styles: null,
    paint_order: null,
    stacking_contexts: null,
  } as const;
  it("snapshotNode 存在但 bounds/clientRects 皆空 → 中心 0", () => {
    const n = el("A", 1, 1, { snapshotNode: nullRectSnap });
    expect(n.x).toBe(0);
    expect(n.y).toBe(0);
  });
  it("无 snapshotNode / bounds 为空 → 宽高 0", () => {
    expect(el("A", 2, 2).width).toBe(0);
    expect(el("A", 3, 3).height).toBe(0);
    const noBounds = el("A", 4, 4, {
      snapshotNode: { ...nullRectSnap, clientRects: new DOMRect(0, 0, 10, 10) },
    });
    expect(noBounds.width).toBe(0);
  });
  it("toJson 对全空矩形的 snapshot_node 输出 null", () => {
    const n = el("A", 5, 5, { snapshotNode: nullRectSnap });
    const snap = n.toJson().snapshot_node as Record<string, unknown>;
    expect(snap.bounds).toBeNull();
    expect(snap.clientRects).toBeNull();
    expect(snap.scrollRects).toBeNull();
  });
});

describe("xpath：元素不在父的 children 列表中（无索引）", () => {
  it("getElementPosition 找不到时返回 0", () => {
    const html = el("HTML", 1, 101);
    const body = el("BODY", 2, 102, { parentNode: html, childrenNodes: [] });
    const a1 = el("A", 3, 103, { parentNode: body });
    // 同类元素不存在于父列表 → 无从索引；xpath 仍按父子链构建
    expect(a1.xpath).toBe("html/body/a");
  });
});

describe("文本表示的空分支", () => {
  it("无文本元素的 llmRepresentation 只有标签", () => {
    expect(el("A", 1, 1, { attributes: { href: "#" } }).llmRepresentation()).toBe("<a>");
  });
  it("getMeaningfulTextForLlm 跳过空值属性", () => {
    const n = el("INPUT", 2, 2, { attributes: { value: "", placeholder: "Search" } });
    expect(n.getMeaningfulTextForLlm()).toBe("Search");
  });
});

describe("isActuallyScrollable 的其余分支", () => {
  const mkSnap = (client: DOMRect, scroll: DOMRect, styles: Record<string, string> | null) =>
    ({
      is_clickable: null,
      cursor_style: null,
      bounds: null,
      clientRects: client,
      scrollRects: scroll,
      computed_styles: styles,
      paint_order: null,
      stacking_contexts: null,
    }) as import("../src/index.js").EnhancedSnapshotNode;

  it("isScrollable 标志直接短路为 true", () => {
    const n = el("DIV", 1, 1);
    n.isScrollable = true;
    expect(n.isActuallyScrollable).toBe(true);
    expect(n.scrollInfo).toBeNull(); // 无 snapshotNode，info 为 null
    expect(n.getScrollInfoText()).toBeNull(); // 不可滚动节点 text 为 null
  });

  it("computed_styles 缺 overflow 键 → 默认 visible → false；overflow-x: auto → true", () => {
    const client = new DOMRect(0, 0, 100, 100);
    const scroll = new DOMRect(0, 0, 300, 300);
    expect(el("DIV", 2, 2, { snapshotNode: mkSnap(client, scroll, {}) }).isActuallyScrollable).toBe(
      false,
    );
    expect(
      el("DIV", 3, 3, {
        snapshotNode: mkSnap(client, scroll, { overflow: "visible", "overflow-x": "auto" }),
      }).isActuallyScrollable,
    ).toBe(true);
  });

  it("scrollInfo 在 clientRects 缺失时为 null（经 isScrollable 标志短路进入）", () => {
    const n = el("DIV", 5, 5, {
      snapshotNode: {
        ...mkSnap(new DOMRect(0, 0, 100, 100), new DOMRect(0, 0, 300, 300), { overflow: "auto" }),
        clientRects: null,
      },
    });
    n.isScrollable = true; // 绕过几何判定，直达 scrollInfo 的 !scroll || !client 守卫
    expect(n.isActuallyScrollable).toBe(true);
    expect(n.scrollInfo).toBeNull();
  });
});

describe("滚动状态（Python 参考值）", () => {
  const mkScroll = (client: DOMRect, scroll: DOMRect) =>
    el("DIV", 1, 1, {
      snapshotNode: {
        is_clickable: null,
        cursor_style: null,
        bounds: client,
        clientRects: client,
        scrollRects: scroll,
        computed_styles: { overflow: "auto" },
        paint_order: null,
        stacking_contexts: null,
      },
    });

  it("已滚动状态：双轴百分比与 pages above/below", () => {
    const d = mkScroll(new DOMRect(0, 0, 500, 500), new DOMRect(50, 100, 2000, 1000));
    const info = d.scrollInfo!;
    expect(info.vertical_scroll_percentage).toBe(20.0);
    expect(info.horizontal_scroll_percentage).toBe(3.3);
    expect(info.pages_above).toBe(0.2);
    expect(info.pages_below).toBe(0.8);
    expect(d.getScrollInfoText()).toBe(
      "scroll: 20%, 0.8 pages below, 0.2 pages above, total: 2.0 pages",
    );
  });

  it("退化 client 高度 0：pages 全 0、total 1.0", () => {
    const d = mkScroll(new DOMRect(0, 0, 500, 0), new DOMRect(0, 0, 500, 1000));
    const info = d.scrollInfo!;
    expect(info.pages_below).toBe(0);
    expect(info.total_pages).toBe(1.0);
    expect(d.getScrollInfoText()).toBe("scroll: 0%, total: 1.0 pages");
  });

  it("仅横向可滚：上下不可滚 → 文本为 null", () => {
    const d = mkScroll(new DOMRect(0, 0, 500, 500), new DOMRect(0, 0, 1000, 500));
    expect(d.scrollInfo).not.toBeNull();
    expect(d.getScrollInfoText()).toBeNull();
  });
});

describe("cryptoUuid 回退路径", () => {
  it("无 globalThis.crypto.randomUUID 时用 Math.random 兜底", () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    delete (globalThis as { crypto?: unknown }).crypto;
    try {
      const n = el("DIV", 1, 1);
      expect(n.uuid).toMatch(/^[0-9a-f]+$/);
      expect(n.uuid.length).toBeGreaterThan(0);
    } finally {
      if (desc) Object.defineProperty(globalThis, "crypto", desc);
    }
  });
});
