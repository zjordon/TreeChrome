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

test("git.exe / 带路径形态在生产入口可达（评审七轮 #3 回归）", () => {
  assert.equal(isGitCommit("git.exe commit -m x"), true);
  assert.equal(isGitCommit("/usr/bin/git commit -m x"), true);
  assert.equal(isGitCommit("cd x && git.exe commit -m y"), true);
  assert.equal(isGitCommit("git.exe status"), false);
});

test("gitSegmentHasFlag / gitAddIsBroad：-C 粘连参数（评审七轮 #2）", () => {
  const force = (s) => gitSegmentHasFlag(s, ["add", "stage"], ["f"], "--force");
  const noVerify = (s) => gitSegmentHasFlag(s, ["commit"], ["n"], "--no-verify");
  // -C 参数粘连形式：子命令定位不得被 "-Csub" 吞掉
  assert.equal(force("git -C.. add -f .env && git commit -m x"), true);
  assert.equal(force("git -Csub add -f .env"), true);
  assert.equal(gitAddIsBroad("git -Csub add -A"), true);
  assert.equal(noVerify("git -C.. commit -n"), true);
  assert.equal(force("git -C.. add packages"), false);
});

test("引号感知分词（评审八轮 #1/#2 + 九轮 #1/#3 的根治口径）", () => {
  const force = (s) => gitSegmentHasFlag(s, ["add", "stage"], ["f"], "--force");
  const noVerify = (s) => gitSegmentHasFlag(s, ["commit"], ["n"], "--no-verify");
  // -C 粘连 / 带引号参数：子命令定位不被吞（八轮回归）
  assert.equal(isGitCommit("git -C.. commit -m x"), true);
  assert.equal(isGitCommit("git.exe -C.. commit -m x"), true);
  assert.equal(isGitCommit('git -C "d 1" commit -m x'), true);
  assert.equal(force('git -C ".." add -f .env && git commit -m x'), true);
  assert.equal(force('git -C ".." add packages'), false);
  // 引号包子命令：shell 引号不改变参数内容，git 收到的就是 commit（九轮 #1）
  assert.equal(isGitCommit('git "commit" -m x'), true);
  assert.equal(isGitCommit("git 'commit' -m x"), true);
  // 空引号与长参前缀粘连：--forc"" 在 shell 中即 --forc（九轮 #3）
  assert.equal(force('git add --forc"" .env && git commit -m x'), true);
  // 消息文本中的标志被引号遮蔽（单 token 含空格，不构成标志）
  assert.equal(noVerify('git commit -m "use -n here"'), false);
  assert.equal(force('git commit -m "add -f" && git push'), false);
  // 空引号保持 argv 占位：-C "" 的参数按位消耗，add 不被吞
  assert.equal(force('git -C "" add -f .env'), true);
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
    "RM old2.ts -> .env", // 组合状态：重命名后工作区又修改（评审七轮 #1）
  ].join("\n");
  assert.deepEqual(parseStatus(out), [
    { status: "M", path: "packages/a.ts" },
    { status: "??", path: "_new.md" },
    { status: "??", path: "path with space.txt" },
    { status: "!!", path: ".env" },
    { status: "R", path: "new-name.ts" },
    { status: "RM", path: ".env" },
  ]);
});

test("gitSegmentHasFlag：段级收窄 + 合并短参 + 长参前缀（评审五轮 #4/#5）", () => {
  const force = (s) => gitSegmentHasFlag(s, ["add", "stage"], ["f"], "--force");
  const noVerify = (s) => gitSegmentHasFlag(s, ["commit"], ["n"], "--no-verify");
  // 无关命令的 -f 不误命中（rm -f / tail -f / git push --force）
  assert.equal(force("rm -f tmp && git commit -m x"), false);
  assert.equal(force("tail -f log && git commit -m x"), false);
  assert.equal(force("git push --force && git commit -m x"), false);
  // 消息文本中的子命令名不误定位（git commit -m add -f 中的 add 是消息）
  assert.equal(force("git commit -m add -f"), false);
  // add/stage 段内的 force 命中（含合并短参 -Af、同义词 stage、带路径的 git.exe）
  assert.equal(force("git add -f .env && git commit -m x"), true);
  assert.equal(force("git add -Af .env && git commit -m x"), true);
  assert.equal(force("git add --force .env"), true);
  assert.equal(force("git stage -f .env && git commit -m x"), true);
  assert.equal(force("/usr/bin/git add -f .env"), true);
  assert.equal(force("git.exe add -f .env"), true);
  // commit 段的 --no-verify 命中（含 -nm 合并短参、--no-ver 前缀）
  assert.equal(noVerify("git commit -nm x"), true);
  assert.equal(noVerify("git commit --no-ver"), true);
  assert.equal(noVerify("git commit --no-verify -m x"), true);
  // 无关段的 -n 不误命中；"--" 分隔符不算长参前缀（评审六轮 #3）
  assert.equal(noVerify("git commit -m x && echo -n done"), false);
  assert.equal(noVerify("git commit -- file"), false);
});

test("gitAddIsBroad：-u 不是广域暂存（评审五轮 #11）；--/../stage 边界（六轮 #1/#2/#3）", () => {
  assert.equal(gitAddIsBroad("git add -A && git commit"), true);
  assert.equal(gitAddIsBroad("git add . && git commit"), true);
  assert.equal(gitAddIsBroad("git add ./src && git commit"), true);
  assert.equal(gitAddIsBroad("git add -Au && git commit"), true);
  assert.equal(gitAddIsBroad("git add .. && git commit"), true); // 子目录卷入父范围
  assert.equal(gitAddIsBroad("git add ../dir && git commit"), true);
  assert.equal(gitAddIsBroad("git add :/ && git commit"), true); // 仓库根 magic pathspec
  assert.equal(gitAddIsBroad("git stage . && git commit"), true); // add 同义词
  assert.equal(gitAddIsBroad("git add -u && git commit"), false); // 只更新已跟踪条目
  assert.equal(gitAddIsBroad("git add packages && git commit"), false);
  assert.equal(gitAddIsBroad("git add -- packages/a.ts && git commit"), false); // -- 后是 pathspec
});
