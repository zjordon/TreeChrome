// tc CLI 的逻辑层（issue #25 M1）：参数解析 / 任务文本解析序（stdin 优先，已拍板）/
// AgentHistoryList → camelCase JSON 投影 / 退出码。IO 一律经 MainDeps 注入（可测），
// bin/tc.mjs 只做 esbuild 引导薄壳。已拍板决策：AutoAllow 直用（runAgent 缺省）、
// --json 键形 camelCase、包位 @tw/node-host、stdin > argv（--task-file 显式覆盖）。

import { readFile as fspReadFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { AgentHistoryList, AgentSettings } from "@tw/core";
import { runAgent } from "./agent-boot.js";
import type { HostSettingsOverrides } from "./settings.js";

export const USAGE = `用法：tc run [task] [选项]

任务文本解析序：--task-file > stdin（管道）> 位置参数；三者皆无报用法错。

选项：
  --json            机器输出：stdout 只出终态 JSON（camelCase），过程日志全走 stderr
  --task-file <p>   从文件读任务文本（UTF-8，显式覆盖 stdin/argv）
  --max-steps <n>   覆盖单 run 步数预算（正整数；护栏之一）
  --allow-write <p> 文件写白名单前缀（可重复；缺省不设 = core 默认全放行）
  --allow-read <p>  文件读白名单前缀（可重复；语义同上）
  --allow-upload <p> 上传文件白名单前缀（可重复；语义同上）
  -h, --help        显示本帮助
  -v, --version     显示版本

示例：
  echo "帮我到 example.com 查 …" | tc run --json
  tc run "打开 example.com 并把标题告诉我"

退出码：0 = done 且成功；1 = 跑完但未成功；2 = 用法/前置失败（参数错、任务文本空、
缺 key、连不上 Chrome）。

环境（cwd/.env 同名键亦可）：ZHIPU_API_KEY（必需）、LLM_MODEL / LLM_BASE_URL /
LLM_MAX_TOKENS / FALLBACK_LLM_* / CDP_HOST / CDP_PORT / CDP_WS_URL / AGENT_* /
AGENT_SKILLS_DIR。Chrome 需以 --remote-debugging-port=9222 运行。详见本包 README。`;

export interface CliArgs {
  /** 位置参数拼出的任务文本（空 → null） */
  task: string | null;
  json: boolean;
  taskFile: string | null;
  maxSteps: number | null;
  /** 文件面白名单前缀（可重复旗标收集；null = 未设 → core 默认放行） */
  allowedWrite: string[] | null;
  allowedRead: string[] | null;
  allowedUpload: string[] | null;
  help: boolean;
  version: boolean;
}

export type ParseResult = { ok: true; args: CliArgs } | { ok: false; message: string };

const SUBCOMMAND = "run";

/** argv → CliArgs（util.parseArgs strict 封装；help/version 先于子命令校验生效） */
export function parseCliArgs(argv: string[]): ParseResult {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        json: { type: "boolean", default: false },
        "task-file": { type: "string" },
        "max-steps": { type: "string" },
        "allow-write": { type: "string", multiple: true },
        "allow-read": { type: "string", multiple: true },
        "allow-upload": { type: "string", multiple: true },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    return { ok: false, message: `参数错误：${e instanceof Error ? e.message : String(e)}` };
  }
  const multi = (key: "allow-write" | "allow-read" | "allow-upload"): string[] | null => {
    const values = parsed.values[key];
    if (!Array.isArray(values) || values.length === 0) {
      return null;
    }
    const kept = values.filter((v): v is string => typeof v === "string" && v !== "");
    return kept.length > 0 ? kept : null;
  };
  const rawTaskFile = parsed.values["task-file"];
  const flags: CliArgs = {
    task: null,
    json: parsed.values.json === true,
    taskFile: typeof rawTaskFile === "string" && rawTaskFile !== "" ? rawTaskFile : null,
    maxSteps: null,
    allowedWrite: multi("allow-write"),
    allowedRead: multi("allow-read"),
    allowedUpload: multi("allow-upload"),
    help: parsed.values.help === true,
    version: parsed.values.version === true,
  };
  if (flags.help || flags.version) {
    return { ok: true, args: flags };
  }
  const positionals = parsed.positionals as string[];
  if (positionals.length === 0) {
    return { ok: false, message: `缺少子命令（当前仅支持 "${SUBCOMMAND}"）` };
  }
  if (positionals[0] !== SUBCOMMAND) {
    return { ok: false, message: `未知子命令 "${positionals[0]}"（当前仅支持 "${SUBCOMMAND}"）` };
  }
  const rawSteps = parsed.values["max-steps"];
  if (rawSteps !== undefined) {
    const n = Number(rawSteps);
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, message: `--max-steps "${rawSteps}" 非法（需正整数）` };
    }
    flags.maxSteps = n;
  }
  if (positionals.length > 1) {
    flags.task = positionals.slice(1).join(" ");
  }
  return { ok: true, args: flags };
}

export interface TaskTextInputs {
  /** --task-file 已读出的内容（读失败在 main 层拦截为 exit 2；null = 未用该通道） */
  taskFileContent: string | null;
  /** stdin 全文（TTY 下为 null——不读防挂起）；空串表示管道给了空输入 */
  stdinText: string | null;
  argvTask: string | null;
}

export type TaskTextResolution =
  | { ok: true; task: string; source: "task-file" | "stdin" | "argv" }
  | { ok: false };

/** 任务文本解析序（已拍板「stdin 优先」：stdin > argv；--task-file 显式覆盖）。
 *  三通道都 trim（echo/heredoc 尾换行不进任务文本）；空白等价于未提供。 */
export function resolveTaskText(inputs: TaskTextInputs): TaskTextResolution {
  if (inputs.taskFileContent !== null) {
    const task = inputs.taskFileContent.trim();
    return task !== "" ? { ok: true, task, source: "task-file" } : { ok: false };
  }
  if (inputs.stdinText !== null) {
    const task = inputs.stdinText.trim();
    if (task !== "") {
      return { ok: true, task, source: "stdin" };
    }
  }
  if (inputs.argvTask !== null) {
    const task = inputs.argvTask.trim();
    if (task !== "") {
      return { ok: true, task, source: "argv" };
    }
  }
  return { ok: false };
}

export interface RunJson {
  isDone: boolean;
  isSuccessful: boolean;
  finalResult: string | null;
  stopReason: string | null;
  nSteps: number;
  finalizeDegradedSteps: number;
  /** done 步附件路径（去重保序） */
  attachments: string[];
  /** 各步非空 error 全收集（含权限拒绝文案——对调用方是有用信号） */
  errors: string[];
  /** 末个携带 url 的步（stateSummary.url；无步带 url 时 null） */
  lastUrl: string | null;
}

/** AgentHistoryList → --json 终态投影（camelCase，已拍板；评测 snake_case 轨迹层不混入） */
export function projectRunJson(history: AgentHistoryList): RunJson {
  const attachments: string[] = [];
  const errors: string[] = [];
  let lastUrl: string | null = null;
  for (const step of history.history) {
    for (const r of step.result) {
      if (r.isDone && r.attachments !== null) {
        for (const a of r.attachments) {
          if (!attachments.includes(a)) {
            attachments.push(a);
          }
        }
      }
      if (r.error !== null && r.error !== "") {
        errors.push(r.error);
      }
    }
    const url = step.stateSummary?.url;
    if (typeof url === "string" && url !== "") {
      lastUrl = url;
    }
  }
  return {
    isDone: history.isDone(),
    isSuccessful: history.isSuccessful(),
    finalResult: history.finalResult(),
    stopReason: history.stopReason,
    nSteps: history.history.length,
    finalizeDegradedSteps: history.finalizeDegradedSteps,
    attachments,
    errors,
    lastUrl,
  };
}

/** 退出码（issue #25 契约）：0 = done 且成功；1 = 跑完但未成功 */
export function exitCodeOf(history: AgentHistoryList): number {
  return history.isDone() && history.isSuccessful() ? 0 : 1;
}

/** 人类模式终态行（文案对齐 examples/basic-agent.mjs） */
export function renderHumanResult(history: AgentHistoryList): string {
  if (history.isDone()) {
    if (history.isSuccessful()) {
      return `Task completed: ${history.finalResult() ?? ""}`;
    }
    const errors = projectRunJson(history).errors;
    const cause = history.finalResult() ?? errors[errors.length - 1] ?? "done with success=false";
    return `Task failed: ${cause}`;
  }
  const stop = history.stopReason !== null ? ` (${history.stopReason})` : "";
  return `Task did not complete${stop}`;
}

export interface MainDeps {
  argv?: string[];
  stdin?: { isTTY: boolean; text: () => Promise<string> };
  readFile?: (path: string) => Promise<string>;
  out?: (line: string) => void;
  err?: (line: string) => void;
  run?: typeof runAgent;
  version?: string;
}

const defaultStdin = (): { isTTY: boolean; text: () => Promise<string> } => ({
  isTTY: process.stdin.isTTY === true,
  text: () =>
    new Promise((resolve, reject) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk: string) => {
        data += chunk;
      });
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", reject);
    }),
});

/**
 * CLI 主流程：parse → help/version → 任务文本解析序 → runAgent → 按模式输出。
 * --json 模式下把 runAgent 的 log 注入为 stderr 写入——assembleAgent/attachConsole/
 * LLMClient/权限门汇总全部经该 sink，stdout 只留终态 JSON。run 抛错（缺 key、连不上
 * Chrome 的 Python 同款文案）→ stderr + exit 2。返回退出码（bin 侧置 process.exitCode）。
 */
export async function main(deps: MainDeps = {}): Promise<number> {
  const argv = deps.argv ?? process.argv.slice(2);
  const stdin = deps.stdin ?? defaultStdin();
  const readFile = deps.readFile ?? ((path) => fspReadFile(path, "utf8"));
  const out = deps.out ?? ((line) => process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line) => process.stderr.write(`${line}\n`));
  const run = deps.run ?? runAgent;
  const version = deps.version ?? "unknown";

  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    err(`[tc] ${parsed.message}`);
    err(USAGE);
    return 2;
  }
  const { args } = parsed;
  if (args.help) {
    out(USAGE);
    return 0;
  }
  if (args.version) {
    out(version);
    return 0;
  }

  let taskFileContent: string | null = null;
  if (args.taskFile !== null) {
    try {
      taskFileContent = await readFile(args.taskFile);
    } catch (e) {
      err(
        `[tc] --task-file 读取失败（${args.taskFile}）：${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return 2;
    }
  }
  // --task-file 已就绪则跳过 stdin 读取：spawn 场景 stdin 管道可能永不关闭，无条件
  // 读会永久挂起（评审轮 1 [1]）；「stdin 优先」只在 stdin 与 argv 之间裁决。
  // stdin 读取失败（管道异常/坏 fd）按前置失败收口为 exit 2（评审轮 1 [2]）——
  // 未处理拒绝会崩成 exit 1，被调用方误读为「跑完但未成功」。
  let stdinText: string | null = null;
  if (!stdin.isTTY && taskFileContent === null) {
    try {
      stdinText = await stdin.text();
    } catch (e) {
      err(`[tc] stdin 读取失败：${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
  }
  const resolution = resolveTaskText({ taskFileContent, stdinText, argvTask: args.task });
  if (!resolution.ok) {
    err("[tc] 未提供任务文本——stdin 管道、位置参数、--task-file 至少其一：");
    err('  echo "帮我到 …" | tc run');
    err(USAGE);
    return 2;
  }

  // 护栏透传（已拍板：AutoAllow 直用，文件面走既有白名单 settings 键）：CLI 旗标 →
  // overrides.agent（与 examples 的 runAgent overrides 同面）；未设旗标 = core 默认
  const agent: Partial<AgentSettings> = {};
  if (args.maxSteps !== null) {
    agent.maxSteps = args.maxSteps;
  }
  if (args.allowedWrite !== null) {
    agent.allowedWritePaths = args.allowedWrite;
  }
  if (args.allowedRead !== null) {
    agent.allowedReadPaths = args.allowedRead;
  }
  if (args.allowedUpload !== null) {
    agent.allowedUploadPaths = args.allowedUpload;
  }
  const overrides: HostSettingsOverrides | undefined =
    Object.keys(agent).length > 0 ? { agent } : undefined;
  // --json：stdout 只留给终态 JSON——过程日志（agent/browser/llm/event/权限门汇总）
  // 经 runAgent 的 log 注入全走 stderr；人类模式 log 传 undefined（runAgent 缺省 stdout）
  const log = args.json ? (message: string) => err(message) : undefined;

  try {
    const history = await run({ task: resolution.task, console: true, log, overrides });
    if (args.json) {
      out(JSON.stringify(projectRunJson(history)));
    } else {
      out(renderHumanResult(history));
    }
    return exitCodeOf(history);
  } catch (e) {
    err(`[tc] ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}
