# SCRATCHPAD — issue #20 UI 重构 · M4 设置收纳（收官期）

> 状态：**M4 已实施并全量验证；评审轮 1 零意见首刷收敛（2026-10-29）。** 待 `/finish-issue` 收官（M1-M4 全部完成，PR 将关闭 #20）。
> 基准：`docs/ui-refactor-reference.md`（§2.5 overlay 形态 / §5.2 通道面 / §5.3 options 处置）；issue #20；M1–M3 已并入 main（PR #21/#22/#23）。
> 分支：`feat/issue-20-ui-m4`（自 main）。

## 目标

设置从独立 options 页收进侧边栏 overlay（qz 底部弹出形态），`Segment`/`Switch` 迎来首个消费方；options 页保留同组件薄壳（双宿主）。

## 关键侦察结论（通道面已事实定型）

§5.2 的"二选一"无需真选：sidepanel 的 `fetchDraftCount` **早已在用** `runtime.sendMessage({kind:"options",...})` 单发面（message-router 无 sender 过滤，e2e 实证可用）——**选 a：零 router/protocol 改动**，sidepanel 注入与 options 页同款的 request 工厂即可。

## 设计决策

**D1 `SettingsOverlay`（console-ui 新组件 + layout.css 追加 overlay 族）**
- `{open, onClose, title, children}`：`position:fixed` inset-0 backdrop（--tc-overlay-backdrop）+ 底部锚定 sheet（--tc-overlay-surface/border/shadow、顶部圆角 lg、max-height 88%、drawer-up 动画 motion-slow × ease-emphasized）+ header（title + × IconButton）+ body（overflow-y auto）
- 关闭路径三条：× 钮 / backdrop 点击 / Esc（useEffect keydown）；动画受 reduced-motion 兜底
- CSS 落 layout.css 追加（面板级布局族，~60 行）

**D2 `OptionsApp` 重构为分区 tab 形态（一组件双宿主）**
- 内部 `Segment` tab 状态四区：**模型**（ProviderList + CardForm + 附属卡 + Agent 覆盖）/ **授权**（GrantsView）/ **技能库**（SkillListView）/ **草稿**（SkillDraftReview）——`Segment` 首个消费方
- Agent 覆盖的「视觉模式」checkbox → `Switch`——首个消费方
- **ThemedRoot 外提**：OptionsApp 不再自带主题壳（宿主负责）——否则 sidepanel 内嵌套 ThemedRoot 在显式主题切换时内外层不一致（内层 auto 跟系统不跟外层）
- error/notice/刷新钮保留在 tab 区上方；OptionsAppProps 仍是 `request` 工厂注入

**D3 sidepanel 接线（ui-glue）**
- `SidepanelAppProps` 增 `optionsRequest?: (op, payload?) => Promise<unknown>`（entrypoints 注入模块级稳定工厂——refresh 依赖 request 身份）；`onOpenSettings` prop 移除，overlay 开合改内部 `useState`（纯 UI 态）
- header 设置钮 → `setSettingsOpen(true)`；`SettingsOverlay` 内挂 `<OptionsApp request={optionsRequest}/>`（外层 ThemedRoot 已在）
- overlay 缺省不注入（`optionsRequest === undefined` 时设置钮维持现状跳 options——测试/降级路径）

**D4 options 页双宿主薄壳**
- `entrypoints/options/App.tsx`：`<ThemedRoot><OptionsApp request/></ThemedRoot>`；manifest/入口**零改动**
- e2e `smoke-self-evolution` 的 options 单发路径零回归

**D5 e2e 与验收**
- `smoke-self-evolution` 回归（options 路径未动）；`smoke-ui` 尝试尾部追加 overlay 冒烟（设置钮 → sheet 可见 → 关闭）——若 e2e 环境 options 请求面不稳则退化为人工验证 + 截图，不阻塞
- 双主题真机开 overlay 截图（`_shot` 临时件）

## 实施步骤

1. `layout.css` 追加 overlay 族 CSS；console-ui 新 `settings-overlay.tsx` + 单测 + index.ts 导出
2. `options-app.tsx` 重构：Segment 四区 tab + Switch 替换视觉模式 checkbox + ThemedRoot 外提
3. `sidepanel-app.tsx` 接线（settingsOpen 态 + SettingsOverlay + OptionsApp 注入）；`App.tsx`（sidepanel）注入 optionsRequest、移除 onOpenSettings；`App.tsx`（options）包 ThemedRoot
4. `pnpm typecheck` + `pnpm test`；biome
5. `wxt build` + `smoke-ui`（含 overlay 冒烟尝试）+ `smoke-self-evolution` 回归 + overlay 双主题截图
6. `node scripts/gate.mjs pre-commit`

## 验收

- 全仓 typecheck/test 绿；console-ui 新组件覆盖率 100%，包阈值内；gate 全绿
- e2e：smoke-self-evolution PASS（options 路径零回归）；smoke-ui PASS
- 真机：overlay 开合三条关闭路径、四区 tab 切换、Switch 交互、亮暗双主题截图
- options 页双宿主渲染正常（同组件）

## 待人工审核的决策点

1. **通道面选 a**（零 router/protocol 改动；fetchDraftCount 已实证同面可用）——建议采纳
2. **OptionsApp 重构**：Segment 四区 tab + ThemedRoot 外提（双宿主前提）——建议采纳
3. **options 页保留双宿主薄壳**（manifest 不动、e2e 零回归；退役留待后续独立决策）——建议采纳

## 实施记录（2026-10-29）

**落地文件**
- `theme/layout.css` 追加 overlay 族（backdrop/sheet/drawer-up + fade-in 动画）——M1 的 `--tc-overlay-*` token 首次消费
- console-ui 新组件 `SettingsOverlay`（三条关闭路径：× / backdrop / Esc；dialog 语义）+ 单测 + 导出
- `options-app.tsx` 重构：**Segment 四区 tab**（模型/授权/技能库/草稿）+ 视觉模式 checkbox→**Switch**（两原语同台首秀）；ThemedRoot 外提（双宿主前提——内层 auto 会跟系统不跟外层主题）
- `sidepanel-app.tsx`：`optionsRequest` 工厂注入（缺省回退 onOpenSettings 跳 options）+ settingsOpen 内部态 + SettingsOverlay 挂 OptionsApp；header 设置钮/草稿徽标均开 overlay
- `App.tsx`（sidepanel）增 optionsRequest 模块级工厂；（options）包 ThemedRoot + 页面壳——同组件双宿主，manifest/e2e 零改动
- `smoke-ui.mjs` 追加 ⑤ 设置 overlay 冒烟（设置钮 → sheet tabs=4 + dialog 语义 → Esc 关闭）；`_shot-theme.mjs` 追加 settings-{light,dark} 截图

**验证**
- 全仓 typecheck/test 一次全绿（console-ui 77 tests；SettingsOverlay 覆盖率 100%）
- `wxt build`；`smoke-ui` PASS（含 overlay 冒烟）；**`smoke-self-evolution` PASS——options 单发路径零回归**
- overlay 双主题截图 `_shot-settings-{light,dark}.png`；gate pre-commit 全绿

**通道面实证**：sidepanel 经 `runtime.sendMessage` 走 options 单发面（message-router 无 sender 过滤）——fetchDraftCount 早已同面运行，零 router/protocol 改动成立。

## 评审轮登记

- **轮 1**（2026-10-29）：零意见、状态 complete——base=main 全量 9 文件，glm-5.3，4m14s。**首刷即收敛出口**（M1-M4 四期唯一一次与 M3 同款），无修复提交；累计 stats：1 轮 / 0 意见 / 0 采纳 / 0 驳回。
