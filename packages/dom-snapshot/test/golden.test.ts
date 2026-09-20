/**
 * Golden fixture 对拍 harness。
 *
 * 当前阶段：fixture 存在时校验其 schema（保证生成器输出格式不漂移）；
 * collector/serializer 移植完成后，本文件升级为「input 喂 TS 管线 →
 * output.element_tree_text 逐字节对拍」的验收测试（见 test/fixtures/README.md）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FIXTURES_DIR = join(__dirname, "fixtures");

interface Fixture {
  meta: {
    url: string;
    generated_at: string;
    degradation: string;
    source_statuses?: Record<string, string>;
  };
  input: {
    dom_tree: Record<string, unknown> | null;
    snapshot: Record<string, unknown> | null;
    ax_tree: Record<string, unknown> | null;
  };
  output: {
    element_tree_text: string;
    selector_map: Record<string, Record<string, unknown>>;
    file_input_backend_ids?: number[];
    file_inputs_meta?: Record<string, unknown>[];
    page_stats?: Record<string, unknown>;
  };
}

function loadFixtures(): { name: string; fixture: Fixture }[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((name) => ({
      name,
      fixture: JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf-8")) as Fixture,
    }));
}

const fixtures = loadFixtures();

describe.skipIf(fixtures.length === 0)("golden fixtures schema", () => {
  it("至少一个 fixture 可加载", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const { name, fixture } of fixtures) {
    it(`${name}: meta/input/output 结构完整`, () => {
      expect(fixture.meta.url).toBeTruthy();
      expect(fixture.meta.degradation).toMatch(/^(full|partial|minimal|failed)$/);

      const { dom_tree, snapshot, ax_tree } = fixture.input;
      expect(dom_tree && (dom_tree as { root?: unknown }).root).toBeTruthy();
      expect(snapshot && Array.isArray((snapshot as { documents?: unknown }).documents)).toBe(true);
      expect(Array.isArray((ax_tree as { nodes?: unknown }).nodes)).toBe(true);

      // wire 形状契约（三轮评审 #11 的教训）：layout.bounds 是 Rectangle[] 嵌套数组，
      // 与 nodeIndex 平行——上游形状变化（如改展平）在此报警而非静默错位
      const docs = (snapshot as { documents?: Array<Record<string, unknown>> }).documents ?? [];
      for (const doc of docs) {
        const layout = doc["layout"] as
          | { nodeIndex: number[]; bounds: number[][]; paintOrders?: number[] }
          | undefined;
        if (!layout) continue;
        expect(layout.bounds.length).toBe(layout.nodeIndex.length);
        for (const rect of layout.bounds.slice(0, 5)) {
          expect(Array.isArray(rect)).toBe(true);
          expect(rect).toHaveLength(4);
        }
      }

      // 降级为 failed 时产物允许为空；否则文本树必须非空
      if (fixture.meta.degradation !== "failed") {
        expect(fixture.output.element_tree_text.length).toBeGreaterThan(0);
      }
      for (const [idx, proj] of Object.entries(fixture.output.selector_map)) {
        expect(String(Number(idx))).toBe(idx); // 键是数字字符串（backendNodeId）
        expect(proj.backend_node_id).toBeTypeOf("number");
        expect(typeof proj.node_name).toBe("string");
      }
    });
  }
});

describe.skipIf(fixtures.length > 0)("golden fixtures 未生成时提示", () => {
  it("跳过（运行 tools/gen_fixtures.py 生成后自动生效）", () => {
    console.warn(
      "[golden] test/fixtures 无 *.json —— 运行 packages/dom-snapshot/tools/gen_fixtures.py 生成基准",
    );
    expect(true).toBe(true);
  });
});
