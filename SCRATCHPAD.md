# issue #10 实施草稿：LLM 调用失败可见性

- issue: [#10](https://github.com/zjordon/TreeChrome/issues/10)
- 分支：`fix/issue-10-llm-failure-visibility`（自 main 63192c2）
- 状态：**实施完成，测试全绿 + gate 过 + 已重建扩展**——待评审（/review-loop）

## 0 实施记录（2026-10-25）

- 计划外发现 ①（D5 实施时实抓）：**能力止损在 step 层收口**——pipeline.ts:116 在
  consecutiveFailures 达上限时 runStep 直接返 true，agent.run 的 `if (done) break`
  吞掉该路径，run 顶部破环是到不了的二道防线。修法：done-break 上以
  `!history.isDone()` 判别归因 max_consecutive_failures（临时埋点实证后落修）
- 计划外收紧 ②：`resolveAgentSettings` 的 judge 覆盖面收 `Partial<JudgeSettings>`
  （交叉类型会把 judge 又收紧回全量——用 Omit 规避）；assemble 单键透传形态依赖此
- 测试：core 1372→1375、node-host 89→91、extension 154→155（判官留痕/超时透传、
  gateFailureReason 三态、stopReason 三停跑点、lastError 终态映射、门控日志归因）
- biome 5 文件格式修正；扩展已重建

## 1 背景与证据（issue #10 三件套）

| 项 | 证据 |
|---|---|
| E2a judge 静默 catch | judge.ts `catch { return null }`——超时/HTTP 异常/两轮空响应零日志零事件；2026-10-24 真机 judge 失败全无痕迹 |
| E2b 60s 硬超时 | JUDGE_CALL_TIMEOUT_MS 不可配；thinking 模型 + 40k 轨迹贴近超时线（2026-10-25 判官实跑窗口 ≤82s 含序列化）；蒸馏侧同类已放宽 180s |
| E2c 门控日志混淆 | 「门控未过（非成功完成或 Judge 复核未通过）」把 judgement=null 与 verdict=false 混为一句 |
| B2 node-host 蒸馏超时 | distillAfterRun 未传 callTimeoutMs，长轨迹撞缺省 60s（扩展 worker 已 180s） |
| E5 终态无原因 | 2026-10-25 HTTP 401 实测：连续 5 步失败 → status=done、isDone=false、lastError=null → UI 仅「✗ 未成功」无解释 |

判词显示链已实证无恙（#9 收尾验证）——本 issue 只修失败/超时面。

## 2 设计决策

- **D1 超时可配走可选键**：`JudgeSettings.callTimeoutMs?: number`，**不进 DEFAULT_JUDGE_SETTINGS**（Python 对拍 fixture 零变化——沿 `submitConfirmEnabled`/`maxAttachmentBytes` 先例）；judge.ts 消费时缺省 60_000。`resolveAgentSettings` 的 judge 子合并天然透传。
- **D2 判官日志注入**：JudgeEvaluator 构造第三参 `log?: (m: string) => void`（agent 侧接线 `this.log`，扩展里呈现为 `[tc] judge: …`）。两条失败路径各自留痕：调用异常（含超时——LLMCallTimeoutError 文案自含超时毫秒）与两轮空响应放弃；**成功路径不刷屏**。judgement=null 仍返 null 不挂任务（03 §8 冻结契约不变）。
- **D3 扩展侧 180s**：assemble 的 `resolveAgentSettings({ judge: { callTimeoutMs: 180_000 } })`——与 distill worker 同口径同理由（SW 生命周期无约束差，判官无 keepalive hold 但调用短于 run 收口窗口）。node-host judge 维持 60s 缺省（无超时实证，不臆测放宽）。
- **D4 门控失败归因单源**：core `distill-gate.ts` 新增 `gateFailureReason(history): string | null`（null=门控通过）——三态：任务未成功完成 / judge 未执行或调用失败（judgement=null）/ judge 复核拒绝（verdict=false）。run-manager 与 node-host distillAfterRun 的日志都改用它（双宿主单源，可单测）。
- **D5 停跑原因进 history**：`AgentHistoryList.stopReason?: string | null`（additive TS 扩展，Python 无此字段——agent 返回契约的可观测增强，非 parity 面）。取值 `max_steps | max_consecutive_failures | max_infra_failures | history_degraded`；四个 break 点 + maxSteps 自然退出赋值，正常 done 收口为 null；`finalizeDegradedSteps` 的 finally 赋值是既有同款先例。
- **D6 终态原因复用 lastError**：扩展 run-manager done 分支 `isDone=false` 时 `lastError ← 停跑原因中文映射`（收在 run-manager 常量表：如 max_infra_failures→「LLM 基建失败达到上限——常见原因：API key 失效/网络不通」）。**零协议改动**——FinalResult 既有 lastError 红字渲染面直接生效。
- **不做**：judgement=null 的 UI 侧区分呈现（需协议扩字段，无真实需求前不立项）；node-host judge 超时配置化；模型 text-not-tool_use 高频重试问题（另一维度，今日实测另行登记与否由用户定）。

## 3 实施步骤

- **S1 core 判官**：settings.ts 加可选键；judge.ts 构造第三参 + 两条失败路径日志 + `callTimeoutMs: settings?.callTimeoutMs ?? JUDGE_CALL_TIMEOUT_MS`；agent.ts 接线传 log。
- **S2 core 门控归因 + node-host B2**：distill-gate.ts 增 `gateFailureReason`；run-manager 与 node-host distillAfterRun 日志改用；distillAfterRun 传 `callTimeoutMs: 180_000`（DistillRunOptions 可选覆盖，缺省 180s）。
- **S3 core 停跑原因 + 扩展终态**：views.ts AgentHistoryList 加 stopReason；agent.ts 四 break 点 + 循环自然退出赋值；run-manager done 分支 lastError 映射；assemble judge 180s。
- **S4 验证**：pnpm typecheck/test + gate；扩展 rebuild。

## 4 测试面

| 层 | 用例 |
|---|---|
| core judge | 超时抛错→日志含失败+返 null；两轮空响应→放弃日志；callTimeoutMs 透传（mock 断言 req.callTimeoutMs=180_000）与缺省 60s |
| core distill-gate | gateFailureReason 三态 + 通过返 null |
| core agent | maxFailures/maxInfra/maxSteps/degraded 四停跑点 stopReason；正常 done 为 null |
| extension run-manager | isDone=false 终态 lastError 含停跑原因；门控日志三分支文案 |
| node-host distill-run | callTimeoutMs=180_000 透传进 distillTaskCard |
| settings | resolveAgentSettings judge 可选键透传 |

## 5 验收清单

- [ ] 人为配错 API key 跑真机：终态呈现「LLM 基建失败达到上限…」红字（E5）
- [ ] SW 控制台可见 `judge:` 前缀日志（失败时）；门控日志区分三态（E2a/c）
- [ ] node-host 蒸馏长轨迹不再撞 60s（B2，单测锚定透传即可）
- [ ] pnpm typecheck/test 全绿；gate 过；覆盖率 ≥85%

## 6 风险与边界

- stopReason 是公共契约新增字段——评测仓消费面不受影响（additive）；fixtures 不动
- judge 日志只在失败路径——不影响现有判官对拍测试的日志断言面
- lastError 复用不改 protocol/journal 类型——无旧快照兼容问题

## 7 评审轮登记

| 轮 | 意见 | 采纳/驳回/stale | 要点 |
|---|---|---|---|
| 1 | 0 | —/—/— | 零意见收敛（complete，13 文件，glm-5.3，6m39s）；测试 core 1375/node-host 91/extension 155；gate 过 |
