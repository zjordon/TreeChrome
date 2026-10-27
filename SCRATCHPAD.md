# issue #16 实施草稿：任务卡匹配器超时可配 + callFailed 步内重试

- issue: [#16](https://github.com/zjordon/TreeChrome/issues/16)
- 分支：`issue-16-matcher-timeout`（自 main 4e3fb32）
- 状态：**实现完成，测试全绿 + gate 过，待 /review-loop**（2026-10-27：D1–D4 全实施；
  新增 6 用例全绿；D4 双向验证两用例旧实现下均红；typecheck/全仓测试/gate EXIT=0）

## 1 背景与根因

`task-matcher.ts` 的 `MATCH_CALL_TIMEOUT_S = 15.0` 固定不可配，Agent 调用侧不传 opts。
thinking 模型 + 慢端点下 structuredCall 15s 出不来 → matcher 内部 2 次重试撞同一
超时 → `call failed: 单次调用超时` → **整 run 无卡盲走**。

2026-10-26 真机实录（run_1a1759310ae，抖音发视频）：无卡 48 步 / 52 分钟（封面模态框
缠斗）；同任务 2026-10-25 有卡 18 步稳定完成。#11 自检 footer 随卡消失（防锚定提醒无载体）。

第三次同型打击（前两次 #10 已修）：

| 调用 | 固定超时 | 修法（#10） |
|---|---|---|
| judge | 60s | `judge.callTimeoutMs` 可选键 + 扩展 180s |
| distill | 60s | `callTimeoutMs` 参数 + 双宿主 180s |
| **matcher** | **15s** | **本次漏网** |

## 2 设计决策

### D1 可选键形态：嵌套 `AgentSettings.taskSkill.callTimeoutMs`（judge 同款）

```ts
/** TS-only 增量（Python config 无此组）——可选键不进 DEFAULT_AGENT_SETTINGS，
 *  settings 对拍 fixture 零变化（#10 纪律） */
export interface TaskSkillSettings {
  /** 单次匹配调用超时毫秒；缺省 matcher 内 15s 冻结契约 */
  callTimeoutMs?: number;
}
// AgentSettings 增可选键 taskSkill?: TaskSkillSettings;
// resolveAgentSettings 增合并分支 taskSkill: taskSkill ? {...base.taskSkill, ...taskSkill} : base.taskSkill
```

- 命名沿用 issue 原文 `taskSkill.callTimeoutMs`；与 node-host `settings.llm.taskSkill`
  （匹配器**专用 LLM 卡**）同名不同层不同物——已评估，接受（核心侧 `taskSkill` 是匹配
  行为组，未来 matcher 键（重试/置信门槛）有归宿）
- 单位 ms 对齐 `judge.callTimeoutMs`；matcher 内部 API 保持 `callTimeoutS` 秒
  （task_matcher.py 移植形态不动），调用侧换算

### D2 透传三个调用侧（不止 issue 点名的 Agent 侧）

| 调用侧 | 位置 | 透传值 |
|---|---|---|
| Agent 初始匹配 + #11 host 重匹配 | `agent.ts` matchTaskSkill（一处函数体，两条路径共用） | `settings.taskSkill?.callTimeoutMs` |
| 蒸馏前置匹配 | `distill.ts:351`——**现状同样吃固定 15s**（issue 未点名，同型缺口） | 共享蒸馏自身的 `input.callTimeoutMs`（两宿主已缺省 180s） |
| （不透传）matcher 单元 API | `task-matcher.ts` opts | 保持 `callTimeoutS`，Python 移植面不动 |

node-host assemble 不传（#10 judge 同口径：judge 180s 也只有扩展传，node-host 走
core 缺省；蒸馏路径经 D2 已覆盖）。

### D3 扩展 assemble 对齐 #10 口径传 180s

`assemble.ts` resolveAgentSettings 增 `taskSkill: { callTimeoutMs: 180_000 }`——
judge / distill / matcher 三者同值 180s。

### D4 callFailed 步内重试（issue 第 3 点「讨论后定」——建议做）

现状：#11 D2 重匹配只覆盖 **host 变化**；host 未变的 callFailed 没有第二次机会。
方案：

- `agent.ts` 增 `taskSkillCallFailed` 私有标志，`matchTaskSkill` 内每次调用前置
  false、调用后按 `match.callFailed` 置位（catalog 空提前返回时也保持 false——
  那不是调用失败）
- `retryTaskSkillMatchOnHostChange` 守卫放宽：同 host 已试过 **且** 上次 callFailed
  → 放行一次旁路；attempts 封顶 `TASK_SKILL_MATCH_ATTEMPTS = 2` 不变（总尝试恰好
  2 轮）
- 重试时点：第一步结束后的步循环检查——慢端点瞬时拥塞天然获得一步喘息

**代价明示**：最坏阻塞窗口 = 2 轮 × matcher 内部 2 次 × 180s = **12 分钟**（匹配
失败不挂任务，只是无卡）。对照无卡盲走 52 分钟实录，值得；正常慢端点单轮 180s 内
大概率出结果。

## 3 实施步骤

1. core settings.ts：`TaskSkillSettings` + `AgentSettings.taskSkill?` +
   resolve 合并分支（Omit 收型同 judge——taskSkill 覆盖面收 Partial）
2. agent.ts：matchTaskSkill 透传 `callTimeoutS = settings.taskSkill?.callTimeoutMs / 1000`；
   `taskSkillCallFailed` 标志 + retry 旁路（D4）
3. distill.ts：内部 matcher 透传 `input.callTimeoutMs`（条件展开保 undefined 语义）
4. assemble.ts：`taskSkill: { callTimeoutMs: 180_000 }`
5. 测试（见 §4）→ `pnpm typecheck && pnpm test` 全绿 → gate

## 4 测试清单（测试先行，D4 双向验证红→绿）

| 文件 | 用例 |
|---|---|
| `core/test/agent/settings-defaults.test.ts` | resolve 合并：传 `{taskSkill:{callTimeoutMs:90000}}` → 90000；不传 → undefined；DEFAULT 无键（fixture 对拍零变化自动成立） |
| `core/test/agent/pipeline-extra.test.ts` | ① settings 90s → 匹配调用收到 callTimeoutMs 90000；② D4：初始 callFailed → 同 host 步内重试成功命中（attempts=2）；③ D4 封顶：恒失败 → attempts 恒 2、无第 3 轮 |
| `core/test/agent/skills/distill.test.ts` | input.callTimeoutMs=180000 → 内部 matcher 收到 callTimeoutS=180 |
| `apps/extension/test/runtime-assemble.test.ts` | resolved settings `taskSkill.callTimeoutMs === 180_000`（judge 180 若无既有断言则同款补上） |

## 5 验收口径（issue）

- 可选键不进 DEFAULT——settings 对拍 fixture 零变化（#10 同纪律）
- 真机慢端点下任务卡稳定命中（`task-skill hit: slug=…` 可见）——实现侧只能保证
  机制与单测，真机验证留给用户跑
