# SCRATCHPAD — issue #20 UI 重构 · M2 控件层

> 状态：**M2 已实施并全量验证（2026-10-28）；三个决策点均按建议拍板执行。** 待 `/review-loop`。
> 基准：`docs/ui-refactor-reference.md`（§4 组件对照 / §6 M2 行）；issue #20；M1 已并入 main（PR #21）。
> 分支：`feat/issue-20-ui-m2`（自 main）。

## 目标

1. **Button 全状态模型**：hover/pressed（:active）/focus-visible（ring）/disabled 四态 + transition；新增 `secondary` 变体与 `sm/md/lg` 尺寸档（消费 M1 只定义的 `--tc-control-height-*/font-*`）
2. **新原语三件**：`IconButton` / `Switch` / `Segment`（React 组件 + `tc-*` 类 + 单测；Segment 首个消费方在 M4，本期交付原语与测试）
3. **danger hover/pressed 补全**（M1 决策点 2 的"M2 后续"：danger-subtle 底 + 红系 border-hover）
4. **表单控件状态**：focus ring、placeholder 色（`--tc-field-placeholder`）、高度消费（`--tc-field-height-md`）
5. **细滚动条**：`.tc-root` 作用域 4px（`--tc-scrollbar-*`）
6. **动效消费 + 兜底**：控件接 `--tc-transition-surface`；`prefers-reduced-motion: reduce` 全局置零

## 非目标

- M3 布局层（dock 化/状态条/欢迎屏）、M4 设置 overlay
- 现有 Button 调用点（console-ui 12 处 + ui-glue 1 处）**零改动**：新 props 全可选；默认渲染除尺寸档高度外与现状一致
- e2e smoke-ui 不动（文本/aria 定位不受影响）；类名/DOM 契约不破坏

## 设计决策

**D1 Button 扩展（向后兼容 + 语义矫正）**
- `variant?: "primary" | "secondary" | "danger" | "ghost"`，默认 **secondary**（渲染与现状逐像素一致——带边框透明底）；`ghost` 矫正为无边框（hover 才有底，qz/行业通义）。**已核实全仓零显式 `variant="ghost"` 调用点**，语义矫正无视觉破坏
- `size?: "sm" | "md" | "lg"`，默认 **md**（32px；拍板点 1）；class 形态 `tc-btn tc-btn-{variant} tc-btn--{size}`（变体单横杠 / 尺寸双横杠，互不干扰）
- 状态规则全落 controls.css：基类 `:active`（pressed 底）+ `:focus-visible`（ring + border-focus）+ `transition: var(--tc-transition-surface)`；primary/danger 各自 hover/pressed 变体；M2 引入的变体规则一律**后置于**通用规则（源顺序依赖已在轮 2 学教训）+ `:where()` 守卫不引入特异性反超

**D2 新原语 API（原生语义、受控友好）**
- `IconButton`：`{ label: string（必填，aria-label+title）, size?: "xs"|"sm"|"md", variant?: "secondary"|"danger", children: SVG }` → `tc-icon-btn tc-icon-btn--{size}`
- `Switch`：原生 checkbox 驱动 `{ checked?, defaultChecked?, onChange?, disabled?, label }`；`useId` 自动关联 label；视觉轨道 30×18 + 圆点 12（`--tc-switch-*` 尺寸进 tokens.css）；checked 态 accent 轨道；focus-visible ring
- `Segment`：受控单选组 `{ items: {value,label}[], value, onChange, ariaLabel }` → `tc-segment` 容器 + `role="group"` + button `aria-pressed`；active 项 accent-subtle 底

**D3 CSS 落点**
- `controls.css` 追加（职责一致，预计 ~220 行，远离行数门）：尺寸档/secondary/ghost 矫正/danger 状态/icon-btn/switch/segment/field 状态
- `base.css` 追加：滚动条（`::-webkit-scrollbar` + `scrollbar-width: thin`，作用域 `.tc-root`）+ reduced-motion 兜底（qz base.css 同款：动画/过渡置零）
- `tokens.css` 微增：`--tc-switch-width/height/thumb`、`--tc-icon-btn-size-xs/sm/md`（尺寸 token 单源）

**D4 测试（console-ui `test/` 惯例：RTL + jsdom + globals）**
- 新文件 `test/icon-button.test.tsx`、`test/switch.test.tsx`、`test/segment.test.tsx`：渲染 class/尺寸与变体/aria-label 必填/disabled/受控切换（fireEvent.click 断言 onChange）/键盘可达（tabIndex 与原生焦点）
- `test/primitives.test.tsx` 扩展：secondary 默认/ghost 无边框 class、size 档 class、向后兼容（不传新 props 时 class 含 `tc-btn tc-btn-secondary tc-btn--md`）
- 覆盖率 85% 门全量过（新组件全在 src/ 计入）

**D5 视觉与真机验收**
- `_cascade-check.html` 扩展：三新原语样例 + focus-visible ring（CDP 键盘 Tab 实测 computed boxShadow）+ Switch 切换 + Segment active
- `_shot-theme.mjs` 复跑双主题四截图；`e2e/smoke-ui.mjs` 回归

## 实施步骤

1. `tokens.css` 微增尺寸 token；`controls.css` 状态模型 + 新类；`base.css` 滚动条 + reduced-motion
2. `primitives.tsx`：Button variant/size 扩展（默认 variant 改 secondary）
3. 新文件 `icon-button.tsx` / `switch.tsx` / `segment.tsx`；`index.ts` 导出面更新
4. 单测三新文件 + `primitives.test.tsx` 扩展
5. `pnpm typecheck` + `pnpm test` 全绿；`pnpm exec biome check --write .`
6. `wxt build` + `e2e/smoke-ui.mjs` + `_cascade-check.html` 扩展实测 + 双主题截图
7. `node scripts/gate.mjs pre-commit`

## 验收

- 全仓 typecheck/test 绿；console-ui 覆盖率 ≥85%；gate 全绿
- e2e smoke-ui PASS（DOM 契约未动）
- 双主题截图 + 交互态（hover/active/focus-visible/switch toggle/segment）实测通过
- 现有 Button 调用点零改动（typecheck 层面验证）

## 待人工审核的决策点

1. **Button 默认尺寸 md=32px**（现状实际渲染 ≈27px，默认档会整体微涨）vs 默认 sm=28（贴近现状）——建议 **md**（与参照密度语言一致，一次到位）
2. **ghost/secondary 语义矫正**：默认 variant 从 ghost 改为 secondary（渲染结果与现状逐像素一致），ghost 矫正成无边框可选变体——已核实零显式 ghost 调用，**视觉零变化**，建议采纳
3. **表单 input 统一 32px 高**（`--tc-field-height-md`）vs 保持 padding 弹性——建议**统一**（表单一致性，options 页多表单受益）

## 实施记录（2026-10-28）

**落地文件**
- `theme/tokens.css`：微增 `--tc-icon-btn-size-*`、`--tc-switch-*` 尺寸 token
- `theme/controls.css`：全状态模型重写——Button 四态（hover/pressed/focus-visible ring/disabled + transition）、尺寸档、secondary（默认，与矫正前默认观感逐像素一致）、ghost 无边框矫正、danger 红系 hover/pressed（M1 的 M2 后续）、icon-btn/switch/segment 三族、表单 32px 高 + placeholder + focus ring
- `theme/base.css`：面板作用域 4px 细滚动条 + `prefers-reduced-motion` 兜底
- `src/primitives.tsx`：Button 增 `size` 与 `secondary`（默认 variant ghost→secondary，全仓零显式 ghost 调用已核实）
- 新文件 `src/{icon-button,switch,segment}.tsx` + `index.ts` 导出；`segment` 用 `fieldset`（biome a11y `useSemanticElements` 抓的真问题：div+role=group → 语义元素，CSS 补边距重置）
- 测试：新 `test/{icon-button,switch,segment}.test.tsx` + `primitives.test.tsx` 扩展（默认 secondary/md 断言更新）

**验证**
- 全仓 typecheck + test 绿（console-ui 64 tests；新组件覆盖率 100%，全包阈值内）
- `wxt build` + `e2e/smoke-ui.mjs` PASS（DOM 契约未动，现有 13 处 Button 调用点零改动）
- `_cascade-check.html` 扩展实测（真 Chrome）：ghost 无框/secondary 32px·13px·540/sm 28px/icon 32px/开关轨道两态+拇指 12px 位移/段控 active accent-subtle——九项 computed style 全对；**Tab 键盘实测 focus-visible ring**（3px accent 14% + border-focus）；**danger hover 实测**（danger-subtle 底 + 红 42% 边，primary 无误染）
- 双主题四截图复跑（`_shot-*.png` 更新）；gate pre-commit 全绿

**过程记录**
- jsdom 分歧登记：`fireEvent.click` 会无视 disabled 触发 checkbox 激活行为（与浏览器相左）——Switch disabled 测试改为断言原生属性落位，已注明
- biome 先后抓两处：新测试 JSX 折行（format）、segment 的 role=group 语义化（lint，真问题已修）

## 评审轮登记

（/review-loop 后填充）
