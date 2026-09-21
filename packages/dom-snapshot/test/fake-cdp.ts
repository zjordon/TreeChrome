/**
 * 测试用假 CDP 客户端：按方法名分发固定响应，记录调用序列。
 * 对拍口径：fixture 的 input 即 Python 端录下的真实 CDP 响应，原样回放。
 */
import type { CdpLikeClient } from "../src/protocol.js";

export type CdpHandler = (params: Record<string, unknown>, sessionId: string | null) => unknown;

export class FakeCdpClient implements CdpLikeClient {
  readonly calls: { method: string; params: Record<string, unknown>; sessionId: string | null }[] =
    [];
  private readonly handlers: Map<string, CdpHandler>;

  constructor(handlers: Record<string, CdpHandler> = {}) {
    this.handlers = new Map(Object.entries(handlers));
  }

  async send<T>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId: string | null = null,
  ): Promise<T> {
    this.calls.push({ method, params, sessionId });
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`FakeCdpClient: 未注册的 CDP 调用 ${method}`);
    return handler(params, sessionId) as T;
  }

  callsOf(method: string): { params: Record<string, unknown>; sessionId: string | null }[] {
    return this.calls.filter((c) => c.method === method);
  }
}

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

/**
 * 用 fixture 的 input 构造假客户端：
 * - AX：fixture.ax_tree 已是逐 frame 合并结果，按单 frame 回放等价
 * - dpr：clientWidth 比值还原 fixture 记录的设备像素比
 * - 监听器探测返回无 objectId → 空集（fixture 页面 has_js_click_listener 全 false）
 */
export function makeGoldenFixtureClient(
  fixture: GoldenFixture,
  overrides: Record<string, CdpHandler> = {},
): FakeCdpClient {
  return new FakeCdpClient({
    "DOMSnapshot.captureSnapshot": () => fixture.input.snapshot,
    "DOM.getDocument": () => fixture.input.dom_tree,
    "Page.getFrameTree": () => ({ frameTree: { frame: { id: "main" } } }),
    "Accessibility.getFullAXTree": () => fixture.input.ax_tree,
    "Page.getLayoutMetrics": () => ({
      visualViewport: { clientWidth: 800 * fixture.input.dpr },
      cssVisualViewport: { clientWidth: 800 },
    }),
    "Runtime.evaluate": () => ({}),
    "Target.getTargets": () => ({ targetInfos: [] }),
    ...overrides,
  });
}
