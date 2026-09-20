// isGitCommit / matchStagedForbidden / parseStatus / gitSegmentHasFlag / gitAddIsBroad 判定用例
// （评审二/四/五轮修复的回归覆盖）
import assert from "node:assert/strict";
import test from "node:test";
import {
  gitAddIsBroad,
  gitSegmentHasFlag,
  isGitCommit,
  matchStagedForbidden,
  parseStatus,
} from "./gate.mjs";

test("识别基础与全局选项变体", () => {
  assert.equal(isGitCommit("git commit -m x"), true);
  assert.equal(isGitCommit('git commit -F "_msg.txt"'), true);
  assert.equal(isGitCommit("git -C /d/dev/repo commit -m x"), true); // 带参选项 -C
  assert.equal(isGitCommit("git --git-dir=/x/.git commit"), true); // --opt=value 内联
  assert.equal(isGitCommit("git --no-pager commit"), true); // 纯标志不得吞掉子命令
  assert.equal(isGitCommit("git -c core.autocrlf=false commit"), true);
});

test("识别 shell 组合/包装形态（旧正则兜底）", () => {
  assert.equal(isGitCommit("cd packages/x && git commit -m y"), true);
  assert.equal(isGitCommit("pnpm test && git commit || echo fail"), true);
  assert.equal(isGitCommit('sh -c "git commit -m z"'), true);
  assert.equal(isGitCommit("git add -A; git commit -m w"), true);
});

test("非 commit 命令不误判（首个非选项 token 即子命令）", () => {
  assert.equal(isGitCommit("git stash push -m 'commit'"), false); // commit 仅是参数
  assert.equal(isGitCommit("git branch commit"), false);
  assert.equal(isGitCommit("git status"), false);
  assert.equal(isGitCommit("git add -A"), false);
  assert.equal(isGitCommit("pnpm test"), false);
  assert.equal(isGitCommit("node scripts/gate.mjs pre-commit"), false);
  assert.equal(isGitCommit(""), false);
});

test(".env 系列拦截口径（评审四轮 #5 的回归覆盖）", () => {
  const blocked = [
    ".env",
    "packages/x/.env",
    ".env.local",
    ".env.production",
    ".env.local.bak", // 多段后缀
    ".envrc", // direnv
    "apps/y/.envrc",
  ];
  for (const f of blocked) {
    assert.ok(matchStagedForbidden(f), `应拦截: ${f}`);
  }
  assert.equal(matchStagedForbidden(".env.example"), undefined); // 白名单例外
  assert.equal(matchStagedForbidden(".environment-notes.md"), undefined); // 前缀相同但非密钥
  assert.equal(matchStagedForbidden("src/env-loader.ts"), undefined);
  // 临时文件与产物口径回归
  assert.ok(matchStagedForbidden("_draft.json"));
  assert.ok(matchStagedForbidden("packages/x/dist/main.js"));
});

test("parseStatus：剥状态列/去引号/剔目录项/重命名取新路径", () => {
  const out = [
    " M packages/a.ts",
    "?? _new.md",
    '?? "path with space.txt"',
    "!! .env",
    "!! node_modules/",
    "R  old-name.ts -> new-name.ts",
  ].join("\n");
  assert.deepEqual(parseStatus(out), [
    { status: "M", path: "packages/a.ts" },
    { status: "??", path: "_new.md" },
    { status: "??", path: "path with space.txt" },
    { status: "!!", path: ".env" },
    { status: "R", path: "new-name.ts" },
  ]);
});

test("gitSegmentHasFlag：段级收窄 + 合并短参 + 长参前缀（评审五轮 #4/#5）", () => {
  const force = (s) => gitSegmentHasFlag(s, "add", ["f"], "--force");
  const noVerify = (s) => gitSegmentHasFlag(s, "commit", ["n"], "--no-verify");
  // 无关命令的 -f 不误命中（rm -f / tail -f / git push --force）
  assert.equal(force("rm -f tmp && git commit -m x"), false);
  assert.equal(force("tail -f log && git commit -m x"), false);
  assert.equal(force("git push --force && git commit -m x"), false);
  // add 段内的 force 命中（含合并短参 -Af）
  assert.equal(force("git add -f .env && git commit -m x"), true);
  assert.equal(force("git add -Af .env && git commit -m x"), true);
  assert.equal(force("git add --force .env"), true);
  // commit 段的 --no-verify 命中（含 -nm 合并短参、--no-ver 前缀）
  assert.equal(noVerify("git commit -nm x"), true);
  assert.equal(noVerify("git commit --no-ver"), true);
  assert.equal(noVerify("git commit --no-verify -m x"), true);
  // 无关段的 -n 不误命中
  assert.equal(noVerify("git commit -m x && echo -n done"), false);
});

test("gitAddIsBroad：-u 不是广域暂存（评审五轮 #11）", () => {
  assert.equal(gitAddIsBroad("git add -A && git commit"), true);
  assert.equal(gitAddIsBroad("git add . && git commit"), true);
  assert.equal(gitAddIsBroad("git add ./src && git commit"), true);
  assert.equal(gitAddIsBroad("git add -Au && git commit"), true);
  assert.equal(gitAddIsBroad("git add -u && git commit"), false); // 只更新已跟踪条目
  assert.equal(gitAddIsBroad("git add packages && git commit"), false);
});
