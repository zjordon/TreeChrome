/**
 * @tw/dom-snapshot 公共入口。
 *
 * 当前状态：models（types.ts）与协议（protocol.ts）已移植并通过 Python 参考值
 * 对拍；collector / serializer 尚未移植（见 docs/architecture.md §10 移植地图）。
 */

export * from "./protocol.js";
export * from "./types.js";

import { DOMRect, type DOMSelectorMap, SerializedDOMState } from "./types.js";

/** 采集失败时的空态（对齐 Python EMPTY_DOM_STATE；collector 移植后核对字段） */
export function createEmptyDomState(): SerializedDOMState {
  return new SerializedDOMState(null, new Map() as DOMSelectorMap, "");
}

/**
 * 序列化器骨架 —— Python serializer.py 五步过滤的移植占位。
 *
 * 移植地图（Python dom-snapshot/serializer.py）：
 *   1. 简化树（剪 script/style/SVG/不可见）
 *   2. paintOrder 几何遮挡标记
 *   3. 剪空容器
 *   4. 包围盒合并（a/button）
 *   5. 交互元素编号 + selector_map（index = backendNodeId，新元素加 * 前缀）
 *
 * element_tree_text 的输出格式是与 LLM prompt 的契约，必须与 Python 端
 * 逐字节一致 —— golden fixture（test/fixtures/*.json）为验收标准。
 */
export interface DOMTreeSerializerOptions {
  enableBboxFiltering: boolean;
  containmentThreshold: number | null;
  paintOrderFiltering: boolean;
  sessionId: string | null;
}

export class DOMTreeSerializer {
  constructor(
    public rootNode: import("./types.js").EnhancedDOMTreeNode,
    public previousCachedState: SerializedDOMState | null = null,
    options?: Partial<DOMTreeSerializerOptions>,
  ) {
    this.options = {
      enableBboxFiltering: true,
      containmentThreshold: null,
      paintOrderFiltering: true,
      sessionId: null,
      ...options,
    };
  }

  options: DOMTreeSerializerOptions;

  serializeTree(
    _node: import("./types.js").SimplifiedNode | null,
    _includeAttributes: string[],
    _depth = 0,
  ): string {
    throw new Error(
      "DOMTreeSerializer.serializeTree 尚未移植：见 docs/architecture.md §10 移植地图（Python serializer.py）",
    );
  }
}

export { DOMRect };
