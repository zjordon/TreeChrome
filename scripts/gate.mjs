#!/usr/bin/env node
/**
 * 共用门禁脚本 —— 被 ZCode hooks（.zcode/config.json）与 git pre-commit
 * （.githooks/pre-commit）共用，也可手动执行。
 *
 * 子命令：
 *   boundaries   架构铁律：核心包 src 禁 chrome.* / process.* / ambient env
 *   staged       暂存区检查：临时文件、密钥、产物不得入库
 *   size         设计规范：单源文件 ≤ 3000 行（>1000 行提醒）
 *   quality      biome + pnpm -r typecheck + test:coverage（覆盖率阈值在 vitest.config 强制）
 *   pre-commit   staged + boundaries + size + quality（git 提交完整门）
 *   hook-commit  ZCode PreToolUse(Bash) 模式：stdin 读工具调用，非 git commit 直接放行
 *   hook-edit    ZCode PostToolUse(Edit|Write) 模式：对被改的核心包文件跑 boundaries + 行数
 *
 * 退出码：0 通过；2 拦截（stderr 给原因）；1 内部错误。
 */
import { execSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath(new URL(...)) 而非 import.meta.dirname：后者 Node >= 20.11 才有，
// 低版本在模块顶层抛 TypeError 且 hook 上下文 exit 1 不阻断（评审四轮 #10）
const REPO = fileURLToPath(new URL("..", import.meta.url));
const exit = (code, msg) => {
  if (msg) process.stderr.write(`[gate] ${msg}\n`);
  process.exit(code);
};
const ok = (msg) => console.log(`[gate] ${msg}`);

// ── 架构铁律：核心包边界 ────────────────────────────────────────────────

const CORE_PACKAGES = ["dom-snapshot", "core"]; // core 尚未建立，先行占位
// 禁止模式：任何形式的 chrome 模块导入（含 type 导入，类型依赖同样耦合）、
// process 导入与 process.env 读取。globalThis.crypto/TextEncoder 等 Web 标准不受限。
const FORBIDDEN = [
  { re: /["']chrome["']/, msg: '禁止 import "chrome"（chrome.* 只能出现在 cdp-chrome 适配包）' },
  {
    re: /["']node:process["']|[^:\w]process\.env\b/,
    msg: "禁止 process / process.env（核心包禁 ambient env，配置显式传入）",
  },
];

// ── 设计规范：单文件行数硬门槛 ─────────────────────────────────────────

const MAX_FILE_LINES = 3000; // 硬门槛：超过强制重构（AGENTS.md 设计规范）
const WARN_FILE_LINES = 1000; // 软提醒：接近巨石化，建议按职责拆分

function countLines(path) {
  return readFileSync(path, "utf8").split("\n").length;
}

function checkFileSizes(paths) {
  const over = [];
  const warn = [];
  for (const p of paths) {
    const n = countLines(p);
    if (n > MAX_FILE_LINES) over.push(`${p}: ${n} 行`);
    else if (n > WARN_FILE_LINES) warn.push(`${p}: ${n} 行`);
  }
  if (over.length) {
    exit(
      2,
      `单文件超过 ${MAX_FILE_LINES} 行（巨石文件，强制重构拆分后重试）：\n  ${over.join("\n  ")}`,
    );
  }
  if (warn.length) {
    process.stderr.write(
      `[gate] 提醒：以下文件超过 ${WARN_FILE_LINES} 行，建议按职责拆分：\n  ${warn.join("\n  ")}\n`,
    );
  }
  ok(`size 通过（无超过 ${MAX_FILE_LINES} 行的源文件）`);
}

const SRC_EXT = /\.(ts|mts|mjs)$/;

function walkSrc(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walkSrc(p, out);
    else if (SRC_EXT.test(name)) out.push(p);
  }
  return out;
}

function size() {
  const paths = [];
  for (const area of ["packages", "apps"]) {
    const areaDir = join(REPO, area);
    let pkgs = [];
    try {
      pkgs = readdirSync(areaDir);
    } catch {
      continue;
    }
    for (const pkg of pkgs) {
      try {
        paths.push(...walkSrc(join(areaDir, pkg, "src")));
      } catch (e) {
        if (e.code === "ENOENT") continue; // 包尚无 src
        exit(2, `扫描 ${pkg}/src 失败，门禁中止（fail-closed）：${e.message}`);
      }
    }
  }
  try {
    const scriptsDir = join(REPO, "scripts");
    paths.push(
      ...readdirSync(scriptsDir)
        .filter((f) => SRC_EXT.test(f))
        .map((f) => join(scriptsDir, f)),
    );
  } catch {
    // 无 scripts 目录
  }
  checkFileSizes(paths);
}

function scanFile(path) {
  const text = readFileSync(path, "utf8");
  const hits = [];
  for (const { re, msg } of FORBIDDEN) {
    const m = text.match(re);
    if (m) hits.push(`${msg}（命中 "${m[0]}"）`);
  }
  return hits;
}

function boundaries(pkgFilter) {
  const violations = [];
  for (const pkg of CORE_PACKAGES) {
    if (pkgFilter && pkg !== pkgFilter) continue;
    const src = join(REPO, "packages", pkg, "src");
    let files;
    try {
      files = walkSrc(src); // 与 size 同口径（ts|mts|mjs），防扩展名绕过
    } catch (e) {
      if (e.code === "ENOENT") continue; // 包尚未建立
      exit(2, `扫描 ${src} 失败，门禁中止（fail-closed）：${e.message}`);
    }
    for (const f of files) for (const hit of scanFile(f)) violations.push(`${f}: ${hit}`);
  }
  if (violations.length) exit(2, `架构边界违规：\n  ${violations.join("\n  ")}`);
  ok(`boundaries 通过（核心包 src 无 chrome.*/process.* 依赖）`);
}

// ── 暂存区检查 ─────────────────────────────────────────────────────────

const STAGED_FORBIDDEN = [
  { re: /(^|\/)_.*\.(txt|json|mjs|py|md)$/, msg: "临时文件（_ 前缀草稿）" },
  // (^|\/) 锚定任意层级；结尾锚定 + rc 形态 + 多段后缀（.env.local.bak），
  // 例外 .env.example（.gitignore 的 !.env.example 允许入库，两处规则须一致）
  { re: /(^|\/)\.env(rc)?(\.(?!example\b)[\w.-]+)?$/, msg: "环境变量/密钥文件" },
  { re: /(^|\/)(node_modules|coverage|dist)\//, msg: "构建/测试产物" },
  { re: /(^|\/)coverage-final\.json$/, msg: "覆盖率产物" },
];

/** 单个路径是否命中禁入库规则（导出供 gate.test.mjs 表驱动覆盖） */
export function matchStagedForbidden(f) {
  return STAGED_FORBIDDEN.find(({ re }) => re.test(f))?.msg;
}

/** 解析 git status --porcelain 输出为 {status, path}（目录项剔除；导出供测试） */
export function parseStatus(out) {
  return String(out)
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const status = l.slice(0, 2).trim();
      const raw = l.slice(3).trim();
      // R/C 在 porcelain 的 index 列（首字符）：组合状态 RM/RD（重命名后工作区
      // 又改/删）同样要箭头切分取新路径；其余状态的文件名可能天然含箭头，不切
      const path =
        status.startsWith("R") || status.startsWith("C")
          ? raw
              .split(" -> ")
              .map((s) => s.trim().replace(/^"|"$/g, ""))
              .pop()
          : raw.replace(/^"|"$/g, "");
      return { status, path };
    })
    .filter((e) => e.path !== "" && !e.path.endsWith("/"));
}

function stagedFiles() {
  try {
    return execSync("git diff --cached --name-only", { cwd: REPO, encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    // fail-closed：读不到暂存区（非 git 仓库/git 不可用）必须中止，不能当"空"放行
    exit(
      2,
      `读取暂存区失败（git diff --cached 异常），门禁中止（hook 上下文须 exit 2 才阻断）：${e.message}`,
    );
  }
}

function staged() {
  const files = stagedFiles();
  if (files.length === 0) {
    ok("暂存区为空，跳过 staged 检查");
    return;
  }
  const violations = [];
  for (const f of files) {
    const msg = matchStagedForbidden(f);
    if (msg) violations.push(`${f}: ${msg}`);
  }
  if (violations.length) exit(2, `暂存区包含不应提交的文件：\n  ${violations.join("\n  ")}`);
  ok(`staged 通过（${files.length} 个文件）`);
}

// ── 质量：类型检查 + 测试覆盖率 ─────────────────────────────────────────

function run(cmd) {
  const r = spawnSync(cmd, {
    cwd: REPO,
    shell: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    process.stderr.write(r.stdout || "");
    process.stderr.write(r.stderr || "");
    exit(2, `${cmd} 失败（退出码 ${r.status}）——修到全绿再提交`);
  }
}

function quality() {
  run("pnpm exec biome check .");
  run("pnpm run test:gate"); // 与 package.json 脚本同源，避免命令双份漂移
  run("pnpm -r run typecheck");
  run("pnpm -r run test:coverage");
  ok("quality 通过（biome + gate 单测 + typecheck + 测试 + 覆盖率阈值）");
}

// ── ZCode hook 模式（stdin 读工具调用 JSON） ────────────────────────────

function readHookInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch (e) {
    // fail-closed：hook 输入不可解析时中止，不能当"非目标命令"放行
    exit(2, `解析 hook stdin 失败，门禁中止（hook 上下文须 exit 2 才阻断）：${e.message}`);
  }
}

/** git 全局选项：带参数（需跳过下一 token）与纯标志分开处理，混在一个集合会误吞子命令 */
const GIT_OPTS_WITH_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const GIT_OPTS_FLAG_ONLY = new Set([
  "-P",
  "--no-pager",
  "--literal-pathspecs",
  "--no-optional-locks",
]);

/** 单段命令是否为 git commit 子命令 */
function segmentIsGitCommit(segment) {
  const tokens = tokenize(segment);
  const head = tokens[0];
  if (!head || !GIT_TOKEN_RE.test(head)) return false;
  const ci = gitSubcommandIndex(tokens, 0);
  return ci !== -1 && tokens[ci] === "commit";
}

/**
 * 判断命令串是否含 git commit。按 shell 分隔符（&&/||/;/|）切段逐段判定；
 * 保留旧正则兜底覆盖包装形态（cd x && git commit / sh -c "git commit"）——
 * 误报方向只是多跑一次门禁（fail-closed），漏报即绕过。
 */
export function isGitCommit(cmd) {
  const s = String(cmd);
  // 兜底正则与 GIT_TOKEN_RE 同口径认 .exe，否则 git.exe commit 走不进任何检查
  if (/\bgit(\.exe)?\s+commit\b/.test(s)) return true;
  return shellSegments(s).some(segmentIsGitCommit);
}

/**
 * 双引号内保留转义语义的四个后继字符（POSIX 2.2.3，实测验证）；
 * `\<LF>` 在双引号内同样是行续接，仅单引号内是字面两字符。
 */
const DQ_ESCAPABLE = new Set(['"', "\\", "$", "`"]);

/**
 * 引号感知分词（状态机）+ 按 shell 拼接语义去除引号与转义，即 git 收到的 argv：
 * - 引号内（含空格/分隔符）保持单 token：`-m "use -f"` 的消息是 argv 的一个
 *   元素，不构成标志；未闭合引号按"引号直到串尾"处理（shell 语法错误形态，
 *   保守起见内容不再散成裸 token——评审十一轮 #1 的实测反例：`"…; rm -rf`
 *   中的 -rf 会被误判 force）；
 * - 词内引号拼接（`"comm"it` = commit、`--forc""` = --forc）天然并回同一
 *   token；空引号 `""` 产生空串 token 保留 argv 占位（`-C ""` 按位消耗）；
 * - 单引号仅在 token 起点视为引号定界：`don't` 里的撇号是字面字符，不得
 *   开启引号态吞掉后续 token（如 `-m don't -n` 的 -n 须仍可见）；
 * - 反斜杠转义（非单引号态）：`\"` 是字面引号字符，不开合引号态、不切分
 *   ——否则 `git log \" ; git add -A` 会被吞成单段重开时间差盲区（十二轮 #2）。
 */
const tokenize = (s) => {
  const out = [];
  let cur = "";
  let hasTok = false;
  let q = "";
  let esc = false;
  // 行续接（\ + 换行）前置整体剔除：引号外与双引号内两字符确实整体消失（POSIX
  // 双引号内反斜杠仅对 $ ` " \ LF 保留特殊含义，跟 LF 即续接）；单引号内是字面
  // 两字符，此处一并剔除——只缩短 token 内容、不改变分词与分段（LF 在引号内
  // 本就不是分隔符，剔除也不跨引号边界），且真实 argv 含 \+LF 的 token 不构成
  // 任何 git 标志/子命令，剔除后至多更"像标志"，偏差方向 fail-closed。
  // 必须前置——若在 esc 分支丢换行，hasTok 已被 \ 置位，会 push 出空串
  // token 顶占子命令位（十三轮 #4：`git \<LF> commit -n` 的子命令成了 "\n"）
  const str = String(s).replace(/\\\r?\n/g, "");
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (esc) {
      cur += ch; // \x → 字面 x，不触发引号开合/分词
      esc = false;
      continue;
    }
    if (ch === "\\" && q !== "'") {
      // POSIX：双引号内仅 \" \\ \$ \` 有转义语义，其余反斜杠是字面字符
      // （十三轮 #2："\c" 的 argv 是 \c 两字符，剥掉反斜杠会让 token 比
      // 真实 argv 更"像标志"）；引号外 \x 一律字面化
      if (q === '"' && !DQ_ESCAPABLE.has(str[i + 1] ?? "")) {
        cur += ch;
      } else {
        esc = true;
      }
      hasTok = true;
      continue;
    }
    if (q) {
      if (ch === q) q = "";
      else cur += ch;
    } else if (ch === '"' || (ch === "'" && !hasTok)) {
      q = ch;
      hasTok = true; // 空引号也构成 argv 占位 token
    } else if (/\s/.test(ch)) {
      if (hasTok) out.push(cur);
      cur = "";
      hasTok = false;
    } else {
      cur += ch;
      hasTok = true;
    }
  }
  if (hasTok) out.push(cur);
  return out;
};

/**
 * shell 段切分：&&/||/;/| 分隔符与换行；引号内的分隔符不切——
 * `-m "docs; git add -A"` 的消息含分号不得产生幻影段（评审十轮 #1）。
 * 状态机实现而非正则：未闭合引号（shell 语法错误，但 agent 会写出来）按
 * "引号直到串尾"处理，不再在引号内切段（评审十一轮 #1 的残余盲区）。
 * 反斜杠转义（非单引号态）：`\"` 是字面引号，不开合引号态、不切分——
 * 否则 `git log \" ; git add -A` 被吞成单段，时间差盲区重开（十二轮 #1）。
 */
const shellSegments = (s) => {
  const str = String(s);
  const segs = [];
  let cur = "";
  let q = ""; // 当前引号状态
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const two = str.slice(i, i + 2);
    if (q === "'") {
      cur += ch; // 单引号内无转义语义，反斜杠是字面字符
      if (ch === q) q = "";
    } else if (ch === "\\" && i + 1 < str.length) {
      cur += two; // \" / \' / \; 等：转义消费下一字符
      i++;
    } else if (q) {
      cur += ch;
      if (ch === q) q = "";
    } else if (ch === '"' || ch === "'") {
      cur += ch;
      q = ch;
    } else if (two === "&&" || two === "||") {
      segs.push(cur);
      cur = "";
      i++;
    } else if (ch === ";" || ch === "|" || ch === "\n") {
      segs.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  segs.push(cur);
  return segs;
};

/** git 可执行 token 形态：裸 git / 带路径 / Windows git.exe */
const GIT_TOKEN_RE = /(^|\/)git(\.exe)?$/;

/** 子命令级带参选项：其参数（如 -m 的消息）不参与标志扫描（评审十轮 #2） */
const NO_OPTS_WITH_ARG = new Set(); // 共享空集合，避免每段每次调用新建（十二轮 #4）
const SUB_OPTS_WITH_ARG = new Map([
  [
    "commit",
    new Set([
      "-m",
      "--message",
      "-F",
      "--file",
      "-t",
      "--template",
      "-c",
      "--reedit-message",
      "-C",
      "--reuse-message",
      "--author",
      "--date",
      "--fixup",
      "--squash",
      "--trailer",
    ]),
  ],
]);

/**
 * git 形态 token 之后的首个非全局选项 token 下标（即子命令位置）；无则 -1。
 * 覆盖：带参选项（-C <dir>）、参数粘连（-Cdir）、纯标志、--opt=value 内联。
 * segmentIsGitCommit 与 forGitSub 共用本 helper——两处循环曾各自漂移致
 * git -C.. commit 整体漏判（评审八轮 #1）。tokens 须为 tokenize 产物（引号已剥）。
 */
function gitSubcommandIndex(tokens, gitIdx) {
  for (let i = gitIdx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (GIT_OPTS_WITH_ARG.has(t)) {
      i++; // 跳过带参选项的参数
      continue;
    }
    if (/^-[Cc]\S/.test(t) || GIT_OPTS_FLAG_ONLY.has(t) || /^--[\w-]+=/.test(t)) continue;
    return i;
  }
  return -1;
}

/**
 * 在子命令命中的段上回调 {flags, args}：flags 为子命令后到 "--" 为止的选项 token
 * （其后是 pathspec），args 为子命令后全部 token（含 "--" 之后的 pathspec）。
 * 子命令定位复用 gitSubcommandIndex；子命令级带参选项（-m 等）的参数不进
 * flags——`git commit -m "-n"` 的消息恰为标志串时不误判（评审十轮 #2）。
 * 回调返回 true 则整体返回 true。
 */
function forGitSub(cmd, subs, fn) {
  for (const seg of shellSegments(cmd)) {
    const tokens = tokenize(seg);
    const gitIdx = tokens.findIndex((t) => GIT_TOKEN_RE.test(t));
    if (gitIdx === -1) continue;
    const cmdIdx = gitSubcommandIndex(tokens, gitIdx);
    if (cmdIdx === -1 || !subs.includes(tokens[cmdIdx])) continue;
    const withArg = SUB_OPTS_WITH_ARG.get(tokens[cmdIdx]) ?? NO_OPTS_WITH_ARG;
    const tail = tokens.slice(cmdIdx + 1);
    const flags = [];
    for (let i = 0; i < tail.length; i++) {
      const t = tail[i];
      // 未被按位消耗的 "--" 才是选项区终点；作为带参选项实参的 "--"
      //（git get_arg 不特判 -m -- 的消息就是 "--"）由下方 i++ 消耗，
      // 否则 git commit -m -- -n 的 -n 会漏检（十三轮 #1）
      if (t === "--") break;
      // 短标志簇的 getopt 语义（十二轮 #5）：首个带参字母消耗其后所有字符——
      // 有剩余字符是粘连值形态（-mminor/-Fn：值已内联，不消耗下一 token）；
      // 带参字母居簇末（-nm/-am：前缀是标志，值取下一 token）；
      // 单字母恰为带参选项（-m）走通用路径（push + 消耗下一 token）
      const glued = t.match(/^-([a-zA-Z]+)$/);
      if (glued) {
        const letters = glued[1];
        const argIdx = [...letters].findIndex((c) => withArg.has(`-${c}`));
        if (argIdx >= 0 && argIdx < letters.length - 1) {
          if (argIdx > 0) flags.push(`-${letters.slice(0, argIdx)}`);
          continue; // 粘连值形态：字母后即参数值
        }
        if (argIdx === letters.length - 1 && letters.length > 1) {
          if (argIdx > 0) flags.push(`-${letters.slice(0, argIdx)}`);
          i++; // 簇末带参字母：值取下一 token
          continue;
        }
      }
      flags.push(t);
      if (withArg.has(t)) i++; // 跳过子命令级带参选项的参数
    }
    if (fn(flags, tail)) return true;
  }
  return false;
}

/** add 的内建同义词：stage 与 add 同口径检测 */
const ADD_SUBS = ["add", "stage"];

/**
 * git add/stage 所在段是否带指定标志：短参合并（-Af）与长参唯一前缀（--forc）都识别。
 * 长参前缀匹配只接受 "--" 开头且非裸 "--"（分隔符）的 token，防 "--all".startsWith("--") 误报。
 * 段级收窄使无关命令的 -f（rm -f / tail -f / git push --force）不误命中。
 */
export function gitSegmentHasFlag(cmd, subs, shortChars, longFull) {
  return forGitSub(cmd, subs, (flags) =>
    flags.some(
      (t) =>
        (t.startsWith("--") && t !== "--" && (t.startsWith(longFull) || longFull.startsWith(t))) ||
        (/^-\w+$/.test(t) && [...t.slice(1)].some((c) => shortChars.includes(c))),
    ),
  );
}

/**
 * git add/stage 是否广域暂存：-A/--all 与 `.`,`..`,`./`,`../`,`:/`（仓库根 magic）
 * pathspec 会把未跟踪文件卷进 index。注意 -u/--update 只更新已跟踪条目
 * （git 语义 adds no new files），不计入。
 */
export function gitAddIsBroad(cmd) {
  return (
    gitSegmentHasFlag(cmd, ADD_SUBS, ["A"], "--all") ||
    forGitSub(cmd, ADD_SUBS, (_flags, args) =>
      args.some(
        (t) =>
          t === "." ||
          t === ".." ||
          t.startsWith("./") ||
          t.startsWith("../") ||
          t.startsWith(":/"),
      ),
    )
  );
}

/**
 * 时间差盲区预检：`git add -f .env && git commit` 在 PreToolUse 时刻 index 仍空，
 * staged() 看不到这条命令将要暂存的文件。hookCommit 命中 commit 后无条件调用本预检
 * （git -C <dir> add 等变体不再依赖窄正则识别）；--ignored 仅在命令含 -f/--force 时
 * 启用——普通 add 摸不到被忽略文件，而本地 .env 常态存在，无条件 --ignored 会
 * 拦下一切常规提交。git pre-commit 钩子是最终兜底。
 */
function worktreePrecheck(cmd) {
  // tokenize 已按 shell 拼接语义剥引号：无关命令的 -f 不误启用 --ignored，
  // 合并短参 -Af 不漏检，引号包裹的消息文本不构成标志
  const usesForce = gitSegmentHasFlag(cmd, ADD_SUBS, ["f"], "--force");
  const broadAdd = gitAddIsBroad(cmd);
  let out;
  try {
    out = execSync(`git status --porcelain${usesForce ? " --ignored" : ""}`, {
      cwd: REPO,
      encoding: "utf8",
    });
  } catch (e) {
    exit(2, `git status 失败，门禁中止（hook 上下文须 exit 2 才阻断）：${e.message}`);
  }
  const violations = [];
  for (const { status, path } of parseStatus(out)) {
    // 未跟踪文件仅广域 add 能卷入；被忽略条目只在 usesForce 扫描时出现，恰是 -f 能强加的时刻
    if (status === "??" && !broadAdd) continue;
    if (status === "!!" && !usesForce) continue;
    const msg = matchStagedForbidden(path);
    if (msg) violations.push(`${path}: ${msg}`);
  }
  if (violations.length) {
    exit(2, `命令将提交的工作区含禁入库文件（时间差预检）：\n  ${violations.join("\n  ")}`);
  }
}

function fullGate() {
  staged();
  boundaries();
  size();
  quality();
}

function hookCommit() {
  const input = readHookInput();
  const cmd = input?.tool_input?.command ?? "";
  if (!isGitCommit(cmd)) process.exit(0); // 非 commit 命令，放行
  // --no-verify/-n（含 -nm 合并短参、--no-ver 前缀）会跳过 pre-commit 这道最终兜底
  if (gitSegmentHasFlag(cmd, ["commit"], ["n"], "--no-verify")) {
    exit(2, "git commit 带 --no-verify/-n 会跳过 pre-commit 兜底，门禁拦截");
  }
  worktreePrecheck(cmd);
  fullGate();
}

/** 核心包 src 路径识别正则：从 CORE_PACKAGES 动态构造，避免双份硬编码漂移 */
const CORE_SRC_RE = new RegExp(
  String.raw`[\\/]packages[\\/](${CORE_PACKAGES.join("|")})[\\/]src[\\/].*\.(ts|mts|mjs)$`,
);

function hookEdit() {
  const input = readHookInput();
  const path = input?.tool_input?.file_path ?? input?.tool_input?.path ?? "";
  if (!CORE_SRC_RE.test(String(path))) process.exit(0);
  const violations = scanFile(String(path).replaceAll("\\", "/"));
  if (violations.length) exit(2, `${path}:\n  ${violations.join("\n  ")}`);
  const lines = countLines(String(path));
  if (lines > MAX_FILE_LINES) {
    exit(2, `${path} 已达 ${lines} 行（> ${MAX_FILE_LINES}）：巨石文件，强制重构拆分`);
  }
  process.exit(0);
}

// ── 入口（仅直接执行时运行；被测试 import 时不触发门禁） ────────────────
// 两侧都取 realpath：ESM 加载器对模块做符号链接规范化，argv[1] 不解析时
// 严格相等可能失配 → 门禁整体静默跳过（评审四轮 #7）
const invokedAsMain =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedAsMain) {
  const mode = process.argv[2] ?? "pre-commit";
  switch (mode) {
    case "boundaries":
      boundaries();
      break;
    case "staged":
      staged();
      break;
    case "size":
      size();
      break;
    case "quality":
      quality();
      break;
    case "pre-commit":
      fullGate();
      break;
    case "hook-commit":
      hookCommit();
      break;
    case "hook-edit":
      hookEdit();
      break;
    default:
      exit(1, `未知子命令：${mode}`);
  }
}
