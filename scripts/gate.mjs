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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
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
      } catch {
        // 包尚无 src，跳过
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

function walkTs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walkTs(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
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
      files = walkTs(src);
    } catch {
      continue; // 包尚未建立
    }
    for (const f of files) for (const hit of scanFile(f)) violations.push(`${f}: ${hit}`);
  }
  if (violations.length) exit(2, `架构边界违规：\n  ${violations.join("\n  ")}`);
  ok(`boundaries 通过（核心包 src 无 chrome.*/process.* 依赖）`);
}

// ── 暂存区检查 ─────────────────────────────────────────────────────────

const STAGED_FORBIDDEN = [
  { re: /(^|\/)_.*\.(txt|json|mjs|py|md)$/, msg: "临时文件（_ 前缀草稿）" },
  { re: /^\.env/, msg: "环境变量/密钥文件" },
  { re: /^(node_modules|coverage|dist)\//, msg: "构建/测试产物" },
  { re: /(^|\/)coverage-final\.json$/, msg: "覆盖率产物" },
];

function stagedFiles() {
  try {
    return execSync("git diff --cached --name-only", { cwd: REPO, encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
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
    for (const { re, msg } of STAGED_FORBIDDEN) {
      if (re.test(f)) violations.push(`${f}: ${msg}`);
    }
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
  run("pnpm -r run typecheck");
  run("pnpm -r run test:coverage");
  ok("quality 通过（biome + typecheck + 测试 + 覆盖率阈值）");
}

// ── ZCode hook 模式（stdin 读工具调用 JSON） ────────────────────────────

function readHookInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function hookCommit() {
  const input = readHookInput();
  const cmd = input?.tool_input?.command ?? "";
  if (!/\bgit\s+commit\b/.test(cmd)) process.exit(0); // 非 commit 命令，放行
  staged();
  boundaries();
  quality();
}

function hookEdit() {
  const input = readHookInput();
  const path = input?.tool_input?.file_path ?? input?.tool_input?.path ?? "";
  const m = /[\\/]packages[\\/](dom-snapshot|core)[\\/]src[\\/].*\.ts$/.exec(String(path));
  if (!m) process.exit(0);
  const violations = scanFile(String(path).replaceAll("\\", "/"));
  if (violations.length) exit(2, `${path}:\n  ${violations.join("\n  ")}`);
  const lines = countLines(String(path));
  if (lines > MAX_FILE_LINES) {
    exit(2, `${path} 已达 ${lines} 行（> ${MAX_FILE_LINES}）：巨石文件，强制重构拆分`);
  }
  process.exit(0);
}

// ── 入口 ───────────────────────────────────────────────────────────────

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
    staged();
    boundaries();
    size();
    quality();
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
