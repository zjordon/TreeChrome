// daemon 协议纯函数面（issue #27 M2）：端口/空闲缺省、动作动词表（CLI 旗标 → core
// 动作参数的类型化映射 + 必填/XOR 校验）、HTTP 信封类型与 daemon.json 形态。
// CLI 客户端与服务端共用；零 IO（可离线单测）。

export const DEFAULT_DAEMON_PORT = 9780;
/** 空闲回收缺省 15 分钟；TC_DAEMON_IDLE_SECS <= 0 关闭回收 */
export const DEFAULT_IDLE_SECS = 900;

/** TC_DAEMON_PORT 解析：正整数覆盖，非法/未设回落缺省 */
export function daemonPort(env: Record<string, string | undefined>): number {
  const raw = env.TC_DAEMON_PORT;
  if (raw === undefined || raw === "") {
    return DEFAULT_DAEMON_PORT;
  }
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_DAEMON_PORT;
}

/** TC_DAEMON_IDLE_SECS 解析：数值覆盖；<= 0 = 关闭空闲回收 */
export function idleSecs(env: Record<string, string | undefined>): number {
  const raw = env.TC_DAEMON_IDLE_SECS;
  if (raw === undefined || raw === "") {
    return DEFAULT_IDLE_SECS;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_IDLE_SECS;
}

/** ~/.tc/daemon/daemon.json 形态（CLI 发现与 doctor 诊断用） */
export interface DaemonInfo {
  pid: number;
  port: number;
  startedAt: number;
}

/** HTTP 信封：ok 携带数据；!ok 携带错误与类别（CLI 退出码映射：exec→1，env/usage→2） */
export type DaemonErrorKind = "usage" | "env" | "exec";

export interface DaemonEnvelope {
  ok: boolean;
  data?: unknown;
  error?: string;
  kind?: DaemonErrorKind;
}

export function daemonOk(data: unknown): DaemonEnvelope {
  return { ok: true, data };
}

export function daemonErr(error: string, kind: DaemonErrorKind): DaemonEnvelope {
  return { ok: false, error, kind };
}

// ── 动词表（v1 子集 15 动词，#27 拍板）──────────────────────────────────────
// special 动词不经 core 动作注册表，daemon 侧直调 BrowserSession（get_state / tabs）。

export type FlagType = "int" | "str" | "bool" | "str[]";

export interface VerbFlag {
  /** CLI 旗标名（kebab-case） */
  flag: string;
  /** core 动作参数名（snake_case） */
  param: string;
  type: FlagType;
  /** 反向布尔：旗标出现时参数置 false（core 缺省 true 的参数用 --no-xx 形态） */
  invert?: boolean;
}

export interface VerbSpec {
  verb: string;
  /** 特殊面（非 core 动作注册表） */
  special?: "get_state" | "tabs";
  flags: VerbFlag[];
  /** 必填参数名（core 动作参数名） */
  required: string[];
  /** 互斥组：每组必须恰好给出一个（如 click 的 index/element_id） */
  xor: string[][];
}

const locatorFlags: VerbFlag[] = [
  { flag: "index", param: "index", type: "int" },
  { flag: "element-id", param: "element_id", type: "int" },
];

export const DAEMON_VERBS: VerbSpec[] = [
  { verb: "get_state", special: "get_state", flags: [], required: [], xor: [] },
  {
    verb: "navigate",
    flags: [
      { flag: "url", param: "url", type: "str" },
      { flag: "new-tab", param: "new_tab", type: "bool" },
    ],
    required: ["url"],
    xor: [],
  },
  {
    verb: "click",
    flags: [...locatorFlags],
    required: [],
    xor: [["index", "element_id"]],
  },
  {
    verb: "input_text",
    flags: [
      ...locatorFlags,
      { flag: "text", param: "text", type: "str" },
      { flag: "no-clear", param: "clear", type: "bool", invert: true },
    ],
    required: ["text"],
    xor: [["index", "element_id"]],
  },
  {
    verb: "select_dropdown",
    flags: [
      { flag: "index", param: "index", type: "int" },
      { flag: "value", param: "value", type: "str" },
      { flag: "values", param: "values", type: "str[]" },
    ],
    required: ["index"],
    xor: [["value", "values"]],
  },
  {
    verb: "scroll",
    flags: [
      { flag: "direction", param: "direction", type: "str" },
      { flag: "amount", param: "amount", type: "int" },
    ],
    required: [],
    xor: [],
  },
  {
    verb: "find_text",
    flags: [
      { flag: "text", param: "text", type: "str" },
      { flag: "nth", param: "nth", type: "int" },
      { flag: "case-sensitive", param: "case_sensitive", type: "bool" },
      { flag: "highlight", param: "highlight", type: "str" },
    ],
    required: ["text"],
    xor: [],
  },
  {
    verb: "read_grid",
    flags: [
      { flag: "namespace", param: "namespace", type: "str" },
      { flag: "search", param: "search", type: "str" },
      { flag: "sorting", param: "sorting", type: "str" },
      { flag: "page-size", param: "page_size", type: "int" },
      { flag: "page", param: "page", type: "int" },
      { flag: "fields", param: "fields", type: "str[]" },
      { flag: "no-fresh", param: "fresh", type: "bool", invert: true },
      { flag: "group-count", param: "group_count", type: "str" },
    ],
    required: [],
    xor: [],
  },
  {
    verb: "evaluate",
    flags: [
      { flag: "code", param: "code", type: "str" },
      { flag: "no-await", param: "await_promise", type: "bool", invert: true },
      { flag: "timeout-ms", param: "timeout_ms", type: "int" },
      { flag: "user-gesture", param: "user_gesture", type: "bool" },
    ],
    required: ["code"],
    xor: [],
  },
  {
    verb: "screenshot",
    flags: [
      // 落盘路径：core handler 无 save_path 只回字节计数回执（不落盘也不回传图片），
      // 「看看页面」必须落盘取文件（评审轮 1 [2]）；相对路径 CLI 侧 resolve 成绝对
      { flag: "save-path", param: "save_path", type: "str" },
      { flag: "format", param: "format", type: "str" },
      { flag: "quality", param: "quality", type: "int" },
      { flag: "full-page", param: "full_page", type: "bool" },
    ],
    required: [],
    xor: [],
  },
  {
    verb: "upload_file",
    flags: [
      { flag: "index", param: "index", type: "int" },
      { flag: "path", param: "path", type: "str" },
    ],
    required: ["index", "path"],
    xor: [],
  },
  { verb: "go_back", flags: [], required: [], xor: [] },
  { verb: "tabs", special: "tabs", flags: [], required: [], xor: [] },
  {
    verb: "switch_tab",
    flags: [{ flag: "tab-id", param: "tab_id", type: "str" }],
    required: ["tab_id"],
    xor: [],
  },
  {
    verb: "close_tab",
    flags: [{ flag: "tab-id", param: "tab_id", type: "str" }],
    required: [],
    xor: [],
  },
];

export function findVerb(verb: string): VerbSpec | null {
  return DAEMON_VERBS.find((v) => v.verb === verb) ?? null;
}

export type BuildParamsResult =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * CLI 旗标值 → core 动作参数：类型转换（int 校验整数）/ 未给旗标不进参数 /
 * 必填与 XOR 组校验。values 形态统一数组（parseArgs multiple）。
 */
export function buildParams(spec: VerbSpec, values: Record<string, unknown>): BuildParamsResult {
  const params: Record<string, unknown> = {};
  for (const flag of spec.flags) {
    const raw = values[flag.flag];
    if (raw === undefined || raw === null) {
      continue;
    }
    if (flag.type === "int") {
      const n = Number(raw);
      if (!Number.isInteger(n)) {
        return { ok: false, message: `--${flag.flag} "${String(raw)}" 非法（需整数）` };
      }
      params[flag.param] = n;
    } else if (flag.type === "bool") {
      // parseArgs 布尔旗标均带 default:false——false 即「未给」，仅旗标给出（true）才
      // 置参；invert 形态给出时置 false（core 缺省 true 的参数用 --no-xx，评审轮 1 [8]）
      if (raw === true) {
        params[flag.param] = flag.invert !== true;
      }
    } else if (flag.type === "str[]") {
      const list = Array.isArray(raw) ? raw : [raw];
      const kept = list.filter((v): v is string => typeof v === "string" && v !== "");
      if (kept.length > 0) {
        params[flag.param] = kept;
      }
    } else {
      // 空串旗标值视同未给（与 allow-* 收集口径一致）
      if (String(raw) !== "") {
        params[flag.param] = String(raw);
      }
    }
  }
  for (const name of spec.required) {
    if (params[name] === undefined) {
      return {
        ok: false,
        message: `缺少必填参数（--${spec.flags.find((f) => f.param === name)?.flag ?? name}）`,
      };
    }
  }
  for (const group of spec.xor) {
    const given = group.filter((name) => params[name] !== undefined);
    if (given.length !== 1) {
      const flagNames = group
        .map((name) => `--${spec.flags.find((f) => f.param === name)?.flag ?? name}`)
        .join(" / ");
      return { ok: false, message: `${flagNames} 必须恰好给出一个（当前给出 ${given.length} 个）` };
    }
  }
  return { ok: true, params };
}
