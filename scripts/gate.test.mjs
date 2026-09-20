// isGitCommit 判定用例（review2 #5/#6/#7 的回归覆盖）

import assert from "node:assert/strict";
import test from "node:test";
import { isGitCommit } from "./gate.mjs";

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
