/**
 * P1.2 collector 移植验收：
 * 1. golden fixture 的 input 喂 TS 采集融合 → 融合树与 Python selector_map 投影全等
 * 2. 降级链（FULL→PARTIAL→MINIMAL→FAILED）逐级单测
 * 3. 跨源 iframe（Target API 递归）、file input 扫描、纯函数工具单测
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSnapshotLookup,
  collectFileInputs,
  DomCollector,
  parseAttrs,
} from "../src/collector.js";
import type { CdpDomNode, CdpGetDocumentResult } from "../src/protocol.js";
import { DOMDegradationLevel, type EnhancedDOMTreeNode } from "../src/types.js";
import { FakeCdpClient, type GoldenFixture, makeGoldenFixtureClient } from "./fake-cdp.js";

const FIXTURES_DIR = join(__dirname, "fixtures");

function loadGoldenFixtures(): { name: string; fixture: GoldenFixture }[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((name) => ({
      name,
      fixture: JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf-8")) as GoldenFixture,
    }));
}

/** 深度遍历融合树（children / shadowRoots / contentDocument）建 backendNodeId 索引 */
function indexByBackendId(root: EnhancedDOMTreeNode): Map<number, EnhancedDOMTreeNode> {
  const index = new Map<number, EnhancedDOMTreeNode>();
  const walk = (node: EnhancedDOMTreeNode): void => {
    index.set(node.backendNodeId, node);
    if (node.contentDocument) walk(node.contentDocument);
    for (const sr of node.shadowRoots ?? []) walk(sr);
    for (const child of node.childrenNodes ?? []) walk(child);
  };
  walk(root);
  return index;
}

const fixtures = loadGoldenFixtures();

describe.skipIf(fixtures.length === 0)("golden 融合对拍（P1.2 验收）", () => {
  for (const { name, fixture } of fixtures) {
    it(`${name}: 融合树投影与 Python selector_map 全等`, async () => {
      const client = makeGoldenFixtureClient(fixture);
      const collector = new DomCollector(client);
      const result = await collector.buildEnhancedDomTree("sess-main");

      expect(result.root).not.toBeNull();
      expect(result.metrics.degradationLevel).toBe(DOMDegradationLevel.FULL);
      expect(Object.values(result.metrics.sourceStatuses).every((s) => s === "ok")).toBe(true);

      // file input 元数据：纯采集层产物，可全量精确对拍
      expect(result.fileInputBackendIds).toEqual(fixture.output.file_input_backend_ids ?? []);
      expect(result.fileInputInfos).toEqual(fixture.output.file_inputs_meta ?? []);

      // selector_map 投影：每个 Python 选中元素在融合树中按 backendNodeId 定位，
      // 八个融合字段逐一全等（选择逻辑本身是 P1.3 serializer 的职责，不在对拍范围）
      const byBackendId = indexByBackendId(result.root!);
      const entries = Object.entries(fixture.output.selector_map);
      expect(entries.length).toBeGreaterThan(0);
      for (const [idx, proj] of entries) {
        const node = byBackendId.get(proj.backend_node_id);
        expect(
          node,
          `selector_map[${idx}] backend_node_id=${proj.backend_node_id} 未在融合树中找到`,
        ).toBeDefined();
        if (!node) continue;
        expect(node.backendNodeId).toBe(proj.backend_node_id);
        expect(node.nodeName).toBe(proj.node_name);
        expect(node.nodeValue).toBe(proj.node_value);
        expect(node.attributes).toEqual(proj.attributes);
        expect(node.isVisible).toBe(proj.is_visible);
        expect(node.isScrollable).toBe(proj.is_scrollable);
        expect(node.hasJsClickListener).toBe(proj.has_js_click_listener);
        expect(node.xpath).toBe(proj.xpath);
      }
    });
  }
});

// ── 降级链 ──────────────────────────────────────────────────────────────

const basicFixture = () => fixtures.find((f) => f.name.includes("basic")) ?? fixtures[0];

describe.skipIf(fixtures.length === 0)("降级链（FULL→PARTIAL→MINIMAL→FAILED）", () => {
  it("AX 源失败 → PARTIAL，节点无 axNode", async () => {
    const client = makeGoldenFixtureClient(basicFixture().fixture, {
      "Accessibility.getFullAXTree": () => {
        throw new Error("ax down");
      },
    });
    const result = await new DomCollector(client).buildEnhancedDomTree("s");
    expect(result.metrics.degradationLevel).toBe(DOMDegradationLevel.PARTIAL);
    expect(result.metrics.sourceStatuses.ax_tree).toBe("failed");
    expect(result.root).not.toBeNull();
    expect(result.root!.axNode).toBeNull();
  });

  it("snapshot 源失败 → MINIMAL：无布局数据，节点一律视为可见", async () => {
    const client = makeGoldenFixtureClient(basicFixture().fixture, {
      "DOMSnapshot.captureSnapshot": () => {
        throw new Error("snapshot down");
      },
    });
    const result = await new DomCollector(client).buildEnhancedDomTree("s");
    expect(result.metrics.degradationLevel).toBe(DOMDegradationLevel.MINIMAL);
    expect(result.metrics.sourceStatuses.snapshot).toBe("failed");
    expect(result.root).not.toBeNull();
    expect(result.root!.snapshotNode).toBeNull();
    // MINIMAL 分支：无 snapshot 数据的元素按可见处理。
    // selector_map 键是 highlight_index（元素树行号），定位须取投影的 backend_node_id
    const firstProj = Object.values(basicFixture().fixture.output.selector_map)[0];
    const anyElement = indexByBackendId(result.root!).get(firstProj.backend_node_id);
    expect(anyElement).toBeDefined();
    expect(anyElement?.isVisible).toBe(true);
  });

  it("snapshot 源挂起 → 两阶段超时后仍 MINIMAL（timeout 状态）", async () => {
    const client = makeGoldenFixtureClient(basicFixture().fixture, {
      "DOMSnapshot.captureSnapshot": () => new Promise(() => {}),
    });
    const collector = new DomCollector(client);
    const result = await collector.collectCdpSources("s", {
      cdpFirstTimeout: 0.03,
      cdpRetryTimeout: 0.03,
      maxIframes: 100,
      heavyPageElementThreshold: 10000,
    });
    expect(result.degradation).toBe(DOMDegradationLevel.MINIMAL);
    expect(result.metrics.sourceStatuses.snapshot).toBe("timeout");
  });

  it("dom_tree 源失败 → FAILED：root 为 null（修正 Python 3/4 元组漂移后不再崩溃）", async () => {
    const client = makeGoldenFixtureClient(basicFixture().fixture, {
      "DOM.getDocument": () => {
        throw new Error("dom down");
      },
    });
    const result = await new DomCollector(client).buildEnhancedDomTree("s");
    expect(result.metrics.degradationLevel).toBe(DOMDegradationLevel.FAILED);
    expect(result.root).toBeNull();
    expect(result.fileInputBackendIds).toEqual([]);
  });

  it("snapshot 文档数超 maxIframes → 截断并记录原始数量", async () => {
    const base = basicFixture().fixture;
    const doubled = {
      ...base.input.snapshot,
      documents: [
        ...(base.input.snapshot as { documents: unknown[] }).documents,
        ...(base.input.snapshot as { documents: unknown[] }).documents,
      ],
    };
    const client = makeGoldenFixtureClient(base, {
      "DOMSnapshot.captureSnapshot": () => doubled,
    });
    const collector = new DomCollector(client);
    const result = await collector.collectCdpSources("s", {
      cdpFirstTimeout: 1,
      cdpRetryTimeout: 1,
      maxIframes: 1,
      heavyPageElementThreshold: 10000,
    });
    expect(result.snapshot?.documents).toHaveLength(1);
    expect(result.metrics.iframeCount).toBe(2);
  });
});

// ── 合成场景：跨源 iframe / 可见性 / 监听器探测 ─────────────────────────

function el(
  nodeId: number,
  backendNodeId: number,
  nodeName: string,
  attrs: Record<string, string> = {},
  extra: Partial<CdpDomNode> = {},
): CdpDomNode {
  return {
    nodeId,
    backendNodeId,
    nodeType: 1,
    nodeName,
    nodeValue: "",
    attributes: Object.entries(attrs).flat(),
    ...extra,
  };
}

function domTreeOf(root: CdpDomNode): CdpGetDocumentResult {
  return {
    root: {
      nodeId: 1,
      backendNodeId: 1,
      nodeType: 9,
      nodeName: "#document",
      nodeValue: "",
      children: [root],
    },
  };
}

function synthSnapshot(entries: { bid: number; bounds: number[] }[]) {
  return {
    strings: [""],
    documents: [
      {
        nodes: { backendNodeId: entries.map((e) => e.bid) },
        layout: {
          nodeIndex: entries.map((_, i) => i),
          bounds: entries.map((e) => e.bounds),
          text: [],
          stackingContexts: { index: [] },
          paintOrders: entries.map((_, i) => i),
          styles: entries.map(() => [0]),
          clientRects: entries.map((e) => e.bounds),
          scrollRects: entries.map(() => [0, 0, 1280, 1600]),
        },
      },
    ],
  };
}

/** html 骨架：html(clientRects=视口) > body > children；附 body 元素 */
function pageWith(children: CdpDomNode[], extraEls: { bid: number; bounds: number[] }[]) {
  const html = el(
    2,
    2,
    "HTML",
    {},
    { frameId: "F1", children: [el(3, 3, "BODY", {}, { children })] },
  );
  const elements = [
    { bid: 2, bounds: [0, 0, 1280, 800] },
    { bid: 3, bounds: [0, 0, 1280, 800] },
    ...extraEls,
  ];
  return { tree: domTreeOf(html), snapshot: synthSnapshot(elements) };
}

describe("跨源 iframe 递归（Target API）", () => {
  it("frameId 命中与 src URL 回退均附加子树；小尺寸 iframe 不处理；用后 detach", async () => {
    const big = el(4, 4, "IFRAME", { src: "http://other/page?x=1" }, { frameId: "IF1" });
    const byUrl = el(5, 5, "IFRAME", { src: "http://other/second?z=2" }, { frameId: "IFX" });
    const tiny = el(6, 6, "IFRAME", { src: "http://other/tiny" }, { frameId: "IFT" });
    const { tree, snapshot } = pageWith(
      [big, byUrl, tiny],
      [
        { bid: 4, bounds: [10, 20, 200, 150] },
        { bid: 5, bounds: [10, 220, 200, 150] },
        { bid: 6, bounds: [10, 400, 30, 30] }, // < 50x50：尺寸门槛拦截
      ],
    );

    const innerA = domTreeOf(
      el(
        20,
        20,
        "HTML",
        {},
        { frameId: "S2F", children: [el(21, 21, "BODY", {}, { children: [el(22, 22, "H1")] })] },
      ),
    );
    const innerB = domTreeOf(
      el(
        30,
        30,
        "HTML",
        {},
        { frameId: "S3F", children: [el(31, 31, "BODY", {}, { children: [el(32, 32, "P")] })] },
      ),
    );

    const client = new FakeCdpClient({
      "DOM.getDocument": (_p, sid) => (sid === "S2" ? innerA : sid === "S3" ? innerB : tree),
      "DOMSnapshot.captureSnapshot": (_p, sid) =>
        sid === null ? snapshot : { strings: [""], documents: [] },
      "Page.getFrameTree": () => ({ frameTree: { frame: { id: "f" } } }),
      "Accessibility.getFullAXTree": () => ({ nodes: [] }),
      "Page.getLayoutMetrics": () => ({
        visualViewport: { clientWidth: 800 },
        cssVisualViewport: { clientWidth: 800 },
      }),
      "Runtime.evaluate": () => ({}),
      "Target.getTargets": () => ({
        targetInfos: [
          // big：frameId 路径（parentFrameId = iframe 元素 frameId）
          { type: "iframe", parentFrameId: "IF1", targetId: "T1", url: "http://other/page" },
          // byUrl：frameToTarget 未命中（parentFrameId 无关），src 去参去尾斜杠后命中
          { type: "iframe", parentFrameId: "OTHER", targetId: "T2", url: "http://other/second/" },
          // tiny 有 target 但尺寸不足，不应触发 attach
          { type: "iframe", parentFrameId: "IFT", targetId: "T3", url: "http://other/tiny" },
        ],
      }),
      "Target.attachToTarget": (p) => ({ sessionId: p.targetId === "T1" ? "S2" : "S3" }),
    });

    const result = await new DomCollector(client).buildEnhancedDomTree(null);
    const byBid = indexByBackendId(result.root!);

    const bigNode = byBid.get(4)!;
    expect(bigNode.contentDocument).not.toBeNull();
    expect(bigNode.targetId).toBe("T1");
    expect(indexByBackendId(bigNode.contentDocument!).get(22)).toBeDefined();
    expect(bigNode.contentDocument!.parentNode).toBe(bigNode);

    const byUrlNode = byBid.get(5)!;
    expect(byUrlNode.contentDocument).not.toBeNull();
    expect(byUrlNode.targetId).toBe("T2");
    expect(indexByBackendId(byUrlNode.contentDocument!).get(32)).toBeDefined();

    expect(byBid.get(6)!.contentDocument).toBeNull();
    expect(client.callsOf("Target.attachToTarget").map((c) => c.params.targetId)).toEqual([
      "T1",
      "T2",
    ]);
    expect(client.callsOf("Target.detachFromTarget").map((c) => c.params.sessionId)).toEqual([
      "S2",
      "S3",
    ]);
  });

  it("attach 失败返回 null → 不抛错、不挂子树", async () => {
    const frame = el(4, 4, "IFRAME", { src: "http://other/page" }, { frameId: "IF1" });
    const { tree, snapshot } = pageWith([frame], [{ bid: 4, bounds: [0, 0, 200, 200] }]);
    const client = new FakeCdpClient({
      "DOM.getDocument": () => tree,
      "DOMSnapshot.captureSnapshot": () => snapshot,
      "Page.getFrameTree": () => ({ frameTree: { frame: { id: "f" } } }),
      "Accessibility.getFullAXTree": () => ({ nodes: [] }),
      "Page.getLayoutMetrics": () => ({}),
      "Runtime.evaluate": () => ({}),
      "Target.getTargets": () => ({
        targetInfos: [
          { type: "iframe", parentFrameId: "IF1", targetId: "T1", url: "http://other/page" },
        ],
      }),
      "Target.attachToTarget": () => {
        throw new Error("attach denied");
      },
    });
    const result = await new DomCollector(client).buildEnhancedDomTree(null);
    expect(indexByBackendId(result.root!).get(4)!.contentDocument).toBeNull();
  });
});

describe("可见性判定（视口交集 + CSS 可见性）", () => {
  async function buildWith(
    children: CdpDomNode[],
    els: { bid: number; bounds: number[] }[],
    viewportThreshold?: number | null,
  ) {
    const { tree, snapshot } = pageWith(children, els);
    const client = new FakeCdpClient({
      "DOM.getDocument": () => tree,
      "DOMSnapshot.captureSnapshot": () => snapshot,
      "Page.getFrameTree": () => ({ frameTree: { frame: { id: "f" } } }),
      "Accessibility.getFullAXTree": () => ({ nodes: [] }),
      "Page.getLayoutMetrics": () => ({}),
      "Runtime.evaluate": () => ({}),
      "Target.getTargets": () => ({ targetInfos: [] }),
    });
    const collector = new DomCollector(client);
    return collector.buildEnhancedDomTree(null, { viewportThreshold });
  }

  it("视口下方远超阈值的元素不可见；threshold=null 跳过视口检查", async () => {
    const far = el(4, 4, "DIV", { id: "far" });
    const result = await buildWith([far], [{ bid: 4, bounds: [0, 5000, 100, 100] }]);
    expect(indexByBackendId(result.root!).get(4)!.isVisible).toBe(false);

    const result2 = await buildWith([far], [{ bid: 4, bounds: [0, 5000, 100, 100] }], null);
    expect(indexByBackendId(result2.root!).get(4)!.isVisible).toBe(true);
  });

  it("display:none / visibility:hidden / opacity:0 → 不可见", async () => {
    // styles[li][si] 的 si 对应 REQUIRED_COMPUTED_STYLES 顺序：0=display 1=visibility 2=opacity
    const strings = ["", "", "none", "hidden", "0"];
    const cases: [label: string, styleIdx: number[]][] = [
      ["display=none", [2]],
      ["visibility=hidden", [0, 3]],
      ["opacity=0", [0, 1, 4]],
    ];
    for (const [label, styleIdx] of cases) {
      const target = el(4, 4, "DIV", { id: "t" });
      const { tree } = pageWith([target], [{ bid: 4, bounds: [0, 0, 100, 100] }]);
      const snapshot = {
        strings,
        documents: [
          {
            nodes: { backendNodeId: [2, 3, 4] },
            layout: {
              nodeIndex: [0, 1, 2],
              bounds: [
                [0, 0, 1280, 800],
                [0, 0, 1280, 800],
                [0, 0, 100, 100],
              ],
              text: [],
              stackingContexts: { index: [] },
              paintOrders: [0, 1, 2],
              styles: [[0], [0], styleIdx],
              clientRects: [
                [0, 0, 1280, 800],
                [0, 0, 1280, 800],
                [0, 0, 100, 100],
              ],
              scrollRects: [
                [0, 0, 1280, 1600],
                [0, 0, 1280, 1600],
                [0, 0, 1280, 1600],
              ],
            },
          },
        ],
      };
      const client = new FakeCdpClient({
        "DOM.getDocument": () => tree,
        "DOMSnapshot.captureSnapshot": () => snapshot,
        "Page.getFrameTree": () => ({ frameTree: { frame: { id: "f" } } }),
        "Accessibility.getFullAXTree": () => ({ nodes: [] }),
        "Page.getLayoutMetrics": () => ({}),
        "Runtime.evaluate": () => ({}),
        "Target.getTargets": () => ({ targetInfos: [] }),
      });
      const result = await new DomCollector(client).buildEnhancedDomTree(null);
      expect(indexByBackendId(result.root!).get(4)!.isVisible, label).toBe(false);
    }
  });
});

describe("JS 点击监听器探测", () => {
  it("objectId → 数组属性 → describeNode → backendNodeId 集，并释放对象", async () => {
    const client = new FakeCdpClient({
      "Runtime.evaluate": () => ({ result: { objectId: "arr1" } }),
      "Runtime.getProperties": () => ({
        result: [
          { name: "0", value: { objectId: "o1" } },
          { name: "1", value: { objectId: "o2" } },
          { name: "length", value: { value: 2 } }, // 非下标属性跳过
          { name: "2", value: { value: null } }, // 无 objectId 跳过
        ],
      }),
      "DOM.describeNode": (p) =>
        p.objectId === "o1" ? { node: { backendNodeId: 11 } } : { node: { backendNodeId: 12 } },
      "Runtime.releaseObject": () => ({}),
    });
    const ids = await new DomCollector(client).detectJsClickListeners("s");
    expect([...ids].sort()).toEqual([11, 12]);
    expect(client.callsOf("Runtime.releaseObject")).toHaveLength(1);
  });

  it("evaluate 无 objectId → 空集；探测链路异常 → 空集不抛", async () => {
    const empty = new FakeCdpClient({ "Runtime.evaluate": () => ({}) });
    expect((await new DomCollector(empty).detectJsClickListeners()).size).toBe(0);

    const broken = new FakeCdpClient({
      "Runtime.evaluate": () => {
        throw new Error("denied");
      },
    });
    expect((await new DomCollector(broken).detectJsClickListeners()).size).toBe(0);
  });

  it("describeNode 失败的单个元素被跳过", async () => {
    const client = new FakeCdpClient({
      "Runtime.evaluate": () => ({ result: { objectId: "arr1" } }),
      "Runtime.getProperties": () => ({
        result: [
          { name: "0", value: { objectId: "ok" } },
          { name: "1", value: { objectId: "bad" } },
        ],
      }),
      "DOM.describeNode": (p) => {
        if (p.objectId === "bad") throw new Error("gone");
        return { node: { backendNodeId: 11 } };
      },
      "Runtime.releaseObject": () => {
        throw new Error("already released"); // 释放失败不影响结果集
      },
    });
    const ids = await new DomCollector(client).detectJsClickListeners();
    expect([...ids]).toEqual([11]);
  });
});

// ── 纯函数工具 ──────────────────────────────────────────────────────────

describe("parseAttrs", () => {
  it("交替数组转 dict；值截 200 码点（对齐 Python [:200]）", () => {
    expect(parseAttrs(["id", "x", "class", "btn"])).toEqual({ id: "x", class: "btn" });
    expect(parseAttrs(undefined)).toEqual({});
    expect(parseAttrs(["k"])).toEqual({}); // 奇数个：悬空键丢弃
    expect(parseAttrs(["id", "a".repeat(250)]).id).toHaveLength(200);
    // 星面字符按码点截断：250 个 emoji → 200 个（400 个 UTF-16 单元）
    expect(parseAttrs(["id", "😀".repeat(250)]).id).toHaveLength(400);
  });
});

describe("buildSnapshotLookup", () => {
  it("稀疏 isClickable / styles 定位 / bounds 除 dpr / 空 layout 容错", () => {
    const snapshot = {
      strings: ["block", "visible", "auto", "pointer"],
      documents: [
        {
          nodes: { backendNodeId: [10, 11], isClickable: { index: [1] } },
          layout: {
            nodeIndex: [0, 1],
            bounds: [[10, 20, 100, 50]],
            text: [],
            stackingContexts: { index: [] },
            paintOrders: [7],
            styles: [[0, 1, 2, 3]],
            clientRects: [[1, 2, 3, 4]],
            scrollRects: [[5, 6, 7, 8]],
          },
        },
      ],
    };
    const lookup = buildSnapshotLookup(snapshot as never, 2.0);
    expect(lookup.size).toBe(2);
    const first = lookup.get(10)!;
    expect(first.is_clickable).toBeNull();
    expect(first.bounds).toEqual({ x: 5, y: 10, width: 50, height: 25 });
    expect(first.computed_styles).toEqual({
      display: "block",
      visibility: "visible",
      opacity: "auto",
      cursor: "pointer",
    });
    expect(first.cursor_style).toBe("pointer"); // REQUIRED_COMPUTED_STYLES[3]=cursor
    expect(first.paint_order).toBe(7);
    expect(first.clientRects).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(first.scrollRects).toEqual({ x: 5, y: 6, width: 7, height: 8 });
    expect(lookup.get(11)!.is_clickable).toBe(true); // 稀疏集合命中
    expect(lookup.get(11)!.bounds).toBeNull(); // 无布局记录
    expect(lookup.get(11)!.computed_styles).toBeNull(); // 空 styles → null
    expect(buildSnapshotLookup(null)).toEqual(new Map());
  });

  it("document 缺 nodes/layout 键 → 按空数据容忍不抛（评审 #1）", () => {
    const truncated = {
      strings: [],
      documents: [{}, { nodes: { backendNodeId: [3] } }, { layout: {} }],
    };
    const lookup = buildSnapshotLookup(truncated as never);
    expect(lookup.size).toBe(1); // 仅第二条的 backendNodeId 生效，其余按空数据跳过
    expect(lookup.get(3)!.bounds).toBeNull();
  });
});

describe("collectFileInputs", () => {
  const snapNode = (styles: Record<string, string>) => ({
    is_clickable: null,
    cursor_style: null,
    bounds: null,
    clientRects: null,
    scrollRects: null,
    computed_styles: styles,
    paint_order: null,
    stacking_contexts: null,
  });

  it("收集 file input：accept/class 提取、可见性、upload 容器继承、shadow/iframe 递归", () => {
    const tree = el(
      1,
      1,
      "HTML",
      {},
      {
        children: [
          el(
            2,
            2,
            "DIV",
            { class: "semi-upload" },
            {
              children: [
                el(3, 3, "INPUT", { type: "file", accept: "image/*", class: "hidden-input" }),
              ],
            },
          ),
          el(4, 4, "INPUT", { type: "file", id: "plain" }),
          el(5, 5, "INPUT", { type: "text" }), // 非 file
          el(
            6,
            6,
            "DIV",
            {},
            {
              shadowRoots: [
                {
                  nodeId: 7,
                  backendNodeId: 7,
                  nodeType: 11,
                  nodeName: "#document-fragment",
                  nodeValue: "",
                  shadowRootType: "open",
                  children: [el(8, 8, "INPUT", { type: "file" })],
                },
              ],
            },
          ),
          el(
            9,
            9,
            "IFRAME",
            {},
            {
              contentDocument: {
                nodeId: 10,
                backendNodeId: 10,
                nodeType: 9,
                nodeName: "#document",
                nodeValue: "",
                children: [el(11, 11, "INPUT", { type: "file" })],
              },
            },
          ),
        ],
      },
    );
    const lookup = new Map([
      [3, snapNode({ display: "none" })],
      [4, snapNode({})],
      [8, snapNode({ opacity: "0" })],
      [11, snapNode({})],
    ]);
    const infos = collectFileInputs(tree, lookup);
    expect(infos).toEqual([
      {
        backend_node_id: 3,
        accept: "image/*",
        visible: false,
        upload_ancestor: true,
        class_name: "hidden-input",
      },
      { backend_node_id: 4, accept: "", visible: true, upload_ancestor: false, class_name: "" },
      { backend_node_id: 8, accept: "", visible: false, upload_ancestor: false, class_name: "" },
      { backend_node_id: 11, accept: "", visible: true, upload_ancestor: false, class_name: "" },
    ]);
  });
});

describe("DomCollector 其余分支", () => {
  it("getViewportRatio：css 宽为 0、device 宽为 0（窗口最小化）或调用失败 → 1.0", async () => {
    const zero = new FakeCdpClient({
      "Page.getLayoutMetrics": () => ({ visualViewport: { clientWidth: 900 } }),
    });
    expect(await new DomCollector(zero).getViewportRatio()).toBe(1.0);
    // deviceWidth=0 若不回退，bounds/dpr 会产出 NaN/Infinity 静默污染整树（评审 #2）
    const minimized = new FakeCdpClient({
      "Page.getLayoutMetrics": () => ({
        visualViewport: { clientWidth: 0 },
        cssVisualViewport: { clientWidth: 800 },
      }),
    });
    expect(await new DomCollector(minimized).getViewportRatio()).toBe(1.0);
    const broken = new FakeCdpClient({
      "Page.getLayoutMetrics": () => {
        throw new Error("x");
      },
    });
    expect(await new DomCollector(broken).getViewportRatio()).toBe(1.0);
  });

  it("buildFrameTargetMap：失败 → 空映射；attach 失败 → null", async () => {
    const broken = new FakeCdpClient({
      "Target.getTargets": () => {
        throw new Error("x");
      },
    });
    const maps = await new DomCollector(broken).buildFrameTargetMap();
    expect(maps.frameToTarget.size).toBe(0);
    expect(await new DomCollector(broken).attachToIframeTarget("T")).toBeNull();
  });

  it("AX 逐 frame 合并：子 frame 节点拼接", async () => {
    const client = new FakeCdpClient({
      "Page.getFrameTree": () => ({
        frameTree: { frame: { id: "main" }, childFrames: [{ frame: { id: "sub" } }] },
      }),
      "Accessibility.getFullAXTree": (p) =>
        p.frameId === "main"
          ? { nodes: [{ nodeId: "a", backendDOMNodeId: 1 }] }
          : { nodes: [{ nodeId: "b", backendDOMNodeId: 2 }] },
    });
    const tree = await new DomCollector(client).getAxTreeForAllFrames();
    expect(tree.nodes.map((n) => n.nodeId)).toEqual(["a", "b"]);
  });

  it("重复 nodeId 复用 memo 实例（Python 备忘录语义）", async () => {
    const shared = el(4, 4, "DIV", { id: "dup" });
    const { tree, snapshot } = pageWith([shared, shared], [{ bid: 4, bounds: [0, 0, 10, 10] }]);
    const client = new FakeCdpClient({
      "DOM.getDocument": () => tree,
      "DOMSnapshot.captureSnapshot": () => snapshot,
      "Page.getFrameTree": () => ({ frameTree: { frame: { id: "f" } } }),
      "Accessibility.getFullAXTree": () => ({ nodes: [] }),
      "Page.getLayoutMetrics": () => ({}),
      "Runtime.evaluate": () => ({}),
      "Target.getTargets": () => ({ targetInfos: [] }),
    });
    const result = await new DomCollector(client).buildEnhancedDomTree(null);
    const body = indexByBackendId(result.root!).get(3)!;
    expect(body.childrenNodes).toHaveLength(2);
    expect(body.childrenNodes![0]).toBe(body.childrenNodes![1]);
  });
});
