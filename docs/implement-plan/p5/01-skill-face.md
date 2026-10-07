# P5.5 skill 面详细实施计划（01-skill-face）

> 状态：2026-10-07 起草，待用户确认后开工。承接 p5/README.md §4。
> 基准：TreeWalker @640d52a（skills/{loader,task_loader,task_matcher}.py + agent.py:545-580）；
> TreeChrome @ba5f236（core 消费面 P4 已全通）。

## S0. 范围与核心结论

**目标**：补齐 skill 的宿主装载层与内容，使 `enableSkillInjection` / `enableTaskSkillInjection`
两个既有开关真正有东西可注入——供评测仓口径 B/C（经 link: 消费）与 M5 扩展前置。

侦察结论（2026-10-07）：

| 面 | 状态 |
|---|---|
| core 消费面 | **P4 已全通，本批零改动**：站点级 sense.ts:324-342 `buildSkillDescription`（[SOP]/[SELECTORS]/[QUIRKS] 头 + 读序 = loader.py:84-105 逐字节语义）；任务级 agent.ts:382-399（taskCatalog→matchTaskSkill→taskCardText→buildTaskSkillText）；匹配器 task-matcher.ts 270 行全量（prompts 字节锚定 prompt-consts.ts）；skill_active 事件；开关默认值两侧同（site=true/task=false，settings.ts:128/:165 ↔ config.py:390/:427）；host 键形态 `hostname_port`（url-utils.ts:26 = 目录命名形态） |
| core 唯一缺口 | **S4 匹配日志未移植**（agent.py:563-577 单行 JSON：catalog_size/catalog_newest_distilled_at/match/confidence/reason/downgraded/match_kind/task_kind——命中与否都记；口径 C 评测调试命脉）。本批补：agent.ts 一处日志 + types.ts 一个 `newestDistilledAt` 纯函数（Python TaskSkillLoader.newest_distilled_at 的可达位——core 不能 import node-host） |
| node-host 装载层 | **全缺**（无 skillsDir/无 env/无 skillSource 接线）——本批主体 |
| 内容 | 全缺——`domain-skills/` 三套拷入（localhost_7780 488K 含 44 任务卡 / creator.douyin.com 12K / member.bilibili.com 12K） |

## S1. Python 语义锚定表（移植基准，逐行为锚）

### loader.py（站点级，114 行）

| 行为 | 锚点 | TS 形态 |
|---|---|---|
| 三件套读序 `_sop→selectors→quirks` | :17-21 | loadHostSkill 返回 `{sop,selectors,quirks}` 三字段（渲染带头在 core sense）——**FsSkillSource 只交原始字段，不渲染** |
| 构造零 IO（禁用态安全实例化） | :35-40 | 构造只存 rootDir |
| 相对路径 CWD 优先 + repo-root 回退 | :42-65 | **偏离登记：回退不移植**——Python 回退服务 editable 安装（.pth 指回仓库根）特有形态；TS link: 消费者（评测仓/扩展）由 AGENT_SKILLS_DIR 显式给相对（CWD 解析）或绝对路径。CWD 下无目录 = 静默无 skill（与 Python 非 editable 行为一致） |
| 无 host 目录 → "" + info 日志（排查 host 不匹配） | :78-82 | → `null` + log（接口语义 miss=null；core 把 null 转不注入段） |
| 逐文件缺文件/读失败/空文本跳过；全空 → "" | :86-99 | 字段缺/空 → 空串；三字段全空 → null + empty 日志 |
| loaded/empty 日志 | :103-105 | log 回调注入（`skill loaded: host=%s chars=%d files=%s` 文案锚定） |
| per-host 缓存 | :75-76/:95 | `Map<string, HostSkill | null>`（null 也缓存——重复 miss 零 IO） |
| invalidate | :108-113 | **不移植**（评测/示例进程生命周期短；TS 接口无此面；扩展侧 M5 用 IndexedDB 源另议） |

### task_loader.py（任务卡，141 行）

| 行为 | 锚点 | TS 形态 |
|---|---|---|
| catalog：`tasks/*/ _task.json` sorted glob | :62-68 | readdir sorted；私有 `cardDir` 字段挂 node-host 侧扩展 meta（core TaskCardMeta 无此字段——对象回传自身，core 不窥探） |
| 坏 JSON/非 dict → warning skip | :88-93 | 同 |
| 无描述 → warning skip（无检索锚点） | :96-99 | 同 |
| keywords 类型守卫（str→单元素/数组滤空/其他→空） | :101-109 | 同 |
| slug 缺省 = 目录名 | :95 | 同 |
| distilled_at 字符串化缺省 "" | :114 | 同 |
| 目录存在 0 卡 → **warning**（显式可见，防坏迁移静默） | :74-78 | 同（日志级别语义锚定：info 有卡/无目录，warning 目录在零卡） |
| card_text：三件套读序 strip，**无分段头**，`"\n\n"` join | :127-140 | **关键口径**：types.ts:18 接口注释「按 [SOP]…分段拼接」与 Python 不符——**FsSkillSource.taskCardText 锚 Python 无头语义**；core 的 `renderTaskCard`（带头版）是站点级渲染形态的重复件，本批不使用不删除，注释登记其真实用途 |
| newest_distilled_at（ISO 字典序 max） | :118-125 | 移植到 core types.ts 纯函数（S4 日志消费） |

### task_matcher.py / agent.py 匹配流程

- 匹配器全量已在 core（P4），本批零改。
- agent.py:545-580 匹配流程 TS 已对齐（agent.ts:382-399），**仅缺 S4 日志**（S0 表）。补线时
  字段与 json 形态逐字节锚定（`ensure_ascii=False` = JSON.stringify 默认；ts 秒级 ISO）。

## S2. node-host 扩面（本批主体）

1. **`src/skill-source.ts`：`FsSkillSource implements SkillSource`**
   - 构造 `(rootDir: string, log?: (msg: string) => void)`，零 IO；内部两缓存 Map。
   - `loadHostSkill(host)` / `taskCatalog(hostKey)` / `taskCardText(meta)` 按 S1 表逐行实现。
   - **直接用 `node:fs/promises`**（node-host 合法面；不经 core FileSystem 接口——它无列目录
     成员，为枚举任务卡扩五接口不值）：readFile/readdir/stat。
2. **settings.ts**：
   - `HostSettings.browser` 或新顶层增 `skillsDir: string | null`（env `AGENT_SKILLS_DIR`，
     缺省 `"domain-skills"` 对齐 config.py:191/:516；空串 = 显式关闭 → null）。
   - agent 层 env 透传：`AGENT_ENABLE_SKILL_INJECTION` / `AGENT_ENABLE_TASK_SKILL_INJECTION`
     （bool 解析；**口径 B/C 的评测开关**，缺省不出现走 core 默认）。
3. **agent-boot.ts**：assembleAgent 内 `skillsDir !== null → new FsSkillSource(skillsDir, log)` →
   `AgentOptions.skillSource`（downloadsPath 先例同款 settings 驱动构造）；`AssembleAgentOptions`
   另开 `skillSource` 显式注入位（评测/扩展自定义源，null = settings 驱动）。
4. 导出面：node-host index 导出 `FsSkillSource`（boot-entry 名单不加——示例暂不需要，
   评测仓 link: 走包入口）。

## S3. 内容拷贝（domain-skills/）

- 三套逐字节拷自 TreeWalker @640d52a：`localhost_7780/`（含 `tasks/` 44 卡，口径 B/C 主战场）、
  `creator.douyin.com/`、`member.bilibili.com/`（真实任务）。
- 根 `domain-skills/README.md` 登记来源（TreeWalker@640d52a）、结构说明、消费方式
  （AGENT_SKILLS_DIR 指向）、评测口径 A 注意事项（**A 轮必须显式关闭**：评测仓 env 或
  overrides 双开关 off——Python 口径 A 同款）。
- 提交前脚本核对：三套目录文件数与哈希清单 vs 源仓（保证逐字节）。

## S4. 测试矩阵

**node-host（预计 +20 例上下）**——临时目录 fixture（mkdtemp，用后删）：

- 站点级：三件套全出 / 缺 selectors 出两段 / 全空 → null / 无 host 目录 → null（+日志断言）/
  缓存命中（二次调用，readdir 计数间谍或改盘不生效断言）。
- 任务级：正常卡 meta 全字段 / 坏 JSON skip+warn / 非 dict skip / 无描述 skip / keywords
  三形态（str/数组/其他）/ slug 缺省目录名 / tasks 目录存在零卡 warn / 排序（目录名字典序）。
- `taskCardText`：三件 join `"\n\n"` **无头**（期望值字符串锚 Python 语义手工样例）；
  缺件跳过。
- settings/agent-boot：AGENT_SKILLS_DIR 链（设置/缺省/空串=null）、双 ENABLE flag env 链、
  assembleAgent skillSource 构造三态（dir 在/不在/显式注入位覆盖）、runAgent 透传。
- **core 侧小补的测试**：`newestDistilledAt` 纯函数（空/多值/缺省串）；agent.ts S4 日志——
  FakeSkillSource + 假 LLM 断言单行 JSON 字段齐（命中/未命中两分支）。

## S5. smoke（本仓可代办，不涉 CDP/LLM）

- FsSkillSource 直读真 `domain-skills/`：三 host 站点卡全非空 + 7780 catalog=44 + 抽卡
  （如 add-phoebe-brown-color-option）text 含关键段——node 一次性脚本（`_` 前缀用后删）。
- 注入端到端与 B/C 真跑：评测仓（issue #11 并行线）；douyin skill on/off 对照留用户复跑
  （登录态）。

## S6. 实施步骤与分支

`feat/p5-skill-face` 自 main → ① core 小补（S4 日志 + newestDistilledAt）→ ② node-host
（skill-source/settings/agent-boot）→ ③ 测试 → ④ 内容拷贝 + 核对脚本 → ⑤ 全绿 + 门禁 →
⑥ smoke → ⑦ README/方案登记 → ⑧ /review-loop（用户触发）→ ⑨ 授权合并。

## S7. 验收

1. 全仓测试绿（core +2 例 / node-host +20 例量级）+ 门禁 exit 0。
2. core 改动恰两处且无行为语义变化（日志 + 纯函数），评审轮以此为约束。
3. domain-skills 与源仓逐字节一致（清单核对）。
4. smoke：三 host 全出；7780 catalog 44 卡。

## S8. 实施结果（2026-10-07）

- core 恰两处：agent.ts S4 匹配日志（单行 JSON，命中/未命中两分支测试锚定——match:null 走
  空值早退 downgraded=false 已按 matcher 实跑语义断言）+ types.ts `newestDistilledAt`；
  另 index.ts 导出行 +1（types 模块既有导出面的延伸，非第三处逻辑改动）。
- node-host：`FsSkillSource`（S1 锚定表逐行实现；直用 node:fs/promises）+ settings
  （AGENT_SKILLS_DIR 缺省 "domain-skills" / 双 ENABLE flag env 透传 / mergeHostSettings
  标量三态）+ agent-boot（settings 驱动构造 + 显式注入位，`[skill]` 日志前缀）+ index 导出。
- 测试：core 1297→1299（review-r1 +1 newestDistilledAt / pipeline-extra +1 S4 日志）；
  node-host 58→69（skill-source.test.ts 11 例新文件 + settings 既有用例扩 3 断言族；
  helper 抽 `agent-boot-helpers.ts` 共享）。全仓 1586 绿 + 门禁 exit 0。
- 内容：三套 185 文件拷入 + 根 README（provenance=TreeWalker@640d52a、消费方式、A 轮关闭
  注意事项）；**SHA-256 清单脚本核对 185/185 逐字节一致**（源仓工作树与 @640d52a diff 为空
  双重验证）；biome files.includes 加 `!domain-skills`（数据非代码，Python json.dump 格式
  保真不入格式化）。
- smoke 全通：三 host 站点卡全出（7780 21229 chars / douyin 2967 / bilibili 3261，
  loaded 日志形态锚定）+ 7780 catalog 44 卡 + 样例卡 text 2920 字无分段头。
- 实施中修正：S1 表预设的「目录在零卡 warning」用例初版与守卫用例混测（有 3 张有效卡时
  warning 不该触发）——拆独立 host 断言；writeCard 助手支持 null=不写 _task.json
  （glob 未命中等价形态）。
