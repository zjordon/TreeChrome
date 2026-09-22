/**
 * P1.3 serializer 五步过滤移植验收：
 * 1. golden fixture 的 input 喂 TS 采集融合 + 序列化 → element_tree_text 逐字节对拍
 *    （输出格式是 LLM prompt 契约，架构 §10）
 * 2. selector_map 键集合与 page_stats 与 Python 全等
 * 3. 五步过滤各关键分支的合成场景单测（简化树/遮挡/剪枝/包围盒/编号/复合控件/属性构建）
 */
import { describe, expect, it } from "vitest";
import { DomCollector } from "../src/collector.js";
import { buildAttributesString, DOMTreeSerializer, isMeaningfulText } from "../src/serializer.js";
import {
  DEFAULT_INCLUDE_ATTRIBUTES,
  DOMRect,
  EnhancedDOMTreeNode,
  type EnhancedSnapshotNode,
  NodeType,
  SerializedDOMState,
  SimplifiedNode,
} from "../src/types.js";
import { makeGoldenFixtureClient } from "./fake-cdp.js";
import { loadGoldenFixtures } from "./golden-fixture.js";

const fixtures = loadGoldenFixtures();

// ── 测试用节点构建器 ────────────────────────────────────────────────────

function el(
  name: string,
  nid: number,
  bid: number,
  extra: Partial<{
    attributes: Record<string, string>;
    parentNode: EnhancedDOMTreeNode | null;
    childrenNodes: EnhancedDOMTreeNode[] | null;
    snapshotNode: EnhancedSnapshotNode | null;
    isVisible: boolean | null;
    nodeType: NodeType;
    nodeValue: string;
    axNode: EnhancedDOMTreeNode["axNode"];
  }> = {},
): EnhancedDOMTreeNode {
  const node = new EnhancedDOMTreeNode({
    nodeId: nid,
    backendNodeId: bid,
    nodeType: extra.nodeType ?? NodeType.ELEMENT_NODE,
    nodeName: name,
    nodeValue: extra.nodeValue ?? "",
    attributes: extra.attributes ?? {},
    parentNode: extra.parentNode ?? null,
    childrenNodes: extra.childrenNodes ?? null,
    axNode: extra.axNode ?? null,
    snapshotNode: extra.snapshotNode ?? null,
  });
  node.isVisible = extra.isVisible ?? null;
  return node;
}

function text(value: string, nid: number, bid: number, visible = true): EnhancedDOMTreeNode {
  const t = el("#text", nid, bid, {
    nodeType: NodeType.TEXT_NODE,
    nodeValue: value,
    snapshotNode: visible ? emptySnap() : null,
  });
  t.isVisible = visible;
  return t;
}

function emptySnap(overrides: Partial<EnhancedSnapshotNode> = {}): EnhancedSnapshotNode {
  return {
    is_clickable: null,
    cursor_style: null,
    bounds: null,
    clientRects: null,
    scrollRects: null,
    computed_styles: null,
    paint_order: null,
    stacking_contexts: null,
    ...overrides,
  };
}

function snapWithBounds(x: number, y: number, w: number, h: number): EnhancedSnapshotNode {
  return emptySnap({ bounds: new DOMRect(x, y, w, h) });
}

/** 便捷：直接对融合树根跑五步管线 */
function serializeRoot(
  root: EnhancedDOMTreeNode,
  sessionId: string | null = null,
): { state: SerializedDOMState; timingInfo: Record<string, number> } {
  return new DOMTreeSerializer(root, { sessionId }).serializeAccessibleElements();
}

/** doc → html → children 的合成文档（子节点挂 parentNode） */
function docOf(children: EnhancedDOMTreeNode[]): EnhancedDOMTreeNode {
  const doc = el("#document", 1, 1, { nodeType: NodeType.DOCUMENT_NODE });
  const html = el("HTML", 2, 2, {
    isVisible: true,
    snapshotNode: snapWithBounds(0, 0, 1000, 1000),
  });
  html.childrenNodes = children;
  for (const c of children) c.parentNode = html;
  doc.childrenNodes = [html];
  return doc;
}

// ── P1.3 验收：golden 逐字节对拍 ────────────────────────────────────────

describe.skipIf(fixtures.length === 0)("golden 序列化对拍（P1.3 验收）", () => {
  for (const { name, fixture } of fixtures) {
    it(`${name}: element_tree_text 逐字节一致 + selector_map/page_stats 全等`, async () => {
      const client = makeGoldenFixtureClient(fixture);
      const built = await new DomCollector(client).buildEnhancedDomTree("sess-main");
      expect(built.root).not.toBeNull();

      const { state } = serializeRoot(built.root!, "sess-main");

      // 逐字节对拍（失败时打印首个差异窗口辅助定位）
      const expected = fixture.output.element_tree_text;
      if (state.elementTreeText !== expected) {
        let i = 0;
        while (
          i < expected.length &&
          i < state.elementTreeText.length &&
          expected[i] === state.elementTreeText[i]
        ) {
          i += 1;
        }
        const win = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 60), i + 80));
        throw new Error(
          `element_tree_text 首个差异 @${i}:\n  py: ${win(expected)}\n  ts: ${win(state.elementTreeText)}`,
        );
      }

      // selector_map 键集合（键 = highlight_index = backendNodeId）
      const pyKeys = Object.keys(fixture.output.selector_map)
        .map(Number)
        .sort((a, b) => a - b);
      const tsKeys = [...state.selectorMap.keys()].sort((a, b) => a - b);
      expect(tsKeys).toEqual(pyKeys);

      // page_stats
      expect(state.pageStats).toEqual(fixture.output.page_stats);
    });
  }
});

// ── isMeaningfulText（单字符噪声过滤，Python 参考值） ─────────────────────

describe("isMeaningfulText", () => {
  it("多字符保留；单字符仅字母/数字（含 CJK）；装饰符滤除", () => {
    expect(isMeaningfulText("hello")).toBe(true);
    expect(isMeaningfulText("  spaced  ")).toBe(true); // strip 后多字符
    expect(isMeaningfulText("5")).toBe(true);
    expect(isMeaningfulText("甲")).toBe(true);
    expect(isMeaningfulText("•")).toBe(false);
    expect(isMeaningfulText("|")).toBe(false);
    expect(isMeaningfulText("·")).toBe(false);
    expect(isMeaningfulText("")).toBe(false);
    expect(isMeaningfulText("   ")).toBe(false);
  });
});

// ── Step 1: 简化树 ──────────────────────────────────────────────────────

describe("Step 1 简化树过滤", () => {
  const visible = (nid: number, bid: number, name = "DIV"): EnhancedDOMTreeNode =>
    el(name, nid, bid, { isVisible: true, snapshotNode: snapWithBounds(0, 0, 10, 10) });

  it("禁用元素与 SVG 子元素被丢弃", () => {
    const root = el("#document", 1, 1, { nodeType: NodeType.DOCUMENT_NODE });
    const html = visible(2, 2, "HTML");
    html.childrenNodes = [
      el("SCRIPT", 3, 3, { isVisible: true }),
      el("STYLE", 4, 4, { isVisible: true }),
      el("PATH", 5, 5, { isVisible: true }),
      visible(6, 6, "P"),
    ];
    root.childrenNodes = [html];
    const { state } = serializeRoot(root);
    // 只剩 p（html 无行）
    expect(state.elementTreeText).toBe("");
    // 树根仍可遍历：直接检查简化结构
    const ser = new DOMTreeSerializer(root);
    const simplified = ser["createSimplifiedTree"](root, 0);
    expect(simplified?.children.map((c) => c.originalNode.nodeName)).toEqual(["P"]);
  });

  it("TEXT_NODE 需可见 + 有意义", () => {
    const doc = el("#document", 1, 1, { nodeType: NodeType.DOCUMENT_NODE });
    const p = visible(2, 2, "P");
    const good = text("正文内容", 3, 3, true);
    const hidden = text("隐藏文本", 4, 4, false);
    const noise = text("•", 5, 5, true);
    p.childrenNodes = [good, hidden, noise];
    doc.childrenNodes = [p];
    const simplified = new DOMTreeSerializer(doc)["createSimplifiedTree"](doc, 0);
    expect(simplified?.children.map((c) => c.originalNode.nodeValue)).toEqual(["正文内容"]);
  });

  it("aria-* 属性强制不可见元素参与保留（子文本进入文本树）", () => {
    const doc = el("#document", 1, 1, { nodeType: NodeType.DOCUMENT_NODE });
    const div = el("DIV", 2, 2, { attributes: { "aria-label": "x" }, isVisible: false });
    const t = text("强制保留", 3, 3, true);
    div.childrenNodes = [t];
    doc.childrenNodes = [div];
    const simplified = new DOMTreeSerializer(doc)["createSimplifiedTree"](doc, 0);
    expect(simplified?.originalNode.nodeName).toBe("DIV");
    expect(simplified?.children).toHaveLength(1);
  });

  it("隐藏的 file input 强制保留", () => {
    const doc = el("#document", 1, 1, { nodeType: NodeType.DOCUMENT_NODE });
    const input = el("INPUT", 2, 2, {
      attributes: { type: "file" },
      isVisible: false,
      snapshotNode: emptySnap({ computed_styles: { opacity: "0" } }),
    });
    doc.childrenNodes = [input];
    const simplified = new DOMTreeSerializer(doc)["createSimplifiedTree"](doc, 0);
    expect(simplified?.originalNode.tagName).toBe("input");
  });

  it("UA shadow root 被跳过，open/closed shadow 片段保留", () => {
    const host = visible(2, 2, "DIV");
    const uaFrag = el("#document-fragment", 3, 3, { nodeType: NodeType.DOCUMENT_FRAGMENT_NODE });
    uaFrag.shadowRootType = "user-agent";
    uaFrag.childrenNodes = [visible(4, 4, "SPAN")];
    const openFrag = el("#document-fragment", 5, 5, { nodeType: NodeType.DOCUMENT_FRAGMENT_NODE });
    openFrag.shadowRootType = "open";
    openFrag.childrenNodes = [visible(6, 6, "BUTTON")];
    host.shadowRoots = [uaFrag, openFrag];

    const doc = el("#document", 1, 1, { nodeType: NodeType.DOCUMENT_NODE });
    doc.childrenNodes = [host];
    const simplified = new DOMTreeSerializer(doc)["createSimplifiedTree"](doc, 0);
    expect(simplified?.isShadowHost).toBe(true);
    // 只有 open 片段进入 children（host 的 children = 片段）
    expect(simplified?.children.map((c) => c.originalNode.shadowRootType)).toEqual(["open"]);
  });

  it("排除标记 data-browser-use-exclude=true 丢弃（带 sessionId 时优先会话键）", () => {
    const mk = (attrs: Record<string, string>) => {
      const doc = el("#document", 1, 1, { nodeType: NodeType.DOCUMENT_NODE });
      doc.childrenNodes = [
        el("DIV", 2, 2, {
          attributes: attrs,
          isVisible: true,
          snapshotNode: snapWithBounds(0, 0, 5, 5),
        }),
      ];
      return new DOMTreeSerializer(doc)["createSimplifiedTree"](doc, 0);
    };
    expect(mk({ "data-browser-use-exclude": "true" })).toBeNull();
    expect(mk({ "data-browser-use-exclude": "TRUE" })).toBeNull();
    expect(mk({ "data-browser-use-exclude": "false" })).not.toBeNull();
    // sessionId 命中会话专属键
    const doc2 = el("#document", 1, 1, { nodeType: NodeType.DOCUMENT_NODE });
    doc2.childrenNodes = [
      el("DIV", 3, 3, {
        attributes: { "data-browser-use-exclude-S1": "true" },
        isVisible: true,
        snapshotNode: snapWithBounds(0, 0, 5, 5),
      }),
    ];
    expect(
      new DOMTreeSerializer(doc2, { sessionId: "S1" })["createSimplifiedTree"](doc2, 0),
    ).toBeNull();
  });

  it("iframe 无 contentDocument 返回 null；有则递归其子文档", () => {
    const doc = el("#document", 1, 1, { nodeType: NodeType.DOCUMENT_NODE });
    const empty = el("IFRAME", 2, 2, { isVisible: true });
    doc.childrenNodes = [empty];
    expect(new DOMTreeSerializer(doc)["createSimplifiedTree"](doc, 0)).toBeNull();

    const withDoc = el("IFRAME", 3, 3, { isVisible: true });
    const inner = el("#document", 4, 4, { nodeType: NodeType.DOCUMENT_NODE });
    inner.childrenNodes = [visible(5, 5, "BUTTON")];
    withDoc.contentDocument = inner;
    doc.childrenNodes = [withDoc];
    const simplified = new DOMTreeSerializer(doc)["createSimplifiedTree"](doc, 0);
    expect(simplified?.originalNode.nodeName).toBe("IFRAME");
    expect(simplified?.children.map((c) => c.originalNode.nodeName)).toEqual(["BUTTON"]);
  });
});

// ── Step 2/3: paint order + 剪枝 ────────────────────────────────────────

describe("Step 3 树优化剪枝", () => {
  it("不可见且无子内容的中间容器被剪除，可见容器保留", () => {
    const doc = el("#document", 1, 1, { nodeType: NodeType.DOCUMENT_NODE });
    const html = el("HTML", 2, 2, {
      isVisible: true,
      snapshotNode: snapWithBounds(0, 0, 100, 100),
    });
    const emptyHidden = el("DIV", 3, 3, { isVisible: false });
    const withText = el("DIV", 4, 4, { isVisible: false, childrenNodes: [text("内容", 5, 5)] });
    html.childrenNodes = [emptyHidden, withText];
    doc.childrenNodes = [html];
    const simplified = new DOMTreeSerializer(doc)["createSimplifiedTree"](doc, 0);
    const optimized = new DOMTreeSerializer(doc)["optimizeTree"](simplified);
    expect(optimized?.children.map((c) => c.originalNode.nodeId)).toEqual([4]);
  });
});

// ── Step 4: 包围盒过滤 ──────────────────────────────────────────────────

describe("Step 4 包围盒过滤", () => {
  function hostTree(children: EnhancedDOMTreeNode[]): EnhancedDOMTreeNode {
    const doc = el("#document", 1, 1, { nodeType: NodeType.DOCUMENT_NODE });
    const html = el("HTML", 2, 2, {
      isVisible: true,
      snapshotNode: snapWithBounds(0, 0, 1000, 1000),
    });
    const a = el("A", 3, 3, { isVisible: true, snapshotNode: snapWithBounds(10, 10, 200, 50) });
    a.childrenNodes = children;
    for (const c of children) c.parentNode = a;
    html.childrenNodes = [a];
    doc.childrenNodes = [html];
    return doc;
  }

  /** doc → html → a → children：createSimplifiedTree 返回 html 子树，a 的子节点在第二层 */
  function aChildrenOf(doc: EnhancedDOMTreeNode): SimplifiedNode[] {
    const ser = new DOMTreeSerializer(doc);
    const simplified = ser["createSimplifiedTree"](doc, 0);
    ser["applyBoundingBoxFiltering"](simplified!);
    return simplified!.children[0]!.children;
  }

  it("被 <a> 完全包含的普通子元素标记 excluded_by_parent；文本节点豁免", () => {
    const span = el("SPAN", 4, 4, {
      isVisible: true,
      snapshotNode: snapWithBounds(12, 12, 100, 20),
    });
    const t = text("链接文本", 5, 5);
    const kids = aChildrenOf(hostTree([span, t]));
    expect(kids[0].excludedByParent).toBe(true);
    expect(kids[1].excludedByParent).toBe(false);
  });

  it("例外规则：表单元素/onclick/aria-label/交互 role/传播型子元素不排除", () => {
    const mk = (
      name: string,
      nid: number,
      attrs: Record<string, string>,
      snap = snapWithBounds(12, 12, 100, 20),
    ) => el(name, nid, nid, { attributes: attrs, isVisible: true, snapshotNode: snap });
    const cases = [
      mk("INPUT", 4, { type: "text" }),
      mk("SELECT", 5, {}),
      mk("TEXTAREA", 6, {}),
      mk("LABEL", 7, {}),
      mk("BUTTON", 8, {}),
      mk("SPAN", 9, { onclick: "f()" }),
      mk("SPAN", 10, { "aria-label": "独立目标" }),
      mk("SPAN", 11, { role: "button" }),
    ];
    const kids = aChildrenOf(hostTree(cases));
    expect(kids.every((c) => !c.excludedByParent)).toBe(true);
  });

  it("包含比例低于阈值不排除；零面积子元素不排除", () => {
    const half = el("SPAN", 4, 4, {
      isVisible: true,
      snapshotNode: snapWithBounds(100, 10, 200, 50),
    }); // 仅半重叠
    const zero = el("SPAN", 5, 5, { isVisible: true, snapshotNode: snapWithBounds(10, 10, 0, 0) });
    const kids = aChildrenOf(hostTree([half, zero]));
    expect(kids[0].excludedByParent).toBe(false);
    expect(kids[1].excludedByParent).toBe(false);
  });

  it("传播型元素嵌套时子树使用新的包围盒（div role=button）", () => {
    const doc = el("#document", 1, 1, { nodeType: NodeType.DOCUMENT_NODE });
    const html = el("HTML", 2, 2, {
      isVisible: true,
      snapshotNode: snapWithBounds(0, 0, 1000, 1000),
    });
    const divBtn = el("DIV", 3, 3, {
      attributes: { role: "button" },
      isVisible: true,
      snapshotNode: snapWithBounds(0, 0, 300, 100),
    });
    const a = el("A", 4, 4, { isVisible: true, snapshotNode: snapWithBounds(400, 0, 200, 50) });
    const innerSpan = el("SPAN", 5, 5, {
      isVisible: true,
      snapshotNode: snapWithBounds(10, 10, 50, 20),
    });
    divBtn.childrenNodes = [innerSpan];
    html.childrenNodes = [divBtn, a];
    doc.childrenNodes = [html];
    const ser = new DOMTreeSerializer(doc);
    const simplified = ser["createSimplifiedTree"](doc, 0);
    ser["applyBoundingBoxFiltering"](simplified!);
    // innerSpan 被 div[role=button] 的包围盒包含 → 排除
    expect(simplified!.children[0].children[0].excludedByParent).toBe(true);
  });
});

// ── Step 5: 交互编号 ────────────────────────────────────────────────────

describe("Step 5 交互编号与新元素标记", () => {
  it("可交互元素编号 = backendNodeId，进入 selector_map", () => {
    const btn = el("BUTTON", 4, 77, {
      isVisible: true,
      snapshotNode: snapWithBounds(0, 0, 50, 30),
    });
    const { state } = serializeRoot(docOf([btn]));
    expect(state.selectorMap.has(77)).toBe(true);
    expect(state.elementTreeText).toContain("[77]<button");
  });

  it("不可交互且不可滚动的可见元素不编号（text 输出无前缀）", () => {
    const p = el("P", 4, 88, { isVisible: true, snapshotNode: snapWithBounds(0, 0, 100, 20) });
    p.childrenNodes = [text("段落", 5, 5)];
    const { state } = serializeRoot(docOf([p]));
    expect(state.selectorMap.size).toBe(0);
    expect(state.elementTreeText).toBe("段落");
  });

  it("滚动下拉容器编号；滚动容器含交互后代时不编号", () => {
    const mkScroll = (
      nid: number,
      bid: number,
      attrs: Record<string, string>,
      children: EnhancedDOMTreeNode[] = [],
    ) => {
      const d = el("DIV", nid, bid, {
        attributes: attrs,
        isVisible: true,
        snapshotNode: emptySnap({
          bounds: new DOMRect(0, 0, 300, 300),
          clientRects: new DOMRect(0, 0, 300, 300),
          scrollRects: new DOMRect(0, 0, 300, 900),
          computed_styles: { overflow: "auto" },
        }),
      });
      d.childrenNodes = children;
      for (const c of children) c.parentNode = d;
      return d;
    };
    // role=listbox → 下拉 → 编号
    const dropdown = mkScroll(4, 44, { role: "listbox" });
    // class=dropdown-menu → 下拉 → 编号
    const byClass = mkScroll(5, 55, { class: "my dropdown-menu" });
    // 普通滚动容器无交互后代 → 编号
    const plain = mkScroll(6, 66, {});
    // 普通滚动容器有交互后代（button）→ 不编号，button 编号
    const innerBtn = el("BUTTON", 7, 77, {
      isVisible: true,
      snapshotNode: snapWithBounds(0, 0, 20, 20),
    });
    const withDescendant = mkScroll(8, 88, {}, [innerBtn]);

    const { state } = serializeRoot(docOf([dropdown, byClass, plain, withDescendant]));
    expect(state.selectorMap.has(44)).toBe(true);
    expect(state.selectorMap.has(55)).toBe(true);
    expect(state.selectorMap.has(66)).toBe(true);
    expect(state.selectorMap.has(88)).toBe(false);
    expect(state.selectorMap.has(77)).toBe(true);
    // select 标签滚动容器（is_scrollable 短路）也属下拉
    expect(state.elementTreeText).toContain("[44]<div");
  });

  it("previousCachedState 中不存在的 backendNodeId 标记为新元素（* 前缀）", () => {
    const oldBtn = el("BUTTON", 4, 404, {
      isVisible: true,
      snapshotNode: snapWithBounds(0, 0, 30, 30),
    });
    const newBtn = el("BUTTON", 5, 505, {
      isVisible: true,
      snapshotNode: snapWithBounds(50, 0, 30, 30),
    });
    const prevMap = new Map<number, EnhancedDOMTreeNode>();
    prevMap.set(404, oldBtn);
    const prev = new SerializedDOMState(null, prevMap, "");
    const ser = new DOMTreeSerializer(docOf([oldBtn, newBtn]), { previousCachedState: prev });
    const { state } = ser.serializeAccessibleElements();
    expect(state.elementTreeText).toContain("[404]<button");
    expect(state.elementTreeText).toContain("*[505]<button");
    expect(state.selectorMap.size).toBe(2);
  });

  it("复合控件恒标记新元素（无 previous 时也应带 *）", () => {
    const select = el("SELECT", 4, 606, {
      isVisible: true,
      snapshotNode: snapWithBounds(0, 0, 120, 30),
      axNode: {
        ax_node_id: "a1",
        ignored: false,
        role: "combobox",
        name: null,
        description: null,
        properties: [],
        child_ids: ["x1"],
      },
    });
    const opt = el("OPTION", 5, 5, { isVisible: true, childrenNodes: [text("A", 6, 6)] });
    select.childrenNodes = [opt];
    opt.parentNode = select;
    const { state } = serializeRoot(docOf([select]));
    expect(state.elementTreeText).toContain("*[606]<select");
    expect(state.elementTreeText).toContain("compound_components=");
  });

  it("shadow DOM 内无 snapshot 数据的交互元素仍编号（is_shadow_dom_element 分支）", () => {
    const host = el("DIV", 3, 3, { isVisible: true, snapshotNode: snapWithBounds(0, 0, 100, 100) });
    const frag = el("#document-fragment", 4, 4, { nodeType: NodeType.DOCUMENT_FRAGMENT_NODE });
    frag.shadowRootType = "open";
    // shadow 内按钮无 snapshotNode（融合层 shadow 元素可能缺失布局数据）；
    // 带 snapshot 的文本子节点让按钮活过 Step 3 剪枝（与 Python 同口径）
    const btn = el("BUTTON", 5, 909, { isVisible: true, childrenNodes: [text("阴影按钮", 6, 6)] });
    frag.childrenNodes = [btn];
    btn.parentNode = frag;
    host.shadowRoots = [frag];
    frag.parentNode = host;
    const { state } = serializeRoot(docOf([host]));
    expect(state.selectorMap.has(909)).toBe(true);
    expect(state.elementTreeText).toContain("[909]<button");
  });

  it("JS click listener 绕过 paint order 遮挡标记", () => {
    const occluder = el("DIV", 4, 44, {
      isVisible: true,
      snapshotNode: emptySnap({
        bounds: new DOMRect(0, 0, 200, 100),
        paint_order: 10,
        computed_styles: { "background-color": "rgb(255, 255, 255)", opacity: "1" },
      }),
    });
    const covered = el("BUTTON", 5, 55, {
      isVisible: true,
      snapshotNode: emptySnap({
        bounds: new DOMRect(10, 10, 50, 30),
        paint_order: 1,
        computed_styles: { "background-color": "rgb(0, 0, 0)" },
      }),
    });
    covered.hasJsClickListener = true;
    const plainCovered = el("BUTTON", 6, 66, {
      isVisible: true,
      snapshotNode: emptySnap({
        bounds: new DOMRect(10, 60, 50, 30),
        paint_order: 2,
        computed_styles: { "background-color": "rgb(0, 0, 0)" },
      }),
    });
    const { state } = serializeRoot(docOf([occluder, covered, plainCovered]));
    // 有监听器的按钮编号；被完全遮挡的普通按钮不编号且 original 被回填
    expect(state.selectorMap.has(55)).toBe(true);
    expect(state.selectorMap.has(66)).toBe(false);
    expect(plainCovered.ignoredByPaintOrder).toBe(true);
  });
});

// ── 文本序列化分支 ──────────────────────────────────────────────────────

describe("serializeTree 输出分支", () => {
  function sn(on: EnhancedDOMTreeNode, children: SimplifiedNode[] = []): SimplifiedNode {
    return new SimplifiedNode(on, children);
  }

  it("svg 折叠行：交互时带索引前缀", () => {
    const svg = el("SVG", 4, 44, { isVisible: true, snapshotNode: snapWithBounds(0, 0, 30, 30) });
    const node = sn(svg);
    node.isInteractive = true;
    node.isNew = false;
    node.highlightIndex = 44;
    expect(DOMTreeSerializer.serializeTree(node, DEFAULT_INCLUDE_ATTRIBUTES)).toBe(
      "[44]<svg /> <!-- SVG content collapsed -->",
    );
    node.isInteractive = false;
    expect(DOMTreeSerializer.serializeTree(node, DEFAULT_INCLUDE_ATTRIBUTES)).toBe(
      "<svg /> <!-- SVG content collapsed -->",
    );
  });

  it("四种元素行：scroll-only / interactive / interactive+scroll / iframe", () => {
    const mkScroll = () =>
      el("DIV", 4, 44, {
        isVisible: true,
        snapshotNode: emptySnap({
          bounds: new DOMRect(0, 0, 300, 300),
          clientRects: new DOMRect(0, 0, 300, 300),
          scrollRects: new DOMRect(0, 0, 300, 900),
          computed_styles: { overflow: "auto" },
        }),
      });
    // scroll-only
    const scrollOnly = sn(mkScroll());
    expect(DOMTreeSerializer.serializeTree(scrollOnly, [])).toBe(
      "|scroll element|<div /> (scroll: 0%, 2.0 pages below, total: 3.0 pages)",
    );
    // interactive + scroll
    const interactiveScroll = sn(mkScroll());
    interactiveScroll.isInteractive = true;
    interactiveScroll.highlightIndex = 44;
    expect(DOMTreeSerializer.serializeTree(interactiveScroll, [])).toBe(
      "|scroll element[44]<div /> (scroll: 0%, 2.0 pages below, total: 3.0 pages)",
    );
    // interactive only
    const btn = sn(
      el("BUTTON", 5, 55, { isVisible: true, snapshotNode: snapWithBounds(0, 0, 30, 30) }),
    );
    btn.isInteractive = true;
    btn.isNew = true;
    btn.highlightIndex = 55;
    expect(DOMTreeSerializer.serializeTree(btn, [])).toBe("*[55]<button />");
    // iframe（非交互）
    const iframe = sn(
      el("IFRAME", 6, 66, { isVisible: true, snapshotNode: snapWithBounds(0, 0, 50, 50) }),
    );
    expect(DOMTreeSerializer.serializeTree(iframe, [])).toBe("|IFRAME|<iframe />");
  });

  it("shadow 边界：Open/Closed Shadow + Shadow End；宿主前缀 |SHADOW(...)|", () => {
    const closedFrag = el("#document-fragment", 4, 4, {
      nodeType: NodeType.DOCUMENT_FRAGMENT_NODE,
    });
    closedFrag.shadowRootType = "closed";
    const fragNode = sn(closedFrag, []);
    expect(DOMTreeSerializer.serializeTree(fragNode, [])).toBe("Closed Shadow");
    const openFrag = el("#document-fragment", 9, 9, { nodeType: NodeType.DOCUMENT_FRAGMENT_NODE });
    openFrag.shadowRootType = "open";
    expect(DOMTreeSerializer.serializeTree(sn(openFrag, []), [])).toBe("Open Shadow");

    // 交互宿主带 open shadow 子片段：自身渲染行 + 前缀，子节点深度 +1
    const host = el("BUTTON", 5, 5, {
      isVisible: true,
      snapshotNode: snapWithBounds(0, 0, 100, 100),
    });
    const innerBtn = sn(
      el("BUTTON", 7, 7, { isVisible: true, snapshotNode: snapWithBounds(0, 0, 20, 20) }),
    );
    innerBtn.isInteractive = true;
    innerBtn.highlightIndex = 7;
    const openFragNode = sn(openFrag, [innerBtn]);
    const hostNode = sn(host, [openFragNode]);
    hostNode.isShadowHost = true;
    hostNode.isInteractive = true;
    hostNode.highlightIndex = 5;
    expect(DOMTreeSerializer.serializeTree(hostNode, [])).toBe(
      "|SHADOW(open)|[5]<button />\n\tOpen Shadow\n\t\t[7]<button />\n\tShadow End",
    );

    // 无子片段的边界：closed 前缀取自子片段类型
    const closedFragNode = sn(closedFrag, []);
    const host2 = sn(
      el("BUTTON", 8, 8, { isVisible: true, snapshotNode: snapWithBounds(0, 0, 100, 100) }),
      [closedFragNode],
    );
    host2.isShadowHost = true;
    host2.isInteractive = true;
    host2.highlightIndex = 8;
    expect(DOMTreeSerializer.serializeTree(host2, [])).toBe(
      "|SHADOW(closed)|[8]<button />\n\tClosed Shadow",
    );
  });

  it("excluded_by_parent：跳过自身行，子节点同深度提升", () => {
    const span = el("SPAN", 4, 4, { isVisible: true, snapshotNode: snapWithBounds(0, 0, 100, 20) });
    const t = sn(text("提升文本", 5, 5));
    const node = sn(span, [t]);
    node.excludedByParent = true;
    expect(DOMTreeSerializer.serializeTree(node, [])).toBe("提升文本");
  });

  it("shouldDisplay=false：跳过自身行，子节点同深度（与 excluded 同构）", () => {
    const span = el("SPAN", 4, 4, { isVisible: true, snapshotNode: snapWithBounds(0, 0, 100, 20) });
    const t = sn(text("透传", 5, 5));
    const node = sn(span, [t]);
    node.shouldDisplay = false;
    expect(DOMTreeSerializer.serializeTree(node, [])).toBe("透传");
  });

  it("isScrollable 原始标志（非 computed 属性）也触发元素行", () => {
    const d = el("DIV", 4, 4, { isVisible: true });
    d.isScrollable = true;
    const node = sn(d);
    // is_scrollable=true 但无 scrollInfo → 无滚动后缀
    expect(DOMTreeSerializer.serializeTree(node, [])).toBe("<div />");
  });
});

// ── 复合控件 ────────────────────────────────────────────────────────────

describe("复合控件（compound_components）", () => {
  /** 走完整管线的文本行（input/select 是交互标签，会渲染属性行） */
  function compoundLine(node: EnhancedDOMTreeNode): string {
    const { state } = serializeRoot(docOf([node]));
    return state.elementTreeText;
  }

  /** 非交互复合标签（details/audio/video）：直接检查 Step 1 挂载的 compoundChildren */
  function compoundChildrenOf(node: EnhancedDOMTreeNode): Record<string, unknown>[] {
    const ser = new DOMTreeSerializer(docOf([node]));
    ser["createSimplifiedTree"](ser.rootNode, 0);
    return node.compoundChildren;
  }

  const axWithChildren = {
    ax_node_id: "a1",
    ignored: false,
    role: null,
    name: null,
    description: null,
    properties: [] as { name: string; value: string | boolean | number | null }[],
    child_ids: ["x1"],
  };

  it("range：slider Value，min/max 按 Python float 渲染（0.0/100.0）", () => {
    const range = el("INPUT", 4, 44, {
      attributes: { type: "range", min: "0", max: "100" },
      isVisible: true,
      snapshotNode: snapWithBounds(0, 0, 120, 30),
    });
    expect(compoundLine(range)).toContain(
      "compound_components=(name=Value,role=slider,min=0.0,max=100.0)",
    );
  });

  it("number：Increment/Decrement/Value 三段，可选 min/max", () => {
    const num = el("INPUT", 4, 44, {
      attributes: { type: "number", min: "1", max: "9" },
      isVisible: true,
      snapshotNode: snapWithBounds(0, 0, 120, 30),
    });
    expect(compoundLine(num)).toContain(
      "(name=Increment,role=button),(name=Decrement,role=button),(name=Value,role=textbox,min=1.0,max=9.0)",
    );
    const noBounds = el("INPUT", 5, 55, {
      attributes: { type: "number" },
      isVisible: true,
      snapshotNode: snapWithBounds(0, 0, 120, 30),
    });
    expect(compoundLine(noBounds)).toContain("(name=Value,role=textbox)");
  });

  it("file：Browse Files + File(s) Selected；valuetext='no file chosen' → current=None；value 取路径末段", () => {
    const mk = (
      props: { name: string; value: string | boolean | number | null }[],
      attrs: Record<string, string> = { type: "file" },
    ) =>
      el("INPUT", 4, 44, {
        attributes: attrs,
        isVisible: true,
        snapshotNode: snapWithBounds(0, 0, 120, 30),
        axNode: { ...axWithChildren, properties: props },
      });
    const empty = compoundLine(mk([{ name: "valuetext", value: "No file chosen" }]));
    expect(empty).toContain(
      "compound_components=(name=Browse Files,role=button),(name=File Selected,role=textbox,current=None)",
    );
    const chosen = compoundLine(mk([{ name: "value", value: "C:\\a\\b\\cover.png" }]));
    expect(chosen).toContain("current=cover.png");
    expect(chosen).toContain("name=File Selected");
    const multi = compoundLine(mk([], { type: "file", multiple: "" }));
    expect(multi).toContain("name=Files Selected");
  });

  it("select：选项计数/前四项/省略尾/format 提示；无选项时仍输出 listbox 骨架", () => {
    const mkSelect = (optionTexts: string[], optionValues?: string[]) => {
      const sel = el("SELECT", 4, 44, {
        isVisible: true,
        snapshotNode: snapWithBounds(0, 0, 120, 30),
        axNode: axWithChildren,
      });
      sel.childrenNodes = optionTexts.map((t, i) => {
        const o = el("OPTION", 10 + i, 10 + i, {
          attributes: optionValues ? { value: optionValues[i] } : {},
          childrenNodes: [text(t, 100 + i, 100 + i)],
        });
        o.parentNode = sel;
        return o;
      });
      return sel;
    };
    const two = compoundLine(mkSelect(["上海", "北京"], ["sh", "bj"]));
    expect(two).toContain("count=2,options=上海|北京");

    const many = compoundLine(
      mkSelect(["一", "二", "三", "四", "五", "六"], ["1", "2", "3", "4", "5", "6"]),
    );
    expect(many).toContain("count=6,options=一|二|三|四");
    // 保真注释：Python 渲染端 '|'.join(first_options[:4]) 把第 5 个元素（"... N more
    // options..." 后缀）切掉——后缀构建后从不渲染（serializer.py:1007），TS 同口径
    expect(many).not.toContain("more options");
    expect(many).toContain("format=numeric");

    const noOptions = el("SELECT", 5, 55, {
      isVisible: true,
      snapshotNode: snapWithBounds(0, 0, 120, 30),
      axNode: axWithChildren,
    });
    expect(compoundLine(noOptions)).toContain("(name=Options,role=listbox)");

    // 无 ax childIds 的 select 不生成复合组件
    const noAx = el("SELECT", 6, 66, {
      isVisible: true,
      snapshotNode: snapWithBounds(0, 0, 120, 30),
    });
    expect(compoundLine(noAx)).not.toContain("compound_components");
  });

  it("details/audio/video 固定组件；video 多 Fullscreen（数值按 Python int 渲染无 .0）", () => {
    const mk = (tag: string) =>
      el(tag, 4, 44, {
        isVisible: true,
        snapshotNode: snapWithBounds(0, 0, 120, 60),
        axNode: axWithChildren,
      });
    expect(compoundChildrenOf(mk("DETAILS"))).toEqual([
      { role: "button", name: "Toggle Disclosure", valuemin: null, valuemax: null, valuenow: null },
      { role: "region", name: "Content Area", valuemin: null, valuemax: null, valuenow: null },
    ]);
    expect(compoundChildrenOf(mk("AUDIO"))).toEqual([
      { role: "button", name: "Play/Pause", valuemin: null, valuemax: null, valuenow: null },
      { role: "slider", name: "Progress", valuemin: "0", valuemax: "100", valuenow: null },
      { role: "button", name: "Mute", valuemin: null, valuemax: null, valuenow: null },
      { role: "slider", name: "Volume", valuemin: "0", valuemax: "100", valuenow: null },
    ]);
    expect(compoundChildrenOf(mk("VIDEO"))).toEqual([
      { role: "button", name: "Play/Pause", valuemin: null, valuemax: null, valuenow: null },
      { role: "slider", name: "Progress", valuemin: "0", valuemax: "100", valuenow: null },
      { role: "button", name: "Mute", valuemin: null, valuemax: null, valuenow: null },
      { role: "slider", name: "Volume", valuemin: "0", valuemax: "100", valuenow: null },
      { role: "button", name: "Fullscreen", valuemin: null, valuemax: null, valuenow: null },
    ]);
    // 无 ax childIds 时不挂载
    const bare = el("AUDIO", 5, 55, {
      isVisible: true,
      snapshotNode: snapWithBounds(0, 0, 120, 60),
    });
    compoundChildrenOf(bare);
    expect(bare.compoundChildren).toEqual([]);
  });

  it("长选项文本 30 字符截断加省略号；format_hint 其他启发", () => {
    const sel = el("SELECT", 4, 44, {
      isVisible: true,
      snapshotNode: snapWithBounds(0, 0, 120, 30),
      axNode: axWithChildren,
    });
    const long = "这是一个非常长的选项文本超过三十个字符会被截断显示再凑用例"; // 29 码点
    const long35 = `${long}边界测试用例甲乙`; // 36 码点 > 30 → 截断 + ...
    const o = el("OPTION", 10, 10, { childrenNodes: [text(long35, 11, 11)] });
    o.parentNode = sel;
    sel.childrenNodes = [o];
    expect(compoundLine(sel)).toContain(`options=${long35.slice(0, 30)}...`);

    const mkOpts = (values: string[]) => {
      const s = el("SELECT", 5, 55, {
        isVisible: true,
        snapshotNode: snapWithBounds(0, 0, 120, 30),
        axNode: axWithChildren,
      });
      s.childrenNodes = values.map((v, i) => {
        const opt = el("OPTION", 20 + i, 20 + i, {
          attributes: { value: v },
          childrenNodes: [text(`项${i}`, 30 + i, 30 + i)],
        });
        opt.parentNode = s;
        return opt;
      });
      return s;
    };
    expect(compoundLine(mkOpts(["US", "CN"]))).toContain("format=country/state codes");
    expect(compoundLine(mkOpts(["a@b.c", "d@e.f"]))).toContain("format=email addresses");
    expect(compoundLine(mkOpts(["2024/01", "2024/02"]))).toContain("format=date/path format");
  });
});

// ── buildAttributesString 8 步 ─────────────────────────────────────────

describe("buildAttributesString", () => {
  const inc = DEFAULT_INCLUDE_ATTRIBUTES;

  it("Step 1：白名单过滤 + 值 strip；空值丢弃", () => {
    const n = el("INPUT", 1, 1, {
      attributes: { id: "  user  ", name: "", role: "switch", href: "#" },
    });
    expect(buildAttributesString(n, inc)).toBe("id=user role=switch");
  });

  it("Step 2：日期/时间注入 format+placeholder；tel 注入 placeholder", () => {
    const date = el("INPUT", 1, 1, { attributes: { type: "date" } });
    expect(buildAttributesString(date, inc)).toBe(
      "type=date placeholder=YYYY-MM-DD format=YYYY-MM-DD",
    );
    const tel = el("INPUT", 2, 2, { attributes: { type: "tel" } });
    expect(buildAttributesString(tel, inc)).toBe("type=tel placeholder=123-456-7890");
    // tel 已有 pattern 时不注入
    const telPat = el("INPUT", 3, 3, { attributes: { type: "tel", pattern: "\\d+" } });
    expect(buildAttributesString(telPat, inc)).toBe("type=tel pattern=\\d+");
  });

  it("Step 2：jQuery/AngularJS/data-datepicker 日期选择器探测", () => {
    const ng = el("INPUT", 1, 1, {
      attributes: { type: "text", "uib-datepicker-popup": "yyyy-MM-dd" },
    });
    expect(buildAttributesString(ng, inc)).toContain("expected_format=yyyy-MM-dd");
    expect(buildAttributesString(ng, inc)).toContain("format=yyyy-MM-dd");

    const jq = el("INPUT", 2, 2, {
      attributes: { type: "text", class: "MyDatepicker has", "data-date-format": "dd/mm/yy" },
    });
    expect(buildAttributesString(jq, inc)).toContain("placeholder=dd/mm/yy");

    const jqDefault = el("INPUT", 3, 3, { attributes: { type: "text", class: "daterangepicker" } });
    expect(buildAttributesString(jqDefault, inc)).toContain("placeholder=mm/dd/yyyy");

    const dataAttr = el("INPUT", 4, 4, { attributes: { type: "text", "data-datepicker": "1" } });
    expect(buildAttributesString(dataAttr, inc)).toContain("format=mm/dd/yyyy");

    // 无 type 属性等同 text 分支
    const noType = el("INPUT", 5, 5, { attributes: { "data-datepicker": "1" } });
    expect(buildAttributesString(noType, inc)).toContain("format=mm/dd/yyyy");
  });

  it("Step 2：file input 保留 class 且排在白名单键序末尾", () => {
    const n = el("INPUT", 1, 1, {
      attributes: { type: "file", accept: ".png", class: "semi-upload-hidden-input" },
    });
    // class 不在白名单：file 分支收集后经 include_attributes 副本参与键序，排在末尾
    expect(buildAttributesString(n, inc)).toBe(
      "type=file accept=.png class=semi-upload-hidden-input",
    );
  });

  it("Step 3/4/5：密码保护 + AX 布尔小写 + 表单值取 AX", () => {
    const pwd = el("INPUT", 1, 1, {
      attributes: { type: "password", value: "secret", role: "textbox" },
      axNode: {
        ax_node_id: "a",
        ignored: false,
        role: "textbox",
        name: null,
        description: null,
        properties: [
          { name: "value", value: "secret" },
          { name: "focusable", value: true },
        ],
        child_ids: [],
      },
    });
    // 密码：HTML value 被 Step 5 删除；AX value/valuetext 被跳过；
    // focusable 不在 include_attributes 白名单，AX 属性合并不收
    expect(buildAttributesString(pwd, inc)).toBe("type=password role=textbox");

    const txt = el("INPUT", 2, 2, {
      attributes: { type: "text", placeholder: "用户名" },
      axNode: {
        ax_node_id: "b",
        ignored: false,
        role: "textbox",
        name: null,
        description: null,
        properties: [
          { name: "valuetext", value: "  已填  " },
          { name: "checked", value: false },
        ],
        child_ids: [],
      },
    });
    // Step 5：AX valuetext 优先注入 value；checked 布尔 → "false"；
    // valuetext 本身也在白名单（#50），Step 4 已收集 → 键序末尾再出现一次
    expect(buildAttributesString(txt, inc)).toBe(
      "type=text checked=false value=已填 placeholder=用户名 valuetext=已填",
    );
  });

  it("Step 4：AX 数值属性按 Python str() 渲染（valuemin=0）", () => {
    const range = el("INPUT", 1, 1, {
      attributes: { type: "range" },
      axNode: {
        ax_node_id: "a",
        ignored: false,
        role: "slider",
        name: null,
        description: null,
        properties: [
          { name: "valuemin", value: 0 },
          { name: "valuemax", value: 100 },
          { name: "valuenow", value: 40 },
        ],
        child_ids: [],
      },
    });
    expect(buildAttributesString(range, inc)).toBe(
      "type=range valuemin=0 valuemax=100 valuenow=40",
    );
  });

  it("Step 6：>5 字符重复值去重（未保护键移除；title/aria-label 受保护双双保留）", () => {
    const dup = el("DIV", 1, 1, {
      attributes: { id: "verylongsharedvalue", name: "verylongsharedvalue" },
    });
    // id 在白名单前于 name：id 首见保留，name 去重移除
    expect(buildAttributesString(dup, inc)).toBe("id=verylongsharedvalue");

    const protectedPair = el("DIV", 2, 2, {
      attributes: { title: "重复的长标题", "aria-label": "重复的长标题" },
    });
    expect(buildAttributesString(protectedPair, inc)).toBe(
      "title=重复的长标题 aria-label=重复的长标题",
    );
  });

  it("Step 7：冗余移除（type==tag / invalid=false / required 假值 / aria-expanded 重复）", () => {
    const typeEq = el("INPUT", 1, 1, { attributes: { type: "input" } });
    expect(buildAttributesString(typeEq, inc)).toBe("");

    const invalid = el("INPUT", 2, 2, {
      axNode: {
        ax_node_id: "a",
        ignored: false,
        role: "textbox",
        name: null,
        description: null,
        properties: [
          { name: "invalid", value: false },
          { name: "required", value: false },
        ],
        child_ids: [],
      },
    });
    expect(buildAttributesString(invalid, inc)).toBe("");

    const expanded = el("DIV", 3, 3, {
      attributes: { "aria-expanded": "true", role: "combobox" },
      axNode: {
        ax_node_id: "b",
        ignored: false,
        role: "combobox",
        name: null,
        description: null,
        properties: [{ name: "expanded", value: true }],
        child_ids: [],
      },
    });
    // aria-expanded 与 AX expanded 重复 → 删 HTML 侧（role 需来自 HTML 属性，AX role 不进属性串）
    expect(buildAttributesString(expanded, inc)).toBe("role=combobox expanded=true");
  });

  it("Step 7：role 与节点名相同则删（Python 大小写敏感比较）", () => {
    const n = el("INPUT", 1, 1, {
      attributes: { role: "input" },
      axNode: {
        ax_node_id: "a",
        ignored: false,
        role: "input", // 与 node_name "INPUT" 不等（大小写），role 保留
        name: null,
        description: null,
        properties: [],
        child_ids: [],
      },
    });
    expect(buildAttributesString(n, inc)).toBe("role=input");
  });

  it("Step 8：值截断至 100 字符", () => {
    const n = el("INPUT", 1, 1, { attributes: { placeholder: "x".repeat(150) } });
    expect(buildAttributesString(n, inc)).toBe(`placeholder=${"x".repeat(100)}`);
  });
});

// ── page_stats ──────────────────────────────────────────────────────────

describe("collectPageStats", () => {
  it("links/interactive/iframes/skeleton 统计", () => {
    const a = el("A", 3, 33, { isVisible: true, snapshotNode: snapWithBounds(0, 0, 60, 20) });
    // iframe 需携带 contentDocument 才会进入简化树（Step 1 processIframe）
    const iframe = el("IFRAME", 4, 44, {
      isVisible: true,
      snapshotNode: snapWithBounds(0, 50, 300, 200),
    });
    const innerDoc = el("#document", 8, 8, { nodeType: NodeType.DOCUMENT_NODE });
    iframe.contentDocument = innerDoc;
    // 骨架类命中需要节点活过 Step 3 剪枝（可见 + snapshot）
    const skeletonDiv = el("DIV", 5, 5, {
      isVisible: true,
      snapshotNode: snapWithBounds(0, 300, 100, 20),
      attributes: { class: "card-loading" },
    });
    // 阈值 interactive < 3：凑足第三个交互元素，skeleton 不触发
    const btn = el("BUTTON", 6, 66, {
      isVisible: true,
      snapshotNode: snapWithBounds(0, 350, 50, 20),
    });
    const { state } = serializeRoot(docOf([a, iframe, skeletonDiv, btn]));
    expect(state.pageStats).toEqual({ links: 1, interactive: 3, iframes: 1, skeleton: false });
  });

  it("骨架类命中且可交互元素 < 3 → skeleton=true", () => {
    const spinner = el("DIV", 3, 3, {
      isVisible: true,
      attributes: { class: "spinner" },
      snapshotNode: snapWithBounds(0, 0, 100, 20),
    });
    const { state } = serializeRoot(docOf([spinner]));
    expect(state.pageStats).toEqual({ links: 0, interactive: 0, iframes: 0, skeleton: true });
  });
});
