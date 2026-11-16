# SCRATCHPAD——sidepanel 改版 U1：转录骨架 + 会话模型

> 依据：`docs/sidepanel-redesign-plan.md` §6 U1（2026-11-16 定稿）。本文件随实施持续更新；
> 评审轮次登记见 §7。U1 拆两条闸门分支：**U1a 数据面**（本分支先行）/ **U1b UI 面**（U1a 合并后另分支，开工前细化其工作项）。

## 0. U1 总目标与验收（引自方案 §6）

同 tab 连发任务 → 连续多轮转录（含前情块注入）；SW 重启后会话列表完整、归档转录无洞。

验收口径：
1. 同 tab 二连发：转录两 turn，第二次 run 的任务文本含前情块且受 8K 截断
2. SW 重启后重连：会话列表完整、归档转录无洞（含环淘汰场景：单 run 事件 >256 时归档仍完整）
3. 重命名/删除/切换生效且 index 一致
4. 会话超 50 条 LRU 淘汰最老、单会话超 1MB 丢 tool 明细保标题行
5. repository/投影纯函数 vitest 覆盖率 ≥85%

## 1. U1a 数据面工作项（本分支）

### W1 协议扩展（packages/protocol/src/index.ts）

- 新类型：`SessionOrigin = "user" | "bridge"`；`SessionTurn`（turnId/sessionId/runId/task(用户原文)/status: queued|running|done|error|interrupted|cancelled/attachments/createdAt/endedAt）；`RunArchive`（runId/turnId/startedAt/endedAt/status/finalResult/events(压缩后 JournalEvent[])/usage{inputTokens,outputTokens}）；`SessionMeta`（sessionId/tabId/title/origin/runCount/lastStatus/createdAt/updatedAt/usageTokens）；`SessionRecord`（meta+turns+runs）
- `RunJournalSnapshot` 加可选 `origin?` / `sessionId?`（非破坏；旧快照无字段照常恢复）
- `UiControlMessage` 加可选 `sessionId?`；action 联合加 `"steer"`（预留——SW 回 not-supported）
- 新单发面（镜像 options 模式）：`SESSION_OPS = ["session-new","session-list","session-open","session-rename","session-delete","queue-add","queue-remove"]` + `UiSessionRequestMessage {kind:"session", op, payload?}`；UI_TO_SW_KINDS 加 `"session"`。queue 两 op 本期 SW 回 not-supported（U2 实现）
- SW→UI：`session-updated` kind + `SwSessionUpdatedMessage {kind, sessionId?: string, reason: "turn"|"archive"|"index"|"queue"}`（Port 广播；UI 消费在 U1b）

### W2 SessionRepository（apps/extension/src/runtime/session-repo.ts，新建）

- 形态：零 chrome（StorageArea 注入，同 journal/settings-store 模式）；内部变更链串行化（读-改-写不竞态，同 mutation-queue/driveAuditWriter 先例）
- 键：`tc_sessions:index`（SessionMeta[]，上限 50 条 LRU——超限删最老会话及其 `tc_session:<id>`）；`tc_session:<sessionId>`（SessionRecord，单会话预算 1MB——超限从最老 run 的 events 丢 tool_result 明细保留标题行，逐步降级）
- 接口：`createSession({tabId, origin, title})` / `resolveSessionForTab(tabId)`（该 tab 最新会话）/ `appendTurn` / `updateTurn(sessionId, turnId, patch)` / `appendRunArchive` / `listIndex` / `open(sessionId)` / `rename` / `delete`
- 坏形态回退：读旧/坏数据回空不抛（宽松收窄，parse 同 settings-store 风格）；写失败上抛由调用方 fail-soft
- id：`newSessionId` 注入（缺省 `sess_${Date.now().toString(16)}_${随机 4 位}`）

### W3 journal 归档钩子（apps/extension/src/runtime/journal.ts，改造）

- `RunJournalOptions` 加 `archiveSink?: (entry: JournalEvent) => void`；`record()` 在 push 后同步调用——**环淘汰只作用于环数组，sink 先于淘汰语义拿到全量事件**（>256 场景归档不丢，验收②的技术保证）
- 归档缓冲（JournalEvent[]）由 run-manager 持有：begin 时重置，终态收口时压缩成 RunArchive 写 repo
- 既有行为零变化（不注入 sink = 现状）

### W4 continuity 模块（apps/extension/src/runtime/continuity.ts，新建纯函数）

- `buildContinuityBlock(priorTurns: Array<{task, finalResult, status}>): string | null`——前情块 `[会话前情·自动注入]…[当前任务]` 形态（方案 §5.2）；总预算 8192 字符（硬编码常量，超限从最老条目起截断/丢弃）；无前情返回 null
- `withContinuity(task, block): string`——块在前、`[当前任务]` 分隔、用户任务在后
- 只取终态 turn 的 finalResult（error/interrupted 的 lastError 不进前情——失败任务以 finalResult=null 形态出现时仅列任务行）

### W5 run-manager 集成（apps/extension/src/runtime/run-manager.ts，改造）

- deps 加 `sessions?: SessionRepository`（缺省 null = 会话面禁用降级——旧单测不动；background 必须显式注入，装配漏注入在 boot 日志断言）
- start 路径：`startRun(task, origin)` 内部方法（control("start") 与 bridge-gateway 共用；starting 互斥语义不变）：
  1. tab 挑选/校验照旧 → `sessions.resolveSessionForTab(tabId)`（无 → `createSession`，title=任务前 30 字符）
  2. `repo.open` 取既有终态 turn → `buildContinuityBlock` → `withContinuity` 得 effectiveTask → `assembleRun({task: effectiveTask, …})`
  3. `appendTurn({runId, task: 用户原文, status:"running", attachments: list()})`
  4. `journal.begin` 携带 `sessionId`/`origin`
- drive() 终态收口（finally 前段）：`appendRunArchive`（events=归档缓冲压缩；usage=events 汇总 tokens）+ `updateTurn`（终态 status/finalResult/endedAt）+ meta 更新（runCount/lastStatus/usageTokens 累计/updatedAt）→ 广播 `session-updated {reason:"turn"|"archive"}`；全部 fail-soft（失败记日志不改变 run 终态——转录缺档优于 run 崩）
- `recoverInterrupted`：非终态快照恢复时同步对账——按 snapshot.sessionId 找会话：turn 标 interrupted + archive 取自快照幸存事件（环外已丢如实记录，discardedBeforeSeq 带入）；无 sessionId（旧快照）跳过对账
- 归档压缩规则：model_call/model_result/session_end 全量保留；tool_call/tool_result 压缩为标题行（type/actionName/elementIndex/error 摘要 ≤200 字符）；anomaly/skill_active/step_* 保留

### W6 session-handler（apps/extension/src/runtime/session-handler.ts，新建）

- 镜像 options-handler：`handleSessionRequest(op, payload, face)`；face = {repo, notifyUpdated(reason, sessionId?)}（广播 session-updated；自吞异常）
- ops：session-new（显式开新会话，返回 meta）/ session-list（索引）/ session-open（完整 Record）/ session-rename / session-delete；queue-add/queue-remove → `{ok:false, error:"排队功能将在 U2 提供"}`
- 全路径 fail-soft 回 `{ok:false,error}`（同 options-handler）

### W7 message-router + bridge-gateway + background 装配

- message-router：deps 加 `onSession?`，`kind === "session"` 分发（同 options 分支形态）
- bridge-gateway：run_task 改调 `runManager.startRun(task, "bridge")`（origin 标记；sessionId 走 tab 解析同 user——wire 级 sessionId 参数 U1a 不加，登记 U2 评估）
- background.ts boot：`SessionRepository` 构造（storage 注入）→ runManager deps + `onSession` 接线 + Booted face；recoverInterruptedRuns 照旧（对账在 run-manager 内）

### W8 测试（vitest，全绿 + 覆盖率 ≥85%）

- `session-repo.test.ts`（新）：键结构/LRU 50（连带删会话键）/1MB 预算降级链（丢 tool 明细保标题）/变更链串行（并发 append 不丢）/坏形态回退/rename-delete-open-roundtrip
- `continuity.test.ts`（新）：无前情 null/多 turn 拼接/8K 截断从最老起/error turn 处理
- `runtime-journal.test.ts`（扩）：archiveSink 收到全量事件（>256 环淘汰场景——验收②单测锚点）
- `runtime-run-manager.test.ts`（扩）：二连发第二次 assemble 入参 task 含前情块（stub assemble 捕获——验收①实现层证据；比 diag echo 更直接，方案文档的 diag 口径以此等效落地）/终态归档与 turn 状态/bridge origin 进快照/recover 对账（含无 sessionId 旧快照跳过）/sessions 缺省 null 降级
- `session-handler.test.ts`（新）：五 op 应答/queue not-supported/fail-soft
- port-server 既有校验单测：kinds 扩容后 `session-updated` 过验（如有枚举断言同步）

### W9 提交门与验收自查

- `pnpm typecheck` + `pnpm test` + `node scripts/gate.mjs pre-commit` 全绿
- 验收①②④⑤有单测锚点；验收③（重命名/删除生效）session-handler 测试覆盖（UI 入口 U1b）

## 2. U1b UI 面（U1a 合并后另分支；开工前细化）

范围（方案 §6 U1）：sidepanel-state reducer 扩展（session-updated 摄取 + session 单发面客户端）/ AppShell 六区壳（header 单 tab + 新对话/设置钮）/ TaskBar→Composer（Enter/Shift+Enter/自适应高度）/ TranscriptView v1 + projectTranscript 纯函数（console-ui，零 chrome）/ WelcomePanel 二态 / 任务页 v0（列表+重命名+删除+切换，入口=header 列表钮或落地页链接）。

## 3. 设计决策记录

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 前情块注入点=run-manager（effectiveTask 传 assemble），journal.task 含前情 | core 零改动；journal.task 本就是 prompt 契约面（附件清单同款先例）；转录用户气泡用 SessionTurn.task 原文，不显示前情块 |
| D2 | 归档缓冲挂 journal.archiveSink（record 内同步） | record 是事件唯一入口、同步无竞态；淘汰只剪环数组不影响 sink——>256 不丢的技术保证 |
| D3 | 会话写全 fail-soft（记日志不阻断 run） | 转录缺档可容忍，run 终态不可逆——与 distill「可选增强」同姿态但会话面记 WARN 级日志便于发现 |
| D4 | sessions 依赖缺省 null（降级）而非必填 | 既有单测 harness 零改动；生产装配在 background 显式注入 + boot 日志确认 |
| D5 | bridge run_task 本期走 tab 会话解析，wire sessionId 参数登记 U2 | wire 协议变更牵 tc-bridge 配对端，U1a 收敛在扩展侧 |
| D6 | queue/steer 协议 kind 本期预留、SW 回 not-supported | 防 U2/远期 breaking；实现零成本 |
| D7 | 验收①的「diag echo 查证」落地为 stub assemble 入参断言 + 持久快照 task 字段断言 | 比新增 diag 探针更直接可测；e2e 冒烟（smoke-sw-runtime 风格）在 U1b 收口时补真机验证 |

## 4. 风险与对策（U1a 特有）

- **storage 写放大**：归档终态一次写（run 结束单点），无逐事件写盘；index 更新同链串行
- **重启对账窗口**：SW 被杀时归档缓冲丢失——恢复用快照幸存事件（≤256）+ discardedBeforeSeq 如实记账；turn 状态以 interrupted 收口不悬挂
- **旧数据兼容**：无 sessionId 的既有 `tc_runUi:*` 快照恢复照旧（对账跳过）；`tc_sessions:index` 不存在=空索引首次创建

## 5. 进度记录

- [ ] W1 协议扩展
- [ ] W2 session-repo
- [ ] W3 journal archiveSink
- [ ] W4 continuity
- [ ] W5 run-manager 集成
- [ ] W6 session-handler
- [ ] W7 router/bridge/background 装配
- [ ] W8 测试全绿 + 覆盖率
- [ ] W9 提交门通过

## 6. 验收自查（对应 §0 五条）

- [ ] ①二连发前情块（含 8K 截断）
- [ ] ②重启归档完整 + >256 环淘汰不丢
- [ ] ③重命名/删除/切换（op 面）
- [ ] ④LRU + 1MB 降级
- [ ] ⑤覆盖率 ≥85%

## 7. 评审轮次登记（review-loop 填写）

（待 /review-loop 各轮登记：轮号/意见分布/采纳与驳回/修复提交）
