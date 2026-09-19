---
description: issue 收尾四步——更新 issue 状态、创建关联 PR、合并、删除分支（先展示计划，确认后执行写操作）
argument-hint: "<issue 编号，例如 12>"
allowed-tools: Bash(git:*), Bash(gh:*), Bash(node:*), Bash(pnpm:*), Read, Edit, Write, Grep, Glob
---

# Issue 收尾（评论 + PR + 合并 + 删分支）

帮用户完成 issue 的 4 步收尾流程：

1. 更新 issue 状态（发总结评论）
2. 创建关联 PR（提交 + 推送 + 建 PR，`Fixes #<N>`）
3. 合并 PR（squash，仓库惯例）
4. 删除当前分支（本地 + 远端）

**严格遵守"先展示完整计划、等用户确认、再执行写操作"**——与本项目「不主动提交」约定、`/release` 命令一致。合并与删分支是对外、难逆转的操作，宁可多确认一次。

## 参数

用户输入：$ARGUMENTS = issue 编号（如 `12`）。**必填**；缺失或非数字则停下让用户补。

## 第 0 步：前置检查（只读，可立即执行）

- `gh auth status`：gh 已登录，否则停下提示 `gh auth login`。
- 当前分支：**必须在 issue 的工作分支上**（分支名通常含 issue 号，如 `fix/12-...` / `feat/...`），**不能在 `main`**。在 main 上则停下——收尾前先切到工作分支。
- `git remote -v`：有 `origin`，否则停下。
- issue：`gh issue view <N>` 确认存在且 open。
- 改动范围：`git log main..HEAD`（已提交的）+ `git status -s`（未提交的）+ `git diff`，据此撰写 commit/PR/评论。
- **排查临时文件**：工作区若有 `_*.txt`/`_*.json`/`_*.mjs` 等脚本/草稿（生成 PR JSON、commit message 用的），**不能进提交**——稍后 `git add` 时显式排除或先删。

## 第 1 步：草拟内容（写操作前，先想好再动）

基于改动撰写（中文，遵循项目 conventional commit + 现有 issue/PR 措辞惯例）：

- **commit message**：`<type>(<scope>): <主题> (#<N>)` + 正文要点。type 取 `fix`/`feat`/`docs`/`chore` 等（看改动性质），scope 可用包名（如 `dom-snapshot`）。若已全部提交则跳过 commit。
- **issue 总结评论**：简述本分支做了什么（可分点：根因/修复/验证），指向相关文档与测试，注明验证状态（若测试未跑或 golden fixture 未更新要写明）。
- **PR 标题**：同 commit 主题（含 `(#<N>)`）。
- **PR body**：开头 `Fixes #<N>`（合并自动关 issue）+ 背景/改动/验证，指向总结文档（若有）。

## 第 2 步：展示计划，等用户确认

向用户列出并**明确请求确认**，未确认前不做任何写操作：

1. issue 号、当前分支名、base 分支（main）
2. 将提交的文件清单（**标注已排除临时文件/测试产物**）
3. commit message 主题（若需提交）
4. PR 标题 + issue 评论要点
5. 即将执行的命令序列（按第 3 步）

## 第 3 步：确认后按序执行（任一步失败立即停下报告）

### 1) 更新 issue 状态——发总结评论

用 Write 工具生成 UTF-8 JSON（body 即评论），或 `node -e "..."` + `JSON.stringify`（不会转义非 ASCII）；然后：

```
gh api --method POST repos/:owner/:repo/issues/<N>/comments --input <comment.json> -q .html_url
```

### 2) 创建关联 PR

- **暂存**：`git add` 应提交的文件（显式列文件；若用 `git add -A`，先确认 `.gitignore` 已排除 `node_modules/`/`dist/`/`coverage/`/`test/fixtures/_tmp/` 等产物，且工作区无临时文件残留——**临时文件绝不能进提交**）。
- **提交**（若有未提交改动）：commit message 写 UTF-8 文件（Write 工具），`git commit -F <msgfile>`。
- **推送**：`git push -u origin <branch>`。
- **建 PR**：标题+body 写 UTF-8 JSON（`{"title":..., "body":..., "head":"<branch>", "base":"main"}`），

  ```
  gh api --method POST repos/:owner/:repo/pulls --input <pr.json> -q '"#\(.number) \(.html_url)"'
  ```

  **不要用 `gh pr create --title "中文"`**——中文标题经 PowerShell 会乱码（实战踩坑）。body 里写 `Fixes #<N>`。
- **清理**：删除本次产生的所有临时文件（`_*.txt`/`_*.json`/`_*.mjs`）。

### 3) 合并 PR

```
gh pr merge <PR号> --squash --delete-branch
```

squash 为仓库惯例；`--delete-branch` 顺带删远端分支、切回 main。

### 4) 删除分支

上一步 `--delete-branch` 已删本地+远端并切回 main，**无需**额外 `git branch -D` / `git push origin --delete`。

## 第 4 步：验证 + 报告

- `gh pr view <PR号> --json state` → `MERGED`
- `gh issue view <N> --json state` → `CLOSED`（`Fixes #<N>` 合并时自动关闭）
- `git branch --show-current` → `main`；`git branch` 无工作分支残留；`git ls-remote --heads origin <branch>` → 空
- 报告里显式提醒任何遗留（如 typecheck/test 未跑、golden fixture 待更新等）。

## 关键坑（来自实战 memory `gh-pr-powershell-pitfalls`，必读）

- **中文标题/body 必须走 `gh api --input` + UTF-8 JSON 文件**（Write 工具写 / `node -e` + `JSON.stringify`）。`gh pr create --title`、`gh issue edit --title` 经 PowerShell 会乱码。
- **commit message 中文用 `git commit -F <UTF-8 文件>`**，不要 `-m "中文"`。
- **临时文件写仓库内路径**（别用 `$env:TEMP`——非交互环境可能为空→坏路径→`--input` 静默失败）；用完即删，且**绝不** `git add` 进提交（若误进，未推送前 `git rm --cached` + `git commit --amend --no-edit` 剔除）。
- **`gh`/`git` 的 NativeCommandError 红字多为假错误**——看实际 stdout / 退出码判断成败。
- **分支名含 `#` 是 PowerShell 注释符**：传给 gh/git 时双引号包裹，或直接用 gh api（本流程分支名一般无 `#`，留意即可）。
- **`--delete-branch` 已含本地+远端删除 + 切回 main**，别重复删。
