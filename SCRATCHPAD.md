# SCRATCHPAD — 实施计划草稿（随实施持续更新）

> 分支：`feat/issue-5-self-evolution`（自 main @ c07d9a4）
> 目标：实现 [issue #5](https://github.com/zjordon/TreeChrome/issues/5) — 架构 §6.3 自进化闭环：成功轨迹 → 蒸馏草稿 → 人工采纳 → 二次任务命中注入
> 状态：**计划修订中——两轮评审意见已吸收（Q1/Q2 + D16 范围裁定），待用户放行开工**

## 0. 背景与结论（可行性评估已完成，2026-10-22）

评估结论：可行。闭环下半段（采纳→匹配→注入）零新增——skill 双层注入链已在生产运行；上半段积木齐——Judge 已在 run 内跑（`agent.ts:296`，verdict 随 `session_end.evaluation` 带出）、`AgentHistory` 完整轨迹在 run-manager 手中（`run-manager.ts:335`）。缺的是中段：蒸馏器（core）、draft 状态与审阅流（扩展）。

关键陷阱（评估实证）：**journal 压缩投影不可作蒸馏输入**——`compactEventData` 丢 tool_call params / extractedContent / thinking，且有 512KB 预算裁剪（`journal.ts:21-68`）。蒸馏输入必须用进程内 `AgentHistory`。

## 1. 方案总览

```
[run 收尾] run-manager.drive() done 分支
    → 门控：isSuccessful() && judgement?.verdict === true（不满足 → 只记日志）
    → 轨迹序列化（共享序列化器，judge 同款形态）→ sensitive 占位脱敏（整串）
    → 入队 chrome.storage `tc_distillQueue`（runId 幂等，上限 10）→ 立即 kick drain
[蒸馏] DistillWorker（SW 内；keepalive hold 保活；alarm 兜底唤醒）
    → task-matcher 对 host catalog 预匹配：命中 → 增量模式（旧卡进 prompt，slug 复用）
                                              未命中 → 新卡模式（蒸馏器产 slug）
    → core DistillEvaluator.structuredCall（TreeForge 任务级 prompt 移植）
    → 产物校验（JSON schema + 三件套非空 + PII 正则门）→ SkillStore 写 status='draft'
    → 广播 skill-drafts {count}（sidepanel 轻提示；options 是审阅面）
[审阅] options 页：草稿列表 + 三件套可编辑 + 采纳（status→active）/丢弃（delete）
[生效] 采纳即进入既有注入链（ExtensionSkillSource 读侧过滤 draft——draft 永不注入）
```

### 关键设计决策（待审）

| # | 决策 | 理由 |
|---|---|---|
| D1 | 门控 = `isSuccessful() && judgement?.verdict === true`，judgement 缺失（judge 被配置关闭/调用失败）= **不蒸馏** | 严格 §6.3「done(success) 且 Judge 复核通过」读法；judge 默认开（`DEFAULT_JUDGE_SETTINGS.enabled=true`，扩展未覆盖即生效），宽松化留实测后再议 |
| D2 | 蒸馏输入 = 进程内 AgentHistory；把 `judge.serializeHistory` 提取为共享模块（纯搬移，judge 锚定测试必须保持绿） | 一份序列化器两处消费；避免复制漂移 |
| D3 | 序列化后整串过 sensitive 占位面再进 prompt；产物再过 PII 正则门（邮箱/手机号/卡号式样） | 轨迹 results 含还原后的敏感真值；占位单源在 `sensitive-observability.ts` |
| D4 | 蒸馏器形态 = `structuredCall` 面（task-matcher 同款 `DistillLLM` 注入面）+ 2 次尝试 + 60s 超时 + 失败 null 不挂任务 | 与 matcher/judge 两个先例对齐；宿主可注入 mock |
| D5 | prompt 移植源 = `treeforge/harness/distiller.py` 任务级模板（`_TASK_PROMPT_TEMPLATE` + `_TASK_SLUG_RULES` + 共用 spec 块 `_CONSUMER_CONTEXT`/`_SELECTORS_SPEC`/`_QUIRKS_SPEC`/`_RULES_BLOCK` + 增量 addendum）；evidence 段替换为 agent trace 叙事。**非字节锚定**（TreeForge 是参考不是契约，不进 prompt-consts 生成器） | TreeForge 已实证的 spec 块直搬；消费端动作词汇表对齐本仓 ACTION_DEFINITIONS（25 动作，与 TreeWalker 24 的差异实施时核对同步） |
| D6 | 更新 vs 新卡：**先跑 task-matcher**（对 host catalog），命中且为 distilled 卡 → 增量模式（slug 复用；built-in 命中走 D14）；未命中 → 新卡模式（蒸馏器产 slug，kebab ≤5 词，撞名加后缀） | 「同 host 同模板更新既有卡」落成现有组件组合，不另造匹配逻辑 |
| D7 | `SkillCardData` + `status?: "active"\|"draft"`（**缺省 = active**，兼容存量 IDB built-in 卡）+ `sourceTraces?: string[]`（runId 并集）；ExtensionSkillSource 读侧三面过滤 draft | 可选字段避免存量卡全量迁移 |
| D8 | 两层语义：**内容层增量蒸馏**（旧卡全文进 prompt，LLM 以旧卡为基线改写——压缩措辞不丢主题，禁从零重写）；**存储层采纳时整卡替换**（slug 不变 + sourceTraces 并集 + distilledAt 刷新），不做字段级 diff 合并 | TreeForge 增量 addendum 原样；「禁 AWM 全量重写」指 prompt 层必须带旧卡上下文，不禁止整卡落盘 |
| D9 | 队列 `tc_distillQueue`（数组，上限 10 溢出丢最老）；enqueue 后立即 drain（SW 活着）；alarm `tc_distill`（队列非空时创建 1min 周期、清空即除）+ boot 时 drain 兜底；job attempts ≤2 超限丢弃；卡片写入幂等（upsert by `host::slug`）。**异步语义**：run 终态收口后才入队——不阻塞 journal/广播/浏览器收口，蒸馏期间用户可开下一任务（蒸馏独立 LLM client + IDB 写草稿，与 run 单飞互斥无关） | MV3 SW 被杀不丢任务；LLM 60s 级调用靠 keepalive hold 保活 |
| D10 | settings 扩 `selfEvolution?: { enabled: boolean; distillCard: string }`（enabled 默认 true；distillCard 空串 = 复用主卡） | 附属卡形态对齐 judgeCard/taskSkillCard；总开关供评测/用户关停 |
| D11 | 审阅面放 **options 页**（空间够编辑）；OPTIONS_OPS +3（`list-skill-drafts` / `adopt-skill-draft` / `discard-skill-draft`）；sidepanel 只收 `skill-drafts` 广播轻提示（SW_TO_UI_KINDS 9→10）；**core 事件枚举不动**（9 类面保 Python 对齐——蒸馏可观测走 SW 日志与广播，偏离声明） | options 已有技能库视图与单发请求面先例；不动 core 事件是移植保真纪律 |
| D12 | 阶段 0 质量门：`examples/self-evolution/distill-and-rerun.mjs`（真实 LLM+浏览器，手动跑）——跑任务→门控→蒸馏→写卡到 `_self-evolution-sandbox/`（`_` 前缀不入库）→ FsSkillSource(rootDir=沙箱) 二跑对拍步数/token/时长。**结论回填 issue 后再进 S3-S6** | 6-8d 投注前先验证自蒸馏卡质量；FsSkillSource 构造已收 rootDir 参数 |
| D13 | v1 只蒸任务级卡；host 级站点卡聚合更新（quirks 沉淀）留 v2 | 任务卡有 matcher 消费闭环；站点卡聚合更新无对应消费增量 |
| D14 | matcher 命中 **built-in** 卡 → 跳过蒸馏（记日志）；增量更新仅对 `sourceType==="distilled"` 卡（import 到货后再定） | 内置卡是上游打包物：本地原地覆盖会把 provenance 改掉、**遮蔽扩展更新时的 built-in 刷新**（upsert 只认 built-in 才覆盖）；且内置卡手工策展，重蒸价值低。「本地改进内置卡」（fork 成 distilled 卡）留 v2 |
| D15 | 蒸馏卡只落宿主存储（扩展=IDB），**不回写仓库 `domain-skills/`**；产物格式与目录卡同构（三件套+meta），手动拷贝可晋升 built-in；导出功能留 v2 | 目录是打包源（embed-skills→json→安装时单向 upsert），非用户数据面；格式同构是 §6.2 互导要求 |
| D16 | node-host 钩子：`runAgent` 加 opt-in `distill: { skillsDir }`——门控（同 D1 判据）→ 序列化+脱敏 → core 蒸馏编排 → 写目录四文件；**同步 await**（runAgent 返回前完成——Node 无 SW 生命周期约束，脚本形态本就要等产物，阶段 0 二跑依赖它）；复用装配好的 LLM（matcher+蒸馏共用；独立卡 env 覆盖留后续）。目录格式无 provenance 面：目标目录内既有卡皆可增量更新（D14 的 built-in 跳过是扩展 IDB 概念，此处不适用）；审阅语义 = 操作者看文件/进 git（TreeForge 离线管线同款）。**不传选项行为不变**——现有 24 示例零改动零蒸馏 | 用户裁定提进 v1（2026-10-23）：编程路径真正沉淀技能；扩展与 Node 复用同一 core 编排（`distillTaskCard`），不双写 D6/D14 逻辑 |
| D17 | **收敛循环**（用户裁定提进 v1，2026-10-24）：探索建卡 → 带卡跑 → 增量蒸馏循环，直到「连续 N 次成功且无新观察」跳过蒸馏。①判定器 = 蒸馏调用兼任（增量输出 schema 加 `has_new_observations`；false → `unchanged`：卡内容不动只累计 streak；漏报按 true——不误判收敛）；②streak 持久在卡 meta（node `_task.json.distill_streak` / 扩展 SkillCardData 同名字段——v2 治理元数据位提前启用这一项）；③判停先于判定器：streak ≥ 阈值（缺省 2）→ matcher 命中后直接 skip，蒸馏调用都不发。已知边界：收敛后同任务不再自动重蒸馏，陈旧重验（lastVerified）仍留 v2 | 用户流程模型把收敛当循环核心而非可选治理；原 v1 只有「更新路径」没有「不动」与「不再蒸」两个状态 |

### 宿主覆盖面（评审 Q2 澄清）

蒸馏**能力本体**在 `@tw/core`（DistillEvaluator 平台无关、构造注入 LLM）——任何宿主可接线。本分支交付的**自动闭环**（门控/队列/后台蒸馏/审阅）只在扩展宿主（第一个产品宿主，M7 验收形态）。其它宿主：

- **examples / 编程运行**：core 能力直接可调；**v1 交付 node-host 钩子（D16）**——`runAgent` 加 opt-in `distill` 选项：不传 = 行为不变（现有 24 示例零改动）；想蒸馏的示例加一行选项即可。阶段 0 脚本（S2）建立在钩子之上做两跑对拍。
- **web-console（M6 后）**：复用 core `DistillEvaluator` + console-ui `SkillDraftReview`（组件平台无关）+ protocol `skill-drafts` 消息；宿主侧自接 fs 草稿存储与 HTTP/SSE 面。
- **cli/tui（未来）**：同 core 件，审阅面换终端交互。

与权限门、skill 存储同一模式：核心是库，宿主是壳，各宿主只写自己的 glue。

### 已知质量局限（登记，阶段 0 验证对象）

本仓 trace 是动作叙事（goal/action+params/result/url/title + done 步 domExcerpt），**无逐步 DOM 快照**——TreeForge quirks 提取依赖 page context（DOM 阶段对比），蒸馏 quirks 质量预期弱于 TreeForge 人工示教管线。若阶段 0 证明不足：v1.5 把 sense 侧 element_tree_text 摘要（截断）纳入 trace 序列化（成本：蒸馏 prompt token 上涨）。

## 2. 组件改动清单

| 层 | 文件 | 改动 |
|---|---|---|
| core | `agent/skills/trace-serialize.ts`（新） | 共享轨迹序列化器（judge.serializeHistory 方法体纯搬移） |
| core | `agent/judge.ts` | serializeHistory 委托共享模块（行为不变，锚定测试保持绿） |
| core | `agent/skills/distill.ts`（新） | `DistillEvaluator`（DistillLLM 注入面：structuredCall + 2 次尝试 + 60s 超时 + fail-soft null）+ `distillTaskCard()` **编排**（matcher 预匹配 → 增量/新卡 → 蒸馏 → 草稿；D14 保护判定可注入；**D17 收敛**：`cardDistillState` streak 判停 + `has_new_observations=false → unchanged`）+ `SkillCardDraft` 类型 + 产物校验（schema/非空/PII 正则）+ slug 归一化。**双宿主复用**：扩展 worker 与 node 钩子同入口 |
| core | `agent/skills/distill-prompt.ts`（新） | prompt 常量（TreeForge 任务级模板移植：消费端动作词汇表 + selectors/quirks spec + slug 规则 + 实体值规则 + 增量 addendum） |
| core | `agent/skills/types.ts` | draft 相关共享类型（如需） |
| core | `index.ts` | 导出面：DistillEvaluator / SkillCardDraft / 序列化器 / sensitive 文本脱敏 helper（若 sensitive-observability 未导出 text 级函数则补） |
| core 测试 | `test/agent/skills/distill.test.ts`（新）+ judge 锚定回归 | mock DistillLLM：正常解析/畸形 fail-soft/slug 归一/PII 门拒绝/增量模式拼装/脱敏断言（真值不出现） |
| node-host | `packages/node-host/src/agent-boot.ts` | `runAgent` opt-in `distill: { skillsDir }`：门控（D1）→ 序列化+脱敏 → core `distillTaskCard` → 写目录四文件（`<host>/tasks/<slug>/`：`_sop.md`/`selectors.md`/`quirks.md`/`_task.json`）；不传选项零副作用 |
| node-host 测试 | `packages/node-host/test/`（新用例） | 钩子：门控过 → 四文件落临时目录（meta 完整）；门控不过 → 零写入；目标目录既有卡命中 → 增量路径；不传选项 → 无副作用 |
| examples | `examples/self-evolution/distill-and-rerun.mjs`（新） | **收敛循环**（D17 重构）：沙箱默认保留（积累模式，有卡直接进带卡循环）、`--fresh` 显式清空（`_` 前缀护栏）、`--runs N`/`--converge N`；收敛后预算允许自动追加「收敛验证轮」（应日志 converged — skip 且卡零改动）；报告逐轮表 + 卡终态（source_traces/distill_streak/distilled_at）+ 收敛判定 + 注入增益 |
| ext host | `skill-store.ts` | `status`/`sourceTraces` 字段；`saveDraft` / `adoptDraft(host,slug,edits?)` / `discardDraft` / `listDrafts`；adopt 经 mutation queue 串行 |
| ext host | `skill-source.ts` | 读侧三面（loadHostSkill/taskCatalog/taskCardText）过滤 `status==="draft"` |
| ext host | `settings-store.ts` | `selfEvolution` 配置块（宽松收窄，缺省 enabled） |
| ext host | `keepalive.ts` | `hold()/release()` 引用计数（蒸馏期间保活，run 语义不变） |
| ext runtime | `distill-queue.ts`（新） | storage 队列：enqueue/drain/ack/attempts（窄 storage 面注入可测） |
| ext runtime | `distill-worker.ts`（新） | drain 一条：装配 LLM（distillCard 缺省主卡）→ matcher 预匹配 → core distill → 草稿落库 → 广播 skill-drafts |
| ext runtime | `run-manager.ts` | drive() done 分支：门控（D1）→ 序列化+脱敏 → enqueue → kick drain；selfEvolution.enabled=false 短路 |
| ext 入口 | `background.ts` | boot 装配 worker（storage/alarm 监听 + boot 时 drain）；options 面 3 个新 op |
| protocol | `index.ts` | OPTIONS_OPS 6→9；`SwSkillDraftsMessage`（SW_TO_UI_KINDS 9→10）；`SkillCardInfo` + `status?` |
| console-ui | `skill-draft-review.tsx`（新）+ `skill-list-view.tsx` + `index.ts` | 审阅组件（列表/展开/三件套可编辑/采纳/丢弃）；列表视图补状态列；导出 |
| ui-glue | `options-app.tsx` | 审阅面接线（request 单发三 op）；技能库区加草稿入口 |
| e2e | `e2e/smoke-self-evolution.mjs`（新）+ package.json | 全链路：mock LLM 成功 run → 队列 → 蒸馏（mock 卡）→ IDB 草稿 → options 采纳 → 二跑 `skill_active` 事件含 taskSlug（M7 验收句） |
| 不动 | core 事件枚举、task-matcher、prompt-consts、 FsSkillSource、embed-skills | matcher 原样复用；prompt-consts 只进 Python 锚定面 |

## 3. 测试计划

| 层 | 用例 |
|---|---|
| core distill | 正常产物解析全字段；畸形/空输出 fail-soft null；超时 2 次尝试后 null；slug 归一化（kebab/截断/撞名后缀）；PII 门（含邮箱/手机号的产物拒绝或打码——按实现定，测试钉行为）；增量模式 prompt 含旧卡文本；脱敏：序列化串中敏感真值替换为占位符 |
| core trace-serialize | judge 锚定测试保持全绿（纯搬移验证）+ 新增直接单测 |
| node-host 钩子 | 门控通过 → 四文件落盘（meta 完整）；门控失败/judge 缺失 → 零写入；既有卡命中 → 增量；不传选项 → 无副作用 |
| skill-store | draft 写/读/列举；adopt（含 edits 应用 + status 翻转 + sourceTraces 并集 + distilledAt 刷新）；discard 删除；adopt 非 draft 卡防御拒绝；mutation queue 串行 |
| skill-source | draft 卡不出现在 loadHostSkill/taskCatalog/taskCardText（三面单测） |
| distill-queue | enqueue 上限溢出丢最老；drain 逐条 ack；attempts 递增与超限丢弃；storage 坏形态防御 |
| distill-worker | happy path（mock LLM → 草稿落库 → 广播）；matcher 命中 distilled 卡走增量/slug 复用；matcher 命中 built-in 卡跳过蒸馏（D14）；LLM 失败重试后 job 保留；selfEvolution.enabled=false 不 drain |
| run-manager 门控 | successful+verdict true → enqueue；verdict false → 不入队；judgement null → 不入队；interrupted/error → 不入队；脱敏真值不入队 |
| background options | 三个新 op 载荷校验与 fail-soft |
| protocol | kind 表 9→10 / ops 6→9 exhaustive 断言更新 |
| console-ui | 审阅组件渲染/编辑/回调；列表状态列 |
| e2e | smoke-self-evolution 全链路 PASS（真 Chrome+SW+IDB） |

## 4. 实施进度

- [x] S1 core 蒸馏器 + trace 序列化提取 + 单测（2026-10-23：`skills/{distill,distill-prompt,trace-serialize}.ts` + 23 用例；judge 锚定回归绿；门禁全绿）
- [x] S2a node-host 蒸馏钩子（D16）+ 单测（2026-10-23：`distill-run.ts`（门控/host 多数票/编排/四文件落盘+source_traces 并集）+ runAgent `distill` 选项 + AssembledAgent.llm 复用面；86 用例全绿）
- [x] S2 阶段 0 脚本 + 真机质量验证 → **决策门：通过**（2026-10-23 真机两跑对拍：12 步→6 步 / 239s→119s / input tokens ~64.6k→~31.4k（均 -50%），两跑 successful+judge pass+答案正确；卡命中注入链全通；quirks 6 条全 DOM 外知识含试错教训、实体值泛化正确。随跑修订：①蒸馏 prompt「引用 trace 步号」改「描述触发情境」②agent-boot llm 双前缀修复。结论已回填 issue #5（comment 6357338163））
- [x] S3 扩展存储/读侧（2026-10-24 完成：SkillCardData + status/sourceTraces/distillStreak（D7/D17 可选字段零迁移）；**草稿独立 `draft::` 键空间**——增量草稿与在用卡共存到采纳，不遮蔽注入（比 D7 原文的同键 status 标记更安全，读侧三面过滤保留为 belt-and-suspenders 兜底）；saveDraft/listDrafts/adoptDraft(edits+sourceTraces 并集旧在前+streak 归 0+正键 built-in 占用拒收 D14)/discardDraft；adopt 经构造注入串行面（mutation-queue 缺省直通，S5 接线真队列）；ExtensionSkillSource 三面 draft 过滤 + `invalidate()` 缓存失效面（采纳后重读见新卡——无失效机制缓存会喂旧状态）；settings selfEvolution 块宽松收窄 + `selfEvolutionOf` 缺省 {enabled:true, distillCard:""}。测试 +11（草稿生命周期 7 + 读侧过滤/失效 2 + settings 2），扩展 118 全绿）
- [x] S4 runtime（2026-10-24 完成：**core 门控/host 纯函数下放**（distill-gate.ts：passesDistillGate/dominantHostOf 自 node-host 迁入，node-host re-export 保 API 面——扩展与 Node 同判据）+ DistillTaskInput 加 `traceText/stepCount` 预序列化入口（队列持久化边界：轨迹入队时已序列化+脱敏，SW 重启仍可蒸馏）+ isUpdatable 允许异步；**扩展 runtime**：distill-queue.ts（tc_distillQueue 持久队列：runId 幂等/上限 10 丢最老/peek-ack/fail 记账 attempts≤2）+ distill-worker.ts（drainAll 防重入+keepalive hold：LLM 装配 distillCard 缺省主卡 → core distillTaskCard（isUpdatable=仅 distilled 卡 D14、cardDistillState 读 streak D17）→ draft 落库+notify / unchanged 走 bumpDistillStreak / skip ack / error 记账）+ run-manager done 分支门控入队（selfEvolution 短路→门控→host 多数票→序列化+脱敏+截断→enqueue+kick，全 fail-soft）+ keepalive hold/release 引用计数（run 与 hold 任一在位保活）+ background 接线（worker 晚绑定构造、tc_distill alarm 非空建/清空除、boot 兜底 drain、notify 先落日志面）。测试 +17：queue 4/worker 7/门控 5/keepalive 1；全仓 core 1370 + node-host 89 + extension 135 全绿）
- [x] S5 protocol/UI 审阅面（2026-10-24 完成：protocol——SW_TO_UI_KINDS 9→10（`skill-drafts` 广播 + SwSkillDraftsMessage）、OPTIONS_OPS 6→9（list/adopt/discard-skill-draft）、SkillCardInfo+status?、SkillDraftInfo 草稿全文投影；background——三个新 op（载荷校验+edits 宽松收窄+fail-soft）+ worker notify 接真广播（skill-drafts）；console-ui——SkillDraftReview 新组件（列表/展开/描述+关键词+三件套可编辑/采纳带 edits/丢弃）+ SkillListView 状态列（draft 徽章）；ui-glue——options-app 审阅面接线（refresh 并拉草稿、采纳/丢弃后刷新+notice）、sidepanel-state+draftCount 轻提示（D11）。测试 +6：protocol exhaustive 更新（kind 10/样例）、console-ui 4（审阅组件渲染/编辑覆盖/收起切换/状态列）、extension 1（skill-drafts reducer）。覆盖一处 console-ui functions 阈值破线（84.72%）——补全字段编辑用例修复。全仓 167+51+1370+37+3+89+49+136 全绿）
- [x] S6 e2e smoke-self-evolution（2026-10-24 完成：`e2e/smoke-self-evolution.mjs` + `e2e:self-evolution` script。mock LLM 按 schema 键路由四种面（task_slug=蒸馏 / match=matcher / failure_reason=judge / agent_response=主循环步）。真机首跑即全链通：run1 done+judge verdict → 异步蒸馏 → IDB 草稿 1 张 + skill-drafts 广播 [1,1] → options op 采纳 ok → run2 matcher 命中注入 → **skill_active(taskSlug=click-fixture-button, chars=473)** + queueLeft=0；llm 计数 steps=4/judge=2/distill=2/matcher=2（run2 自身蒸馏链路顺带覆盖）。一处断言修正：host key 是 `_` 分隔目录键形态（127.0.0.1_8808，同 localhost_7780 惯例），非 `:`）
- [ ] S7 全量验收（typecheck/test/lint/gate 全绿）→ `/review-loop` → `/finish-issue`

## 5. 风险与已知项

- **AOCI 认知维护待分支收尾**：本分支新增/修改了多个受管理对象（core skills 三件、node-host distill-run、examples 两脚本等）——S3-S6 还会继续改扩展侧文件，按「最终稳定状态一次维护」原则推迟到 /finish-issue 前统一 aoci_maintain

- 蒸馏 quirks 质量弱于 TreeForge（无逐步 DOM 快照，见 §1 局限）——阶段 0 决策门兜底
- prompt 为新创作面（非 Python 锚定）——评审重点看 spec 块移植保真与产物校验兜底
- MV3 边界：alarm 最小周期 0.5min、LLM 调用 60s 级——keepalive hold + 队列幂等双保险；SW 在 LLM 调用中被杀 → job 未 ack → 下次唤醒重试（重复调用无害，写卡幂等）
- IDB（草稿本体）与 storage（队列）分离——单一写者纪律：草稿只经 SkillStore，队列只经 DistillQueue
- 工作区残留 main 带来的未跟踪文件（.archify/、docs/code-review/、AGENTS.md.backup）——提交时只挑本分支相关文件（issue #2 先例）
- 评测隔离：自进化默认只在扩展宿主开；评测仓走 core 配置（enableTaskSkillInjection 同款先例），本分支不改 core 默认值

## 6. 变更记录

- 2026-10-22 计划初稿（可行性评估 → issue #5 → 本计划；替换 issue #2 期 SCRATCHPAD 内容，其历史在 git）
- 2026-10-23 计划修订（评审 Q1/Q2）：产物落点与两层增量语义澄清（D8 细化）；新增 D14（built-in 命中跳过蒸馏——修补 D6 与测试计划的原不一致）与 D15（不回写仓库目录）；新增「宿主覆盖面」小节
- 2026-10-23 范围裁定（用户）：node-host `runAgent` opt-in 蒸馏钩子提进 v1（D16 + 进度 S2a）；core 蒸馏编排 `distillTaskCard` 双宿主复用；阶段 0 脚本改建于钩子之上。暂不开工，待放行
- 2026-10-23 S1 完成：core `agent/skills/` 新增 distill.ts（编排：matcher 预匹配→增量/新卡→2 次尝试→PII 门→SkillCardDraft）/ distill-prompt.ts（TreeForge 任务级模板移植，词汇表守卫测试钉 ACTION_DEFINITIONS 同步）/ trace-serialize.ts（judge.serializeHistory 纯搬移，锚定测试经委托保持绿）；index.ts 导出面扩展；新增测试 23 例（core 总 1364 全绿，门禁 quality 全过）
- 2026-10-23 S2a + S2 脚本完成：node-host `distill-run.ts`（passesDistillGate 严格 D1 / dominantHostOf 多数票 / distillAfterRun 编排 fail-soft / writeTaskCard 四文件+source_traces 并集）+ runAgent `distill` 选项 + AssembledAgent.llm 复用面 + index 导出；`examples/self-evolution/distill-and-rerun.mjs`（跑 1 无卡基线+钩子 → 沙箱产物 → 跑 2 注入对拍）；node-host 86 用例全绿（distill-run 92.66% 语句）；门禁全绿
- 2026-10-23 阶段 0 决策门**通过**（用户真机跑，日志 D:\temp\tree-walker\log\distill-and-rerun.log）：步数/耗时/token 三项 -50%，judge 双 pass，卡命中注入。随跑修订两处：distill-prompt 步号引用改触发情境描述（产物卡 quirk 引「(步骤 5→6)」对未来 run 无意义）；agent-boot 主 llm sink 去掉重复 [llm] 前缀。门禁复跑全绿。遗留观察：跑 2 有 2 步防御性 evaluate 验证（quirks 已含相关知识但模型仍 verify）——quirks 表述强化是 v1.5 提升空间，不阻断 S3
- 2026-10-23 沙箱防误删护栏（用户问询暴露脚枪）：`--sandbox` 传非 `_` 前缀目录（如真实 domain-skills）会被脚本整目录 wipe——加 `_` 前缀校验拒绝并指引 D15 手动拷贝路径；实测拦截生效、内置库未动
- 2026-10-23 脚本加 `--distill-run2` 开关（默认关）：跑 2 也开蒸馏钩子，验证「用卡成功 → 卡被增量精炼」路径（matcher 命中沙箱卡 → 旧卡进 prompt → source_traces 并集 + distilled_at 刷新）；对拍数字不受影响（蒸馏发生在跑 2 完成后）。报告尾新增增量结果核查段
- 2026-10-24 **D17 收敛循环落地**（用户纠正流程模型：增量蒸馏要有「不动」与「不再蒸」状态，原实现是每次成功无条件重写）：core distill 加 `has_new_observations` 判定（false→unchanged/漏报按 true）+ `cardDistillState`/`convergeThreshold` 判停（streak≥N → 零蒸馏调用 skip）；node-host `_task.json.distill_streak`（unchanged 只重写 meta、内容与 distilled_at 不动；写入即归 0）+ `bumpDistillStreak`；脚本重构为收敛循环（沙箱默认保留积累、`--fresh`/`--runs`/`--converge`、收敛验证轮、删 `--distill-run2`）。测试 core 28 + node-host 新增 3（unchanged/streak 跳过/归零），全量门禁绿（1369+89）。既有「增量：既有卡 source_traces 并集」用例经 seed 卡顺带覆盖 streak 语义
- 2026-10-24 收敛循环首跑（distill-and-rerun-2.log）：19→21→8→4 步全 judge pass，run2/run3 增量更新（run2 的「input_text 填日期无效须 JS 设值+JS 提交」、run2 的「行重复不去重以 footer 对账」被折进卡——增量观察实收），run4 首次无新观察（streak=1，--runs 4 到限未收敛）。**暴露 LLM JSON 双重转义 bug**：产物 md 换行全是字面量 `\n`（模型在工具输入里写 `\\n`，可正常解析故漏过重试）——distill.ts 加 `unescapeLiteralNewlines` 确定性修复（判定口径：trim 后内部无真换行才反转义——首版守卫被 writeTaskCard 行尾 `\n` 骗过）+ 测试；沙箱卡已修复（sop 29 行/quirks 10 行）；门禁绿
- 2026-10-24 S3 完成：扩展存储/读侧（skill-store 草稿键空间与生命周期、skill-source 三面过滤+invalidate、settings selfEvolution）。期间裁定一处设计偏移：草稿走独立 `draft::` 键而非同键 status 标记——同键会让增量草稿在审阅期顶掉在用卡且采纳时 sourceTraces 并集无源可并
- 2026-10-24 S4 完成：runtime 链路（queue/worker/门控/keepalive hold + background 接线）。要点：①门控/host 判定下放 core（双宿主同源）；②队列携带预序列化+脱敏轨迹文本（core 加 traceText 入口）——持久化边界不再依赖进程内 AgentHistory；③worker 的 D14 保护 = isUpdatable 回调（仅 distilled 卡可增量，built-in/import 命中即 skip）；④unchanged → bumpDistillStreak（skill-store 新增，内容/distilledAt 不动）。notify 面暂为日志——S5 接 protocol 广播与 options 审阅 op
- 2026-10-24 S5 完成：protocol/UI 审阅面全链（广播轻提示 + options 审阅/编辑/采纳/丢弃）。options 三 op 的 background 处理无单测面（entrypoint 不可 import）——载荷校验经 console-ui/ui-glue 层与 S6 e2e 覆盖（M7 验收句走 e2e）
- 2026-10-24 S6 完成 + S7 全量验收绿（typecheck 0 错误 / 1902 单测全绿 / biome 净）：e2e smoke-self-evolution 真机 PASS。**扩展侧全链（S3 存储→S4 runtime→S5 审阅面→S6 e2e）实现完毕**，待提交 → /review-loop → /finish-issue
- 2026-10-24 merge main（5fbbb7f，冲突仅 SCRATCHPAD 取本分支版）→ 全仓 1911 绿（dom-snapshot 176 = #6 修复入树）
- 2026-10-24 **--fresh 观察性验收完成**（跑 4/5 日志）：①门控拦截幻觉失败实证（Judge 逐条点名无证据断言「全站无数据」，毒卡未入闭环）；②收敛机制全链正常（17 步建卡→4 步→无新观察×2→converged skip）；③最优性盲区定性（Day/Month：成功信号区分不了「正确但笨」与「正确且优」——单轨迹过拟合仍在，危害被掩盖）。观察 + v2 候选（效率信号进闭环：简化机会纳入合法新观察）已登记 issue #5（comment 6384317522）
- 2026-10-24 **抖音实测 + 卡剧本锚定发现**（`examples/douyin-upload-analysis.mjs` 新脚本：逐段计时 + 收敛可见性）：三轮 45 步✗ / 18 步✓ / 带卡 8 步（-56% 步 -66% 时 -62% token）但**剧本锚定幻觉收尾**（弹层未开即 done 虚构全项完成，Judge 拦下 *"entirely fabricated"*，增量蒸馏被门控阻断）。慢点归因：model 段 76-82% 墙钟（thinking 模型 10-16s/调用 × ~14k input tokens）。已登记 issue #5（comment 6384681538）+ v1.5 缓解方向（防锚定措辞 + done 前自检提示）
- 2026-10-24 **扩展实测三缺口修复**（用户真机跑扩展暴露）：①journal 快照持久化 judgement（verdict/reasoning/failureReason——收尾后可查「为什么没蒸馏」）+ FinalResult Judge 徽章与折叠判词；②sidepanel 草稿数打开/重连主动查询（广播即发即逝的漏看窗口）；③蒸馏调用超时可配置（core callTimeoutMs 覆盖项）+ 扩展 worker 放宽 180s（长轨迹 thinking 模型 60s 实测不够，真机超时实证）。修复后用户真机全链验证通过：跑任务 → Judge 通过 → 蒸馏出卡 → options 审阅采纳 → 技能库可见 → 二跑 matcher 命中注入 2773 字符。另确认一个移植保真边界：任务卡匹配每任务一次锚定起始 host——起跑页≠目标站则不注入（v1.5 候选）

## 7. 评审轮登记（/review-loop，base=main）

### 轮 1（2026-10-24，ocr 21m，9 条意见 high:2 medium:5 low:2 → 全采纳，驳回 0）

- **#3（P1）SkillStore 串行面生产失效**：构造缺省直通 + background 未注入——bumpDistillStreak 与 adoptDraft 竞态可静默回退已采纳卡。修复：缺省改内建 promise 链（host 层内联 mutation-queue 同款），且**全部写路径**（saveDraft/discardDraft/adopt/bump/built-ins upsert+prune）共面——#4（save/discard 绕过面）同修
- **#9（P1）douyin 分析脚本基线污染**：探索轮未显式关 skillSource → runAgent 缺省按 CWD "domain-skills" 注入仓库内置卡（agent-boot.ts 实证）——「无卡基线」实为带内置站点卡。修复：`skillSource: withCard ? FsSkillSource : null`
- **#7（P2）worker 落库段异常逃逸**：saveDraft/taskCatalog 抛错时 job 既不 ack 也不 fail → alarm 每分钟无限重跑完整 LLM 蒸馏。修复：distillOne 全路径 try/catch → 统一 queue.fail 记账
- **#8（P2）队列读改写无互斥**：enqueue（run 终态）与 ack/fail（worker）并发交错丢更新（ack 复活/新 job 丢失）。修复：DistillQueue 内建 promise 链串行 RMW
- **#1（P2）关键词回显被空串遮蔽**：展开时 patch({}) 把 keywordsRaw 钉 ""（非 nullish）→ 草稿原词永不回显。修复：不预建编辑态
- **#2（P2）编辑态残留**：采纳/丢弃后同键新草稿吃到过期编辑。修复：clearEdits
- **#5/#6（P2）judgement 字段名**：example 脚本读 snake（impossible_task/failure_reason），core JudgementResult 是 camel——恒 undefined。两个脚本修正
- 测试 +6（store 串行面计数/内建链、queue 并发无丢失、worker 落库异常记账、组件关键词回显/编辑态清理）；全仓 1923 绿

### 轮 2（2026-10-24，增量审 661e6ac..e7be1d5 即轮 1 修复提交，耗时 5m47s，意见数 0 → 收敛）

零意见、状态 complete；无修复提交。累计 2 轮：意见 9 / 采纳 9 / 驳回 0 / stale 0（P1×2 + P2×7），分支提交 7 个（含 AOCI 资产与 merge）。P3 backlog 空。

