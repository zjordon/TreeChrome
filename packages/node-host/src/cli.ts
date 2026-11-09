// tc CLI 的逻辑层（issue #25 M1 + #26 M1.5 + #27 M2）：参数解析（run / skill install /
// daemon / 会话式动作动词）/ 任务文本解析序（stdin 优先，已拍板）/ AgentHistoryList →
// camelCase JSON 投影 / 退出码 / 凭据链（TC_ENV_FILE > ~/.tc/.env > cwd/.env，仅 CLI 面）/
// --auto-chrome 自动拉起 / skill 用法卡分发 / daemon 自起与单命令调用（控制权反转：
// 调用方 LLM 直驱浏览器原语，daemon 内部无 LLM）。IO 一律经 MainDeps 注入（可测）；
// bin/tc.mjs 与 dist 构建入口共用。

import { readFileSync } from "node:fs";
import {
  appendFile as fspAppendFile,
  mkdir as fspMkdir,
  readFile as fspReadFile,
  rm as fspRm,
  writeFile as fspWriteFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { discoverWebSocketUrl } from "@tw/cdp-ws";
import type { AgentHistoryList, AgentSettings } from "@tw/core";
import { runAgent } from "./agent-boot.js";
import { type LaunchedChrome, launchAutoChrome } from "./auto-chrome.js";
import { probeHealth, requestDaemon, stopDaemon } from "./daemon/client.js";
import { type DoctorResult, diagnoseDaemon, parseDaemonInfo } from "./daemon/doctor.js";
import { buildParams, type DaemonEnvelope, daemonPort, findVerb } from "./daemon/protocol.js";
import { PortInUseError, startDaemonServer } from "./daemon/server.js";
import { createDaemonSession } from "./daemon/session-holder.js";
import {
  applyDotEnv,
  type HostSettingsOverrides,
  loadHostSettings,
  resolveEnvChain,
} from "./settings.js";
import { SKILL_CARD } from "./skill-card.js";

export const USAGE = `用法：tc run [task] [选项]                    # 任务级：本仓 LLM 驱动整段 agent loop
      tc skill install [--dir <path>] [--print]
      tc daemon (--status | --stop | --doctor)  # 会话守护进程管理
      tc <动作> [选项]                          # 会话级：你的 LLM 直驱浏览器原语（#27）

任务文本解析序（run）：--task-file > stdin（管道）> 位置参数；三者皆无报用法错。

run 选项：
  --json            机器输出：stdout 只出终态 JSON（camelCase），过程日志全走 stderr
  --task-file <p>   从文件读任务文本（UTF-8，显式覆盖 stdin/argv）
  --max-steps <n>   覆盖单 run 步数预算（正整数；护栏之一）
  --allow-write <p> 文件写白名单前缀（可重复；缺省不设 = core 默认全放行）
  --allow-read <p>  文件读白名单前缀（可重复；语义同上）
  --allow-upload <p> 上传文件白名单前缀（可重复；语义同上）
  --auto-chrome     CDP 不通时自动拉起临时 headless Chrome（run 结束回收；显式
                    CDP_WS_URL 时为 no-op——调用方自管连接）
  --keep-chrome     保留 --auto-chrome 拉起的实例不回收（调试用）
  -h, --help        显示本帮助
  -v, --version     显示版本

skill 选项：
  install           安装用法卡（缺省 → ~/.claude/skills/tc/SKILL.md）
  --dir <path>      自定义安装目录
  --print           用法卡打到 stdout（供管道进任意 agent 配置，不写文件）

daemon 选项（单例：127.0.0.1，缺省端口 9780 / TC_DAEMON_PORT；首次动作自动拉起，
空闲 15 分钟自动回收 / TC_DAEMON_IDLE_SECS<=0 关闭；并发调用按 FIFO 串行）：
  --status          查运行态（pid/端口/空闲计时）
  --stop            优雅关停（自拉 Chrome 一并按 PID 树回收）
  --doctor          诊断三类故障（Chrome 没起 / daemon 僵死 / 端口占用）并给动作
  --daemon-port <n> 覆盖端口（动作动词同用）

会话式动作（15 动词；stdout 恒单 JSON。index 类动作前先 get_state 刷新元素索引）：
  get_state                                   # elementTreeText（核心供给物）+ url/title/tabs
  navigate --url <u> [--new-tab]
  click (--index N | --element-id N)          # 二选一
  input_text (--index N | --element-id N) --text <t> [--no-clear]  # 缺省先清空再输入
  select_dropdown --index N (--value v | --values v1 --values v2)   # 单选/多选二选一
  scroll [--direction up|down] [--amount 1-10]
  find_text --text <t> [--nth N] [--case-sensitive] [--highlight box|selection|none]
  read_grid [--namespace ns] [--search kw] [--sorting "字段 desc"] [--page N]
            [--page-size N] [--fields f1] [--fields f2] [--no-fresh] [--group-count f]
  evaluate --code <js> [--no-await] [--timeout-ms N] [--user-gesture]
  screenshot [--save-path <file>] [--format png|jpeg|webp] [--quality 0-100] [--full-page]
            # 不给 --save-path 只回字节数回执（不落盘不回传图片）；相对路径按调用方 CWD 解析
  upload_file --index N --path <file>         # 相对路径按调用方 CWD 解析为绝对路径
  go_back
  tabs                                        # 列表 + 当前 attached tab
  switch_tab --tab-id <id后4位>
  close_tab [--tab-id <id后4位>]              # 缺省关当前 tab

示例：
  echo "帮我到 example.com 查 …" | tc run --json --auto-chrome
  tc run "打开 example.com 并把标题告诉我"
  tc skill install
  tc navigate --url https://example.com && tc get_state
  tc click --index 12 && tc input_text --index 8 --text "关键词"

退出码：run/动作 0 = 成功；1 = 跑完/执行但未成功（stdout 仍出 JSON，看 error 字段）；
2 = 用法/前置失败（参数错、daemon 拉起失败、Chrome 不可达）。

凭据（run/daemon）：环境变量 > TC_ENV_FILE > ~/.tc/.env > cwd/.env（逐键先到先得）。
ZHIPU_API_KEY（run 必需）、LLM_MODEL / LLM_BASE_URL / LLM_MAX_TOKENS / FALLBACK_LLM_* /
CDP_HOST / CDP_PORT / CDP_WS_URL / CHROME_PATH / TC_DAEMON_PORT / AGENT_*。
会话式 upload 不设白名单（调用方 agent 即信任边界；run 面护栏不变）。详见本包 README。`;

export interface CliArgs {
  command: "run" | "skill-install" | "daemon" | "action";
  /** 位置参数拼出的任务文本（仅 run；空 → null） */
  task: string | null;
  json: boolean;
  taskFile: string | null;
  maxSteps: number | null;
  /** 文件面白名单前缀（可重复旗标收集；null = 未设 → core 默认放行） */
  allowedWrite: string[] | null;
  allowedRead: string[] | null;
  allowedUpload: string[] | null;
  autoChrome: boolean;
  keepChrome: boolean;
  /** skill install --dir（null = 缺省 ~/.claude/skills/tc） */
  skillDir: string | null;
  /** skill install --print：用法卡出 stdout（不写文件） */
  skillPrint: boolean;
  /** daemon 子命令模式（--serve 为内部自起入口，不进帮助） */
  daemonMode: "status" | "stop" | "doctor" | "serve" | null;
  /** --daemon-port（动作与 daemon 子命令共用；null = TC_DAEMON_PORT 或 9780） */
  daemonPortFlag: number | null;
  /** 会话式动作动词（command === "action" 时非 null） */
  actionVerb: string | null;
  /** 动作参数（buildParams 产物；空参数动词为 {}） */
  actionParams: Record<string, unknown> | null;
  help: boolean;
  version: boolean;
}

export type ParseResult = { ok: true; args: CliArgs } | { ok: false; message: string };

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
        "auto-chrome": { type: "boolean", default: false },
        "keep-chrome": { type: "boolean", default: false },
        dir: { type: "string" },
        print: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
        // ── daemon / 会话式动词（#27）──
        "daemon-port": { type: "string" },
        status: { type: "boolean", default: false },
        stop: { type: "boolean", default: false },
        doctor: { type: "boolean", default: false },
        serve: { type: "boolean", default: false },
        url: { type: "string" },
        "new-tab": { type: "boolean", default: false },
        index: { type: "string" },
        "element-id": { type: "string" },
        text: { type: "string" },
        "no-clear": { type: "boolean", default: false },
        direction: { type: "string" },
        amount: { type: "string" },
        "tab-id": { type: "string" },
        value: { type: "string" },
        values: { type: "string", multiple: true },
        nth: { type: "string" },
        "case-sensitive": { type: "boolean", default: false },
        highlight: { type: "string" },
        namespace: { type: "string" },
        search: { type: "string" },
        sorting: { type: "string" },
        "page-size": { type: "string" },
        page: { type: "string" },
        fields: { type: "string", multiple: true },
        "no-fresh": { type: "boolean", default: false },
        "group-count": { type: "string" },
        code: { type: "string" },
        "no-await": { type: "boolean", default: false },
        "timeout-ms": { type: "string" },
        "user-gesture": { type: "boolean", default: false },
        format: { type: "string" },
        quality: { type: "string" },
        "full-page": { type: "boolean", default: false },
        "save-path": { type: "string" },
        path: { type: "string" },
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
  const rawSkillDir = parsed.values.dir;
  const rawDaemonPort = parsed.values["daemon-port"];
  const flags: CliArgs = {
    command: "run",
    task: null,
    json: parsed.values.json === true,
    taskFile: typeof rawTaskFile === "string" && rawTaskFile !== "" ? rawTaskFile : null,
    maxSteps: null,
    allowedWrite: multi("allow-write"),
    allowedRead: multi("allow-read"),
    allowedUpload: multi("allow-upload"),
    autoChrome: parsed.values["auto-chrome"] === true,
    keepChrome: parsed.values["keep-chrome"] === true,
    skillDir: typeof rawSkillDir === "string" && rawSkillDir !== "" ? rawSkillDir : null,
    skillPrint: parsed.values.print === true,
    daemonMode: null,
    daemonPortFlag: null,
    actionVerb: null,
    actionParams: null,
    help: parsed.values.help === true,
    version: parsed.values.version === true,
  };
  if (flags.help || flags.version) {
    return { ok: true, args: flags };
  }
  if (rawDaemonPort !== undefined) {
    const n = Number(rawDaemonPort);
    if (!Number.isInteger(n) || n <= 0 || n >= 65536) {
      return { ok: false, message: `--daemon-port "${rawDaemonPort}" 非法（需 1-65535 整数）` };
    }
    flags.daemonPortFlag = n;
  }
  const positionals = parsed.positionals as string[];
  if (positionals.length === 0) {
    return { ok: false, message: "缺少子命令（支持 run / skill install / daemon / 会话动作）" };
  }
  if (positionals[0] === "skill") {
    if (positionals[1] !== "install" || positionals.length > 2) {
      return { ok: false, message: 'skill 子命令当前仅支持 "tc skill install"' };
    }
    flags.command = "skill-install";
    return { ok: true, args: flags };
  }
  if (positionals[0] === "daemon") {
    const modes = ["status", "stop", "doctor", "serve"].filter((m) => parsed.values[m] === true);
    if (modes.length !== 1) {
      return {
        ok: false,
        message: "tc daemon 需要恰好一个模式旗标（--status / --stop / --doctor）",
      };
    }
    if (positionals.length > 1) {
      return { ok: false, message: "tc daemon 不接受位置参数" };
    }
    flags.command = "daemon";
    flags.daemonMode = modes[0] as CliArgs["daemonMode"];
    return { ok: true, args: flags };
  }
  const verb = findVerb(positionals[0]);
  if (verb !== null) {
    if (positionals.length > 1) {
      return { ok: false, message: `动作 ${verb.verb} 不接受位置参数（参数走旗标）` };
    }
    const built = buildParams(verb, parsed.values);
    if (!built.ok) {
      return { ok: false, message: built.message };
    }
    flags.command = "action";
    flags.actionVerb = verb.verb;
    flags.actionParams = built.params;
    return { ok: true, args: flags };
  }
  if (positionals[0] !== "run") {
    return {
      ok: false,
      message: `未知子命令 "${positionals[0]}"（支持 run / skill install / daemon / 会话动作如 get_state）`,
    };
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
  /** env 对象（缺省 process.env；凭据链与 settings 装载都从这里读） */
  env?: Record<string, string | undefined>;
  /** home 目录（缺省 os.homedir；skill install 缺省目标用） */
  home?: () => string;
  /** 凭据链应用（缺省 applyDotEnv chain 模式；测试注入捕获） */
  applyEnv?: (paths: string[]) => void;
  /** CDP 发现（缺省 cdp-ws discoverWebSocketUrl） */
  discover?: (host: string, port: number) => Promise<string>;
  /** --auto-chrome 拉起（缺省 auto-chrome.ts launchAutoChrome） */
  launch?: typeof launchAutoChrome;
  /** skill install 写盘（缺省 node:fs/promises） */
  ensureDir?: (dir: string) => Promise<void>;
  writeFile?: (path: string, content: string) => Promise<void>;
  // ── #27 会话式（缺省真 HTTP/spawn；测试注入假件）──
  /** 动作单命令调用（缺省 requestDaemon：不可达自动拉起重试） */
  daemonCall?: (
    port: number,
    action: string,
    params: Record<string, unknown>,
  ) => Promise<DaemonEnvelope>;
  /** /health 探测（daemon --status） */
  daemonHealth?: (port: number) => Promise<Record<string, unknown> | null>;
  /** /shutdown（daemon --stop） */
  daemonStopFn?: (port: number) => Promise<{ stopped: boolean; wasRunning: boolean }>;
  /** doctor 诊断（daemon --doctor） */
  daemonDoctor?: () => Promise<DoctorResult>;
  /** serve 模式日志追加（缺省 appendFile ~/.tc/daemon/daemon.log） */
  appendLog?: (line: string) => void;
  /** serve 模式 daemon.json 写/删（缺省 node:fs/promises） */
  writeInfo?: (path: string, content: string) => Promise<void>;
  removeFile?: (path: string) => Promise<void>;
  /** serve 模式 daemon server 工厂（缺省 startDaemonServer；测试注入） */
  startServer?: typeof startDaemonServer;
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
 * CLI 主流程：parse → help/version → skill install → 凭据链 → 任务文本解析序 →
 * （--auto-chrome：确保 CDP 可达）→ runAgent → 按模式输出。
 * --json 模式下把 runAgent 的 log 注入为 stderr 写入——stdout 只留终态 JSON。
 * run 抛错（缺 key、连不上 Chrome 的 Python 同款文案）→ stderr + exit 2。
 * 返回退出码（bin 侧置 process.exitCode）。
 */
export async function main(deps: MainDeps = {}): Promise<number> {
  const argv = deps.argv ?? process.argv.slice(2);
  const stdin = deps.stdin ?? defaultStdin();
  const readFile = deps.readFile ?? ((path) => fspReadFile(path, "utf8"));
  const out = deps.out ?? ((line) => process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line) => process.stderr.write(`${line}\n`));
  const run = deps.run ?? runAgent;
  const version = deps.version ?? "unknown";
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir;

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

  if (args.command === "skill-install") {
    if (args.skillPrint) {
      out(SKILL_CARD.trimEnd());
      return 0;
    }
    const dir = args.skillDir ?? join(home(), ".claude", "skills", "tc");
    const target = join(dir, "SKILL.md");
    const ensureDir = deps.ensureDir ?? ((d) => fspMkdir(d, { recursive: true }));
    const writeFile = deps.writeFile ?? ((p, c) => fspWriteFile(p, c, "utf8"));
    try {
      await ensureDir(dir);
      await writeFile(target, SKILL_CARD);
    } catch (e) {
      err(`[tc] skill 安装失败（${target}）：${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
    err(`已安装用法卡 → ${target}`);
    return 0;
  }

  // 凭据链（issue #26 D1，已拍板仅 CLI 面；runAgent 缺省单文件行为不变）：
  // TC_ENV_FILE > ~/.tc/.env > cwd/.env，逐键先到先得；OS env 恒最高
  const applyEnv = deps.applyEnv ?? ((paths: string[]) => applyDotEnv(env, paths, { chain: true }));
  const clientDeps = { env, log: (m: string) => err(m) };
  const daemonCall =
    deps.daemonCall ?? ((port, action, params) => requestDaemon(port, action, params, clientDeps));
  const daemonHealth =
    deps.daemonHealth ?? ((port) => probeHealth(globalThis.fetch.bind(globalThis), port));
  const daemonStopFn = deps.daemonStopFn ?? ((port) => stopDaemon(port, clientDeps));
  const daemonInfoPath = () => join(home(), ".tc", "daemon", "daemon.json");
  const daemonDoctor =
    deps.daemonDoctor ??
    (() =>
      diagnoseDaemon({
        ...clientDeps,
        // 读 serve 面写入的运行态（daemon.json 僵死诊断依赖）；不存在/坏文件 → null
        //（评审轮 1 [6][7]：此前生产路径从未注入 readInfo，僵死诊断不可达）
        readInfo: () => {
          try {
            return parseDaemonInfo(readFileSync(daemonInfoPath(), "utf8"));
          } catch {
            return null;
          }
        },
      }));
  const portOf = (flag: number | null): number => flag ?? daemonPort(env);

  // ── daemon 子命令（#27）：管理面 ─────────────────────────────────────────
  if (args.command === "daemon") {
    // 凭据链先于端口计算：TC_DAEMON_PORT 可写在 .env 链（USAGE 已把它列入凭据链键），
    // status/stop/serve/doctor 四模式与动作面解析必须一致（评审轮 1 [3]）；显式
    // --daemon-port 覆盖时写入 env——doctor 面内部从 env 取端口
    applyEnv(resolveEnvChain(env));
    if (args.daemonPortFlag !== null) {
      env.TC_DAEMON_PORT = String(args.daemonPortFlag);
    }
    const port = portOf(args.daemonPortFlag);
    if (args.daemonMode === "serve") {
      return serveDaemon({ deps, env, port, err, home });
    }
    if (args.daemonMode === "status") {
      const health = await daemonHealth(port);
      out(
        JSON.stringify(
          health === null
            ? {
                running: false,
                port,
                hint: "未运行；下一次动作命令会自动拉起（tc daemon --doctor 诊断）",
              }
            : { running: true, port, ...health },
        ),
      );
      return 0;
    }
    if (args.daemonMode === "stop") {
      const r = await daemonStopFn(port);
      out(JSON.stringify(r));
      if (!r.wasRunning) {
        err("[tc] daemon 未在运行");
      }
      return 0;
    }
    // doctor（凭据链已在分支顶部应用）
    const result = await daemonDoctor();
    out(JSON.stringify(result));
    for (const f of result.findings) {
      if (f.status !== "ok" && f.hint !== null) {
        err(`[doctor] ${f.name}: ${f.hint}`);
      }
    }
    return 0;
  }

  // ── 会话式动作（#27）：单命令单 JSON；不可达自动拉起 daemon ────────────────
  if (args.command === "action" && args.actionVerb !== null) {
    applyEnv(resolveEnvChain(env));
    const port = portOf(args.daemonPortFlag);
    const params = { ...(args.actionParams ?? {}) };
    // upload_file / screenshot 相对路径按调用方 CWD 解析（daemon 的 CWD 可能不同）
    if (typeof params.path === "string" && params.path !== "") {
      params.path = resolve(params.path);
    }
    if (typeof params.save_path === "string" && params.save_path !== "") {
      params.save_path = resolve(params.save_path);
    }
    const envelope = await daemonCall(port, args.actionVerb, params);
    if (envelope.ok) {
      const data = envelope.data as { error?: string | null };
      out(JSON.stringify(envelope.data));
      return data.error != null ? 1 : 0;
    }
    err(`[tc] ${envelope.error ?? "daemon 调用失败"}`);
    return envelope.kind === "exec" ? 1 : 2;
  }

  applyEnv(resolveEnvChain(env));

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

  // --auto-chrome（issue #26 D2）：无显式 CDP 目标时先发现；不通则拉起临时 headless
  // Chrome 并把解析出的 wsUrl 显式传 runAgent（runAgent 零改动）；显式 CDP_WS_URL
  // = 调用方自管连接，旗标 no-op。拉起的实例在 finally 按树回收（--keep-chrome 除外）。
  const discover = deps.discover ?? discoverWebSocketUrl;
  const launch = deps.launch ?? launchAutoChrome;
  let wsUrl: string | undefined;
  let chrome: LaunchedChrome | null = null;
  const browser = loadHostSettings(env).browser;
  if (args.autoChrome && browser.wsUrl === null) {
    try {
      wsUrl = await discover(browser.cdpHost, browser.cdpPort);
    } catch {
      try {
        chrome = await launch({ port: browser.cdpPort, log: (m) => err(m) });
      } catch (e) {
        err(`[tc] ${e instanceof Error ? e.message : String(e)}`);
        return 2;
      }
      try {
        wsUrl = await discover(browser.cdpHost, browser.cdpPort);
      } catch (e) {
        await chrome.stop((m) => err(m));
        err(`[tc] Chrome 拉起后 CDP 仍不可达：${e instanceof Error ? e.message : String(e)}`);
        return 2;
      }
    }
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
    const history = await run({ task: resolution.task, console: true, log, overrides, wsUrl });
    if (args.json) {
      out(JSON.stringify(projectRunJson(history)));
    } else {
      out(renderHumanResult(history));
    }
    return exitCodeOf(history);
  } catch (e) {
    err(`[tc] ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  } finally {
    if (chrome !== null && !args.keepChrome) {
      await chrome.stop((m) => err(m));
    }
  }
}

/**
 * daemon --serve（#27 内部自起入口，不进帮助）：日志 append ~/.tc/daemon/daemon.log、
 * daemon.json 运行态写/删、startDaemonServer 惰性会话；SIGTERM/SIGINT 优雅关停。
 * 端口已被占（daemon 已在运行）按幂等成功收口 exit 0。本函数常驻不返回直至信号。
 */
async function serveDaemon(options: {
  deps: MainDeps;
  env: Record<string, string | undefined>;
  port: number;
  err: (line: string) => void;
  home: () => string;
}): Promise<number> {
  const { deps, env, port, err, home } = options;
  const dir = join(home(), ".tc", "daemon");
  const infoPath = join(dir, "daemon.json");
  const ensureDir = deps.ensureDir ?? ((d) => fspMkdir(d, { recursive: true }));
  const writeInfo = deps.writeInfo ?? ((p, c) => fspWriteFile(p, c, "utf8"));
  const removeFile = deps.removeFile ?? ((p) => fspRm(p, { force: true }));
  const appendLog =
    deps.appendLog ??
    ((line) => fspAppendFile(join(dir, "daemon.log"), `${line}\n`, "utf8").catch(() => {}));
  try {
    await ensureDir(dir);
  } catch (e) {
    err(`[tc] daemon 目录创建失败（${dir}）：${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const log = (m: string) => {
    void appendLog(m);
  };
  const startServer = deps.startServer ?? startDaemonServer;
  let daemon: Awaited<ReturnType<typeof startServer>>;
  try {
    daemon = await startServer({
      env,
      port,
      log,
      makeSession: () => createDaemonSession({ env, log }),
      writeInfo: (info) => {
        void writeInfo(infoPath, JSON.stringify(info)).catch(() => {});
      },
      clearInfo: () => {
        void removeFile(infoPath).catch(() => {});
      },
    });
  } catch (e) {
    if (e instanceof PortInUseError) {
      log(`[daemon] ${e.message}——已有实例在跑，本次自起按幂等成功退出`);
      err(`[tc] daemon 已在运行（${e.message}）`);
      return 0;
    }
    err(`[tc] daemon 启动失败：${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  // 常驻：监听 socket 持住事件循环；SIGTERM/SIGINT → 优雅关停（会话 + 自拉 Chrome）
  const exitCode = await new Promise<number>((resolve) => {
    const finish = () => resolve(0);
    process.once("SIGTERM", finish);
    process.once("SIGINT", finish);
  });
  await daemon.close();
  return exitCode;
}
