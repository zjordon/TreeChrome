// 直驱动词 MCP 面（issue #32 M2 P3）：core DRIVE_VERBS 单源生成 15 动词工具 +
// session_stop——inputSchema 由参数规格生成（snake_case core 名 ↔ camelCase MCP
// 名互转），locator 动词的 epoch 由桥侧会话簿记自动附带（调用方零新参数，
// 决策点 ①/③）。描述是供给面 UX 文案（含索引纪律），与 daemon CLI help 各自维护。

import { DRIVE_VERBS } from "@tw/core";

export interface DriveToolSpec {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

const PARAM_TYPE_SCHEMA: Record<string, unknown> = {
  int: { type: "integer" },
  str: { type: "string" },
  bool: { type: "boolean" },
  "str[]": { type: "array", items: { type: "string" } },
};

/** snake_case（core 动作参数名）→ camelCase（MCP 工具参数名） */
export function camelOf(name: string): string {
  return name.replace(/_([a-z])/g, (_all, c: string) => c.toUpperCase());
}

/** camelCase → snake_case（MCP 工具入参 → core 动作参数） */
export function snakeOf(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

const VERB_DESCRIPTIONS: Record<string, string> = {
  get_state:
    "当前页只读快照：elementTreeText（带 [N] 索引的元素树）+ url/title/tabs/gridMeta。locator 动词的索引来自最近一次本调用。",
  navigate: "当前 tab 跳转 URL（newTab=true 另开新页并切换）。",
  click:
    "点击元素：index 或 elementId（二选一，来自最近一次 get_state；会话重建会返回 EPOCH_STALE——重跑 get_state 即恢复）。",
  input_text: "向输入框输入文本：index/elementId 定位 + text；clear=false 不清原值。",
  select_dropdown: "下拉选择：index 定位；value 单选或 values 多选（整组替换语义）。",
  scroll: "滚动页面：direction（up/down）与 amount。",
  find_text: "页内查找并高亮文本：text 必填，nth 定位第 n 个匹配。",
  read_grid: "读取 UI 网格数据（可见文本/属性/表头/JS 求值四通道降级）。",
  evaluate: "在页面内执行 JS：code 必填；awaitPromise/timeoutMs/userGesture 可选。",
  screenshot:
    "截图：format/quality/fullPage 可选；savePath 落扩展虚拟工作区（调用方读不到，建议省略直接取回数据）。",
  upload_file: "向文件输入框上传本机文件（路径模式——由 Chrome 读盘）：index 定位 + path 绝对路径。",
  go_back: "后退一页。",
  tabs: "列出全部标签页：targetId 后 4 位可用于 switchTab/closeTab。",
  switch_tab: "切换标签页：tabId 为 targetId 后 4 位（取自 tabs 输出）。",
  close_tab: "关闭标签页：tabId 省略则关当前（自动切到剩余页）。",
};

export function buildDriveTools(): DriveToolSpec[] {
  return DRIVE_VERBS.map((spec) => ({
    name: spec.verb,
    description: VERB_DESCRIPTIONS[spec.verb] ?? spec.verb,
    inputSchema: {
      type: "object" as const,
      properties: Object.fromEntries(
        spec.params.map((param) => [camelOf(param.name), PARAM_TYPE_SCHEMA[param.type]]),
      ),
      ...(spec.params.some((param) => param.required === true)
        ? {
            required: spec.params
              .filter((param) => param.required === true)
              .map((param) => camelOf(param.name)),
          }
        : {}),
    },
  }));
}

const SESSION_STOP_TOOL: DriveToolSpec = {
  name: "session_stop",
  description: "结束直驱会话并释放保活（空闲 15min 也会自动回收；会话重建 epoch +1）。",
  inputSchema: { type: "object", properties: {} },
};

/** 15 动词 + session_stop（顺序稳定：tools/list 断言锚定） */
export const DRIVE_TOOLS: DriveToolSpec[] = [...buildDriveTools(), SESSION_STOP_TOOL];
