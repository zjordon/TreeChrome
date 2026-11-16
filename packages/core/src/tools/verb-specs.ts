// 会话级直驱动词面（issue #32 决策点 3 补缺进 core）：tc 15 动词的宿主中立
// 权威规格——动词 → Tools 动作名 / BrowserSession 特殊面，参数（snake_case core
// 名）/类型/必填/XOR/locator 标记，及直驱响应投影（camelCase JSON 形态，与
// daemon 会话输出同形）。非 TreeWalker 移植来源的新导出面（架构 §3.3 登记）：
// daemon CLI 解析层（node-host daemon/protocol.ts）保持不动，其旗标表与本表由
// node-host 侧 verb-parity 测试锚定同步；扩展 MCP 面的 inputSchema 由消费方从
// 本表生成。工具动词执行仍走 Tools 注册表校验（双保险）。

import type { ActionResult } from "../agent/views.js";
import type { BrowserStateSummary, TabInfo } from "../browser/views.js";

export type DriveParamType = "int" | "str" | "bool" | "str[]";

export interface DriveParamSpec {
  /** core 动作参数名（snake_case——与 daemon CLI 旗标映射的 param 同名） */
  name: string;
  type: DriveParamType;
  required?: boolean;
}

export interface DriveVerbSpec {
  verb: string;
  /** core Tools 动作名（特殊面动词为 null） */
  tool: string | null;
  /** BrowserSession 特殊面（get_state/tabs 不经 Tools 注册表，直调浏览器） */
  browser: "get_state" | "get_tabs" | null;
  params: DriveParamSpec[];
  /** 互斥组：每组须恰好给出一个（参数名；如 click 的 index/element_id） */
  xor: string[][];
  /** locator 类：参数含 selector map 索引/element_id——epoch 簿记对象（#32 决策点 1） */
  locator: boolean;
}

/** click/input_text 共用定位参数（element_id 同属 map 定位——backendNodeId 来自快照） */
const locatorParams: DriveParamSpec[] = [
  { name: "index", type: "int" },
  { name: "element_id", type: "int" },
];

export const DRIVE_VERBS: readonly DriveVerbSpec[] = [
  {
    verb: "get_state",
    tool: null,
    browser: "get_state",
    params: [],
    xor: [],
    locator: false,
  },
  {
    verb: "navigate",
    tool: "navigate",
    browser: null,
    params: [
      { name: "url", type: "str", required: true },
      { name: "new_tab", type: "bool" },
    ],
    xor: [],
    locator: false,
  },
  {
    verb: "click",
    tool: "click",
    browser: null,
    params: locatorParams,
    xor: [["index", "element_id"]],
    locator: true,
  },
  {
    verb: "input_text",
    tool: "input_text",
    browser: null,
    params: [
      ...locatorParams,
      { name: "text", type: "str", required: true },
      { name: "clear", type: "bool" },
    ],
    xor: [["index", "element_id"]],
    locator: true,
  },
  {
    verb: "select_dropdown",
    tool: "select_dropdown",
    browser: null,
    params: [
      { name: "index", type: "int", required: true },
      { name: "value", type: "str" },
      { name: "values", type: "str[]" },
    ],
    xor: [["value", "values"]],
    locator: true,
  },
  {
    verb: "scroll",
    tool: "scroll",
    browser: null,
    params: [
      { name: "direction", type: "str" },
      { name: "amount", type: "int" },
    ],
    xor: [],
    locator: false,
  },
  {
    verb: "find_text",
    tool: "find_text",
    browser: null,
    params: [
      { name: "text", type: "str", required: true },
      { name: "nth", type: "int" },
      { name: "case_sensitive", type: "bool" },
      { name: "highlight", type: "str" },
    ],
    xor: [],
    locator: false,
  },
  {
    verb: "read_grid",
    tool: "read_grid",
    browser: null,
    params: [
      { name: "namespace", type: "str" },
      { name: "search", type: "str" },
      { name: "sorting", type: "str" },
      { name: "page_size", type: "int" },
      { name: "page", type: "int" },
      { name: "fields", type: "str[]" },
      { name: "fresh", type: "bool" },
      { name: "group_count", type: "str" },
    ],
    xor: [],
    locator: false,
  },
  {
    verb: "evaluate",
    tool: "evaluate",
    browser: null,
    params: [
      { name: "code", type: "str", required: true },
      { name: "await_promise", type: "bool" },
      { name: "timeout_ms", type: "int" },
      { name: "user_gesture", type: "bool" },
    ],
    xor: [],
    locator: false,
  },
  {
    verb: "screenshot",
    tool: "screenshot",
    browser: null,
    params: [
      { name: "save_path", type: "str" },
      { name: "format", type: "str" },
      { name: "quality", type: "int" },
      { name: "full_page", type: "bool" },
    ],
    xor: [],
    locator: false,
  },
  {
    verb: "upload_file",
    tool: "upload_file",
    browser: null,
    params: [
      { name: "index", type: "int", required: true },
      { name: "path", type: "str", required: true },
    ],
    xor: [],
    locator: true,
  },
  {
    verb: "go_back",
    tool: "go_back",
    browser: null,
    params: [],
    xor: [],
    locator: false,
  },
  {
    verb: "tabs",
    tool: null,
    browser: "get_tabs",
    params: [],
    xor: [],
    locator: false,
  },
  {
    verb: "switch_tab",
    tool: "switch_tab",
    browser: null,
    params: [{ name: "tab_id", type: "str", required: true }],
    xor: [],
    locator: false,
  },
  {
    verb: "close_tab",
    tool: "close_tab",
    browser: null,
    params: [{ name: "tab_id", type: "str" }],
    xor: [],
    locator: false,
  },
];

export function findDriveVerb(verb: string): DriveVerbSpec | null {
  return DRIVE_VERBS.find((spec) => spec.verb === verb) ?? null;
}

export type DriveParamsResult =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * 会话面参数校验（宿主中立，供 MCP 面等 typed 输入复用）：类型窄校验 + 必填 +
 * XOR；空串视同未给、str[] 滤非串与空串（与 daemon buildParams 口径一致）。
 * 工具动词执行时仍走 Tools 注册表校验——本层是信封级双保险。
 */
export function validateDriveParams(
  spec: DriveVerbSpec,
  input: Record<string, unknown>,
): DriveParamsResult {
  const known = new Map(spec.params.map((param) => [param.name, param] as const));
  const params: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    const param = known.get(key);
    if (param === undefined) {
      return { ok: false, message: `未知参数 ${key}（动词 ${spec.verb}）` };
    }
    if (raw === undefined || raw === null) continue;
    if (param.type === "int") {
      if (typeof raw !== "number" || !Number.isInteger(raw)) {
        return { ok: false, message: `参数 ${key} 非法（需整数）` };
      }
      params[key] = raw;
    } else if (param.type === "bool") {
      if (typeof raw !== "boolean") {
        return { ok: false, message: `参数 ${key} 非法（需布尔）` };
      }
      params[key] = raw;
    } else if (param.type === "str") {
      if (typeof raw !== "string") {
        return { ok: false, message: `参数 ${key} 非法（需字符串）` };
      }
      if (raw !== "") params[key] = raw;
    } else {
      const list = Array.isArray(raw) ? raw : [raw];
      const kept = list.filter((v): v is string => typeof v === "string" && v !== "");
      if (kept.length > 0) params[key] = kept;
    }
  }
  for (const param of spec.params) {
    if (param.required === true && params[param.name] === undefined) {
      return { ok: false, message: `缺少必填参数 ${param.name}` };
    }
  }
  for (const group of spec.xor) {
    const given = group.filter((name) => params[name] !== undefined);
    if (given.length !== 1) {
      return {
        ok: false,
        message: `${group.join(" / ")} 必须恰好给出一个（当前给出 ${given.length} 个）`,
      };
    }
  }
  return { ok: true, params };
}

// ── 直驱响应投影（#32：daemon session-holder 的 StateOut/TabsOut/ActionResultOut
//    同形投影——扩展 MCP 面与 daemon JSON 面共用口径）──────────────────────────

/** 动作执行回执（camelCase；daemon 信封 data 的动作形态） */
export interface DriveActionResultOut {
  isDone: boolean;
  success: boolean | null;
  error: string | null;
  extractedContent: string | null;
  longTermMemory: string | null;
  judgement: unknown;
  metadata: Record<string, unknown> | null;
  attachments: string[] | null;
  denied: boolean;
}

export function projectDriveActionResult(r: ActionResult): DriveActionResultOut {
  return {
    isDone: r.isDone,
    success: r.success,
    error: r.error,
    extractedContent: r.extractedContent,
    longTermMemory: r.longTermMemory,
    judgement: r.judgement,
    metadata: r.metadata,
    attachments: r.attachments,
    denied: r.denied,
  };
}

/** get_state 投影：element_tree_text 是核心供给物；截图走 screenshot 动词 */
export interface DriveStateOut {
  url: string;
  title: string;
  tabs: TabInfo[];
  currentTargetId: string | null;
  elementTreeText: string;
  gridMeta: Record<string, unknown> | null;
}

export function projectDriveState(
  st: BrowserStateSummary,
  currentTargetId: string | null,
): DriveStateOut {
  return {
    url: st.url,
    title: st.title,
    tabs: st.tabs,
    currentTargetId,
    elementTreeText: st.domState === null ? "" : st.domState.elementTreeText,
    gridMeta: st.gridMeta,
  };
}

export interface DriveTabsOut {
  tabs: TabInfo[];
  currentTargetId: string | null;
}

export function projectDriveTabs(tabs: TabInfo[], currentTargetId: string | null): DriveTabsOut {
  return { tabs, currentTargetId };
}
