/**
 * golden fixture 的 schema 与加载器——gen_fixtures.py 产物形状的单一来源。
 * golden.test.ts（schema 校验）、collector.test.ts（融合对拍）、fake-cdp.ts
 * （回放客户端）共用，防止三处口径漂移（评审 P1.2 三轮 #4）。
 * expectByteEqual 供 serializer/dom-state 测试的逐字节对拍共用（评审 P1.5 一轮 #3）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** golden fixture 的 input/output 形状（gen_fixtures.py 产物）。
 *
 * input 三源非空是产物契约：生成器在落盘前校验 snapshot 含 documents、dom_tree
 * 含 root（失败形态在生成期抛错，不会产出 fixture）。schema 测试保留空值防御，
 * 以便未来支持 failed 降级样本落盘时报警而非崩溃（评审 P1.2 四轮 #5）。
 */
export interface GoldenFixture {
  meta: {
    url: string;
    generated_at: string;
    degradation: string;
    source_statuses?: Record<string, string>;
    /** gen_fixtures 以 len(state.selector_map) 落盘（非采集器自身产物） */
    element_count?: number;
  };
  input: {
    dom_tree: Record<string, unknown>;
    snapshot: Record<string, unknown>;
    ax_tree: Record<string, unknown>;
    dpr: number;
  };
  output: {
    element_tree_text: string;
    selector_map: Record<
      string,
      {
        backend_node_id: number;
        node_name: string;
        node_value: string;
        attributes: Record<string, string>;
        is_visible: boolean | null;
        is_scrollable: boolean | null;
        has_js_click_listener: boolean;
        xpath: string;
      }
    >;
    file_input_backend_ids?: number[];
    file_inputs_meta?: Record<string, unknown>[];
    page_stats?: Record<string, unknown>;
  };
}

const FIXTURES_DIR = join(__dirname, "fixtures");

/** 目录内全部 golden fixture；未生成时返回空（调用方 skipIf 兜底） */
export function loadGoldenFixtures(): { name: string; fixture: GoldenFixture }[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((name) => ({
      name,
      fixture: JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf-8")) as GoldenFixture,
    }));
}

/** 逐字节对拍，失败时打印首个差异窗口辅助定位；label 为对拍字段名，复用于其他字段时显式传入 */
export function expectByteEqual(
  actual: string,
  expected: string,
  label = "element_tree_text",
): void {
  if (actual === expected) return;
  let i = 0;
  while (i < expected.length && i < actual.length && expected[i] === actual[i]) {
    i += 1;
  }
  const win = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 60), i + 80));
  throw new Error(`${label} 首个差异 @${i}:\n  py: ${win(expected)}\n  ts: ${win(actual)}`);
}
