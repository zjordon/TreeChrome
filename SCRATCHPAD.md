# issue #11 实施草稿：v1.5——卡质量三项

- issue: [#11](https://github.com/zjordon/TreeChrome/issues/11)
- 分支：`feat/issue-11-v15-card-quality`（自 main d26fb88）
- 状态：**实施完成，待 /review-loop**（2026-10-25：S1-S4 落地，typecheck/test 全绿 54+15 文件，gate 过，扩展 rebuild 完成）

## 1 背景与证据（三项）

| 项 | 证据 |
|---|---|
| A1 卡锚定 | 2026-10-24 抖音实测：注入卡把「确认发布成功」写成可照做步骤，模型按剧本声称完成（Judge 拦截） |
| A2 起跑页 miss | google 起跑去 douyin 任务整 run 无法命中任务卡（匹配锚定初始 host、每 run 一次） |
| 附件守卫 | 2026-10-25 实录：附件注册表空（SW 重启/clearForRun 清空）→ 任务文本无 [Attachments] 段 → 模型瞎猜文件路径空烧 ~10 步（issue #11 评论全文） |

## 2 设计决策

- **D1 防锚定三层（蒸馏侧，不动消费端冻结口径）**：
  ① `TASK_SOP_SPEC` 补规则：SOP 步骤只能是**页面操作**；禁止把「确认/验证任务完成」写成可执行步骤——完成声明只属于末步 done 且须引用页面实时证据；
  ② core `distillTaskCard` 后处理：LLM 产出校验通过后，`draft.sop` 尾部附加**固定**「执行前自检」footer（中文常量，导出供测试锚定）——**幂等**：sop 已含该 footer 先剥再附（增量模式旧卡带着 footer 进 LLM、输出再统一附加）；
  ③ footer 文案要点：本卡是历史轨迹总结、页面可能已变；「已完成/已保存」类剧本断言不是证据；done 前以当前页面真实状态核验（读到的值/新出现的元素/URL 变化），不符时以页面为准重试或改道。
  **不动消费端渲染面**（任务卡全文 strip 后 `\n\n` 直拼是 P5.5 冻结口径，与 Python loader 对齐——footer 落在卡的 sop 内容里随卡走，双宿主/采纳后的扩展卡都自动携带）。
- **D2 任务卡重匹配（host 变更重试）**：`Agent` 增 `taskSkillTriedHosts: Set<string>` + `taskSkillAttempts`（上限 2 = 初始 1 次 + 重试 1 次）。初始 `matchTaskSkill` 登记尝试 host；run 循环每步收尾后：未命中（`taskSkillText === null`）且注入开关在、`historyLast().stateSummary?.url` 的 host **未曾试过** → 重试匹配（锚点用步内已采的 stateSummary URL——零额外 CDP 调用）。命中即止；SW 侧无改动（core 变更双宿主免费）。skill_active 事件随命中照常发出。
- **D3 附件起跑守卫**：run-manager `startInner` 在任务空判后：原始任务文本命中 `/附件|attachment:/i` 且 `attachments.list()` 为空 → `{ok:false, error:"任务提到附件但附件列表为空——请先在下方附加文件（浏览器重启或上一轮结束会清空附件）"}`。误报成本低（提示明确可行动：附加或改措辞）。
- **D4 不做**：附件持久化（M5 有意内存态，改持久化需整体设计 SW 恢复语义——独立议题）；sidepanel 附件丢失显性提示（守卫挡住主危害后评估）；搜索 host 黑名单锚定（host-change 重试已覆盖等价场景且不引入站点清单维护）。
- **D5 两级技能显示修复（2026-10-25 真机验收发现，用户批准并入）**：baidu run 任务卡命中但侧边栏显示「未命中」——`run-timeline.tsx` 把站点级 `skillLoaded`（命中标志）与任务级 `taskSlug`（拼在同一行）混用。修法：两级分开呈现（`✚ 站点卡 {host} 命中/未命中 · 任务卡 {slug} 已注入`，任务卡未命中不渲染空 slug——顺带消掉 `str("")` 不过 null 检查导致的尾斜杠）；`journal.ts` 持久化 `taskSkillChars`（此前发了但丢弃，旧事件回退 slug 非空判定）；`repeatedSkillSeqs` 去重键补 taskSlug（D2 中途命中 miss→hit 转换行不得折叠）。

## 3 实施步骤

- **S1 core 防锚定**：distill-prompt.ts TASK_SOP_SPEC 补规则；distill.ts `TASK_SOP_SELF_CHECK_FOOTER` 常量 + `applySelfCheckFooter(sop)` 幂等附加（新卡/增量两路径统一走 draft 落地点）。
- **S2 core 重匹配**：agent.ts 增 triedHosts/attempts 状态 + `retryTaskSkillMatchOnHostChange()`（runStep 收尾后调用）；matchTaskSkill 登记尝试 host。
- **S3 扩展守卫**：run-manager startInner 附件指涉检查。
- **S4 测试 + gate**：core distill（footer 附加/幂等/prompt 规则锚定）、core agent（host 变更重试命中/频控/已命中不重试）、extension run-manager（守卫两分支）；typecheck/test/gate；扩展 rebuild。

## 4 测试面

| 层 | 用例 |
|---|---|
| core distill | 新卡 sop 尾含 footer；增量模式旧卡带 footer 不重复（幂等剥附）；TASK_SOP_SPEC 文本含防锚定措辞（prompt 构造锚定） |
| core agent | 初始 host catalog 空 → 导航后有 catalog host → 下一步重试命中 taskSkillText；attempts 上限 2；已命中不再重试 |
| extension | 「附件」+空表拒绝（含可行动文案）；有附件放行；无附件指涉放行 |
| console-ui | 站点卡未命中+任务卡命中两段各标各的；空 slug 不渲染尾斜杠；旧事件（无 taskSkillChars）slug 非空回退判定；去重键含 taskSlug（miss→hit 转换行不折叠） |
| journal | skill_active 压缩投影带 taskSkillChars（charCount 仍不持久化） |

## 5 验收清单

- [ ] 蒸馏产物卡 sop 尾部恒带自检 footer（单测锚定）
- [ ] google 起跑 douyin 任务实测第 2 步后命中任务卡（skill_active 日志）
- [ ] 附件空表 + 「附件」任务 → 起跑被拒并提示（真机或单测）
- [ ] typecheck/test 全绿；gate 过；覆盖率 ≥85%

## 6 风险与边界

- footer 改变蒸馏产物内容——既有已采纳卡不带（旧卡不回写）；增量更新时统一补上
- 重匹配引入第二次 matcher LLM 调用（仅 miss + host 变更场景，频控 2 次）
- 守卫正则可能拦截「把附件发给我」类反向表述——接受（提示可行动）

## 7 评审轮登记

| 轮 | 意见 | 采纳/驳回/stale | 要点 |
|---|---|---|---|
| 1 | 1（high/bug×1） | 采纳 1 | applySelfCheckFooter 首现位 slice 截断：LLM 前置/中部回带 footer 时静默丢弃其后正文，残缺卡过非空校验落盘覆盖旧卡（P1 数据损坏）。修复：剥除所有出现位 + 分段 trim 重组 + 尾部单份重附（评审建议片段的残留四连换行与空文前导由 trim/join 归一与空文守卫补齐）；双向验证红→绿；测试 +1（前置/中部两场景） |
| — | — | — | 待续 |
