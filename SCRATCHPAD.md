# issue #9 实施草稿：skill-drafts 通知面三缺口

- issue: [#9](https://github.com/zjordon/TreeChrome/issues/9)
- 分支：`fix/issue-9-skill-drafts-notify`（自 main 3608b09）
- 状态：**实施完成，测试全绿 + gate 过 + 已重建扩展**——待评审（/review-loop）

## 0 实施记录（2026-10-25）

- 计划外收紧 ①：D1 的「通知失败不改 op 结果」从实现侧自律升级为 **handler 层兜底吞异常**（测试暴露：裸 await 会把通知异常漏进外层 catch 变 {ok:false}）
- 计划外修复 ②：迁移测试实抓 **revoke-grant `removed` 求值顺序脆弱性**——原代码在 `saveAlways` 之后求 `grants.length - kept.length`，loadAlways 返回活引用时 splice 已清空原数组恒得 0；真实 ChromeGrantStore 每次 filter 出新数组故线上无恙，仍改为先算后写
- 测试：extension 140→154（+options-handler 11、worker 过程拍 5 处断言、run-manager queued 拍、reducer distill 状态机、core 判官归一 2 例、envelope kind 表）
- 覆盖率：extension 93.96%（gate ≥85% 过）；biome 3 文件格式修正

## 1 背景与证据（2026-10-24/25 真机）

| 缺口 | 证据 |
|---|---|
| adopt/discard 后不广播计数 → 幻影「1 张待审」 | 代码机制：background.ts 两个 case 只调 store 返回；draftCount 只增不减。存储层无泄漏 |
| 蒸馏过程零状态 → run 结束后 3m43s 空窗 | SW 日志实测：run ended 01:57:07 → matcher 115s → distill 105s → 草稿 02:00:50；用户在空窗内误判「蒸馏没成功」 |
| failureReason 字面字符串 "null" | 快照实读：judge prompt 示例 `"... or null"` 被照抄 |

判词显示链已实证无恙（不在本 issue 范围）。

## 2 设计决策

- **D1 通知收敛**：options 面注入 `notifyDrafts: () => Promise<void>`（**必填**——评审轮教训：可选注入缺省静默失去语义），实现放 boot 闭包（自查 listDrafts → broadcast，内部 catch 只记日志，**通知失败不得改变 op 返回值**）；adopt/discard 成功路径调用。worker 既有 `notify(count)` 保持签名不动（两处薄实现，不强行抽象）。
- **D2 过程状态走新协议 kind `distill-status`**：不动 skill-drafts 语义（它表达「当前待审数」，过程态是另一维度）。`DistillPhase = "queued" | "running" | "done" | "failed"` + `detail?: string | null`（中文短句）。SW_TO_UI_KINDS 10→11，向后兼容（sidepanel reducer default 忽略未知 kind 已有）。
- **D3 三拍来源**：
  - `queued`：run-manager enqueueDistill 在 enqueue 成功后经 deps.broadcast 直发（run-manager 已持广播面）；
  - `running` / `done` / `failed`：DistillWorker 新增必填 `onPhase(phase, detail?)` 钩子，boot 接线为广播+日志。每条 job 一拍 running、一拍终拍（队列多条即多拍，状态行覆盖更新）；
  - saveDraft 后既有 skill-drafts count 广播保持不变（done 拍与 count 广播独立并存）。
- **D4 done 也有拍**：skip/unchanged 路径无 count 变化，done 拍 + detail（「跳过：…」「无新观察（streak+1）」「新草稿待审」）让用户知道「跑完了、为何没产出」。failed detail 带错误摘要（含重试信息）。
- **D5 sidepanel 状态行**：state 加 `distill: {phase, detail} | null`；`distill-status` 消息置位；**journal-snapshot runChanged 时清 null**（旧失败提示不跨 run 残留）；hello 同 run 保留。渲染：queued/running/done 用 muted 文案，failed 用 tc-ev-err 常驻。与草稿待审提示并存不互斥。
- **D6 判官字面 null 归一（core，解析侧）**：`reasoning`/`failureReason` 为字符串且 trim+小写后 === "null" → null。**不动 prompt**（judge system prompt/tool schema 与 Python 字节锚定，改措辞引入 parity 分歧）。范围只收 "null"（无 "None" 证据，不臆测）。
- **D7 handleOptionsRequest 迁出 entrypoint**：搬入新 `apps/extension/src/runtime/options-handler.ts`（纯函数+注入面，行为不变），换可测性——现状零单测；background.ts 只留注册与 boot 装配。同时 D1 的 notifyDrafts 在新文件注入。
- **不做**：SW 重启后过程态恢复（transient 可接受，fetchDraftCount 兜底草稿数）；e2e smoke 不加断言（单元覆盖足够）。

## 3 实施步骤

- **S1 协议面**：`packages/protocol/src/index.ts`——DistillPhase 类型 + SwDistillStatusMessage + kind 表 10→11 + 联合；`test/envelope.test.ts` 样例与长度同步。
- **S2 core 判官归一**：`packages/core/src/agent/judge.ts`——nullish 归一 helper 应用于 reasoning/failureReason；judge 测试补字面 "null"（含大小写/空白变体）与正常串透传。
- **S3 options-handler 迁出 + notifyDrafts**：新 `apps/extension/src/runtime/options-handler.ts`（自 background.ts 搬移 handleOptionsRequest/OptionsFace/grantsMutation + 扩 notifyDrafts）；background.ts 引用改 import、boot 组装注入；新 `apps/extension/test/runtime-options-handler.test.ts`（adopt/discard 成功 → notifyDrafts 调用；载荷校验回归；通知异常不改 op 结果）。
- **S4 worker 三拍 + run-manager queued 拍**：`distill-worker.ts` 加 onPhase（running 每条 job、done/failed 终拍全路径含 skip/unchanged/无卡）；`run-manager.ts` enqueueDistill 成功后广播 queued；distill-worker.test / runtime-run-manager.test 补断言。
- **S5 sidepanel 状态行**：`sidepanel-state.ts` 状态机 + reducer；`sidepanel-app.tsx` 渲染；ui-glue.test 补（各 phase 渲染、runChanged 清空、hello 保留）。
- **S6 验证**：pnpm typecheck + test + gate；扩展 rebuild 供真机走查。

## 4 测试面

| 层 | 用例 |
|---|---|
| protocol envelope | kind 表 11、distill-status 样例路由 |
| core judge | "null"/" NULL "/" null " 归 null；正常串透传；verdict 布尔不受影响 |
| options-handler | adopt/discard 成功调 notifyDrafts；坏载荷拒绝不调；notify 抛异常 op 仍 ok |
| distill-worker | 每条 job running；saveDraft→done(新草稿)；skip/unchanged→done(detail)；error→failed；空队列不发拍 |
| run-manager | 门控过入队 → 广播含 distill-status queued；门控不过不发 |
| ui-glue | 四 phase 渲染文案；failed 用 err 样式；新 run 清空；与草稿提示并存 |

## 5 验收清单

- [ ] 采纳/丢弃草稿后 sidepanel 徽标即刻清零（真机）
- [ ] run 结束后可见「已排队 → 蒸馏中 → 完成/失败」过程提示（真机）
- [ ] 失败提示常驻至下一 run，新 run 清空
- [ ] 快照 judgement 不再出现字面 "null"（单测锚定）
- [ ] pnpm typecheck/test 全绿；gate 过；覆盖率 ≥85%

## 6 风险与边界

- protocol 新 kind 对旧 UI 向后兼容（default 忽略）——本仓 UI 与 SW 同版本发布，无灰度问题
- onPhase 必填会破坏 distill-worker 既有测试装配——同步更新注入（stub 记录）
- boot 闭包 notifyDrafts 与 worker notify 双实现有轻微重复——接受（各 3 行，语义不同源）
- 不改 e2e、不改 prompt 常量、不动 skill-drafts 既有语义

## 7 评审轮登记

| 轮 | 意见 | 采纳/驳回/stale | 要点 |
|---|---|---|---|
| — | — | — | 待 /review-loop |
