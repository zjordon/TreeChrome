# UI 重构参照档案（qz-browser-agent / 轻舟）

> 第 0 步定界调研产出（2026-10-27）。定位：UI 重构 issue 的素材 + 后续功能分支 SCRATCHPAD 实施计划的设计基准；**不是实施计划本身**。
> 参照仓库（只读）：`D:/dev/git/z_jordon/fork/qz-browser-agent`（上游 alibaba/qz-browser-agent，Apache-2.0）。本文所有对 qz 文件的引用均相对该仓库根。

## 1. 范围裁定（已拍板）

| 决策点 | 结论 |
| --- | --- |
| 层次切分 | 本次做 **①视觉层**（token 体系/质感/控件状态模型/动效）+ **②布局层**（输入区 dock 化、状态条、设置收纳）；**③交互形态层**（"任务面板+时间线"→"聊天转录"的产品改版）单独立项，本次非目标 |
| accent 基调 | **保留 TreeChrome 蓝**（#0969da 亮 / #388bfd 暗），不跟随 qz 黑白单色；借鉴的是其 token 组织与质感体系，不是配色人格 |
| 设置形态 | **学 qz 收进侧边栏 overlay**（底部弹出面板），独立 options 页的处置在计划期定（见 §5.3） |

## 2. 参照物档案

### 2.1 技术栈对照——移植的是设计契约，不是代码

| | qz | TreeChrome 现状 |
| --- | --- | --- |
| 渲染 | 原生 TS DOM + HTML 模板 + feature 模块 | React 组件（`packages/console-ui`）+ ui-glue 组态 + entrypoints 粘合 |
| 样式 | Tailwind 4（`qz:` 前缀 utilities）+ `qz-*` 语义控件类 + tokens | `tc-*` 语义类单文件 `theme.css`（M5 段 E 有意"视觉打磨后置"） |
| 主题 | 语义 token 双套（`prefers-color-scheme` + 构建期换肤） | `--tc-*` 变量双套（data-tc-theme 作用域，auto 跟随系统） |

结论：两边共同语言是 **"语义类名 + CSS 变量 token"**，React/Vanilla 差异不构成移植障碍；Tailwind utilities 不引入（依赖纪律），只用它的 token 组织方式。

### 2.2 qz 设计系统结构（值得照搬的骨架）

- `docs/design-system.md`：设计契约总纲（cascade：`theme → base → vendor → components → utilities`；控件/工具类公共面；换肤机制）
- `src/themes/default/index.css` 声明层序；`tokens.css`（token 单源）/ `base.css`（reset+13px root+reduced-motion 兜底）/ `controls.css`（qz-btn/icon-btn/field 全状态）/ `utilities.css`
- 样式跟模块走（feature `ui.css` 随属主模块进构建）——对应我们"组件视觉集中在 theme.css"的现状，可演进为 tokens/controls/components 分文件

### 2.3 qz sidepanel 布局骨架（`src/sidepanel/sidepanel.html`）

```
#app（flex column，满高）
├─ header            段控 tab（对话）+ 图标钮动作区（新建/设置）
├─ session-title-bar 会话标题（重命名）+ 字号调节 + 导出 HTML
├─ #messages         转录主体（welcome 屏 ↔ 消息流：用户气泡/agent markdown/工具卡内联渲染器）
├─ #chat-dock
│  ├─ #status-bar    status-dot + 状态文本 + context 用量 + 停止钮（运行时才出现）
│  └─ #input-area    goal-strip → composer（textarea 自适应高度 + 发送钮）→ 快捷键提示行
└─ #settings-panel   overlay：backdrop + 底部弹出卡（header/tabs/内容/保存状态条，动画 drawer-up）
```

### 2.4 qz 视觉语言要点（`src/themes/default/tokens.css` 实证）

1. **表面分层**：bg-primary/secondary/tertiary/elevated 四级灰阶 + "porcelain" 渐变表面（color-mix 纵向渐变 + inset 高光线）用于浮层卡——静态截图里"精致感"的主要来源
2. **文字四级**：text-primary/secondary/muted/faint
3. **边框透明度化**：亮色 `rgba(0,0,0,.08)`、暗色 `rgba(255,255,255,.09)`；focus 态加深（.26/.22）——比实色边框柔和
4. **控件密度标尺**：高度 xs22/sm28/md32/lg38px、字号 10–13px、weight 540、radius 4/6/8——小面板高密度的关键
5. **完整状态模型**：每个控件 hover/pressed/focus-visible（3px color-mix ring）/disabled(.42) 四态 + `--transition-surface` 统一过渡
6. **动效 token**：120/180/240ms × 两条缓动（standard `cubic-bezier(.2,.8,.2,1)` / emphasized `(.16,1,.3,1)`）；`prefers-reduced-motion` 全局兜底（base.css）
7. **细节**：4px 自绘细滚动条、shadow 三档、popover/menu/toast 各自成族、代码高亮 syntax 族、气泡/块面 token（user-bubble、block-fill/radius 7px）
8. **base.css**：13px root、line-height 1.55、`-webkit-font-smoothing: antialiased`、技术内容强制 LTR

### 2.5 qz 设置 overlay 形态（`src/sidepanel/capability-host/settings-shell.ts` + `settings.css`）

底部弹出卡（宽 ≤560px、near-full-height、modal-card 渐变表面 + drawer-up 动画）+ 分类段控 tab + 底部保存状态条（保存状态文案 + 版本 + 保存钮）。入口是 header 图标钮。

## 3. Token 映射表（`--tc-*` 变量面扩容计划）

值来源三档：**A 借值**（中性灰阶/动效/阴影/圆角，直接取 qz 值或微调）、**B 保蓝派生**（accent/语义色保 TreeChrome 值，新增派生键用 color-mix 从主值推导）、**C 重调**（边框透明度按我们前景色调和）。

| 族 | 现有（10 个） | 扩容后（新增加粗） | 来源 |
| --- | --- | --- | --- |
| 表面 | `--tc-bg`、`--tc-card-bg` | `--tc-bg`（primary）、**`--tc-bg-muted`**（tertiary 级）、**`--tc-bg-elevated`**、**`--tc-overlay-backdrop/surface/border/shadow`**（设置 overlay 用） | A/C |
| 文字 | `--tc-fg`、`--tc-muted` | + **`--tc-fg-faint`** | A |
| accent | `--tc-accent`、`--tc-accent-fg` | + **`--tc-accent-strong`**、**`--tc-accent-subtle`**（hover 底/选中底，color-mix(accent 4–6%)） | B |
| 语义色 | `--tc-danger/success/warning` | + **`--tc-danger-subtle` 等三色 subtle 底**（确认卡/终态着色底） | B |
| 边框 | `--tc-border`（实色 #d0d7de） | 改透明度策略：**`--tc-border`（.12–.14）**、**`--tc-border-strong`**、**`--tc-border-focus`**（.3+） | C |
| 控件 | 无 | **`--tc-control-height-sm/md/lg`**（28/32/38）、**padding/gap/font(-sm/-md/-lg)/weight**、**surface/hover/pressed**（accent-subtle 派生）、**focus-ring**（`0 0 0 3px color-mix(accent ~12%)`）、**disabled-opacity .42** | A 结构+B 值 |
| 表单 | 无（样式内联在 tc-field） | **`--tc-field-height-sm/md`**（28/32）、**font**、**border/border-focus/placeholder/focus-ring** | A 结构 |
| 浮层 | 无 | **`--tc-popover-border/radius/shadow/padding`**、**`--tc-menu-item-*`** | A |
| 动效 | 无 | **`--tc-motion-fast/base/slow`**（120/180/240ms）、**`--tc-ease-standard/emphasized`**、**`--tc-transition-surface`** | A |
| 阴影/圆角 | 无 | **`--tc-shadow-sm/md/lg`**；**`--tc-radius-sm/md/lg/pill`**（4/6/8） | A |
| 滚动条 | 无 | **`--tc-scrollbar-size/thumb`**（4px 细条） | A |

注意：
- `color-mix()` 目标 Chrome 111+，本项目要求 Chrome 116+，可用
- 语义色值不取 qz 的（green #24845d 系 vs 我们 #1a7f37 系），保持我们 GitHub 系观感连续
- M1 只扩变量与替换现有类里的取值，**不改类名与 DOM**

## 4. 组件对照清单

console-ui 组件（`packages/console-ui/src/`）为改动落点：

| qz 控件 | 我们现状 | 动作 | 期 |
| --- | --- | --- | --- |
| `qz-btn`（primary/secondary/ghost/danger；xs–lg；inline） | `Button`（primary/danger/ghost；单尺寸；无状态模型） | 补 secondary 变体、sm/lg 尺寸档、hover/pressed/focus-visible/disabled 四态 | M2 |
| `qz-icon-btn` | 无（全文字钮） | 新增图标钮原语（header/overlay 关闭钮等需要） | M2 |
| `qz-field` + label/hint + `qz-select` | `Field`（label+error） | 补 hint、select/textarea 统一面、focus ring | M2 |
| `qz-switch` | 原生 checkbox | 新增 switch 原语（设置 overlay 用） | M2 |
| `qz-segment` 段控 | 无 | 新增（设置分类 tab） | M4 |
| `qz-scroll` | 浏览器默认 | 面板作用域细滚动条 | M2 |
| status-bar（dot+文本+用量+停止钮） | `StatusLine`（徽章+步数+耗时） | 重排为 dock 状态条形态 | M3 |
| composer dock + 快捷键提示行 | `TaskBar`（顶部：输入/附件/预算/拒绝明细） | dock 化（§5.1 决策点） | M3 |
| settings overlay | options 页 `OptionsApp` | 收进 sidepanel（§5.2/5.3） | M4 |
| `qz-decision-dialog` | `PermissionCard`/`SubmitCard` | **保自有形态仅换皮**——这两张卡是 core 权限门语义面（capability/倒计时/字段摘要），不照抄 qz | M1 换皮 |
| 转录渲染器（表格/图片/diff） | `RunTimeline` 折叠体 | ③层非目标：结构不动，仅随 token 换皮 | M1 换皮 |
| welcome 屏 | 无（空态直出输入框） | 可选低成本高观感项 | M3 可选 |

## 5. 布局迁移要点（②层）

### 5.1 sidepanel 目标结构

```
.tc-root（flex column 满高）
├─ header        轻量：标题/状态入口 + 设置图标钮（新）
├─ main          run 视图：状态条 → 时间线 → 确认卡 → 终态（信息架构不变）
└─ dock          TaskBar dock 化（输入+附件+预算）+ 快捷键提示行
```

**决策点（SCRATCHPAD 定，不预设）**：qz 输入常驻底部是"连续会话"形态的自然结果；我们是 RunManager 单飞单 run，运行中输入区本就禁用。dock 化的实际收益（视觉重心、与 qz 一致性）vs 改动面（TaskBar 是附件上传编排的宿主，`attachment-upload` 与 sidepanel-state 的交互要跟着动）需在计划里权衡。

### 5.2 设置 overlay 的通道面

现状：options 页走 `runtime.sendMessage` 单发（`message-router` 的 options 面）；sidepanel 走 Port（`@tw/protocol` `UI_TO_SW_KINDS` 白名单）。设置收进 sidepanel 后二选一：

- a) `message-router` 的 options 请求面向所有扩展页放开（sidepanel 也可 sendMessage）——改动最小
- b) options 请求搬上 Port 信封协议——面更统一但动 protocol 白名单

涉及 `packages/protocol/src/index.ts` 与 `options-handler` 消费面，计划期定。

### 5.3 options 页处置与 e2e 影响

- manifest 的 `options_page` 三选一：保留薄壳（重定向侧边栏/同组件双宿主）、移除（`chrome://extensions` 的"选项"入口消失）、暂留双入口过渡
- **e2e DOM 契约**：`apps/extension/e2e/smoke-ui.mjs` 靠 CDP DOM（文本/aria）驱动，`smoke-self-evolution.mjs` 走 options 单发路径——DOM 契约（aria-label/占位文本/data-*）不得静默变更；overlay 化后 options 路径的回归方案（改驱动 sidepanel DOM 或保留 sendMessage 面）随 M4 计划
- 安全面：apiKey 表单进 overlay 仍在扩展边界内，等价

## 6. 分期建议（供 SCRATCHPAD 展开）

| 期 | 内容 | 验收 |
| --- | --- | --- |
| M1 token 层 | `theme.css` 拆分（tokens/controls/components 分文件，qz 同款分层）；变量面按 §3 扩容；亮暗双套对齐；**类名与 DOM 不动** | 全测试绿 + 亮/暗双主题截图对照 |
| M2 控件层 | primitives 全状态模型 + icon-btn/switch/segment + 细滚动条 + 动效 + reduced-motion 兜底 | 同上 + 键盘焦点走查 |
| M3 布局层 | header/状态条/终态卡/dock 化（按 §5.1 决策）+ 可选欢迎屏 | e2e smoke-ui 更新后绿 |
| M4 设置收纳 | overlay + options 页处置 + 通道面（§5.2）+ e2e 回归 | e2e smoke-self-evolution 更新后绿 |

单 issue 单功能分支、按期分批提交（每批测试全绿过提交门），`/review-loop` + `/finish-issue` 收尾。

## 7. 工程约束与许可

- 全部改动落在 `packages/console-ui` 与 `apps/extension` 粘合层——console-ui 禁 `chrome.*`（biome 强制）不新增风险；core/protocol 只在 §5.2 选 b) 时触碰
- `theme.css` 拆分注意 3000 行硬门/1000 行软提醒；biome format 对 CSS 同样生效（2 空格/双引号）
- 覆盖率 ≥85% 门：纯 CSS 不影响；组件 TSX 改动保测试同步（console-ui 有组件纯函数面单测）
- **许可**：qz 为 Apache-2.0。借鉴 token 组织与值没有问题；若逐字复制 CSS 片段（如 focus-ring/porcelain 表面定义），在文件头注释标注来源：`/* 结构参照 alibaba/qz-browser-agent（Apache-2.0）*/`
- 本轮不改架构决策；M4 若动 manifest 入口，再评估是否同步 `docs/architecture.md` §2
