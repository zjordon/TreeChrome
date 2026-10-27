# SCRATCHPAD — issue #20 UI 重构 · M1 token 层

> 状态：**M1 已实施并全量验证（2026-10-28）；四个决策点均按建议拍板执行。** 待 `/review-loop`。
> 基准：`docs/ui-refactor-reference.md`（§3 token 映射 / §6 分期）；issue #20。
> 分支：`feat/issue-20-ui-refactor`（自 main）。

## 目标

console-ui 主题层从「10 变量单文件」升级为「分片 + 全量语义 token」：

1. `theme.css` 拆分为 `theme/` 目录四分片，原文件保留为聚合入口
2. `--tc-*` 变量面按基准档案 §3 扩容（表面/文字/accent/语义色/边框/控件/表单/浮层/动效/阴影/圆角/滚动条 12 族）
3. 现有组件类的**规则结构不动**，仅改取值来源——视觉变化全部来自 token 值
4. 亮/暗双套 + auto 三块同步扩容

## 非目标（后续期）

- M2：控件状态模型（hover/pressed/focus-visible/disabled 选择器）、icon-btn/switch/segment 新原语、细滚动条落地、动效与 reduced-motion 兜底
- M3：布局层；M4：设置 overlay（overlay 族变量本期**只定义不消费**）
- 类名/DOM/JSX 零改动；e2e DOM 契约零影响

## 设计决策

**D1 文件组织与消费面**
- `packages/console-ui/src/theme.css` 保留原路径改为聚合入口（4 行 `@import`）；新增 `src/theme/{tokens,base,controls,components}.css`
- `@tw/console-ui/theme.css` 出口与两个 `main.tsx` 的 import 零改动（Vite/WXT 构建内联 @import）
- tokens.css 文件头注明结构参照 alibaba/qz-browser-agent（Apache-2.0，只参照组织与中性值，未逐字复制片段）

**D2 拆分职责**
- `base.css`：`.tc-root` 作用域根（字体/13px/行高/color-scheme）——自现 theme.css 头部迁出
- `tokens.css`：全部变量；主题机制不变（`.tc-root[data-tc-theme="light"|"dark"]` 显式 + `auto`×`prefers-color-scheme`，沿用现有三块重复形态）
- `controls.css`：`.tc-btn*` / `.tc-field*`（按钮与表单控件）
- `components.css`：`.tc-badge*` / `.tc-table` / `.tc-card*` / `.tc-timeline*` / `.tc-ev-*` / `.tc-countdown` / `.tc-kv`

**D3 取值基调**（基准档案 §3 的落地细化）
- 灰阶走 **GitHub 冷灰系扩展**，不搬参照暖灰（#f4f4f2 系）——观感连续性优先；即基准档案表面族标「A 借值」实际落「C 重调」，**分层结构**（四级表面 + overlay 族）照搬
- accent/语义色保现有值，新增 strong/subtle 派生（subtle 是 M2 hover/选中底的原料）
- 边框透明度化：亮 `rgba(31,35,40,·)`、暗 `rgba(230,237,243,·)`
- 动效曲线/时长、阴影、圆角、滚动条 token 值直接取参照（中性值）
- 旧变量 `--tc-card-bg` 删除，消费点（全在 CSS 内部，TSX 零内联引用已验证）同 PR 改指 `--tc-bg-muted`

**D4 组件规则迁移边界**
- 只允许：改取值来源、随 token 值自然变化的视觉
- 不允许：新增伪类/状态选择器、新增类、改选择器结构；控件高度/字号变量本期只定义、M2 消费

**D5 测试与构建**
- console-ui 组件测试为 DOM 断言，与 CSS 无耦合，预期零改动；全仓 typecheck/test 必须全绿
- `wxt build` 验证 @import 内联无回归

## Token 值表（tokens.css 全量，亮 / 暗）

| 族 | 变量 | 亮 | 暗 |
| --- | --- | --- | --- |
| 表面 | `--tc-bg` | `#ffffff` | `#0d1117` |
| | `--tc-bg-muted` | `#f6f8fa` | `#161b22` |
| | `--tc-bg-elevated` | `#eff2f5` | `#21262d` |
| | `--tc-overlay-backdrop` | `rgba(31,35,40,.24)` | `rgba(1,4,9,.55)` |
| | `--tc-overlay-surface` | `#ffffff` | `#1c2128` |
| | `--tc-overlay-border` | `color-mix(in srgb, var(--tc-border) 78%, transparent)` | 同左 |
| | `--tc-overlay-shadow` | `var(--tc-shadow-lg)` | 同左 |
| 文字 | `--tc-fg` | `#1f2328` | `#e6edf3` |
| | `--tc-muted` | `#656d76` | `#8b949e` |
| | `--tc-fg-faint` | `#8c959f` | `#6e7681` |
| accent | `--tc-accent` | `#0969da` | `#388bfd` |
| | `--tc-accent-strong` | `#0550ae` | `#58a6ff` |
| | `--tc-accent-fg` | `#ffffff` | `#ffffff` |
| | `--tc-accent-subtle` | `rgba(9,105,218,.08)` | `rgba(56,139,253,.12)` |
| 语义 | `--tc-danger` / `--tc-danger-subtle` | `#cf222e` / `rgba(207,34,46,.08)` | `#f85149` / `rgba(248,81,73,.12)` |
| | `--tc-success` / `--tc-success-subtle` | `#1a7f37` / `rgba(26,127,55,.08)` | `#3fb950` / `rgba(63,185,80,.12)` |
| | `--tc-warning` / `--tc-warning-subtle` | `#9a6700` / `rgba(154,103,0,.08)` | `#d29922` / `rgba(210,153,34,.12)` |
| 边框 | `--tc-border` | `rgba(31,35,40,.12)` | `rgba(230,237,243,.12)` |
| | `--tc-border-strong` | `rgba(31,35,40,.20)` | `rgba(230,237,243,.22)` |
| | `--tc-border-focus` | `rgba(31,35,40,.30)` | `rgba(230,237,243,.32)` |
| 控件 | `--tc-control-height-sm/md/lg` | `28px` / `32px` / `38px` | 同左 |
| | `--tc-control-font-sm/md` | `12px` / `13px` | 同左 |
| | `--tc-control-weight` | `540` | 同左 |
| | `--tc-control-radius` | `var(--tc-radius-sm)` | 同左 |
| | `--tc-control-surface` | `transparent` | 同左 |
| | `--tc-control-surface-hover` | `var(--tc-accent-subtle)` | 同左 |
| | `--tc-control-surface-pressed` | `color-mix(in srgb, var(--tc-accent-subtle) 72%, var(--tc-bg-elevated))` | 同左 |
| | `--tc-control-primary-surface` | `var(--tc-accent)` | 同左 |
| | `--tc-control-primary-surface-hover` | `var(--tc-accent-strong)` | 同左 |
| | `--tc-control-primary-fg` | `#ffffff` | 同左 |
| | `--tc-control-focus-ring` | `0 0 0 3px color-mix(in srgb, var(--tc-accent) 14%, transparent)` | 同左 |
| | `--tc-control-disabled-opacity` | `.42` | 同左 |
| 表单 | `--tc-field-height-md` / `--tc-field-font-md` | `32px` / `13px` | 同左 |
| | `--tc-field-placeholder` | `var(--tc-fg-faint)` | 同左 |
| 浮层 | `--tc-popover-radius` / `--tc-popover-shadow` / `--tc-popover-padding` | `var(--tc-radius-md)` / `var(--tc-shadow-lg)` / `4px` | 同左 |
| | `--tc-menu-item-min-height` | `30px` | 同左 |
| 动效 | `--tc-motion-fast/base/slow` | `120ms` / `180ms` / `240ms` | 同左 |
| | `--tc-ease-standard` / `--tc-ease-emphasized` | `cubic-bezier(.2,.8,.2,1)` / `cubic-bezier(.16,1,.3,1)` | 同左 |
| | `--tc-transition` | `var(--tc-motion-fast) var(--tc-ease-standard)` | 同左 |
| | `--tc-transition-surface` | `background-color/border-color/color/opacity/box-shadow var(--tc-transition)` | 同左 |
| 阴影 | `--tc-shadow-sm` | `0 1px 2px rgba(31,35,40,.08)` | `0 1px 2px rgba(1,4,9,.48)` |
| | `--tc-shadow-md` | `0 8px 24px rgba(31,35,40,.12)` | `0 8px 24px rgba(1,4,9,.64)` |
| | `--tc-shadow-lg` | `0 16px 40px rgba(31,35,40,.16)` | `0 16px 40px rgba(1,4,9,.72)` |
| 圆角 | `--tc-radius-sm/md/lg/pill` | `4px` / `6px` / `8px` / `999px` | 同左 |
| 滚动条 | `--tc-scrollbar-size` / `--tc-scrollbar-thumb` | `4px` / `color-mix(in srgb, var(--tc-border) 72%, transparent)` | 同左 |

## 实施步骤

1. 建 `src/theme/` 四分片骨架；`theme.css` 改为聚合入口（含出处注释与职责一句话）
2. `tokens.css` 落上表（light / dark / auto×media 三块）
3. `base.css` 迁 `.tc-root`；`controls.css` / `components.css` 逐类 retarget 新 token（`.tc-btn` 底色转 `--tc-control-*`、边框类转透明度变量、`--tc-card-bg`→`--tc-bg-muted`）
4. `pnpm typecheck && pnpm test`（全仓）全绿
5. `apps/extension` 构建 + 真机双主题目检（截图存 `_` 前缀临时件，不入库）
6. `pnpm format` + `node scripts/gate.mjs pre-commit` 自查

## 验收

- 全仓 typecheck + test 全绿；gate pre-commit 全绿
- 亮/暗双主题：侧边栏与 options 目检无回归（按钮/徽章/表单/表格/卡片/时间线/倒计时条）

## 待人工审核的决策点

1. **控件圆角 4px**（参照密度语言）vs 保留现 6px —— 建议 4px（`.tc-btn` 视觉随之变锐）
2. **按钮默认底 transparent**（hover 才有底，参照状态模型的前置）vs 保留 `card-bg` 实底 —— 建议 transparent；primary 实底 accent 不变
3. **灰阶 GitHub 冷灰** vs 参照暖灰 —— 建议冷灰（D3，观感连续）
4. overlay/浮层/动效/滚动条变量本期**只定义不消费** —— 确认可接受（M2/M4 才接消费）

## 实施记录（2026-10-28）

**落地文件**
- `packages/console-ui/src/theme.css` → 聚合入口（4 行 `@import`，出口路径与消费方零改动）
- `packages/console-ui/src/theme/tokens.css`（三块双主题 + 主题无关族）/ `base.css` / `controls.css` / `components.css`
- `packages/console-ui/src/themed-root.tsx` 注释同步（theme.css → theme/tokens.css，零行为）
- 决策点 4/4 按建议执行：控件圆角 4px、默认钮透明底 + hover 填充（`:not(:disabled):hover` 是本期唯一状态新增，primary hover 同族）、GitHub 冷灰、overlay/动效/滚动条只定义不消费

**验证**
- `pnpm typecheck` 全包绿；`pnpm test` 全包绿（覆盖率阈值内）
- `wxt build` 通过（CSS 分片正常内联，`themed-root-*.css` 8.13 kB）
- `e2e/smoke-ui.mjs` PASS（真机全链：输入 → 权限卡代答 → 时间线 → done）
- `pnpm lint` 绿（biome 修了 `_shot-theme.mjs` 临时件的 import 超宽）
- `node scripts/gate.mjs pre-commit` 全绿（boundaries/size/quality）
- 双主题四截图目检通过：`_shot-sidepanel-{light,dark}.png`、`_shot-options-{light,dark}.png`（仓库根，临时件）

**遗留**
- `_shot-theme.mjs` + `_shot-*.png` 为验收临时件（`_` 前缀不入库）；M2–M4 验收可复用该脚本
- M2 起点：控件全状态模型 + icon-btn/switch/segment 新原语 + 细滚动条 + 动效与 reduced-motion 兜底

## 评审轮登记

- **轮 1**（2026-10-28，3 条 medium / 5m30s）：**P2×2 采纳 + 驳回×1**
  - [1] 采纳（P2）：`.tc-btn:not(:disabled):hover`（0,3,0）压过 `.tc-btn-danger`（0,1,0）透明底——danger 钮 hover 被误染 accent-subtle（蓝底红字）；收窄为 `:not(.tc-btn-danger):not(:disabled):hover`（danger hover 底色属 M2 面）
  - [2] 采纳（P2）：`.aoci/baseline.json` 幽灵条目 `docs/ui-refactor-qz-reference.md`（改名残留，盘上无此文件且与新路径同哈希）——手工摘除；`baseline scope` 治理流需 TTY approve 不适用单条清理，摘除后 verify/check 复核无治理失配
  - [3] 驳回（先例）：baseline 索引 `_shot-theme.mjs` 是既定约定——`_dump_bestsellers.txt`/`_issue-self-evolution.md` 同为未入库 `_` 件且早已被基线索引（AOCI 索引工作树实况，非仅入库文件）
  - 测试：纯 CSS 选择器修复无单测面（本仓测试不打样式断言）；`gate pre-commit` 全绿
