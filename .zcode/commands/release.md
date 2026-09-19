---
description: 发布 TreeChrome 新版本——整理 changelog、bump 版本号、打 tag、建 GitHub Release（先展示计划，确认后再执行）
argument-hint: "[版本号|auto，例如 v0.1.0；留空则根据提交自动建议]"
allowed-tools: Bash(git:*), Bash(gh:*), Bash(pnpm:*), Read, Edit, Write, Grep, Glob
---

# 发布新版本

你要帮用户发布 TreeChrome 的新版本。**严格遵守"先展示计划、等用户确认、再执行写操作"的原则**——本项目约定不主动提交，任何 tag / commit / push / release 动作都必须在用户明确确认后才执行。

## 参数

用户输入：$ARGUMENTS

- 若为空或 `auto`：根据自上个 tag 以来的提交自动建议版本号
- 若为具体版本号（如 `v0.1.0` 或 `0.1.0`）：以它为目标，但仍需按 SemVer 校验合理性，不合适时提醒用户

## 第一步：收集信息（只读，可立即执行）

并行读取以下信息：

- 当前版本：读根 `package.json` 的 `version`（monorepo 根版本即发布版本；`packages/*` 子包版本如需同步，在计划里单独列出）
- 上个 tag：`git describe --tags --abbrev=0`（若无任何 tag，首个版本建议 `v0.1.0`）
- 自上个 tag 以来的改动：`git log <上个tag>..HEAD`（看完整 commit message，关注 conventional commit 前缀 feat/fix/BREAKING）
- 工作区状态：`git status -s`（必须干净，否则停下提醒用户先处理未提交改动）
- 当前分支：确认在 `main`，且已 `git pull` 到最新
- `gh auth status`：未登录则停下提示 `gh auth login`；`git remote -v` 确认有 `origin`

## 第二步：建议版本号（SemVer）

基于提交前缀判断：

- 含 `BREAKING CHANGE` 或 `feat!:` / `!:` → **MAJOR**（x.0.0）
- 含 `feat:` → **MINOR**（x.y.0）
- 其余 `fix:`/`docs:`/`chore:` 等 → **PATCH**（x.y.z）

给出建议版本号并说明判断依据。

## 第三步：跑发布前验证 + 整理 changelog 草稿

- **验证**：`pnpm typecheck && pnpm test` 必须全绿（任一失败停下，不带病发版）。golden fixture 相关测试若被跳过（fixtures 未生成），在计划里注明。
- 按 `CHANGELOG.md` 的 **Keep a Changelog** 风格生成新版本段落（仓库尚无 CHANGELOG.md 时按该规范初始化，含 Unreleased 段），分类用 `### Added` / `### Fixed` / `### Changed` / `### Docs` 等，参考已有条目的写法和详细程度：

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
- ...

### Fixed
- ...
```

注意：CHANGELOG 里版本号用 `[X.Y.Z]`（不带 v），git tag 用 `vX.Y.Z`（带 v）。

## 第四步：展示完整发布计划，等用户确认

向用户展示以下内容并**明确请求确认**，未确认前不做任何写操作：

1. 新版本号 + 判断依据
2. changelog 段落草稿
3. 即将改动的文件：
   - 根 `package.json`：version 改为 `X.Y.Z`
   - `CHANGELOG.md`：顶部插入新版本段落（或初始化）
   - （如适用）`packages/*/package.json` 的版本同步
4. 即将执行的命令清单：
   - `git add package.json CHANGELOG.md`
   - `git commit -m "chore(release): vX.Y.Z"`（中文正文则 `git commit -F <UTF-8 文件>`）
   - `git tag -a vX.Y.Z -m "Release vX.Y.Z"`
   - `git push origin main`
   - `git push origin vX.Y.Z`
   - `gh release create vX.Y.Z --notes-file <notes.md>`（notes 用 Write 写 UTF-8 文件，用完即删）

## 第五步：确认后执行

用户确认后，**分步执行、每步报告结果**：

1. Edit 根 `package.json` 改 version（及如需的子包同步）
2. Edit `CHANGELOG.md` 插入新段落
3. `git add` + `git commit`
4. `git tag -a vX.Y.Z -m "..."`
5. `git push origin main` 和 `git push origin vX.Y.Z`
6. `gh release create vX.Y.Z --notes-file <notes.md>`，删除临时 notes 文件

任一步失败立即停下，不要继续后续步骤，报告错误让用户决定。

## 约束

- 仅用附注 tag（`git tag -a`），不用轻量 tag
- tag 必须显式 push（`git push` 默认不推 tag，否则 GitHub 看不到）
- **release notes 走 `--notes-file` + UTF-8 文件**（Write 工具写），不要 `--notes "<中文>"`——与 gh 中文标题同源的乱码坑
- 发布是对外、难逆转的操作：宁可多确认一次，不要自作主张
