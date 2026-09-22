/**
 * P1.5 buildDomState 组合入口验收：
 * 1. golden fixture 端到端：input（三源 CDP 响应回放）→ buildDomState() →
 *    对拍 output 全字段（element_tree_text / selector_map 8 字段投影 /
 *    file_input_backend_ids / file_inputs_meta / page_stats）
 * 2. prev_map 轮转接线：上轮全量 → 与无 prev_map 基线逐字节一致；缺一键 →
 *    恰好多一个 `*`；空 map 视同未传（Python falsy 语义）
 * 3. FAILED 分支：DOM 树源失败 → EMPTY_DOM_STATE 单例 + FAILED metrics
 */
import { describe, expect, it } from "vitest";
import { buildDomState, EMPTY_DOM_STATE } from "../src/collector.js";
import { DOMDegradationLevel, EnhancedDOMTreeNode, NodeType } from "../src/types.js";
import { FakeCdpClient, makeGoldenFixtureClient } from "./fake-cdp.js";
import { loadGoldenFixtures } from "./golden-fixture.js";

const fixtures = loadGoldenFixtures();

/** 逐字节对拍失败时打印首个差异窗口（与 serializer.test.ts 同款辅助） */
function expectByteEqual(actual: string, expected: string): void {
  if (actual === expected) return;
  let i = 0;
  while (i < expected.length && i < actual.length && expected[i] === actual[i]) {
    i += 1;
  }
  const win = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 60), i + 80));
  throw new Error(
    `element_tree_text 首个差异 @${i}:\n  py: ${win(expected)}\n  ts: ${win(actual)}`,
  );
}

/** element_tree_text 中 `*[<backendNodeId>]` 新元素星标计数 */
function starCount(text: string): number {
  return [...text.matchAll(/\*\[\d+\]</g)].length;
}

// ── P1.5 验收：golden 端到端全字段对拍 ──────────────────────────────────

describe.skipIf(fixtures.length === 0)("golden 端到端对拍（P1.5 验收）", () => {
  for (const { name, fixture } of fixtures) {
    it(`${name}: input → buildDomState → output 全字段一致`, async () => {
      const client = makeGoldenFixtureClient(fixture);
      const { state, metrics } = await buildDomState(client, "sess-main");

      expectByteEqual(state.elementTreeText, fixture.output.element_tree_text);

      // selector_map 全字段投影（gen_fixtures.py 同款 8 字段；键 = backendNodeId）
      const pyKeys = Object.keys(fixture.output.selector_map)
        .map(Number)
        .sort((a, b) => a - b);
      const tsKeys = [...state.selectorMap.keys()].sort((a, b) => a - b);
      expect(tsKeys).toEqual(pyKeys);
      for (const key of pyKeys) {
        const on = state.selectorMap.get(key);
        if (!on) throw new Error(`selector_map 缺键 ${key}`);
        expect({
          backend_node_id: on.backendNodeId,
          node_name: on.nodeName,
          node_value: on.nodeValue,
          attributes: on.attributes,
          is_visible: on.isVisible,
          is_scrollable: on.isScrollable,
          has_js_click_listener: on.hasJsClickListener,
          xpath: on.xpath,
        }).toEqual(fixture.output.selector_map[String(key)]);
      }

      // file_input 挂载（Python build_dom_state 尾部两行赋值的移植）
      expect(state.fileInputBackendIds).toEqual(fixture.output.file_input_backend_ids ?? []);
      expect(state.fileInputsMeta).toEqual(fixture.output.file_inputs_meta ?? []);

      expect(state.pageStats).toEqual(fixture.output.page_stats ?? {});

      // metrics parity：可复现字段（degradation 与逐源状态；时间量不对拍）
      expect(metrics.degradationLevel).toBe(DOMDegradationLevel.FULL);
      expect(metrics.sourceStatuses).toEqual(fixture.meta.source_statuses ?? {});
      // gen_fixtures 以 len(selector_map) 落盘 element_count
      expect(state.selectorMap.size).toBe(fixture.meta.element_count ?? -1);
    });
  }
});

// ── prev_map 轮转（`*` 标记的入口接线；compound 恒新由 P1.3 单测覆盖） ─────

describe.skipIf(fixtures.length === 0)("prev_map 轮转接线", () => {
  // 回放是确定性的：同一 fixture 两次 buildDomState 产出逐字节相同基线
  const { name, fixture } = fixtures[0];

  it(`${name}: 上轮 selector_map 全量传入 → 与基线逐字节一致（compound 星标除外无新增）`, async () => {
    const first = await buildDomState(makeGoldenFixtureClient(fixture), "sess-main");
    const second = await buildDomState(makeGoldenFixtureClient(fixture), "sess-main", {
      previousSelectorMap: first.state.selectorMap,
    });
    expectByteEqual(second.state.elementTreeText, first.state.elementTreeText);
  });

  it(`${name}: prev_map 缺一键 → 该元素标新（恰好多一个 \`*\`），键集合不变`, async () => {
    const first = await buildDomState(makeGoldenFixtureClient(fixture), "sess-main");
    // 选一个基线无星标的键（有星标的 compound 元素恒新，删了也测不出差异）
    const starred = new Set(
      [...first.state.elementTreeText.matchAll(/\*\[(\d+)\]</g)].map((m) => Number(m[1])),
    );
    const targetKey = [...first.state.selectorMap.keys()].find((k) => !starred.has(k));
    if (targetKey === undefined) throw new Error("fixture 无非星标可交互元素，轮转用例不成立");

    const partial = new Map(first.state.selectorMap);
    partial.delete(targetKey);
    const second = await buildDomState(makeGoldenFixtureClient(fixture), "sess-main", {
      previousSelectorMap: partial,
    });
    expect(second.state.elementTreeText).toContain(`*[${targetKey}]<`);
    expect(starCount(second.state.elementTreeText)).toBe(
      starCount(first.state.elementTreeText) + 1,
    );
    expect([...second.state.selectorMap.keys()].sort((a, b) => a - b)).toEqual(
      [...first.state.selectorMap.keys()].sort((a, b) => a - b),
    );
  });

  it(`${name}: 空 map 视同未传（Python 空字典 falsy）→ 与基线逐字节一致`, async () => {
    const baseline = await buildDomState(makeGoldenFixtureClient(fixture), "sess-main");
    const withEmpty = await buildDomState(makeGoldenFixtureClient(fixture), "sess-main", {
      previousSelectorMap: new Map(),
    });
    expectByteEqual(withEmpty.state.elementTreeText, baseline.state.elementTreeText);
  });
});

// ── FAILED 分支 ─────────────────────────────────────────────────────────

describe("buildDomState FAILED 分支", () => {
  it("DOM 树源失败 → 返回 EMPTY_DOM_STATE 单例 + FAILED metrics", async () => {
    // 三源与 dpr 均不注册：FakeCdpClient 对未注册调用直接抛错（瞬时拒绝，无超时等待）
    const client = new FakeCdpClient({
      "Target.getTargets": () => ({ targetInfos: [] }),
      "Runtime.evaluate": () => ({}),
    });
    // prev_map 非空也不影响 FAILED 分支（短路在轮转之前）
    const prevNode = new EnhancedDOMTreeNode({
      nodeId: 1,
      backendNodeId: 1,
      nodeType: NodeType.ELEMENT_NODE,
      nodeName: "BUTTON",
      nodeValue: "",
      attributes: {},
    });
    const { state, metrics } = await buildDomState(client, "sess-1", {
      previousSelectorMap: new Map([[1, prevNode]]),
    });
    // Python 返回模块级 EMPTY_DOM_STATE 单例本身（非拷贝）
    expect(state).toBe(EMPTY_DOM_STATE);
    expect(metrics.degradationLevel).toBe(DOMDegradationLevel.FAILED);
    expect(state.elementTreeText).toBe("");
    expect(state.selectorMap.size).toBe(0);
    expect(state.llmRepresentation()).toContain("Empty DOM tree");
    // FAILED 分支不触碰单例（file_input 挂载只在成功路径）
    expect(EMPTY_DOM_STATE.fileInputBackendIds).toEqual([]);
    expect(EMPTY_DOM_STATE.fileInputsMeta).toEqual([]);
  });
});

// 与 golden.test.ts「未生成时提示」块同口径：fixture 缺失时显式告警而非静默跳过
describe.skipIf(fixtures.length > 0)("golden 端到端对拍未生成时提示", () => {
  it("跳过（运行 tools/gen_fixtures.py 生成后自动生效）", () => {
    console.warn("[dom-state] test/fixtures 无 *.json —— P1.5 端到端对拍未执行");
    expect(true).toBe(true);
  });
});
