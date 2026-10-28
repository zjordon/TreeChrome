# SCRATCHPAD — issue #20 UI 重构 · M3 布局层

> 状态：**M3 已实施并全量验证；评审循环收敛（轮 1 零意见，2026-10-29）。待 `/finish-issue`。**
> 基准：`docs/ui-refactor-reference.md`（§5.1 布局迁移要点 / §6 M3 行）；issue #20；M1/M2 已并入 main（PR #21/#22）。
> 分支：`feat/issue-20-ui-m3`（自 main）。

## 目标

侧边栏从「单列滚动」重排为参照形态的三区结构：

```
.tc-root（height 100%）
├─ header   轻量：产品名 + 连接状态点 + 蒸馏状态 + 草稿徽标 + 设置图标钮（IconButton 首个消费方）
├─ main     滚动区：确认卡 → 时间线 → 终态卡；空闲时欢迎屏
└─ dock     底部常驻：运行状态条（dot+文案+步数耗时+停止钮）+ TaskBar（输入/附件/预算/起跑）
```

## 非目标

- M4 设置 overlay（header 设置钮本期跳 options 页，M4 换 overlay）
- TaskBar 内部结构（输入/附件/预算/拒绝明细 DOM 契约不动——只移容器位置与移除停止钮）
- Enter 快捷键提交与提示行（交互行为不扩，缩范围）
- sidepanel-state / protocol / SW 运行时零改动（纯 UI 重排）

## 设计决策

**D1 布局壳 `AppShell`（console-ui 新组件 + theme/layout.css 第五分片）**
- `{header?, dock?, children}` 三区；`.tc-shell`（flex column 满高）/ `.tc-shell-header`（flex none + 底边框）/ `.tc-shell-main`（flex 1 + overflow-y auto）/ `.tc-shell-dock`（flex none + 顶边框）
- `base.css` `.tc-root` 增 `height:100%`（保留 min-height；options 页内容超高仍可页面滚动）；`theme.css` 聚合口 +1 行 @import

**D2 `RunPanelHeader`（console-ui 新组件）**
- `{title, portStatus?, distill?, draftCount?, onOpenSettings?, onReviewDrafts?}`
- 左：标题 + 连接状态点（online 绿 / connecting 黄 / offline 红，`title` 全文）
- 右：蒸馏状态图标（⧗/⚗/✓/✗，failed 红色，`title` 全文——`distillStatusText` 从 ui-glue 迁入）；草稿徽标（`📝 N 草稿` 可点 → `onReviewDrafts`）；设置 IconButton（齿轮 svg，→ `onOpenSettings`）
- ui-glue 删除对应三条文本行（main 减噪）

**D3 `RunStatusBar`（console-ui 新组件，替代 StatusLine）**
- `{status, stepCount, startedAt, endedAt?, now?, onStop?}`——状态点（running=accent 呼吸动画 / awaiting-*=warning）+ 状态文案 + 步数·耗时 + 停止 IconButton（danger xs，右对齐）
- **只运行期渲染**（terminal 后消失，终态由 FinalResult 卡承载）；`formatSeconds` 保留导出；`StatusLine` 组件删除（唯一消费者是 sidepanel，测试迁移）
- **停止钮从 TaskBar 迁出**：TaskBar 移除 `onStop` prop 与"⏹ 停止"钮（运行态只禁用起跑）——e2e smoke-ui 已核实不依赖该钮

**D4 `WelcomePanel`（console-ui 新组件，空闲态）**
- `snap == null && events 空` 时渲染：产品名大字 + tagline「浏览器里的任务代理」+「在下方输入任务开始 ↓」；取代现"空闲——配置好 LLM 卡片…"文本行

**D5 sidepanel 组态重排（ui-glue `sidepanel-app.tsx` + entrypoints `App.tsx`）**
- `SidepanelAppProps` 增 `onOpenSettings?: () => void`（entrypoints 注入 `chrome.runtime.openOptionsPage`，M4 换 overlay）；`AppShell` 装配 header/main/dock
- main：确认卡（保持顶部 inline）→ 欢迎屏或时间线 → 终态卡；port 警示文本行删除（收进 header 状态点）

**D6 CSS 落点**
- 新 `theme/layout.css`：shell/header/runstatus/welcome/port-dot 类 + `tc-pulse` keyframes（受 base 的 reduced-motion 兜底）
- TaskBar 移位零 CSS 改动（容器换 dock）；`components.css` 不动

## 实施步骤

1. `theme/layout.css` 新分片 + `theme.css` 聚合 + `base.css` height:100%
2. console-ui 四新组件（AppShell/RunPanelHeader/RunStatusBar/WelcomePanel）+ index.ts 导出；task-bar 移除 onStop/停止钮；status-line.tsx 删除
3. 测试：四新组件单测 + `run-panel.test.tsx` 迁移（StatusLine→RunStatusBar）+ `task-bar.test.tsx` 停止钮断言更新
4. ui-glue `sidepanel-app.tsx` 重排 + entrypoints `App.tsx` 注入 onOpenSettings
5. `pnpm typecheck` + `pnpm test` 全绿；`pnpm exec biome check --write .`
6. `wxt build` + `e2e/smoke-ui.mjs` + `_cascade-check.html` 增 shell 结构 + 双主题截图
7. `node scripts/gate.mjs pre-commit`

## 验收

- 全仓 typecheck/test 绿（新组件覆盖率 100%，包阈值内）；gate 全绿
- e2e smoke-ui PASS（TaskBar 选择器未破；若断言受移位影响同步修）
- 双主题截图 + 真机目检：三区结构、header 徽标、运行状态条（含停止）、欢迎屏、暗色回归

## 待人工审核的决策点

1. **输入常驻底部 dock**（qz 形态；运行中状态条在 dock 上沿、TaskBar 输入禁用但常驻）——建议采纳
2. **停止钮迁出 TaskBar** 至运行状态条（TaskBar 纯输入+起跑；e2e 已核不依赖）——建议采纳
3. **欢迎屏**：空闲态大字产品名+tagline（低成本高观感）——建议做
4. **header 收编**：port 状态点/蒸馏状态/草稿徽标进 header（main 删三条文本行）——建议采纳

## 实施记录（2026-10-29）

**落地文件**
- `theme/layout.css`（第五分片）：shell 三区/面板 header/port 点/草稿徽标/运行状态条（tc-pulse 呼吸动画）/欢迎屏；`theme.css` 聚合 +1 行；`base.css` `.tc-root` 增 height:100%（AppShell 高度链）
- console-ui 新组件 ×4：`AppShell` / `RunPanelHeader`（distillStatusText 自 ui-glue 迁入）/ `RunStatusBar`（替代 StatusLine——status-line.tsx 删除，formatSeconds 随迁）/ `WelcomePanel`；index.ts 导出面更新
- `task-bar.tsx`：移除 onStop 与"⏹ 停止"钮（迁 RunStatusBar）；运行态只禁输入与起跑
- `sidepanel-app.tsx` 三区重排（header 徽标区收编 port/蒸馏/草稿三条文本行；main = 确认卡→欢迎屏/时间线→终态；dock = 运行状态条 + TaskBar 常驻底部）；`App.tsx` 注入 onOpenSettings（openOptionsPage，M4 换 overlay）
- 测试：app-shell/run-panel-header/welcome-panel 三新文件 + run-panel.test 迁移（StatusLine→RunStatusBar）+ task-bar.test 更新（停止钮断言改起跑禁用）

**验证**
- 全仓 typecheck/test 一次全绿（console-ui 75 tests；新组件覆盖率 100%）
- `wxt build` + `e2e/smoke-ui.mjs` PASS——**断言口径同步更新**：终态"完成"徽章随 StatusLine 消失，改为 FinalResult 的"✓ 成功"承载（计划第 5 步预案兑现）
- 双主题四截图复跑（`_shot-*.png`——三区结构/欢迎屏可直查）
- gate pre-commit 全绿（biome 顺清迁移后失效的 SidepanelState import）

**过程记录**
- chrome-devtools MCP 的 take_screenshot 在浏览器重连后持续挂起（120s×2 超时），目检降级为截图文件直查 + DOM 结构由 smoke 覆盖——MCP 侧问题非产物问题

## 评审轮登记

- **轮 1**（2026-10-29）：**零意见首刷收敛**（base=main 全量 13 文件，5m48s，complete）——循环终止；M1-M3 累计评审 7 轮，唯一一次首轮即收敛
