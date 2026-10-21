# SCRATCHPAD — 实施计划草稿（随实施持续更新）

> 分支：`feat/issue-2-attachments`（自 main @ 301ec0a）
> 目标 1：实现 [issue #2](https://github.com/zjordon/TreeChrome/issues/2) — 多附件收尾：被拒附件 UI 明细反馈、预算预检口径、port 通道分块传输（C 档）
> 状态：**实现完成（步骤 1-8 全绿），待步骤 9 评审收尾**

## 0. 背景与结论（调研已完成）

多附件主体（multiple 输入、增量消息面、注册表多件）已在 M5 段 E/F 落地。剩余三件事的事实基础：

| 事实 | 位置 | 含义 |
|---|---|---|
| 拒绝只进 SW log，无 UI 反馈 | `run-manager.ts` addAttachment（仅 `deps.log`） | 需新增回传通道 |
| 注册表无预算访问器 | `attachment-registry.ts`（总量只在 add 内部算） | 需新增 `budget()` |
| base64 整串单条 port 消息 | `attachment-file.ts` fileToBase64 → `attachment-add` | 100MB→≈133MB 字符串，撞消息上限风险 + 多份拷贝 |
| core 侧按单 id 消费，多件无关 | `task-text.ts` attachTaskText 已遍历清单；`assemble.ts` readAttachment 装饰 | **core 不动**（已核实） |
| 既有测试断言「拒绝时不广播」 | `runtime-run-manager.test.ts` | 语义已反转：断言 `attachment-rejected` 广播 |
| e2e 零附件覆盖 | smoke-sw-runtime / smoke-ui | 已补 smoke-attachments |

## 1. 方案总览（含实施期实证修订）

传输语义（begin→begun→chunk×N→commit/abort 状态机全程保留）：

```
UI: attachment-begin {transferId, name, mimeType, size}   ← SW 预检（单件/总量含 pending）+ 预分配
SW: attachment-begun  {transferId}                        ← 预检通过回执（UI 才开始发块）
UI: attachment-chunk  {transferId, offset, data} × N（顺序发，file.slice 流式读）
UI: attachment-commit {transferId}                        ← 转正 att_N
SW: attachments {items, budget}（成功）或 attachment-rejected（失败明细）
```

> **⚠️ 实施期实证修订（2026-10-21，e2e smoke-attachments 的 diag echo 探针）**：
> 计划原定 chunk 载荷为 ArrayBuffer（假设 port 结构化克隆可行）。实证 chrome.runtime
> 消息通道为 **JSON 序列化**——ArrayBuffer 回显为 `{}`、Uint8Array 为 `{0:1,2:…}`，
> 克隆不可用。**chunk 载荷改为 base64 字符串（4MB 源字节/块）**：
> - 保留的主收益：单条消息压到块级（≈5.3MB 字符串），整串大消息撞限值与瞬时双份内存风险消除；
> - 未达成项：issue 验收中「port 面不再出现 base64 字符串」——+33% 膨胀保留（块级粒度）；
> - 替代方案（OPFS 侧信道零 base64）评估为 registry 存储模型重做，改动面过大，未采。
> - 该修订已写进 protocol 注释与 e2e 头注释留痕。

- `attachment-add`（base64 整串版）已删除；`fileToBase64`、registry `add(base64)`/导出 `base64ToBytes` 退役（编码核以块级粒度活在 `attachment-upload.ts` 的 `bytesToBase64`）。
- `resolve()` 不动：读取时 bytes→base64 供 core `readAttachment`（core 契约面零变化）。

## 2. 组件改动清单（已实施）

| 层 | 文件 | 改动 |
|---|---|---|
| protocol | `packages/protocol/src/index.ts` | `AttachmentBudget`/`AttachmentRejection` 类型；4 个新 Ui 消息（begin/chunk/commit/abort）+ 2 个新 Sw 消息（begun/rejected）；`SwAttachmentsMessage` +`budget`；kind 表 7→9 / 9→12 |
| registry | `apps/extension/src/host/attachment-registry.ts` | pending→committed 状态机：`begin`（预检+预分配+pending 占位总量）/`append`（严格顺序 base64 块）/`commit`（写满转正，失败带 meta）/`abort`/`budget()`；60s 无活动超时；`clearForRun` 连 pending 清 |
| run-manager | `apps/extension/src/runtime/run-manager.ts` | 四个新 handler；begin 通过→begun 广播 / 拒绝→attachment-rejected 明细广播；commit 成功→attachments+budget 广播 / 失败→lost（占位名「（未知附件）」）；remove/清表广播带 budget |
| ui-glue | `apps/extension/src/ui-glue/attachment-upload.ts`（新） | 传输编排纯函数：begin→等 begun（信号三态 begun/rejected/timeout）→chunk→commit；读文件失败/begun 超时→本地拒绝+abort（修复旧 unhandled rejection） |
| ui-glue | `sidepanel-app.tsx` | begunWaiters 桥（onMessage→传输推进）；uploads 进度本地态；起跑清拒绝明细 |
| ui-glue | `sidepanel-state.ts` | state +`attachmentBudget`/`attachmentRejections`（上限 5）；reducer 处理 rejected/本地拒绝/逐条清/整表清 |
| ui-glue | `attachment-file.ts` | **删除**（fileToBase64 退役） |
| console-ui | `packages/console-ui/src/task-bar.tsx` | 可选 props `budget`/`uploads`/`rejections`/`onDismissRejection`；UI 放置：清单 → 上传中条目（%）→ 预算行（≥90% 警色）→ 拒绝区（reason 文案映射 + × 清除）；上传中禁用开始 |
| e2e | `apps/extension/e2e/smoke-attachments.mjs`（新）+ package.json | `e2e:attachments` 脚本；diag echo 通道探针（记录不断言） |
| 不动 | core 全部、final-result、journal | 边界声明见 §2.8（原计划） |

## 3. 测试计划（已实施）

| 层 | 用例 |
|---|---|
| protocol | envelope kind 表 9/12 + 新消息样例 |
| registry | begin/append/commit/abort 全路径；三拒绝（含 pending 占位竞态）；invalid（size 非正/字段坏/重复 id）；append 错位/重复/越界/非法 base64/非 string；commit 半传带 meta/彻底未知；budget 三态；超时清理；list 不见 pending |
| run-manager | begin→begun；拒绝→rejected 广播（旧「不广播」断言已反转）；chunk 静默；commit→attachments+budget；remove 带预算；commit 半传→lost+meta |
| ui-glue | reducer 预算/拒绝/上限 5/清除；uploadAttachment 四路径（成功多块/被拒停发/超时 abort/读失败 abort） |
| console-ui | 预算行渲染+警色；拒绝文案映射+×；uploads 进度+禁开始 |
| e2e | 微型单块 / 8MB 两块 / 超限拒绝 / 多件并存 —— **PASS（真 Chrome+SW+Port）** |

## 4. 实施进度

- [x] 1. protocol 类型 + kind 表 + envelope 测试
- [x] 2. registry 状态机 + 测试（10 用例）
- [x] 3. run-manager handler + 广播 + 测试（含旧断言语义反转）
- [x] 4. sidepanel-state reducer + 测试
- [x] 5. sidepanel-app 传输编排 + ui-glue 测试；attachment-file.ts 退役
- [x] 6. task-bar UI + 测试
- [x] 7. e2e smoke-attachments.mjs（**含通道实证：ArrayBuffer 不可用 → 块载荷 base64 修订**）
- [x] 8. 全量验收：`pnpm typecheck` ✅、`pnpm -r test` 8 包 1823 用例 ✅、`pnpm lint` ✅、`node scripts/gate.mjs pre-commit` ✅
- [ ] 9. `/review-loop` 评审循环 → `/finish-issue` 收尾（待用户启动；前置：实现需先提交成 range）

## 5. 风险与已知项

- ~~chrome.runtime port 消息上限~~ → 已实证通道 JSON 序列化，4MB 块 ≈5.3MB 字符串，限值风险消除
- run 期间新增附件不回写 journal 快照（既有行为，本次不动）
- 真 100MB 上限跑通属手动验证项（e2e 常态跑 8MB 多块路径已证分块正确性）——建议手动跑一次后回填 issue 备注
- 本分支工作区还叠着 main 带来的未提交改动（issue #1 实现、.zcode/.claude 命令、AOCI 资产）——本分支提交时须只挑附件相关文件

## 6. 变更记录

- 2026-10-21 计划初稿（用户审核通过）
- 2026-10-21 实施完成（步骤 1-8）；C 档实证修订：ArrayBuffer 克隆不可用（通道 JSON 序列化）→ 块载荷改 base64，详见 §1 修订块
