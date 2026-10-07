# P5 评测仓 TS 后继 + SR parity 闸门（M4）实施计划

> 状态：2026-10-07 起草，待用户确认后开工。
> 定位：架构 §7「评测（独立仓库，质量发动机）」+ §9 M4「parity 闸门」——**同模型同口径
> TS vs Python TreeWalker，SR 差距进噪声区间 = Python 退役验收门槛**。
> 对拍基准：evals/webarena（Python 仓）冻结行为语义；TreeWalker @640d52a；TreeChrome @15dee00。

## 1. 前置检查（2026-10-07 核验）

| 项 | 结论 |
|---|---|
| core 评测接面 | **大项全绿（P3/P4 已预埋）**：`Agent.run(keepAlive)`（agent.ts:222）、`AgentHistory.stateSummary`（views.ts:180）、`LLMClient.extract`（含 F9.2 退避）、cdp-ws `setCookiesFromStorageState`（session-primitives.ts:108，注释自述「evals runner.py:76-156 移植」）、BrowserSession 裸 CDP 逃生口（session.ts:588，注释自述「评测 adapter 用」）、`enableSkillInjection`/`enableTaskSkillInjection` 双开关齐 |
| Python 参考数据 | **在位**：三口径 A/B/C × 184 shopping_admin 任务（docs/three-caliber-abc-report-2026-09-10.md，勘误后 SR 66.8%/68.5%/72.8%，McNemar 口径），results/ 有原始 JSON |
| WebArena 环境 | 用户机器 docker 栈 + reset_env.ps1 在位，2026-09-27 仍有跑动记录（jsprobe_a）——环境活 |
| 任务数据 | `webarena_repo/config_files/*.json` 已生成且 start_url 占位符已解析（`http://localhost:7780/admin` 实值）；`.auth/` 登录态在位——**TS 仓直接复用，不重新生成** |
| 模型一致性 | **待核对**（P5.4 前置项）：A 轮结果 JSON 里的模型记录 vs 现配置——parity 定义是「同模型同口径」，若参考轮模型与现配不同，以参考轮模型配置跑 TS（或同机重跑 Python 对照轮） |

## 2. 侦察关键事实（决定方案形态）

1. **口径 A/B/C = skill 注入开关组合**（runner.py:484 注释 + three-caliber 报告）：
   A=`enableSkillInjection:false`+`enableTaskSkillInjection:false`（裸跑）；B=站点级开；C=双开。
   **推论：口径 B/C parity 有 skill 前置**——TS 侧目前无 domain-skills 内容库也无宿主 SkillSource
   （P4 起已知缺口）。本计划**阶段化**：先口径 A（零前置），skill 面（P5.5）到位后再 B/C。
2. **SR = 每任务 `score > 0`（WebArena 官方 evaluator 判分），agent 自评 `is_successful`
   不入 SR**（three-caliber 报告 §2.2 明示，且反向案例 score=1/自评=false 有 4 个）。
   **推论：douyin 真机暴露的「谎报完成」不污染 parity 度量**——evaluator 读页面状态不读 agent
   声明。防谎报加固（done 回溯校验/judge 阻断）据此**降级为 post-M4 产品层改进**（M5 扩展时代），
   不进 P5、更不能在 parity 度量前引入（会破坏两侧行为对等）。
3. **evaluator 对 browser 的消费面极窄**：`page.evaluate`×7 / `page.goto`×3 / `page.url` /
   `page.content` / `browser.stop`——CDPPageAdapter 鸭子类型 1:1 移植面很小，session.ts:588 的
   裸 CDP 逃生口就是为此预留。
4. runner.py 对 tree_walker 的调用契约（§10 末行「即其对 core 的调用面」）：Agent 直连构造
   （非 node-host runAgent 形态）+ `replace(settings.agent, max_steps=N)` + `run(keep_alive=True)`
   ——TS 对应 `new Agent({...})` + `resolveAgentSettings` + `run(true)`，零缺口。
5. 批量层（smoke_test.py run_all）：分层看门狗（soft=wait_for 超时 / 硬=进程级击杀+毒丸落盘）、
   断点续跑（error 空=done 的单一事实源 + watchdog_kill 例外）、增量落盘、--sites 过滤、
   验收钩子（hang/fast-done 模拟）——全部属评测仓工程，1:1 移植。
6. string_match 判分适配层（issue #7/#9）：LLM 抽取精简答案（exact_match/N-A 型）+ 确定性清理
   （引号/装饰尾巴正则）+ 类型分流——移植时逐行锚定，抽取走 `LLMClient.extract`。

## 3. 新评测仓形态（待确认项 ①）

- **位置/名称**：建议 `D:/dev/git/z_jordon/evals/webarena-ts`（与 Python 仓并列；独立 git 仓）。
- **依赖**：pnpm `link:` 指向本仓库 `packages/core` + `packages/cdp-ws` + **`packages/node-host`**
  （架构 §7 只列 core+cdp-ws；node-host 的 settings/env 映射与 esbuild 引导复用是自然延伸，
  **登记为对架构 §7 的一处扩展**——评测仓自建 env 映射是重复劳动）。
- **运行形态**：`tsx` 直跑 TS（link: 的源码直发包无需构建；node-host boot.mjs 模式留给散脚本，
  评测仓整仓 tsx/vitest）。测试 vitest；无本仓提交门依赖（gate 在本仓）。
- **数据互引**：`WEBARENA_REPO` 环境变量指向 Python 仓的 `webarena_repo/`（config_files +
  .auth 复用，不拷贝）；评测结果落 TS 仓自己的 results/。

## 4. 工作项与预估

### P5.0 评测仓脚手架（0.5d）

pnpm workspace + link: 三包 + tsx + vitest + 目录骨架（src/{runner,evaluator,batch}/）+
WEBARENA_REPO env 解析 + README（前置/用法，对照 Python 仓 env_setup.md 摘要）。
验收：`tsx src/hello.ts` 能 import @tw/core 打印版本；vitest 空跑绿。

### P5.1 runner.ts 移植（1~1.5d）

runner.py 545 行 → `src/runner.ts`：run_one_task 全流程（BrowserSession 构造 → start →
cookie 注入（cdp-ws 原语）→ Agent 构造（resolveAgentSettings + maxSteps 覆盖）→ run(true)
带超时 → isDone/isSuccessful/finalResult → _prepare_eval_answer（extract_concise_answer +
_clean_concise_answer 正则 + _needs_extraction 分流）→ build_webarena_trajectory →
evaluate_task → 收尾 stop）。验收钩子（hang/fast-done）与 Wikipedia URL 注入同款。
**单测**：答案分流/清理正则/trajectory 转换（mock LLM+Browser，不发真请求）。

### P5.2 cdp_evaluator.ts + 测试（1.5~2d）

cdp_evaluator.py 785 行 → `src/evaluator.ts`：evaluate_task + StringEvaluator/URL/FUNC/
program_html 判分族 + ua_match judge 调用 + 读值状态标注（locator_empty/slow/eval_error）+
CDPPageAdapter（page.evaluate/goto/url/content 四面，走 session 裸逃生口）。
**单测**：test_cdp_evaluator.py 1:1 移植（该文件是评测仓自己的测试，形态直接搬）。

### P5.3 批量层 batch.ts（1.5~2d）

smoke_test.py → `src/batch.ts`：run_all（--all/--task-ids/--sites/--count/--resume/--output）+
分层看门狗（soft=Promise 超时；硬=子进程级击杀+毒丸落盘，Node 形态：每任务子进程或
worker，主进程 SIGKILL 等价）+ 完成判定单一事实源 + 增量落盘 + calib 头记录（口径 flag
+ 指向的 TreeChrome commit——架构 §7 可复现性要求）。分析脚本（gen_round_reports/
analyze_*）**不移植**（Python 侧对同一 results JSON 格式直接可跑；格式保持兼容即零成本复用）。

### P5.4 口径 A parity 闸门（人力 1d + 跑机）

1. smoke 10 任务（smoke_task_ids.json）：TS 链路全通（cookie 注入/判分/落盘/续跑）。
2. `reset_env` → 184 shopping_admin 全量一轮（口径 A：双 skill 开关 off；max_steps=30）。
   参考侧：优先复用既有 A 轮数据（**先核对其模型记录**；不一致则 Python 同机重跑一轮，
   跑机 +7~8h）。
3. **parity 判定**（吸收 three-caliber 报告的统计口径）：|SR_TS − SR_Py| 落噪声区间 =
   McNemar 检验 p ≥ 0.05 且逐任务不一致对抽样复核无系统性归因（沿用报告的 12:15 型数据）。
4. 产物：TS 仓 docs/ 内 parity 报告（对照表 + 不一致任务清单 + 归因），本仓不改代码
   （若暴露 core API 缺口，小补丁走本仓功能分支 + 评审循环，属计划外回修）。

### P5.5 阶段 2：skill 面 + 口径 B/C parity（0.5~1d 人力 + 跑机；P5.4 过闸后启动）

- **FsSkillSource 在评测仓实现**（core 的 `SkillSource` 接口 + task-matcher 已在，评测仓自
  实现读目录版——**本仓零改动**，符合「评测不被被测方牵制」）；内容拷贝
  `TreeWalker/domain-skills/localhost_7780/`（三件套 + tasks/ 任务卡）到评测仓 data/
  （douyin/bilibili 两套站点卡同批拷入，供 M5 扩展与真实任务——skill 库正式立项的第一步）。
- 口径 B（站点级）→ 口径 C（双开）各一轮 184 任务，同判据对拍 Python 参考值。
- 任务级卡匹配泛化（TreeWalker#182 杠杆结论）在 TS 侧的复现本身就是 skill 移植的验收。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| LLM 成本（184 任务 × ~20-30 步 × 最多三轮） | 先 smoke 10；A 轮优先复用既有参考数据；每轮 calib 头记录模型/commit 可追溯 |
| 环境时序噪声（evaluation-instability 文档教训） | 每轮 reset_env 出厂数据起点；判分读值状态标注区分「时机问题」与「真不匹配」；fuzzy_rejudge 工具 Python 侧复用 |
| 看门狗语义移植漂移（Python asyncio/进程模型 ≠ Node） | 验收钩子（hang/fast-done）1:1 移植并演练（test_hard_watchdog 等价离线测试） |
| TS 侧 step 形态差异（如 multi_act 包裹、glm-5.3 抖动）影响步数/超时分布 | parity 度量是 SR 非步数；超时阈值沿用 600s；不一致任务逐个归因（报告 §4 产物） |
| 本仓 API 缺口计划外暴露 | 缺口走本仓分支 + 评审循环回修，评测仓 pin 的 link: 指向 commit 保证可复现 |

## 6. 验收（M4 闸门定义）

1. 口径 A：TS vs Python 184 任务 SR 差距进噪声区间（McNemar p ≥ 0.05 + 无系统性归因）。
2. （阶段 2）口径 B/C 同判据过闸；C 轮任务级卡增益方向与 Python 一致（+6pp 量级可波动）。
3. TS 仓自有测试全绿（runner/evaluator/batch 单测，不发真网络）；smoke 10 任务真机全通。
4. parity 报告归档（TS 仓 docs/），Python 退役评审（M7）据此启动。

## 7. 待确认清单

1. **新仓位置/名称**：`evals/webarena-ts`？（或 treechrome-evals / 其他）
2. **parity 参考侧**：优先复用既有 A 轮数据（先核对模型记录），不一致才 Python 同机重跑——接受？
3. **阶段划分**：先口径 A 过闸、skill 面（P5.5）后置 B/C——接受？（skill 库立项因此并入 P5.5 + M5，douyin/bilibili 卡同批带入）
4. **跑机窗口**：184 任务一轮约 7~8h（用户机器 docker 环境 + LLM key），由用户触发；我只做 smoke 10 级验证（沙箱无 WebArena 栈）。
