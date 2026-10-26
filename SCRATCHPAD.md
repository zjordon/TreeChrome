# issue #12 实施草稿：v2——收敛循环引入效率信号

- issue: [#12](https://github.com/zjordon/TreeChrome/issues/12)
- 分支：`feat/issue-12-efficiency-signal`（自 main b9408a5）
- 状态：**评审收敛，待 /finish-issue**（2026-10-26：review-loop 2 轮收敛——2 意见全采纳（V1 兼容剥除/adopt min 合并），轮 2 零意见；沙箱回归实跑通过）
- 设计讨论已定四点（2026-10-26 用户拍板）：v1 度量**只用步数**；margin `max(2, ⌈10%·best⌉)`；**P3 footer 加效率句**；`best_steps` 语义 **min+margin 组合**。

## 1 背景与根因

D17 收敛判据 = 连续 N 次成功且无新观察——只保证「稳定」不保证「最优」。两个缺口：

- **缺口 A（捕获）**：更短轨迹发生了，蒸馏器也判不出「这是值得入卡的新观察」（内容主题比对，看不见步数差）→ unchanged → 收敛锁死旧 SOP
- **缺口 B（探索）**：卡收敛后引导每次 run 走同一条路，更短路径没有机会发生——#11 锚定问题的效率面

证据：Day/Month 盲区（distill-and-rerun 5 轮，Period 恒选 Day）；步数→model 段→wall clock 76-82%，步数即成本主项。

## 2 设计决策

- **D1 基线机制（core 蒸馏侧，双宿主免费）**：
  - 卡 meta 增 `best_steps`（成功 run 最小步数）——node-host `_task.json` / 扩展 `SkillCardData.bestSteps`（IDB JSON 无迁移）
  - `DistillTaskInput.baselineSteps?: number | null`；`SkillCardDraft.bestSteps: number = min(baseline ?? ∞, steps)`（新卡 = steps）
  - 增量 prompt（`buildTaskDistillPrompt` 增 `baselineSteps`）加效率对比行：「本次 M 步 vs 卡基线 N 步——显著更短则把更短做法写进 SOP 且 has_new_observations=true；更长/持平则步骤保持」——只渲染在 update 块（新卡无基线）
- **D2 收敛防锁死（core 机械兜底）**：
  - `efficiencyMargin(best) = max(2, ⌈10%·best⌉)` 导出纯函数；improvement ⇔ `steps < best − margin`
  - streak 判停处加守卫：`streak ≥ threshold && 无改进` 才 skip——有改进强制发蒸馏调用（防模型漏看基线吞掉改进）
  - unchanged 且有改进：卡内容不动，但宿主 bump 时合并 `best_steps = min(旧, steps)`（基线棘轮——内容没捕获到也要记住下界，下次同水位不再误判改进；终止性：best 单调降，降平后收敛）
- **D3 footer 效率句（缺口 B 软杠杆，借 #11 D1 的蒸馏后处理路径）**：`TASK_SOP_SELF_CHECK_FOOTER` 增一条：「卡中步骤不是最短保证：若当前页面提供更少的等效做法（如更粗的报表粒度、直达 URL），优先采用更短路径——仍以页面实时核验为收题标准」。旧卡增量更新时统一补上（幂等剥附机制不变）；乱抄近道风险由既有门控兜住（只蒸馏 success+judge 过的 run）
- **D4 宿主接线**：
  - node-host：`distill-run.ts` 的 `cardDistillState` 扩 `{streak, bestSteps}`（readTaskMeta 读 `best_steps`）+ 传 `baselineSteps`；`writeTaskCard` meta 写 `best_steps`；`bumpDistillStreak` 增 steps 参合并 min
  - 扩展：worker `cardDistillState` 扩 `bestSteps` + 传 `baselineSteps`；unchanged 路径 `bumpDistillStreak(host, slug, steps)`；`saveDraft`/`adopt` 随 draft 落 `bestSteps`
- **D5 不做**：token 度量（两宿主管道不通，挂账 v3）；双轨迹择优/skill-off 探索 run（P4——与「多轨迹合并」议题划边界后另立）；EMA 基线（min+margin 已防侥幸）。

## 3 实施步骤

- **S1 core**：`distill.ts`（efficiencyMargin 导出 + 判停守卫 + baselineSteps/bestSteps + draft 落值）、`distill-prompt.ts`（update 块效率对比行）、footer 常量加句。
- **S2 宿主**：node-host `distill-run.ts`/`writeTaskCard`/`bumpDistillStreak`；扩展 `skill-store.ts`（SkillCardData.bestSteps + bump 签名）与 `distill-worker.ts` 接线。
- **S3 测试 + gate**：core（margin 纯函数/判停守卫两分支/draft.bestSteps 三态/prompt 基线行/footer 句锚定）、node-host（bump 合并、writeTaskCard best_steps、cardDistillState 透传）、扩展（bump 带 steps、adopt 落 bestSteps）；typecheck/test/gate；扩展 rebuild。

## 4 测试面

| 层 | 用例 |
|---|---|
| core distill | margin=max(2,10%) 边界；streak≥阈值且改进 → 不 skip（蒸馏调用发生）；无改进 → 照常 skip；新卡 draft.bestSteps=steps；增量改进 = min；unchanged 原样 |
| core prompt | update 块含基线对比行（M vs N + 显著更短指示）；新卡模式无该行 |
| core footer | 常量含效率句；幂等剥附回归不破 |
| node-host | bumpDistillStreak 合并 min（含旧卡无 best_steps）；writeTaskCard 落 best_steps |
| extension | worker unchanged→bump 带 steps；saveDraft→adopt 后 bestSteps 落卡 |

## 5 验收清单

- [x] 沙箱回归（2026-10-26 实跑，.git/issue12-regression.log）：卡 streak=2/best=12（种子）遇 5 步轨迹 → **D2 守卫生效**（streak≥阈值但 5<12−2 → 蒸馏调用未被收敛拦截）→ 模型判无新观察（**正确**——现行卡 SOP 本身就是这条 5 步 evaluate 路径，12 步基线是建卡前时代的残留）→ unchanged：内容不动 + **best_steps 棘轮 12→5**；下一轮 4 步（<best 但在 margin(5)=2 内）→ 正常 `converged — skip` 零改动。原始 Day/Month 场景已被卡的 evaluate 聚合消解（粒度不再影响步数，该任务效率天花板 ~4-5 步）——issue 验收句里的「SOP 含 Month」在新卡形态下无可捕获对象，机制本身（守卫/棘轮/终止）全验证
- [x] footer 效率句：沙箱卡预置稳态 footer 实跑注入（node-host 链路）；扩展链路等价性由单测覆盖（saveDraft/adopt/bump 落值）
- [x] typecheck/test 全绿；gate 过；覆盖率 ≥85%

## 6 风险与边界

- footer 变更 → #11 锚定测试随常量自动锚定（导入驱动，非字面量）；已采纳旧卡不带效率句（增量更新统一补——与 #11 footer 同款扩散路径）
- 改进判定依赖 steps 口径含步内重试噪音——margin 即为此设；margin 偏保守只会晚收敛，不会锁死（改进每次都会强制蒸馏）
- unchanged+改进只棘轮 best_steps 不改内容——若短路径可复现，下一轮改进 run 会再次强制蒸馏直到模型捕获或水位降平

## 7 评审轮登记

| 轮 | 意见 | 采纳/驳回/stale | 要点 |
|---|---|---|---|
| 1 | 2（medium/bug×2） | 采纳 2 | ① footer 常量加第四条后 #11 存量卡的旧三条 footer 剥除不命中 → 增量回带残留双份自检节且永久不可剥——保留冻结的 V1 常量（TASK_SOP_SELF_CHECK_FOOTER_V1）新旧一并 split 剥除；② adoptDraft 直接落草稿 bestSteps 未与在用卡取 min（草稿待审期在用卡可能已被棘轮下移——采纳会抬回基线；存量草稿缺字段时静默丢在用值）——min(草稿, 在用) + 缺字段保留在用值，与 node-host writeTaskCard 口径对齐。双修复测试先行红→绿验证 |
| 2 | 0 | — | 增量 diff（仅轮 1 修复）零意见——收敛。累计：2 轮 / 2 意见 / 采纳 2 / 驳回 0 / stale 0 |
