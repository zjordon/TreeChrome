// actionability 判定（actionability.py 纯函数部分 + 探索侧 index 等待）。
// 降级原则：超时/拿不到 node/index 漂移 → 照常执行，永不引入新失败。

import type { EnhancedDOMTreeNode } from "../browser/views.js";

/** 仅这 3 个动作做 actionability：有明确 DOM 目标且依赖元素已就绪可交互 */
export const ACTIONABILITY_ACTIONS: ReadonlySet<string> = new Set([
  "click",
  "input_text",
  "select_dropdown",
]);

/** INPUT[type=file] 防御短路（file input 永远 is_visible=False 但有效） */
export function isFileInput(node: EnhancedDOMTreeNode): boolean {
  return (
    (node.nodeName ?? "").toUpperCase() === "INPUT" &&
    (node.attributes?.type ?? "").toLowerCase() === "file"
  );
}

export interface ActionabilityNode {
  isVisible: boolean | null;
  /** L1：被 paint-order 判定完全覆盖 */
  ignoredByPaintOrder?: boolean;
  /** L2：computed pointer-events（snapshot_node 缺失时保守放过） */
  pointerEvents?: string | null;
  /** AX disabled 属性（真值） */
  axDisabled?: boolean;
  attributes?: Record<string, string>;
}

/** visible + enabled（+ receives-events）判定。None 字段保守放过 */
export function isActionable(node: ActionabilityNode, checkReceivesEvents = false): boolean {
  if (node.isVisible === false) return false;
  if (checkReceivesEvents) {
    if (node.pointerEvents !== undefined && node.pointerEvents !== null) {
      if (node.pointerEvents.toLowerCase() === "none") return false;
    }
    if (node.ignoredByPaintOrder === true) return false;
  }
  if (node.axDisabled === true) return false;
  const attrs = node.attributes ?? {};
  if ("disabled" in attrs) return false;
  if ((attrs["aria-disabled"] ?? "").toLowerCase() === "true") return false;
  return true;
}

/** 从 selector_map 节点投影出 actionability 判定面（AX disabled / pointer-events 提取） */
export function projectActionabilityNode(node: EnhancedDOMTreeNode): ActionabilityNode {
  let axDisabled = false;
  const ax = node.axNode;
  if (ax !== null && ax !== undefined && Array.isArray(ax.properties)) {
    for (const prop of ax.properties) {
      if (prop.name === "disabled" && prop.value) {
        axDisabled = true;
        break;
      }
    }
  }
  const styles = node.snapshotNode?.computed_styles ?? null;
  const pe = styles !== null ? (styles["pointer-events"] ?? null) : null;
  return {
    isVisible: node.isVisible,
    ignoredByPaintOrder: node.ignoredByPaintOrder,
    pointerEvents: pe,
    axDisabled,
    attributes: node.attributes,
  };
}

export interface ActionabilityBrowser {
  /** element-pointer 三级回退坐标 */
  getElementCoordinates(
    backendNodeId: number,
  ): Promise<{ x: number; y: number; width: number; height: number } | null>;
  /** L3 运行时遮挡（elementFromPoint） */
  isElementOccluded(backendNodeId: number, x: number, y: number): Promise<boolean>;
  getState(options?: {
    includeScreenshot?: boolean;
  }): Promise<import("../browser/views.js").BrowserStateSummary>;
}

export interface ActionabilityWaitOptions {
  timeout: number;
  poll: number;
  receivesEvents: boolean;
  runtimeOcclusion: boolean;
  stable: boolean;
  stableInterval: number;
  stableTolerance: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** 两次取 rect 比（~interval 间隔），变化 ≤ tolerance 视为稳定；拿不到坐标视为不稳定 */
export async function isRectStable(
  browser: ActionabilityBrowser,
  backendNodeId: number,
  interval: number,
  tolerance: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const r1 = await browser.getElementCoordinates(backendNodeId);
  if (r1 === null) return false;
  await sleep(interval * 1000);
  const r2 = await browser.getElementCoordinates(backendNodeId);
  if (r2 === null) return false;
  return (
    Math.abs(r1.x - r2.x) <= tolerance &&
    Math.abs(r1.y - r2.y) <= tolerance &&
    Math.abs(r1.width - r2.width) <= tolerance &&
    Math.abs(r1.height - r2.height) <= tolerance
  );
}

/**
 * 探索侧 index-based actionability 等待（deadline + poll + 降级不抛错）。
 * 命中即返 [state, node]；超时降级返最新对，让 tools.execute 照常执行。
 */
export async function waitForActionability(
  browser: ActionabilityBrowser,
  state: import("../browser/views.js").BrowserStateSummary,
  index: number,
  opts: ActionabilityWaitOptions,
): Promise<[import("../browser/views.js").BrowserStateSummary, EnhancedDOMTreeNode | null]> {
  const deadline = opts.now() + opts.timeout;
  let current = state;
  let freshNode: EnhancedDOMTreeNode | null = null;
  for (;;) {
    const sm = current.domState?.selectorMap;
    freshNode = sm ? (sm.get(index) ?? null) : null;
    if (freshNode !== null) {
      let actionable = isActionable(projectActionabilityNode(freshNode), opts.receivesEvents);
      if (actionable && opts.runtimeOcclusion) {
        const rect = await browser.getElementCoordinates(freshNode.backendNodeId);
        if (rect !== null) {
          const x = Math.trunc(rect.x + rect.width / 2);
          const y = Math.trunc(rect.y + rect.height / 2);
          actionable = !(await browser.isElementOccluded(freshNode.backendNodeId, x, y));
        }
      }
      if (actionable && opts.stable) {
        actionable = await isRectStable(
          browser,
          freshNode.backendNodeId,
          opts.stableInterval,
          opts.stableTolerance,
          opts.sleep,
        );
      }
      if (actionable) return [current, freshNode];
    }
    if (opts.now() >= deadline) return [current, freshNode]; // 超时降级不抛错
    await opts.sleep(opts.poll * 1000);
    try {
      current = await browser.getState({ includeScreenshot: false });
    } catch {
      // 刷新失败保持旧 state 继续
    }
  }
}
