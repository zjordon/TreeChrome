/**
 * models.ts 移植保真测试。
 *
 * 期望值全部来自 Python 参考实现（dom-snapshot models.py）在同一棵测试树上的
 * 实际输出，生成命令见 docs/architecture.md §7。这些锚点是移植验收的最低标准；
 * golden fixture（element_tree_text 逐字节对拍）在 collector/serializer 移植后补齐。
 */
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/sha256.js";
import {
  DEFAULT_INCLUDE_ATTRIBUTES,
  DOMRect,
  type EnhancedAXNode,
  EnhancedDOMTreeNode,
  type EnhancedSnapshotNode,
  filterDynamicClasses,
  NodeType,
  roundHalfEven,
} from "../src/types.js";

// ── 参考树：与 Python 参考脚本逐字段一致 ────────────────────────────────

function el(
  name: string,
  attrs: Record<string, string>,
  nid: number,
  bid: number,
  extra: {
    axNode?: EnhancedAXNode | null;
    childrenNodes?: EnhancedDOMTreeNode[] | null;
    parentNode?: EnhancedDOMTreeNode | null;
    snapshotNode?: EnhancedSnapshotNode | null;
  } = {},
): EnhancedDOMTreeNode {
  return new EnhancedDOMTreeNode({
    nodeId: nid,
    backendNodeId: bid,
    nodeType: NodeType.ELEMENT_NODE,
    nodeName: name,
    nodeValue: "",
    attributes: attrs,
    ...extra,
  });
}

function buildReferenceTree() {
  const html = el("HTML", {}, 1, 101);
  const body = el("BODY", {}, 2, 102, { parentNode: html });
  html.childrenNodes = [body];

  const ax: EnhancedAXNode = {
    ax_node_id: "ax1",
    ignored: false,
    role: "button",
    name: "Submit",
    description: null,
    properties: null,
    child_ids: null,
  };
  const btnText = new EnhancedDOMTreeNode({
    nodeId: 8,
    backendNodeId: 108,
    nodeType: NodeType.TEXT_NODE,
    nodeName: "#text",
    nodeValue: "Hello world",
    attributes: {},
  });
  const btn = el("BUTTON", { type: "button" }, 4, 104, {
    axNode: ax,
    childrenNodes: [btnText],
  });
  btnText.parentNode = btn;
  const div = el("DIV", { class: "btn primary", id: "submit-btn" }, 3, 103, {
    childrenNodes: [btn],
    parentNode: body,
  });
  btn.parentNode = div;
  const a1 = el("A", { href: "#" }, 5, 105, { parentNode: body });
  const a2 = el("A", { href: "#x" }, 6, 106, { parentNode: body });
  const a3 = el("A", { href: "#y" }, 7, 107, { parentNode: body });
  body.childrenNodes = [div, a1, a2, a3];
  return { html, body, div, btn, btnText, a1, a2, a3 };
}

// ── sha256 标准测试向量 ────────────────────────────────────────────────

describe("sha256Hex（同步纯 TS 实现）", () => {
  it("标准向量", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("hello world")).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });

  it("长输入跨块（>64 字节）与 UTF-8（Python hashlib 参考值）", () => {
    expect(sha256Hex("x".repeat(200))).toBe(
      "aa20c23e3201834050679e1d88941b9a6fed0557c9a705cb2c315e2e63fd486d",
    );
    expect(sha256Hex("你好世界-dom-snapshot")).toBe(
      "833cee1f38e0c834efa9dfcd62b671e2c48c1ba8a0c310c08788b3fd6f060978",
    );
  });
});

// ── 类名过滤（Python filter_dynamic_classes 参考值） ────────────────────

describe("filterDynamicClasses", () => {
  it("Python 参考值：'btn focus is-open primary active:now' → 'btn primary'", () => {
    expect(filterDynamicClasses("btn focus is-open primary active:now")).toBe("btn primary");
  });
  it("空值与纯动态类", () => {
    expect(filterDynamicClasses(null)).toBe("");
    expect(filterDynamicClasses("")).toBe("");
    expect(filterDynamicClasses("hover focused")).toBe("");
  });
  it("结果按字典序排序（对齐 Python sorted）", () => {
    expect(filterDynamicClasses("zebra apple")).toBe("apple zebra");
  });
});

// ── 属性白名单转录防错 ─────────────────────────────────────────────────

describe("DEFAULT_INCLUDE_ATTRIBUTES 转录", () => {
  it("共 54 项（Python models.py:22-77）", () => {
    expect(DEFAULT_INCLUDE_ATTRIBUTES.length).toBe(54);
  });
  it("抽查首尾成员", () => {
    expect(DEFAULT_INCLUDE_ATTRIBUTES[0]).toBe("title");
    expect(DEFAULT_INCLUDE_ATTRIBUTES[53]).toBe("ax_name");
  });
});

// ── XPath（Python 参考值） ─────────────────────────────────────────────

describe("xpath", () => {
  it("唯一子元素不加索引", () => {
    const { btn, div } = buildReferenceTree();
    expect(btn.xpath).toBe("html/body/div/button");
    expect(div.xpath).toBe("html/body/div");
  });
  it("同名兄弟按位置索引（1-based）", () => {
    const { a1, a2, a3 } = buildReferenceTree();
    expect(a1.xpath).toBe("html/body/a[1]");
    expect(a2.xpath).toBe("html/body/a[2]");
    expect(a3.xpath).toBe("html/body/a[3]");
  });
});

// ── 哈希（Python compute_stable_hash / __hash__ 参考值，bigint） ────────

describe("element hash", () => {
  it("computeStableHash 与 Python 一致", () => {
    const { btn, a2 } = buildReferenceTree();
    expect(btn.computeStableHash()).toBe(15482602235375908289n);
    expect(a2.computeStableHash()).toBe(12441699582052938144n);
  });
  it("elementHash（未过滤 class 的变体）与 Python hash() 一致", () => {
    const { btn } = buildReferenceTree();
    expect(btn.elementHash).toBe(1647544180093744583n);
  });
  it("同树同属性确定性", () => {
    const { btn } = buildReferenceTree();
    expect(btn.computeStableHash()).toBe(btn.computeStableHash());
  });
});

// ── 文本收集（Python 参考值） ──────────────────────────────────────────

describe("text collection", () => {
  it("getAllChildrenText / getMeaningfulTextForLlm / llmRepresentation", () => {
    const { btn, div } = buildReferenceTree();
    expect(btn.getAllChildrenText()).toBe("Hello world");
    expect(btn.getMeaningfulTextForLlm()).toBe("Hello world");
    expect(btn.llmRepresentation()).toBe("<button>Hello world");
    expect(div.llmRepresentation(5)).toBe("<div>Hello");
  });
  it("属性优先于子文本（value/aria-label/title/placeholder/alt 顺序）", () => {
    const node = el("INPUT", { value: "typed", placeholder: "Search" }, 1, 1);
    expect(node.getMeaningfulTextForLlm()).toBe("typed");
  });
});

// ── 滚动信息（Python 参考值） ──────────────────────────────────────────

describe("scroll info", () => {
  it("scrollInfo 数值与格式化文本与 Python 一致", () => {
    const snap: EnhancedSnapshotNode = {
      is_clickable: null,
      cursor_style: null,
      bounds: new DOMRect(0, 0, 500, 500),
      clientRects: new DOMRect(0, 0, 500, 500),
      scrollRects: new DOMRect(0, 0, 2000, 1000),
      computed_styles: { overflow: "auto" },
      paint_order: null,
      stacking_contexts: null,
    };
    const div = el("DIV", {}, 103, 3, { snapshotNode: snap });
    const info = div.scrollInfo!;
    expect(info.scrollable_height).toBe(1000);
    expect(info.scrollable_width).toBe(2000);
    expect(info.content_below).toBe(500);
    expect(info.content_right).toBe(1500);
    expect(info.pages_below).toBe(1.0);
    expect(info.total_pages).toBe(2.0);
    expect(info.can_scroll_down).toBe(true);
    expect(info.can_scroll_right).toBe(true);
    expect(div.getScrollInfoText()).toBe("scroll: 0%, 1.0 pages below, total: 2.0 pages");
  });
});

// ── toJson 形态（snake_case 对齐 Python __json__，fixture 对拍依赖） ────

describe("toJson snake_case 形态", () => {
  it("键名与枚举名对齐 Python", () => {
    const { btn } = buildReferenceTree();
    const j = btn.toJson();
    expect(j.node_type).toBe("ELEMENT_NODE");
    expect(j.node_id).toBe(4);
    expect(j.backend_node_id).toBe(104);
    expect(j.ax_node).toMatchObject({ role: "button", name: "Submit" });
    expect(Array.isArray(j.children_nodes)).toBe(true);
    expect((j.children_nodes as unknown[])[0]).toMatchObject({
      node_type: "TEXT_NODE",
      node_value: "Hello world",
    });
  });

  it("toJson 浅模式跳过 children 序列化但保留核心字段（SimplifiedNode 性能路径）", () => {
    const { btn } = buildReferenceTree();
    const shallow = btn.toJson(false);
    expect(shallow.children_nodes).toBeUndefined();
    expect(shallow.shadow_roots).toBeUndefined();
    expect(shallow.node_id).toBe(4);
    expect(btn.toJson().children_nodes).toHaveLength(1);
  });

  it("toJson 对枚举外脏值兜底为数字串（不丢键）", () => {
    const n = el("DIV", {}, 1, 1);
    (n as unknown as { nodeType: number }).nodeType = 0;
    expect(n.toJson().node_type).toBe("0");
  });
});

// ── 多分组 SHA-256 向量（NIST，Python hashlib 实跑取值） ────────────────

describe("sha256Hex 多分组路径", () => {
  it("448-bit 消息触发填充分组切换边界", () => {
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmnlmnomnopnopq")).toBe(
      "a57ed99266a7c7be3eaee2ffa23f54ff042a4829fa036cf5ea83d7e3de0c666e",
    );
  });
  it("896-bit 消息跨多分组（w 调度与跨块累加）", () => {
    expect(
      sha256Hex(
        "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
      ),
    ).toBe("cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1");
  });
});

// ── roundHalfEven 大数路径（e >= 0，|n| ≥ 2^52；Python 实跑取值） ──────

describe("roundHalfEven 大数（回归：m<<e 曾被 m*ten 覆盖）", () => {
  it("2^53 量级", () => {
    expect(roundHalfEven(2 ** 53, 0)).toBe(9007199254740992);
    expect(roundHalfEven(2 ** 53 + 2, 0)).toBe(9007199254740994);
    expect(roundHalfEven(1e17, 2)).toBe(1e17);
  });
});
