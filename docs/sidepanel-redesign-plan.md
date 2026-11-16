# Sidepanel 改版方案——按 qz-browser-agent 设计的聊天转录形态重构

> 状态：2026-11-16 定稿。定位：**评估 + 分期路线图**（非文件级实施计划——各期落地时按新功能工作流另建 issue + SCRATCHPAD）。
> 参照设计（只读）：`D:/dev/git/z_jordon/fork/reading/qz-browser-agent/docs/ui-layout-and-features.md`（布局骨架与功能点清单）及姊妹篇 `ui-ux-design-notes.md`（交互模式分析）。
> 承接关系：issue #20 已完成视觉层（token 体系）+ 布局层（三区壳/设置浮层）重构，`docs/ui-refactor-reference.md` §1 当时把「③交互形态层：任务面板+时间线 → 聊天转录」裁定为单独立项——**本文即该档立项**。

## 1. 结论先行

1. **能改，且大部分改在 UI/SW 粘合层，不动 core**。现有 Port 协议、journal 快照、等待卡（permission/submit）、附件管线、设置浮层全部复用；真正的新建面只有三块：**会话存储层（SessionRepository）**、**转录投影与渲染（TranscriptView）**、**SW 侧多轮上下文拼接（continuity 模块）**。
2. **多轮对话最小可行设计：run 仍 = 单任务，多轮 = 同 session 内 follow-up 新 run，前情块由 SW run-manager 拼**。core 零改动，bridge 直驱路径免费受益。
3. **干预面分三级**：L0 停止（已有）→ L1 run 间排队（U2，纯 SW）→ L2 运行中 steering（远期独立提案，需动 core，本期仅协议预留）。
4. **明确不做**：Data 页、定时任务、i18n、首用数据同意页、斜杠命令、导入 HTML、choice 等待卡、通用 overlay 注册器、消息编辑重发完整版、Skill Git 导入、Skill 结果候选选择、token 级流式回答，共 12 项（逐项理由见 §2 各行，汇总见 §3）。
5. **四期主线 + 远期**：U1 转录骨架+会话模型（10–12 人日）→ U2 干预与状态（8–10）→ U3 可读性与页面注册（8–10）→ U4 补全打磨（7–9）；远期 core steering 独立提案。主线合计约 33–41 人日。
6. **一个必须先想清的架构点**：现有 256 条事件环是 UI 实时投影窗，**不能当会话归档的真相源**——归档缓冲必须在环淘汰前独立消费（§5.1.4，U1 最高风险点）。

## 2. 对标评估表

裁决标签：**【复用】**直接用现有件 / **【改造】**现有件升级 / **【新建】**新做 / **【延后】**排入后期 / **【不做】**出局。

### 2.1 布局骨架（qz 六区）

| qz 功能点 | TC 现状 | 裁决 | 理由 |
| --- | --- | --- | --- |
| header 分段 tab 导航（对话 + 能力页按 order 排） | header = 标题 + 连接点 + 蒸馏/草稿徽标 + 设置钮（`packages/console-ui/src/run-panel-header.tsx`），无页签 | 【改造】(U3) | AppShell 壳保留，header 加静态 PageRegistry tab；TC 能力面固定，不需要 qz 的运行时 register（§5.4） |
| header 动作钮（新对话/设置） | 仅设置钮（开 SettingsOverlay） | 【改造】(U1) | 「新对话」是会话模型的天然入口；设置钮复用现有 overlay；连接点/徽标区为 TC 特有保留 |
| 会话标题条（行内重命名 + Aa 字号 + 导出 HTML + 插槽） | 无会话概念 | 【新建】(U3) | 依赖会话模型；行内重命名 U1 先以列表项形态出现，标题条 U3 收拢 |
| 落地页（品牌 + 标语 + 外部直驱欢迎卡） | WelcomePanel 空闲欢迎屏（`welcome-panel.tsx`） | 【改造】(U1/U2) | U1 升级二态；U2 点亮外部直驱欢迎卡（bridge 会话在场时：连接命令 + 复制钮，§5.6） |
| 转录主区（消息流 / 工具时间线 / 等待卡） | RunTimeline step 分组事件行（纯文本）+ FinalResult 卡 | 【改造·最大件】(U1–U3) | 事件数据齐全，缺的是消息形态投影与渲染；分三步走（§5.5） |
| chat-dock（状态条 → 只读提示 → 输入区） | RunStatusBar + TaskBar（运行中**禁用输入**） | 【改造】(U1/U2) | 关键语义反转：**运行中不再禁用输入**，转为排队（U2）；Enter/Shift+Enter、自适应高度（U1） |
| 设置底部浮层 + 分类 tab | 已有 SettingsOverlay + OptionsApp 四区 Segment（模型/授权/技能库/草稿） | 【复用】 | 形态已对齐 qz（issue #20 M4 落地）；U1–U2 不动设置面 |
| 右上搜索浮层（Ctrl/Cmd+F + 计数 aria-live） | 无 | 【延后】(U4) | 依赖转录形态与归档先立住；先做当前会话内全文搜索 |
| 首用数据同意页（全屏） | 无 | 【不做】 | TC 本地优先，无遥测无数据上送面；无收集则无同意页。若日后加遥测，随遥测一起过审 |
| i18n（en/zh-CN/zh-TW） | 全中文（含运行时常量如动作名映射） | 【不做】 | 中文产品定位；全量文案 key 化 + 运行时常量改造渗透成本高收益低。预留动作：新文案集中在组件常量区，不做散落字符串 |

### 2.2 交互功能

| qz 功能点 | TC 现状 | 裁决 | 理由 |
| --- | --- | --- | --- |
| 多轮对话 | 单发任务面板（`task-bar.tsx`：textarea + ▶开始，终态后视图保留到下一 run） | 【新建】(U1) | 本次改版核心；run = 单任务语义不变，多轮 = 同 session 续 run（§5.2） |
| 流式回答（token 级流式渲染） | 无——core LLM 客户端非流式，事件面是 step/tool/model_result 粒度 | 【不做·远期观察】 | 转录的「实时可见」由事件流逐步呈现（每步/每工具实时推送）已够监督态；token 级流式需改 core LLM 客户端 + 事件协议 + SW→UI 带宽模型，收益集中在长思考等待场景——等真实需求再议，不进本路线图 |
| 停止 | `control.stop` 已有（RunStatusBar 停止钮） | 【复用】 | 外部直驱会话也保留停止（本地用户对浏览器有最终控制权） |
| 排队 follow-up（可视化 / 撤销） | 无（运行中禁输入） | 【新建】(U2) | run 间排队纯 SW 可实现，不动 core；覆盖 qz 排队场景主体 |
| 运行中 steering（插话转向） | core 无 mid-run 注入（step pipeline 五阶段 + 守卫链无此分支） | 【延后·独立提案】 | 需改 core；TC 单 run 时长短，L1 排队已吸收大部分需求；本期仅协议预留 kind（§5.3） |
| 消息编辑重发 / 重试 | 无 | 【延后·弱替代】(U4) | 完整版需会话分支树（qz 有）；TC turn = 任务粒度，「复制为新对话起点」弱替代覆盖九成场景、成本 1/10；分支树不做承诺 |
| 聊天内搜索 | 无 | 【延后】(U4) | 同搜索浮层 |
| 复制全文/选区、下载（含代码块复制） | FinalResult 纯文本展示，无复制钮 | 【延后】(U3/U4 轻件) | finalResult/turn 气泡加复制钮随 U3 转录形态落地；代码块复制钮随 U3 markdown 渲染一起（react-markdown 组件标配）；选区复制走浏览器原生，不做拦截 |
| 对话字号 Aa popover | 无（console-ui 已有 CSS token 体系，双主题） | 【新建】(U3) | 纯 token 档位（`--tc-font-scale`），成本低，偏好只存本机 |
| 目标模式状态条（goal-strip） | 无对应（TaskBar 无目标显示） | 【改造】(U2) | TC 语义 = 会话目标 tab（URL/标题）：composer 顶部目标条展示、点击聚焦 tab。TC 会话本质是「围绕一个页面目标的任务序列」，目标条比 qz 更必要 |
| 图片/文档粘贴拖入 | 附件管线完整（分块上传/预算/拒绝明细，`attachment-upload.ts`），仅 📎 按钮入口 | 【改造】(U4) | clipboard/drop 事件接现有 uploadAttachment 编排，管线零改动 |
| 页面元素引用（元素选择器） | 权限卡已投影 elementIndex/bbox/xpath；dom-snapshot 包在 | 【延后·U4 末评估】 | 技术件齐，但需 content script 长交互（选择模式注入/高亮/Esc），是全新交互面；且与「自然语言描述任务」的 TC 心智部分重叠，先观察需求 |
| 斜杠命令菜单 | 无 | 【不做】 | TC 输入框语义是任务描述，可命令化动作 ≤5 个（开始/停止/切模型）；命令面不足 8 个时斜杠菜单不划算，chrome.commands 平台惯例成本 1/5（U2 落地） |
| 结构化等待卡（text/textarea/choice/cards，按 waitId 恰好一次结算） | permission 卡（capability/host/参数/元素定位/倒计时）+ submit 卡（fields 已打码），token 结算 + 超时 cancelled（`policy-bridge.ts`） | 【复用】+ choice【延后】 | text/submit 两类已满足且结算语义完备；choice 类型需 core 产出结构化选择题，core 无此能力，远期 core 有结构化提问面再议 |
| 上下文用量指示 | 数据已有（事件流 model_result 携 inputTokens/outputTokens；providerCard 有 contextWindow 字段），无展示 | 【改造】(U2) | 状态条 pill = 最近 model_result.inputTokens / activeCard.contextWindow（§5.7），零协议新增 |
| 模型快速切换 Ctrl+Shift+M / Ctrl+Shift+K 开面板 | manifest 无 commands（`wxt.config.ts`） | 【新建】(U2) | chrome.commands 注册；替代斜杠命令的命令面；manifest 新增 commands 项 |
| 模型 Provider 预设模板（DeepSeek/OpenRouter/Kimi…） | 设置·模型为手动填卡（name/protocol/baseUrl/apiKey/model） | 【延后】(U2 顺手件) | 预设 = 新卡表单的端点预填下拉，纯前端常量成本低；随 U2 模型快速切换一起做（切换器好用的前提是建卡门槛低）；不引入 qz 的预设中心，只做常用端点模板 |
| 定时任务（automations） | 无 | 【不做】 | MV3 SW 生命周期与无人值守 run 的权限卡模型硬冲突（定时 run 撞 permission 卡无人确认 = 超时 deny）；且调度/重试/通知是一整条产品线，偏离「人在环上的浏览器代理」定位；前提条件（grant 覆盖面 + 无人值守授权策略）不存在 |
| 通知回流（点击回任务） | 无 | 【延后】(U4) | chrome.notifications 低成本，但依赖「sidepanel 不可见」判定与设置开关 |
| 调试日志页 | diag 探针（echo/smoke:attach） | 【改造】(U3) | 调试页 = journal 原始事件流渲染 + compactEventData 可读回退；isEnabled = 调试开关；排障价值高成本低 |
| Enter 发送 / Shift+Enter 换行 | textarea 无快捷键语义 | 【改造】(U1) | TaskBar → Composer 改造的一部分 |

### 2.3 会话管理

| qz 功能点 | TC 现状 | 裁决 | 理由 |
| --- | --- | --- | --- |
| 会话重命名/切换/删除 | 无（journal 按 `tc_runUi:<tabId>` 落盘，无索引无历史查询面） | 【新建】(U1) | 会话模型核心件（§5.1） |
| 会话搜索 | 无 | 【延后】(U4) | 先做会话内转录搜索；跨会话搜索依赖索引摘要面，U4 与通知同期评估裁剪 |
| 子任务树、产物索引 | RunTimeline step 分组（线性）；附件已在 FinalResult/转录展示 | 子任务树【延后·观察项】；产物索引【改造】(U3) | 子任务树：core 是线性 step pipeline，无 planner 子任务概念，step 分组已提供过程可读性，等 core/自进化产出真实计划结构再上树形。产物索引：任务页会话条目聚合展示该会话累计附件（数据已有，纯投影） |
| Skill 结果候选选择（selection 渲染器卡片组） | 无 | 【不做·远期】 | 与 choice 等待卡同根：需 core/技能体系产出结构化候选集，TC 技能体系（站点卡/任务卡注入）无 selection 渲染器概念；等结构化选择产出面存在再议 |
| Skill Git 导入与更新 | 无（技能源 = 内置嵌入 `embed-skills.mjs` + 蒸馏草稿闭环，`skill-store.ts`/`skill-source.ts`） | 【不做】 | TC 技能供给是「内置 + 自进化蒸馏」内生闭环，无外部技能仓库生态；Git 导入是无需求的自增攻击面 |
| 一句话保存任务为 Skill | 无手动入口——已有更强形态：run 终态 → Judge 门控 → 自动蒸馏 → 草稿 → 面板徽标 + options 审阅采纳（自进化闭环，`distill-worker.ts`） | 【复用】 | qz 是手动显式保存；TC 已自动化此流程且带质量门控，无需补手动路径（「保存为 Skill」说法可被蒸馏覆盖） |
| 导出 HTML | 无 | 【新建】(U3) | 转录投影的静态渲染（内联 CSS 自包含 HTML），纯 UI 成本低，「转录即交付物」价值高 |
| 导入 HTML | 无 | 【不做】 | 导入 = 跨机会话恢复，引入不可信 HTML 解析面；真有需求走结构化 JSON 导出（远期可选），不走 HTML |
| 外部直驱会话只读查看 | bridge run 与 sidepanel 共享 journal 与互斥队列，但无「外部会话」标识、无降级体验 | 【新建】(U2) | journal/session 加 `origin` 标记即可点亮：欢迎卡 + composer 只读条 + 保留停止（§5.6）——「同一面板服务人与 agent 两类用户」 |
| 数据表页（Data） | 无 | 【不做】 | TC 无结构化数据产出通道（qz Data 页消费 agent 产出的数据集）；空壳页签无意义，web-console（M6）有报表需求时随数据面一起设计 |
| 技能页 | options 四区之一（技能库 + 草稿审阅，`options-app.tsx`） | 【改造】(U3) | 组件双宿主：OptionsApp 技能库组件复用进 sidepanel 页签，数据面同走 OPTIONS_OPS 单发；options 页保留 |

### 2.4 注册机制（qz §4 可移植扩展点）

| qz 机制 | TC 裁决 | 理由 |
| --- | --- | --- |
| `registerPage({id,title,order,elements,isEnabled,activate})` | 【改造·静态化】 | TC 能力面固定（任务/技能/调试），做**静态注册表**：console-ui 导出 `PageRegistration` 类型 + PageTabs 渲染器；extension ui-glue 组态处一个数组常量。保留 order/isEnabled 语义，舍弃运行时 register 与动态能力包加载——那是 qz 跨包边界的需要，TC 单仓无此约束 |
| `registerSettings({tab})` | 【复用】 | 现有 SettingsOverlay 四区已等价；授权/技能库留在设置浮层（低频管理面不占页签，技能库 U3 双宿主进页签后设置浮层保留入口） |
| `registerOverlay({id,priority,close,blocksFocus})` | 【不做通用版】 | TC 浮层只有两个（设置 + 确认卡），通用 overlay 注册器是过度设计；确认卡 U2 起评估入转录流渲染 |
| `data-ui-slot` 声明式插槽（DOM 协议） | 【改造·React 化】 | 用 React 组合替代：AppShell/Composer 开具名 props（`headerActions`/`composerNotices`/`composerMeta`: ReactNode）；qz 的 DOM 插槽是为外部能力包跨渲染边界，TC 全 React 单树，props 组合即可且对 web-console 双宿主更友好 |

## 3. 范围裁定汇总

**做**（四期主线）：聊天转录形态、会话模型（列表/重命名/删除/切换）、多轮 follow-up 与前情块、L1 排队干预、状态条（usage pill）、外部直驱只读态、目标条、chrome.commands 快捷键（含模型快速切换与预设模板）、静态页签（任务/技能/调试）、markdown 渲染（含复制钮）、字号、导出 HTML、任务页产物索引、会话内搜索、通知回流、粘贴/拖入附件、「复制为新对话起点」。

**不做**（附理由，见 §2 各行）：Data 页、定时任务、i18n、首用数据同意页、斜杠命令、导入 HTML、choice 等待卡、通用 overlay 注册器、消息编辑重发完整版（分支树）、Skill Git 导入、Skill 结果候选选择、token 级流式回答。

**远期独立提案**（不在本路线图承诺）：core steering（L2）、rolling summary 前情块、元素选择器（U4 末评估，若做另计 4–5 人日）、跨会话搜索、token 级流式、web-console 双宿主联动。

## 4. 目标布局骨架

单列六区（qz 骨架的 TC 适配版；粗体为 TC 特有保留项）：

```text
┌─────────────────────────────────────────────┐
│ #header                                      │
│  [对话][任务][技能][调试]   徽标区 ⊕ ⚙       │ ← tab（静态注册，U3）+ 动作钮
│                              ↑ 连接点/蒸馏/  │    徽标区=TC 特有保留；⊕新对话(U1) ⚙设置(已有)
│                                草稿徽标      │
├─────────────────────────────────────────────┤
│ #session-title-bar（有会话时显示）            │
│  标题(行内重命名) · [Aa 字号] · [导出 HTML]  │ ← U3；重命名 U1 先在任务页列表项提供
├─────────────────────────────────────────────┤
│  #messages 主区（二态：landing / 转录）       │
│   · 落地页：品牌 + 标语 + 外部直驱欢迎卡(条件)│
│   · 转录：用户气泡 / run 块(工具时间线) /     │
│     finalResult 气泡 / 等待卡浮层(暂居中)     │
│   · 右上搜索浮层（U4，不占布局）              │
├─────────────────────────────────────────────┤
│ #chat-dock 底部坞                            │
│  · 状态条(运行时)：●状态 · 上下文用量 · ⏹    │ ← RunStatusBar 升级(U2)
│  · 外部直驱只读提示(条件，U2)                │
│  · 输入区：[目标条(U2)] [排队消息条(U2)]      │
│    [📎] [自适应输入框] [➤ 发送]              │ ← TaskBar→Composer(U1)
│    Enter 发送 · Shift+Enter 换行 · 预算/拒绝  │    附件管线原样接入
│    明细行(现有保留)                           │
├─────────────────────────────────────────────┤
│ #settings-panel 设置浮层（已有，复用不动）    │
└─────────────────────────────────────────────┘
```

与 qz 的两点有意差异：① header 徽标区（连接状态/蒸馏/草稿）是 TC 特有运行时可观测面，保留；② 附件预算/拒绝明细行保留在输入区上方（qz 无此面，TC 附件预算模型需要）。

## 5. 目标架构

### 5.1 会话模型与存储

**Session 定义**：`Session = 围绕一个页面目标（tab）的任务序列 + 用户 turn 记录 + run 归档`。与 qz「全局聊天会话」的本质差异：TC 会话**携带目标 tab 属性**（首 run 的 tabId），follow-up 默认作用于同一 tab；tab 已关闭时 follow-up 由 SW 报错并提示重选目标。这是 TC 任务语义（CDP 附着特定 tab）决定的，不照搬 qz。

**存储选型：chrome.storage.local**（manifest 已含 `unlimitedStorage`，**无需新增权限**）。理由：与现有 SW 重启恢复扫描（`tc_runUi:*`）同构，MV3 生命周期下最稳；IndexedDB 在 SW 被杀/重启时序里复杂度高，TC 单用户单机数据量级（几十会话）用不到。隔离手段：归档读写收在 **SessionRepository 接口**后面（extension 层，不进 console-ui），若日后会话数/查询性能成瓶颈，换 IndexedDB 实现不动消费方。

**键结构**：

| 键 | 内容 | 备注 |
| --- | --- | --- |
| `tc_sessions:index`（新建） | `[{sessionId, tabId, title, origin: "user"\|"bridge", runCount, lastStatus, createdAt, updatedAt, usageTokens}]` | 上限 50 条 LRU（bridge 与 user 同策略） |
| `tc_session:<sessionId>`（新建） | `{meta, turns: SessionTurn[], runs: RunArchive[]}` | 单会话预算 1MB（§5.1.4） |
| `tc_runUi:<tabId>`（保留） | 活动 run 工作集 + 恢复扫描面 | **原语义不动**——SW 重启恢复、bridge get_snapshot 照旧 |

**SessionTurn（新建类型，protocol）**：`{turnId, sessionId, runId|null, task(用户原文), status: queued|running|done|error|interrupted|cancelled, attachments, createdAt}`。

**RunArchive（归档，新建）**：`{runId, turnId, startedAt, endedAt, status, finalResult, events: JournalEvent[](压缩后), usage}`。

### 5.1.4 环 256 与归档的关系（关键设计决策，U1 最高风险点）

现有 journal 事件环（`JOURNAL_EVENT_LIMIT` = 256 条 + `discardedBeforeSeq` 记账 + 512KB 快照预算）是 **UI 实时投影窗，不是真相源**。归档链路独立：

- SW run-manager 在**事件入环前**同步喂给归档缓冲（或环淘汰 hook 转投），环只服务 UI 实时投影；
- run 终态时压缩落盘一次写：model_call/model_result/finalResult 全量保留，tool_call/tool_result 压缩为标题 + 摘要行；
- 归档层预算独立记账：单 run 4K 事件 / 256KB，单会话 1MB，超限丢最老 tool_result 明细、保留标题行；
- 落盘时机 = run 终态一次写，挂现有 200ms debounce 通道。

**验收专测**：单 run 事件 >256 时归档仍完整（环淘汰不丢转录）。

### 5.2 多轮对话语义（最小可行设计）

- **语义**：run 仍 = 单任务 → 终态，不变。多轮 = 同 session 内 follow-up 新 run。`control.start` 非破坏扩展 `sessionId?` 字段：省略 = 续当前 tab 绑定会话；`session-new` 显式开新会话。
- **用户 turn 来源 = SW 受理 control.start / bridge run_task 时的 task 参数**，在 run-manager 层记录为 SessionTurn——这是「事件流无用户消息」约束下的正解：turn 不进 core 事件流，core 无感知。
- **连续性上下文在哪层拼：SW 侧 run-manager（新建 continuity 模块），core 零改动**。对比过三个位置——core（侵入 prompt 构建，bridge 直驱路径要重复实现）、UI（不可靠、双宿主不一致）、SW（所有入口统一：sidepanel/bridge/options 全走 run-manager 受理）——裁决 SW。
- **前情块形态（U1 最简档）**：

  ```text
  [会话前情·自动注入]
  此前任务 1：{task1}
  结果：{finalResult1（截断）}
  …
  [当前任务]
  {userTask}
  ```

  只带 finalResult（任务间上下文 = 结果而非过程）；前情块总预算硬编码 8K 字符起步（后续有需求再进设置「高级」区）；diag echo 可查证拼装结果——验收直接可测。
- **U3 进阶（可选开关，默认关）**：rolling summary——每 run 终态后 SW 侧一次 LLM 调用生成/更新会话滚动摘要，替代逐条 finalResult；机制类比现有 distill worker（queued/running/done/failed）。
- **免费收益**：bridge 的 run_task 带 sessionId 时同样获得连续性。

### 5.3 干预面分级

| 级 | 能力 | 实现位置 | 期 |
| --- | --- | --- | --- |
| L0 | 停止 | 已有 `control.stop`【复用】 | — |
| L1 | 排队 follow-up（run 间） | SW 队列：run 终态后节流 2s 自动出队续跑（同 session）；队列上限 5；stop 时清空队列并将 queued turn 标 cancelled | U2 |
| L2 | 运行中 steering | core mid-run 注入 + 守卫链新分支；协议本期只预留 `control.steer` kind（SW 立即回 not-supported），避免日后 breaking | 远期独立提案 |

L1 的 UI 面：composer 运行中保持可输入（**语义反转**——现有 TaskBar 运行中禁用），发送 → `queue-add`，排队 turn 立即写 session 并以「排队中」标记出现在转录尾部；排队消息条展示队列 + 逐条撤销（开跑前有效）。

### 5.4 页签注册（静态最简版）

- console-ui 导出：`interface PageRegistration { id: string; title: string; order: number; isEnabled?: () => boolean; Component: React.ComponentType<PageProps> }` + `PageTabs` 渲染器（复用现有 Segment 组件做 tab 导航）；
- extension ui-glue 组态处静态数组：任务(10) / 技能(40) / 调试日志(50，isEnabled = 调试开关)；授权不占页签（留设置浮层）；Data 不做；
- 设置浮层保持现有 SettingsOverlay + 四区；技能库组件 U3 做双宿主复用（sidepanel 页签与 options 页共享同一组件，数据面同走 OPTIONS_OPS）；
- 插槽 = AppShell/Composer 具名 ReactNode props，不做 DOM 协议（§2.4）。

### 5.5 转录渲染（分三步）

1. **U1 形态确立**：TranscriptView（新建，console-ui）——用户 turn 气泡 + run 块（复用 RunTimeline 的 step 分组逻辑，换皮为卡片）+ finalResult 气泡（纯文本 pre-wrap）。等待卡（permission/submit）浮层**保留原位不入转录流**（U1 减法：仍居中确认，形态稳定后再议入流）。未知事件类型的可读回退行（compactEventData 键值对渲染）从 U1 就做。
2. **U2 滚动意图裁剪版**：尾部跟随（sticky bottom）+ 用户上滚即解除跟随 + 回底恢复 + 新事件锚点提示。呈现状态（展开/收起）放组件本地 state 跨重建保留——key = seq/turnId 稳定，即 qz「投影保留稳定键」的对应实现。
3. **U3 markdown**：react-markdown + 安全 schema + rehype-highlight，作用于 finalResult / nextGoal。理由：LLM 输出常含列表与代码，纯文本可读性差；react-markdown 成熟可配安全面，extension 打包体积可接受；core 的 finalResult 纯文本不是障碍——渲染层向上兼容，纯文本输入零损失。

**转录投影纯函数**：`projectTranscript(session, activeSnapshot?) → TranscriptItem[]`，按 (turn 序, seq) 合并用户 turn 与 run 事件——双宿主（sidepanel / web-console M6）与测试的共同锚点，零 chrome 依赖。

**工具渲染宿主四件套（mount/update/dispose/renderStatic）不抽**：TC 工具卡是封闭集（权限卡/submit 卡/工具行/回退行），等 web-console 有动态工具渲染需求再抽——现在抽是过度设计。

### 5.6 外部直驱只读态

- bridge run_task 受理时，run-manager 在 journal 快照与 session meta 标 `origin: "bridge"`（`RunJournalSnapshot` 加可选字段，非破坏；core 无感知）；
- sidepanel 三处消费：hello / journal-snapshot / session-updated 带出 origin → ① 落地页/转录顶部欢迎卡：「外部会话进行中」+ bridge 配对连接命令模板 + 复制钮；② composer 降级为只读提示条（隐藏发送/队列，保留任务展示）；③ **停止钮保留**——本地用户对浏览器有最终控制权；
- `SIDEPANEL_REQUIRED` 写类在场门保持不变：只读查看是叠加能力，不替代在场门。

### 5.7 上下文用量指示

- **计算**：UI 侧 reducer 从事件流自算（活动期实时）；SW 侧 run 终态把累计 usage 存进 session meta（历史会话头展示）。**不新增协议消息**。
- **展示**：状态条 pill = `最近 model_result.inputTokens / activeCard.contextWindow`——多轮拼接模式下，最近一次真实 inputTokens 就是拼接后 prompt 的实证，比字符估算准；会话标题条 = 会话累计。contextWindow 字段设置 schema 已有（`settings-store.ts` 的 ProviderCardDto），零数据面改动。

### 5.8 协议扩展清单

**复用（不动）**：现有 11 种 SW→UI 广播与 12 种 UI→SW 消息全部保留原语义（hello / journal-snapshot / event / permission-request / permission-cancelled / submit-request / attachments / attachment-begun / attachment-rejected / skill-drafts / distill-status；journal-ack / permission-resolve / submit-resolve / control / attachment×5 / settings-changed / options / diag）。

**扩展（非破坏）**：

| 变更点 | 内容 |
| --- | --- |
| `control.start` | 加 `sessionId?`（省略 = 续当前 tab 会话） |
| `RunJournalSnapshot` | 加 `origin?: "user"\|"bridge"`、`sessionId?` |
| `control.steer`（预留） | 仅 UI→SW 方向预留 kind，SW 立即回 not-supported（L2 前防 breaking） |

**新增 UI→SW（请求-应答，走 sendMessage 单发——同 options 模式，Port 只承载推送广播，沿用 optionsRequest 注入先例）**：`session-new` / `session-list` / `session-open {sessionId}` / `session-rename` / `session-delete` / `queue-add {sessionId, task, attachments}` / `queue-remove {turnId}`。

**新增 SW→UI（Port 推送）**：`session-updated`——索引/队列/归档变更合并推送（载荷带变更摘要，UI 按需 session-list 补查），一条消息多用途，避免细粒度广播风暴。

## 6. 分期路线图

> 期号 U1–U4（避免与仓库既有里程碑编号冲突：M5=extension、M6=web-console、M7=Python 退役评审；#31/#32 已用 M1/M2 作桥子里程碑）。
> 排序原则：先立骨架（转录形态 + 会话模型）→ 再长功能；不动 core 的全部前置；转录组件对 web-console 双宿主零 chrome 依赖。
> 落地流程：每期一条 issue → 功能分支 → SCRATCHPAD 实施计划 → 人工审核 → 实现（测试全绿 + 提交门）→ /review-loop → /finish-issue。

### U1 转录骨架 + 会话模型（10–12 人日）

| 项 | 内容 |
| --- | --- |
| 范围 in | SessionRepository（键结构/预算/LRU/接口隔离）；SW：start/run_task 写 UserTurn、continuity 前情块拼接（最简档）、run 终态归档、重启恢复对账（半途 run 归档为 interrupted turn）；协议扩展（§5.8 全部）；UI：AppShell 六区壳（header 单 tab 起步 + 新对话/设置钮）、TaskBar→Composer（Enter/Shift+Enter/自适应高度）、TranscriptView v1（纯文本）、WelcomePanel 二态改造、任务页 v0（会话列表 + 重命名 + 删除 + 切换；U1 阶段入口 = header 列表钮/落地页历史链接，U3 才收进 header tab） |
| 范围 out | 排队、usage 展示、外部直驱标识、markdown、字号、导出、技能/调试页、搜索、通知 |
| 关键交付 | 会话模型可用的最小产品：同 tab 连发任务 → 连续多轮转录 |
| 验收 | ① 同 tab 二连发：转录两 turn，第二次 run 的 prompt（diag echo 查证）含前情块且受 8K 截断；② SW 重启后重连：会话列表完整、归档转录无洞（含环淘汰场景：单 run 事件 >256 时归档仍完整）；③ 重命名/删除/切换生效且 index 一致；④ 会话超 50 条 LRU 淘汰最老、单会话超 1MB 丢 tool 明细保标题行；⑤ repository/投影纯函数 vitest 覆盖率 ≥85% |
| 依赖 | 无 manifest 变更（unlimitedStorage 已有） |
| 建议拆分 | 按仓库五段闸门经验拆两条闸门分支：**U1a 数据面**（repo + turn 记录 + continuity + 归档 + 协议 + SW 集成测）、**U1b UI 面**（壳 + Composer + TranscriptView + 任务页 v0）——小 diff 是评审收敛的第一变量 |

### U2 干预与状态（8–10 人日）

| 项 | 内容 |
| --- | --- |
| 范围 in | follow-up 排队全链（SW 队列 + 终态节流 2s 自动续跑 + 上限 5 + stop 清空标 cancelled；UI 排队消息条 + 撤销 + 转录排队标记）；状态条升级（状态点 + usage pill + 停止）；外部直驱只读态（origin 标记 / 欢迎卡连接命令 + 复制 / composer 只读降级 / 保留停止）；目标条（composer 顶部当前会话目标 tab URL，点击聚焦）；chrome.commands（Ctrl+Shift+M 模型切换 / Ctrl+Shift+K 开面板）；模型预设模板（新卡表单端点预填）；滚动意图裁剪版 |
| 范围 out | steering（仅协议预留）、markdown、搜索、元素选择器、通知 |
| 验收 | ① run 进行中发送 → 入队可见且转录出现排队标记；done 后 ≤2s 自动开跑下一条；开跑前撤销有效；② stop 后队列清空且对应 turn 标 cancelled（转录可查）；③ bridge 发起 run，sidepanel 显示外部欢迎卡 + 只读条，复制钮产出可执行连接命令，stop 可用；④ usage pill 数值与 diag 导出的 model_result.inputTokens 一致，分母 = activeCard.contextWindow；⑤ e2e 冒烟：排队 3 条中途 stop 的全状态断言 |
| 依赖 | U1（session/turn 模型）；manifest 新增 commands 项（用户可见变更，changelog 说明） |

### U3 可读性与页面注册（8–10 人日）

| 项 | 内容 |
| --- | --- |
| 范围 in | markdown（react-markdown + 安全 schema + rehype-highlight，作用于 finalResult/nextGoal，含代码块复制钮）；turn/finalResult 气泡复制钮；静态 PageRegistry + header tab（任务/技能/调试）；技能页双宿主迁移（OptionsApp 技能库组件进页签，options 保留）；调试日志页（原始 journal 事件流 + 可读回退）；字号 Aa popover（CSS token 档位）；会话标题条收拢（行内重命名 + 字号 + 导出）；任务页会话条目产物索引（累计附件聚合）；导出 HTML（自包含内联 CSS 静态渲染） |
| 范围 out | 导入 HTML（不做）、聊天搜索、通知、元素选择器、rolling summary（默认关的可选开关，若做随本期） |
| 验收 | ① 含 markdown/代码块/script 注入样例的 finalResult 渲染正确且无脚本执行（安全样例集测试）；② 技能页 sidepanel/options 双处数据一致（同 OPTIONS_OPS 面）；③ 调试页 isEnabled 关闭时页签不出现；④ 导出 HTML 离线打开与面板转录一致（抽查工具卡/等待态/多轮边界）；⑤ 字号切换持久化且双主题下均可读 |
| 依赖 | U1（转录投影）；U2（状态面已稳定） |

### U4 补全与打磨（7–9 人日）

| 项 | 内容 |
| --- | --- |
| 范围 in | 聊天搜索浮层（当前会话内全文，命中计数 + aria-live + 跨 turn 高亮；跨会话搜索 = 索引标题 + 摘要，随本期评估裁剪）；通知回流（chrome.notifications：run 终态且 sidepanel 不可见时，设置开关，点击打开面板）；粘贴/拖入接现有 attachment 管线；「复制为新对话起点」弱替代；元素选择器评估（若做：content script 选择模式 + 任务文本插元素引用，另计 4–5 人日） |
| 范围 out | steering、Data 页、定时任务、i18n、数据同意页、导入 HTML |
| 验收 | ① 搜索计数/aria-live 播报正确；② sidepanel 关闭时 done 通知出现且点击打开 sidepanel；③ 粘贴截图直接进附件清单，预算/拒绝明细路径与 📎 完全一致；④ 弱替代从任意历史 turn 一键开新会话且前情块为空 |
| 依赖 | U1–U3；manifest 新增 notifications 权限（用户可见变更，changelog 说明） |

### 远期（独立提案，不承诺）

core steering（mid-run 注入 + 守卫链集成，5–8 人日起）、rolling summary 进前情块、元素选择器（若 U4 评估通过）、跨会话搜索、web-console 双宿主消费（M6 联动：转录投影纯函数 + sendMessage 应答面已为 SSE 桥预留同构消费路径）。

## 7. 风险与依赖

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| core steering 改动面大（pipeline 五阶段 + 守卫链） | 高（已隔离在远期） | 本期仅协议预留 kind；L1 排队先行吸收主需求 |
| **归档与 256 环的时序**：环淘汰先于归档消费会造成转录永久空洞 | 高（U1 必须做对） | 归档缓冲在事件入环前同步喂给（或淘汰 hook 转投），环只服务 UI 实时投影；U1 验收②专测 >256 事件 run |
| chrome.storage.local 写放大与容量 | 中 | 归档终态一次写 + 现有 debounce；unlimitedStorage 已有；repository 接口隔离，IndexedDB 为后备选型 |
| MV3 SW 生命周期：长 LLM 调用期间 SW 被杀 | 中 | 现有 interrupted 恢复机制保留；会话模型新增「归档未完成 run」对账（半途 run 也归档为 interrupted turn，不丢 turn） |
| console-ui 双宿主（web-console M6） | 中 | 纪律延续：session repository 只在 extension 层，console-ui 消费注入接口（同 optionsRequest 先例）；TranscriptView / projectTranscript 零 chrome |
| 等待卡入转录流的结算复杂度 | 低 | U1 明确减法：等待卡仍居中浮层，入流渲染推迟到形态稳定后 |
| 权限可见性变化 | 低 | 实际 manifest 变更仅两处：U2 commands、U4 notifications（unlimitedStorage 已有）；changelog 提前说明 |

## 8. 测试策略（轻量行为索引）

qz BEHAVIOR_INDEX 的裁剪版：**单一 `behaviors` 常量表（docs 或代码内）作为验收与测试的共享索引**，每条 `{id, 行为一句话, 触发, 期望, 覆盖方式}`，规模 30–40 条（qz 的十分之一量级），各期冻结一批：

- U1 批（会话骨架）：`B-SESS-01 续跑含前情`、`B-SESS-02 重启归档完整`、`B-SESS-03 环淘汰不丢归档`、`B-SESS-04 预算 LRU`、`B-TRAN-01 多轮投影序`…
- U2 批（干预与状态）：`B-QUEUE-01/02/03`（入队可见/自动续跑/撤销）、`B-EXT-01 bridge 只读`、`B-USG-01 用量一致`…
- U3/U4 批：`B-MD-01 安全渲染`、`B-EXP-01 导出一致`、`B-SRCH-01 计数播报`…

覆盖分层（沿用现有工程纪律）：

1. **纯函数单测为主**（vitest，≥85%）：projectTranscript 快照测试（多轮/排队/bridge 只读/超环淘汰四个关键样例）、repository 预算、continuity 拼接、ingestSidepanel reducer 扩展；
2. **SW 集成测**（伪 core）：run-manager 的排队/续跑/归档/恢复对账状态机；
3. **diag e2e 冒烟**（少量）：二连发前情块查证、排队 3 条中途 stop、bridge 只读降级。

§6 各期验收标准直接引用行为 id，评审按 id 核对覆盖方式——避免「验收口径」与「测试实现」两张皮。

## 附：本方案涉及的主要现状源码

| 区域 | 位置 |
| --- | --- |
| 组态装配（三区壳） | `apps/extension/src/ui-glue/sidepanel-app.tsx` |
| 状态机 reducer | `apps/extension/src/ui-glue/sidepanel-state.ts` |
| 组件库（双宿主面） | `packages/console-ui/src/`（app-shell/run-panel-header/task-bar/run-timeline/run-status-bar/welcome-panel/final-result/permission-card/settings-overlay） |
| SW 装配与 run 生命周期 | `apps/extension/entrypoints/background.ts`、`src/runtime/run-manager.ts`、`src/runtime/journal.ts`、`src/runtime/port-server.ts`、`src/runtime/policy-bridge.ts` |
| 协议 | `packages/protocol/src/index.ts`（SW_TO_UI/UI_TO_SW 消息面、RunJournalSnapshot、OPTIONS_OPS） |
| 设置 | `apps/extension/src/host/settings-store.ts`（providerCards 含 contextWindow） |
| manifest | `apps/extension/wxt.config.ts`（permissions 已含 unlimitedStorage；无 commands） |
| 桥（外部直驱） | `src/runtime/bridge-gateway.ts`、`src/runtime/drive-gateway.ts`（SIDEPANEL_REQUIRED 在场门） |
