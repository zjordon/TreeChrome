---
description: 评审-修复自动循环——ocr 跑分支评审、逐条按严重度门控处置意见、修复提交后自动跑下一轮，直到零意见或连续两轮无 P1/P2 收敛（每轮一次修复提交由本命令授权，不 push）
argument-hint: "[背景说明] [--from base] [--to branch] [--max-rounds N]"
allowed-tools: Bash(git:*), Bash(node:*), Bash(pnpm:*), Bash(ocr:*), Bash(which:*), Bash(ls:*), Bash(grep:*), Read, Edit, Write, Grep, Glob, WebSearch, WebFetch
---

# 评审-修复自动循环（ocr review → 处置 → 提交 → 下一轮）

把「人工跑 code review → 把结果文件贴回来 → 修复 → 提交 → 再跑」固化为一轮自动循环。
前置：某计划已在分支上实现完毕（分支创建与实现不在本命令范围）。

## 收敛规则（P2 实测 47 轮不收敛的教训，必读）

**「零意见」不是可达出口**：LLM 评审员对大 diff 的稳态输出是每轮 10-20 条意见，
与代码质量无关——修复本身持续生产新评审面（加一个告警 → 下轮挑它的去重维度/
归因/测试锚定 → 再下轮挑锚定的措辞），标准是弹性的没有不动点。因此本循环的
收敛判据是**严重度门控**而非零意见：

- **P1**（正确性/安全/数据泄露/契约破坏）与 **P2**（可达路径的健壮性、真实现象的
  观测缺失）：实施。
- **P3**（观测对称性、测试锚定、措辞/注释/结构、防御 unreachable 状态）：登记
  backlog 不实施——仅当「改动极小且在当轮已触碰的文件内」可顺手修。
- **连续两轮无 P1/P2 → 宣布收敛终止循环**，P3 backlog 留档，向用户汇报。
- 每轮汇报必须报「P1/P2/P3 分布」而不是只有条数——条数不反映缺陷密度，
  后期条数震荡全是 P3 时就是该停的信号（不要等用户质疑）。

## 参数（$ARGUMENTS）

- 位置参数（若有）：评审背景说明（业务上下文，喂给 `-B`）。缺省则从 `git log --oneline <base>..<branch>` 首提交与分支名推导一段，并向用户复述确认口径。
- `--from <base>`：diff 基线，缺省 `main`。
- `--to <branch>`：目标分支，缺省当前分支；解析后**不得是 base 自身**，否则停下让用户指定。
- `--max-rounds <N>`：轮次安全上限，缺省 10；达到上限时停下汇报并问用户是否续跑（每轮都是真金白银的 LLM 评审，不做无界循环）。

## 前置检查（只读，可立即执行）

0. **续跑/接手检测**（两种形态，都从盘上事实推导，不靠会话记忆）：
   - **状态文件续跑**：`.git/review-loop-state.json` 存在且 `phase != "done"` → 读状态文件，与 `git log --oneline -1` 核对 `lastCommit` 一致后**从记录的轮次续跑**（轮号不重推）；不一致（用户手动动过分支）则向用户确认后重建状态。
   - **孤儿结果收养**（无状态文件或已 done 时必查）：`ls docs/code-review/review-<slug>-*.json` 扫出的结果文件中，凡 **README §7 无「评审轮 N」登记**且 `git log --grep="轮 <N>"` 无对应提交的，即为「已生成未处置」的孤儿（典型：用户手工跑了 ocr 还没贴回来修）。按轮号升序**先处置完所有孤儿**（初始化状态文件 `round=该轮, phase="triaging"`，走第 2 步起的正常流程），全部消化后才进入自动轮转——否则轮号推算（最大号+1）会跳过已付费的评审结果、对着同一分支 tip 重复跑一轮。
1. `which ocr`：不在 PATH 则停（open-code-review fork 需另装）。
2. `git status --short`：工作区必须干净——未提交改动会混进本轮修复提交；不干净则停下让用户先处理。
3. 当前分支与 `--to` 一致（不一致时先 `git checkout` 过去或让用户确认）。
4. `git log --oneline <base>..<branch> -- | head -5`：确认分支上确有待评审的实现。

## 状态持久化与上下文管理（长循环的生存机制）

单轮循环包含 dump 全文阅读 + 多文件编辑 + 测试输出，**连续两轮以上上下文消耗已过半**。循环必须做到「任意时点压缩/重开会话都无损续跑」：

- **状态文件 `.git/review-loop-state.json`**（在 .git 内，永不入库），字段：`{base, branch, slug, background, maxRounds, round, phase, stats, lastCommit}`。
  - `phase`：`reviewing`（ocr 在跑）/ `triaging`（处置中，dump 在盘可重读）/ `done`。
  - `stats`：`{rounds, findings, adopted, rejected, stale}` 累计值。
  - 写入时机：循环启动时、**每次发起 ocr 后台评审前**（round/phase=reviewing）、**每轮提交完成后**（stats/lastCommit/round=下一轮）。
- **轮边界主动提醒（上下文 >50% 防线）**：每轮提交完成、即将发起下一轮评审前——若本会话已连续处理 ≥2 轮，向用户提示「上下文可能已过半，现在 /compact 最安全：循环状态已落盘，压缩后自动续跑或重开 /review-loop 均无损」，等用户决定（压缩是用户侧命令，agent 无法代触发；用户说继续就直接续跑，ZCode 长会话自动摘要兜底）。评审后台运行的 15 分钟空窗是压缩的最佳时机。
- **压缩后恢复**：上下文被摘要后第一件事 Read 状态文件——`reviewing` → 等后台任务通知或检查输出文件已生成则直接进入处置；`triaging` → 重读 dump 重新逐条处置（裁决在 README §7 已登记的部分核对后不重复改）。

## 文件命名与轮次编号

- slug = 分支名 basename（`/` 后段）去掉 `.`（例：`feat/p2-llm-client` → `p2-llm-client`；`feat/p1.2-collector` → `p12-collector`）。
- 轮号 N = `docs/code-review/review-<slug>-*.json` 现有最大号 + 1（用 `ls docs/code-review/ | grep` 提取）。
- 评审输出 `docs/code-review/review-<slug>-<N>.json`；dump 摘要 `docs/code-review/_r_<slug>_<N>.md`。
- **两者都不入库**：评审 JSON 按本仓惯例保持未跟踪，dump 带 `_` 前缀被提交门拦——`git add` 时绝不带上。

## 每轮流程

### 1. 跑评审（后台，完成后续跑）

背景文本用 **Write 工具**写到 `.git/ocr-background.md`（UTF-8；**不得**用 `-b` 内联中文——Git Bash 中文传参乱码），同时把状态文件更新为 `{round: N, phase: "reviewing"}`，然后：

```
ocr review --from <diffBase> --to <branch> -B .git/ocr-background.md --format json --output docs/code-review/review-<slug>-<N>.json --audience agent
```

- **增量 diff（防「修复生产新意见」的正反馈）**：`diffBase` 首轮 = `<base>`（如 main），后续轮 = 状态文件的 `lastCommit`（上一轮修复提交）——只评审增量，旧代码不重复扫（早前轮已覆盖；全量重扫是 47 轮不收敛的机制之一）。**上一轮无修复提交时（全驳回/backlog）lastCommit 未变 → 增量为空，该轮即视为无 P1/P2 轮**，直接计入收敛判据，不空跑评审。
- **产出体量三道闸（已预置，勿重复配置）**：`.opencodereview/rule.json` 的 `rules[].rule`（`path:"**"` + `merge_system_rule:true`）携带严重度边界——只产出必须修改的问题、每条须给失效场景、宁缺毋滥；`review-dump.mjs --min-severity` 读前机械滤除；本命令 triage 的 P1/P2 门控。意见体量仍高时可在评审命令加 `--effort low` 降产出深度（备用旋钮，默认不动）。
- **必须 `run_in_background: true`**：单轮评审 10-20 分钟，超过前台命令 10 分钟上限；任务完成通知到达后继续下一步。
- 完成后删除 `.git/ocr-background.md`。
- 退出码非 0 / 输出文件缺失 / dump 无法解析 → 报告原始错误并**终止循环**，等用户处置。

### 2. dump 与读取

先把状态文件翻为 `phase: "triaging"`（压缩后凭它知道要重读 dump），然后
`node scripts/review-dump.mjs docs/code-review/review-<slug>-<N>.json --out docs/code-review/_r_<slug>_<N>.md`，
再 **Read dump 文件**。**绝不直接 Read 评审 JSON**（thinking 大块会超限——既定纪律）。

- dump 头部 `意见数: 0` → 本轮零意见，跳到第 6 步收尾。
- 意见数为 0 但存在异常（状态非 complete 等）→ 按失败处置。
- dump 默认**不滤**（全量 + 每条带 `[severity/category]` 标签 + 头部分布）——评审自评严重度只当**先验**不当裁决（P2 轮 47 实证：2 条 high 是 stale、3 条 low 是真 P2，双向误标）；用户明说「只要高严重度」或上下文紧张时才加 `--min-severity medium`（滤除是体量闸门，滤后仍需逐条核验）。

### 3. 逐条 triage（P1/P2 实施 / P3 backlog / 驳回 / stale）

对每条意见先定严重度（P1/P2/P3，见「收敛规则」），再独立裁决并落修复，纪律
（数十年轮实战沉淀，违反任何一条都会翻车）：

- **外部事实声明先核实再采纳**：协议规格/端点行为类声明用 WebSearch/WebFetch 核实官方口径；Python parity 类声明对照 `D:/dev/git/z_jordon/TreeWalker/src/tree_walker/llm/client.py` 等参考源码行号核实。评审对 Python 行为/官方规格的事实断言可能错误。
- **评审给出的修复代码也可能有缺陷**（轮 10 正则兜底、轮 15 minLength 类型口径、轮 17 undefined 不能 .slice 均为实例）——建议片段须自行核验后再落。
- **驳回必须附实证**（web 链接 / 参考源码行号 / 结构性不可达分析），登记进 README §7；同议题被多轮重提时维持既有裁决并引用轮号，除非新证据成立。
- **stale 意见**（对照当前代码已失效/已修）核实后按 stale 登记处理，不盲改。
- 敏感值缺省姿态（toolResult/args 明文出站）等已裁定的 P4 议题：维持裁决、引用轮号，除非评审带来新事实。

### 4. 测试与门禁

- 新增/修改行为同步补测试（正常路径 + 关键边界）；期望值锚定参考实现，不「看起来对」。
- `pnpm typecheck` + `pnpm test` 全绿；格式化用 `pnpm exec biome check --write .`（`pnpm format` 包装在 Git Bash 失效）。
- 门禁取**真实退出码**：`node scripts/gate.mjs pre-commit; ec=$?`——**不得接管道 `| tail`**（轮 12 管道掩码退出码教训）。
- 行为级修复做一次双向验证：临时还原旧实现确认新测试必红，再还原回来。

### 5. 登记与提交

- `docs/implement-plan/<计划>/README.md` §7 登记本轮：轮号、采纳/驳回数、要点（含驳回理由）、测试数与覆盖率。
- 中文 commit message 用 Write 写 `.git/COMMIT_MSG.txt`（UTF-8），`git commit -F .git/COMMIT_MSG.txt`，提交后删除消息文件（shell 传参乱码纪律）。
- `git add` 范围：源码 + 测试 + 相关 docs；**评审 JSON / dump / `_` 前缀临时文件一律不加**。
- 提交钩子（gate）跑失败时如实报告并修复后重试，不得 `--no-verify`。
- **不 push**。每轮一次修复提交由本命令授权（用户启动循环即授权）；除此之外不产生任何提交。

### 6. 轮转与收尾

- 意见数 > 0：更新状态文件（stats 累计、`lastCommit`、`round: N+1`），向用户简报本轮处置（P1/P2/P3 分布 + 采纳/驳回/stale 计数 + 关键修复一句），然后：
  - **本轮与上一轮均无 P1/P2 → 宣布收敛**（状态 `phase: "done"`，P3 backlog 留档），不等额度；
  - **本会话已连续处理 ≥2 轮 → 先做轮边界上下文提醒**（见「状态持久化与上下文管理」：提示用户可 /compact，评审后台空窗是最佳时机；用户示意继续或已压缩则直接续跑）；
  - N+1 回到第 1 步自动续跑下一轮。
- 意见数 = 0：循环收敛——状态文件写 `phase: "done"` 与最终 stats，汇报累计数据（总轮数、累计意见/采纳/驳回、测试数变化、分支提交数、覆盖率），等用户后续指令（合并/真机 smoke 等）。
- 达到 max-rounds：状态文件保留 `phase: "triaging"` 语义上的暂停态（记录已完成轮数），停下汇报进度，问用户是否继续。

## 硬性红线

- 评审 JSON 绝不直接 Read；门禁退出码绝不接管道；中文绝不走 shell 传参。
- 不 force push、不 `--no-verify`、不 amend 已发布提交、不 push（用户明确要求除外）。
- 测试不发真网络请求、不真调 LLM（评审修复的测试同样遵守）。
- 循环中断（失败/上限/用户叫停）后，工作区必须处于干净已提交状态，方便随时重启续跑。
