/**
 * golden fixture 的 schema 与加载器——gen_fixtures.py 产物形状的单一来源。
 * golden.test.ts（schema 校验）、collector.test.ts（融合对拍）、fake-cdp.ts
 * （回放客户端）共用，防止三处口径漂移（评审 P1.2 三轮 #4）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** golden fixture 的 input/output 形状（gen_fixtures.py 产物） */
export interface GoldenFixture {
  meta: {
    url: string;
    generated_at: string;
    degradation: string;
    source_statuses?: Record<string, string>;
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
