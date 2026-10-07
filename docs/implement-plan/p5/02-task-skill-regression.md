# P5.5 续：任务级 skill 匹配离线回归 harness（02-task-skill-regression）

> 状态：2026-10-07 起草，待用户确认后开工（建议并入 `feat/p5-skill-face` 分支同批评审）。
> 源：`TreeWalker/examples/p7_task_skill_match_regression.py`（324 行，docs/p7/04 §七 S3 / issue #182）。
> 性质：P5.5 skill 面的配套——matcher 的离线回归门（prompt 迭代省真机全量），非浏览器示例。

## R1. 源件行为（移植面）

无浏览器：44 卡 catalog × 184 任务文本批量跑 `matchTaskSkill`（纯 LLM 调用），量
回放正确命中 / 泛化正确命中（模板等价类判定）/ 跨模板误命中 + 降档数 + 分级字段分布 +
按模板聚合（零命中模板/无卡模板单列）。`--gate` 门槛：回放 44/44 且泛化 ≥80%（退出码）。

关键语义（逐条锚定，多处是 review 修订成果）：

| 行为 | 锚点 |
|---|---|
| 任务文本组装对齐 runner（`{intent}\n\n起始页: {start_url}`，无 fallback 分支） | :166-169 |
| 数据三守卫 fail-fast：任务缺 intent/start_url/intent_template_id 启动即拦；catalog 卡缺 replay 映射拦；replay 陈旧 slug 拦（防 184 调用后统计期 KeyError/门槛永久 FAIL） | :66-71/:135-150 |
| 重试：harness 层 3 次（matcher 内部 1 次之外），**信号量只在调用期占槽**（退避不占——防故障突发时并行度塌零），末次失败不空等 | :89-101 |
| 持续调用失败剔除命中率分母 + metrics 单列 `call_failed_persistent` + 门槛不判 PASS（基础设施故障 ≠ 匹配语义） | :196-202/:300-307 |
| 模板等价类：卡模板 = 本尊任务 intent_template_id；命中同模板另一张卡算正确命中 | :152-153/:184 |
| `--limit` 前缀可能无变体 → 除零守卫（variant_rate=0） | :263-264 |
| 输出 JSON（metrics/zero_hit/no_card/per_template/全量 rows 含 reason）+ 控制台报告 | :262-298 |
| catalog 装载：仓库根绝对路径 domain-skills（不依赖 CWD） | :116-119 |

数据依赖：`--eval-root` 指评测仓（`webarena_repo/config_files/test.raw.json` 的 184
shopping_admin 任务 + `config/replay_map.json` 44 映射）——本地
`D:/dev/git/z_jordon/evals/webarena` 两文件均在；catalog 用本仓 `domain-skills/localhost_7780`
（P5.5 已落地，44 卡）。

## R2. 缺口修复：taskSkillLlm 专用匹配模型（Python 生产面，TS P4 漏移植）

Python：`AgentSettings.task_skill_llm: LLMSettings | None`（config.py:197；env
`AGENT_TASK_SKILL_MODEL` 空串 = None 复用主 llm，四键 `AGENT_TASK_SKILL_{MODEL,API_KEY,BASE_URL,MAX_TOKENS}`
缺省链 key→主卡 / baseUrl→智谱端点 / maxTokens→2048，config.py:575-583）；agent.py:160-163
构造独立 LLMClient，:553 匹配调用用它。**TS 侧恒用主 llm（agent.ts:389）——生产保真缺口**。

TS 补法（extractLlm 先例——AgentOptions 注入位，不挂 core AgentSettings）：

- **core 一处小扩面**：`AgentOptions.taskSkillLlm?: LLMClient | null`；agent 构造快照
  `this.taskSkillLlm = options.taskSkillLlm ?? null`；matchTaskSkill 调用点
  `this.taskSkillLlm ?? this.llm`。
- **node-host**：HostSettings.llm 增 `taskSkill: { model; apiKey?; baseUrl?; maxTokens } | null`
  （FALLBACK 同款缺省链，env 四键）；assembleAgent 构专用 LLMClient → `AgentOptions.taskSkillLlm`
  （显式注入位 `taskSkillLlm` 同开）。
- 本仓 harness 镜像 agent 接线消费同一 env 面。

## R3. TS 形态

`examples/p7-task-skill-match-regression.mjs`（根层示例惯例单级 `../` import；
零依赖手搓 argv 解析与信号量）。分块：

1. 装载：repo 根 `domain-skills` 绝对解析（fileURLToPath 回退两级——镜像 REPO_ROOT 不依赖
   CWD）→ `FsSkillSource.taskCatalog(hostKey)`；
2. matcher LLM：`loadHostSettings` → `settings.llm.taskSkill` 非空构 `LLMClient` 否则主卡
   （buildProviderCard 形态——Python :124-130 镜像）；
3. 数据三守卫 + 重试信号量（槽只罩调用期）+ Promise.all 并发；
4. 归类统计/门槛/报告/JSON——逐段锚定 R1 表（含 `_dist`、per_template、
   `call_failed_persistent`、除零守卫、ensure_ascii=False ↔ JSON.stringify、indent=2）；
5. 输出缺省 `<repoRoot>/out/task_skill_match_regression.json`；**.gitignore 补 `out/`**
   （运行时产物，与 evaluate_output/ 同类纪律）。

## R4. 测试

- core +2 例：AgentOptions.taskSkillLlm 注入 → 匹配收专用 client（FakeAgentLLM 双实例，
  structuredCall 命中专用侧）+ 缺省 null 复用主 llm。
- node-host +2~3 例：AGENT_TASK_SKILL_* 四键 env 链（空串=null、缺省链复用主卡 key/智谱
  baseUrl/2048）、assembleAgent 三态（settings 驱动构造 / null / 显式注入位）。
- harness 本体无单测（examples 惯例；matcher 核心已有测试覆盖，harness 是数据编排）。

## R5. smoke 与真机

- smoke（本机可代办）：`--eval-root D:/dev/git/z_jordon/evals/webarena --limit 2
  --concurrency 2` ——2 次真匹配调用（分钱级）验全链（数据装载/守卫/匹配/统计/落盘）。
- 44/184 全量 + `--gate`：留用户跑机（~184 次调用；B/C 轮前的 prompt 迭代门槛件）。

## R6. 实施步骤

并入 `feat/p5-skill-face`（同属 P5.5 skill 面，一轮评审覆盖）：① R2 缺口修复（core+node-host）
→ ② harness 本体 + .gitignore → ③ 测试 → ④ 全绿+门禁 → ⑤ smoke → ⑥ 方案登记 → ⑦ /review-loop
（用户触发，diff 覆盖 08496d5 起全部分支增量）→ ⑧ 授权合并。

## R7. 实施结果（2026-10-07）

- **R2 缺口修复**：core `AgentOptions.taskSkillLlm`（extractLlm 同款注入位；matchTaskSkill
  调用点 `this.taskSkillLlm ?? this.llm`——agent.py:160-163/:553 镜像）；node-host
  `HostSettings.llm.taskSkill` 四键 env（AGENT_TASK_SKILL_*，baseUrl 缺省走智谱端点常量
  **非主卡 baseUrl**——config.py:578-581 硬编码语义）+ mergeHostSettings 二级合并（fallback
  同款纪律）+ `buildTaskSkillCard` 导出（assembleAgent 与 harness 复用）+ AssembleAgentOptions
  显式注入位；boot-entry 名单 +`matchTaskSkill`（harness 消费面，smoke 实跑暴露后补）。
- **harness**：`examples/p7-task-skill-match-regression.mjs`——R1 锚定表逐条落地（三守卫
  fail-fast / 信号量只罩调用期 / 持续失败剔分母 + 门槛不判 PASS / 模板等价类 / 除零守卫 /
  dist/per_template/zero_hit/no_card / JSON 输出 ensure_ascii=False↔JSON.stringify）；
  .gitignore 补 `out/`。
- 测试：core 1299→1300（taskSkillLlm 双向 spy——专用侧命中/主侧零调用 + 缺省复用主）；
  node-host 69→72（AGENT_TASK_SKILL_* env 链四形态 / taskSkill 二级合并 / assembleAgent
  三态 / buildTaskSkillCard 缺省链含 baseUrl 非主卡断言）；全仓 1590 绿 + 门禁 exit 0。
- **smoke 全通**（--limit 2 --concurrency 2 真匹配调用 12.5s）：catalog 44 / tasks 184
  （replay 44 / variants 140，44 卡 over 37 模板——docstring「42 模板」系早期数据版叙事，
  同数据同算式 Python 亦 37）；回放 2/2 exact 命中（same_task 分级）、泛化 0/0 除零守卫
  工作、明细落盘 out/（已清理）。matcher LLM 走主卡（.env 无 AGENT_TASK_SKILL_MODEL——
  镜像接线生效）。44/184 全量 + --gate 留用户。

## R8. 全量对拍与修复（2026-10-07，用户跑 TS 184 全量 vs Python 2026-09-20 轮）

- **一致性面**：任务数据逐任务全同（184/42 模板/template_id/intent 零差异）；回放面完全
  一致（44/44/44/44、missed 空）；cross_template 同为 [458-463]；分级分布形态同
  （replay 全 same_task；variants 以 same_template 为主）；变体**率**几乎同
  （命中 85.4%/85.0%，正确 80.8%/80.7%——均过 80% 线）。
- **d9b2fcd 修复（TS 键类型陷阱，Python 无此面）**：perTemplate 经对象键化后
  Object.keys/entries 是字符串、卡模板集合是数字——`Set.has` 严格等值恒 false →
  no_card 全量误报（39 vs 正确 5）、zero_hit 恒空（vs 正确 []）。修复 = 两处 `Number(t)`
  归一 + 注释钉死陷阱；per_template 输出改数值序（Python sorted(int) 对照）。修正值
  经既有结果离线重算验证 = Python（no_card [42,247,255,280,288]、zero_hit []）。
- **TS 侧 10 个持续调用失败 vs Python 0**：全部「单次调用超时（15000ms）」——
  glm-5.3 思考型偶发超匹配器 15s 锚定超时（Python 轮模型快零超时）；被剔除出分母
  （设计内），per_template 计数差 = 这 10 任务的缺席。**--gate 轮因此不判 PASS（数据
  不完整）**——正解 = 设 `AGENT_TASK_SKILL_MODEL`（快速模型，如 flash/glm-5.1）重跑，
  此即 task_skill_llm 的存在意义；两侧模型不同（输出 JSON 不记模型，对照时注意）。

## R9. 思考强度档位（2026-10-07，用户 coding-plan 仅路由 glm-5.3 → 用 effort 降档替代换模型）

根因：anthropic 适配器请求体从不传思考参数（outputMode 只是 tool schema 文本分支不进
wire）→ 智谱网关默认 **max 档思考**（docs.bigmodel.cn/cn/coding-plan/latest-model：
`thinking.type`+`output_config.effort`，low/high/max，disabled 亦只降 low）→ 匹配调用
偶发超 15s。实施：

- **core**：`ProviderConfig.thinkingEffort?: "low"|"high"|"max"`（TS 新增面，Python 无）；
  anthropic-messages 请求体条件注入 `output_config:{effort}`（缺省不发）；单测双向锚定
  （注入形态 + 缺省键不存在锁）。
- **node-host**：主卡 `LLM_THINKING_EFFORT` env（缺省不发；非法告警回退）；taskSkill 卡
  `AGENT_TASK_SKILL_EFFORT`（**缺省 low**——匹配器时延敏感；登记为对齐 Python 快模型
  运行时行为的偏离）；`buildProviderCard`/`buildTaskSkillCard` 透传。
- 全仓 1592 绿（core +1 / node-host +1）+ 门禁 exit 0。
- **探针受阻**：实施时发现仓库根 `.env` 已缺失（用户此前全量跑尚在）——延迟对比探针
  未跑；验证并入全量重跑（taskSkill 卡 low 下 10 个超时任务应归零）。
- **用户侧用法**（coding-plan 单模型约束下）：`AGENT_TASK_SKILL_MODEL=glm-5.3`（同模型
  名也行——建出带 low 的专用卡，匹配器降档而主 agent 步骤保持 max）或
  `LLM_THINKING_EFFORT=low`（全局降档）。

**R9 补记（同日）**：根 `.env` 丢失（成因未明——git 无追踪/stash/回收站/备份均无；非
本会话命令所删，嫌疑为外部工具）。恢复：`packages/.env`（2026-09-30 的单键拷贝）尚在
盘上，key 经真调验证有效 → 恢复根 `.env`（key + LLM_MODEL；原 60 行其余键值用户按需
补回）。**探针补测完成**：max 档 9.0/6.5/8.1s vs low 档 4.3/4.9/5.1s——延迟近乎减半、
匹配结果一致（同 slug/high 置信）——R9 机制实证有效。

## R10. 评审与收敛记录（feat/p5-skill-face）

**轮 1（2026-10-07，全量 main..feat/p5-skill-face = 6 提交，66 文件，12m49s）**：2 条意见
（medium×1 + low×1），**P2×1 + 顺手修×1，全采纳**，零驳回零 stale；P3 backlog 空。
- **#1（P2）assembleAgent skillSource 显式 null 三态破缺**：条件 `!== undefined && !== null`
  把显式 null 与缺省混同——JSDoc 承诺「显式 null=关闭」，实际落入 skillsDir 分支照常构造
  FsSkillSource（缺省 "domain-skills" 存在时注入保持开启）——评测调 `skillSource: null`
  跑基线会被静默污染。修复：`!== undefined` 三态（taskSkillLlm 同款）；补「skillsDir
  非空 + 显式 null → agent.skillSource null」用例；双向验证（还原旧条件必红）。
- **#2（顺手修，low）harness CLI 边值**：`--concurrency` 缺值/非数字/0 → NaN 信号量
  `active < NaN` 恒 false，全任务静默死锁。修复：argparse 子集补值校验（value/intArg
  内联于循环、闭包消费循环变量；缺值/串开关/非整数即 exit(2) 带明确报错——Python
  argparse exit(2) 面同款）；--eval-root/--limit 同覆盖。实跑四边值形态验证。
- 测试：node-host 73 例（断言并入既有用例）；全仓 1592 绿 + 门禁 exit 0。

**轮 2（2026-10-07，增量 = 修复提交 f68de55 自身）**：实跑零意见（complete / 3 文件 / 1m3s）
——循环收敛。零采纳零驳回零 stale。

**累计（轮 1-2）**：意见 2 / 采纳 2（P2×1 + 顺手修×1）/ 驳回 0 / stale 0；P3 backlog 空。
