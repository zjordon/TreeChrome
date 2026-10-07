# P5 评测仓 TS 后继 + SR parity 闸门（M4）实施计划

> 状态：2026-10-07 定稿（用户裁定执行主体分工后重写）。
> 定位：架构 §7「评测（独立仓库，质量发动机）」+ §9 M4「parity 闸门」——**同模型同口径
> TS vs Python TreeWalker，SR 差距进噪声区间 = Python 退役验收门槛**。
> 对拍基准：evals/webarena（= github.com/zjordon/treewalker-webarena，Python 参考实现）；
> TreeWalker @640d52a；TreeChrome @057de85。

## 1. 执行主体分工（2026-10-07 用户裁定）

| 线 | 执行地 | 执行者 | 跟踪 |
|---|---|---|---|
| P5.0-P5.4：评测仓 TS 后继改造 + 口径 A SR parity | **treewalker-webarena 仓（独立 git，Ubuntu 机器）** | 用户侧 | [issue #11](https://github.com/zjordon/treewalker-webarena/issues/11)（工作清单/接口事实/判据全文在案） |
| P5.5：skill 面（阶段 2 前置，**并行推进，不等 A 轮过闸**） | **TreeChrome 本仓** | 本仓会话 | 本文件 §4 |
| 本仓对评测侧的唯一义务 | — | — | 核心包公共 API 稳定（架构 §7）；计划外缺口走本仓分支 + 评审循环回修 |

> 分工依据：评测改造与 A 轮评测在另一台 Ubuntu 机器的独立仓进行，与本仓 P5.5 并行。

## 2. 前置检查（2026-10-07 核验，两侧共用事实）

| 项 | 结论 |
|---|---|
| core 评测接面 | **大项全绿（P3/P4 已预埋）**：`Agent.run(keepAlive)`（agent.ts:222）、`AgentHistory.stateSummary`（views.ts:180）、`LLMClient.extract`（含 5xx 有界退避）、cdp-ws `setCookiesFromStorageState`（session-primitives.ts:108，注释自述「evals runner.py:76-156 移植」）、BrowserSession 裸 CDP 逃生口（session.ts:588，注释自述「评测 adapter 用」）、`enableSkillInjection`/`enableTaskSkillInjection` 双开关齐 |
| Python 参考数据 | **在位**：三口径 A/B/C × 184 shopping_admin 任务（three-caliber-abc-report-2026-09-10，勘误后 SR 66.8%/68.5%/72.8%，McNemar 口径）；**A 轮模型记录待评测侧核对**（与本次配置不一致则 Python 同机重跑对照轮） |
| 任务数据 | `webarena_repo/config_files/*.json` 已生成且 start_url 占位符已解析（实值）；`.auth/` 登录态在位——**TS 侧直接复用** |

## 3. 评测侧关键事实（已在 issue #11 全文转交）

1. **口径 A/B/C = skill 注入开关组合**：A=双关（裸跑）/ B=站点级开 / C=双开——B/C 有 skill 前置（本仓 P5.5 供给）。
2. **SR = 每任务 score>0（官方 evaluator），agent 自评 is_successful 不入 SR**——douyin 真机暴露的「谎报完成」不污染 parity 度量；防谎报加固据此**降级为 post-M4 产品层改进**（M5 扩展时代；parity 前引入反而破坏两侧行为对等）。
3. evaluator 对 browser 消费面极窄（page.evaluate/goto/url/content + browser.stop），CDPPageAdapter 1:1 移植即可。
4. parity 判定：McNemar p≥0.05 且逐任务不一致对抽样无系统性归因（沿用 three-caliber 报告统计口径）。

## 4. P5.5 skill 面（本仓并行线，待出详细方案后开工）

**目标**：口径 B/C 的 skill 注入供给 + M5 扩展前置 + douyin/bilibili 真实任务能力（douyin 真机三部曲的 selectors.md 正解此局）。

- **内容**：`domain-skills/` 顶层目录（TreeWalker 同构：`<host_key>/` 三件套 + `tasks/` 任务卡），
  从 TreeWalker @640d52a 拷入 localhost_7780（评测用）+ creator.douyin.com + member.bilibili.com（真实任务用）。
- **宿主实现**：node-host 增 `FsSkillSource`（实现 core 的 `SkillSource` 接口——机制侧 task-matcher/
  注入点 P4 已移植且评测接面在位，本项是补宿主装载层）；评测仓经 link: 直接消费，扩展侧 M5 转
  IndexedDB 存储（架构 §6.2）。
- **口径供给**：B/C 轮时评测侧 `overrides.agent.{enableSkillInjection,enableTaskSkillInjection}` +
  skillSource 注入即达；本仓侧验证以注入单测 + （可选）真机 douyin 复跑（skill on/off 对照）代替——
  完整 B/C parity 跑机在评测仓（issue #11 并行线节已声明届时另开 issue）。
- **详细实施计划已起草**：[01-skill-face.md](./01-skill-face.md)（S0-S7：语义锚定表 / node-host 扩面 /
  内容拷贝 / 测试矩阵 / smoke / 分支），待用户确认后开工。

## 5. 验收（M4 闸门定义，评测侧执行）

1. 口径 A：TS vs Python 184 任务 SR 差距进噪声区间（McNemar p≥0.05 + 无系统性归因）。
2. （阶段 2，依赖本仓 P5.5）口径 B/C 同判据过闸；C 轮任务级卡增益方向与 Python 一致。
3. 评测仓自有测试全绿 + smoke 10 任务真机全通（Ubuntu 侧）。
4. parity 报告归档评测仓 docs/，Python 退役评审（M7）据此启动。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 评测侧 TS 移植暴露本仓 API 缺口 | 走本仓分支 + 评审循环回修；评测仓 pin 的 link: commit 保证可复现 |
| A 轮参考数据模型不一致 | 评测侧核对结果 JSON calib 记录，不一致 Python 同机重跑 |
| 环境时序噪声（evaluation-instability 教训） | 每轮 reset_env 出厂数据起点；读值状态标注区分时机与真不匹配 |
| P5.5 与 A 轮并行的时间差 | 无耦合：A 轮零 skill 前置；P5.5 交付物经 link: 供给，B/C 轮前到位即可 |
