# SCRATCHPAD——sidepanel 改版 U3：可读性与页面注册

> 依据：docs/sidepanel-redesign-plan.md §6 U3。U1（#35 会话模型+转录）与 U2（#37 干预与状态）
> 已合并。本期单分支四批提交（U2 已验证该节奏——评审循环按增量轮跑），评审登记见 §6。

## 0. U3 总目标与验收（引自方案 §6）

转录可读性升级（markdown/复制/字号）+ 面板页签化（PageRegistry：任务/技能/调试）+ 会话标题条收拢 + 导出 HTML。

验收五条：
1. 含 markdown/代码块/script 注入样例的 finalResult 渲染正确且**无脚本执行**（安全样例集测试）
2. 技能页 sidepanel/options 双处数据一致（同 OPTIONS_OPS 单发面）
3. 调试页 isEnabled 关闭时页签不出现
4. 导出 HTML 离线打开与面板转录一致（抽查工具卡/等待态/多轮边界）
5. 字号切换持久化且双主题下均可读

## 1. 工作项（提交分四批）

### 批 A：markdown 渲染管线 + 复制钮

- **A1 依赖**：console-ui 引入 react-markdown + remark-gfm + rehype-highlight（组件包层——核心包零依赖铁律不动；pnpm install 后 lock 入库）
- **A2 MarkdownText 组件**（console-ui/src/markdown.tsx）：
  - 安全 schema：节点白名单（react-markdown 默认不渲染 raw HTML；urlTransform 收口 href/src 协议白名单 http/https/mailto/相对）；禁 style 脚本面
  - rehype-highlight 代码高亮；`CodeBlock` 包装 pre——语言标签 + 复制钮（navigator.clipboard，失败回退选中文案提示）
  - highlight.js 主题 CSS 引入 theme/（明暗双主题各一套或 GitHub 风格双套）
- **A3 落点**：FinalResult.finalResult 与 UserTurn 气泡后的 next_goal 面（RunTimeline 事件流内 model_result 事件携带的 next_goal——批内精读 run-timeline 落点）；lastError 保持纯文本（错误原文不该被 markdown 重排）
- **A4 复制钮**：UserBubble（task 原文）与 FinalResult（finalResult）hover 显复制钮
- **A5 测试**：安全样例集（script 标签 / img onerror / `[x](javascript:alert)` / 自动链接 js: —— 断言 DOM 无 script 元素、无 on* 属性、外链协议白名单）；markdown 基本渲染（标题/表格/代码块复制钮）；快照语义断言

### 批 B：PageRegistry + header tab + 技能页 + 调试日志页

- **B1 console-ui**：`PageRegistration{id,title,order,isEnabled,Component}` 类型 + `PageTabs` 组件（role=tablist/tab/tabpanel 语义 + 受控 activeId）；聊天不是页签——是缺省主视图（页签仅任务/技能/调试，点页签切走，再点回/关闭回聊天）
- **B2 sidepanel-app**：`view` 态从 "chat"|"tasks" 扩为 `{kind:"chat"} | {kind:"page", id:PageId}`；静态注册数组（任务 10/技能 40/调试 50——方案 §5 顺序号）；header 的列表钮换 PageTabs（新对话/设置钮保留）
- **B3 SkillPage**：新 console-ui 组件 `SkillPage`（组合 SkillListView + SkillDraftReview，optionsRequest 注入——与 OptionsApp 同款消费面）；sidepanel 页签挂载；options 页保留原样（双宿主）
- **B4 DebugLogPage**：原始 journal 事件流（seq/type/ts/data JSON 折叠行 + 未知类型可读回退）+ snapshot 头部态；`isEnabled` 注入（组态常量，缺省 true——验收③关掉不渲染页签）
- **B5 测试**：PageTabs 切换语义/键盘；SkillPage 数据流（mock optionsRequest）；DebugLogPage 折叠/回退/isEnabled 关闭路径

### 批 C：字号 + 会话标题条收拢

- **C1 字号**：tokens.css 增 `--tc-font-size-base` 档位（13/14/15px 三档）；`FontSizePopover`（Aa 钮弹出，三档 radio + localStorage 持久化 `tc:font-size`）；ThemedRoot 或独立 effect 挂档位 class（`tc-font-scale-sm/md/lg`——双主题继承）
- **C2 会话标题条**：主区顶部条件行（有会话时）：会话标题（行内重命名——复用 SessionsPage 的 Enter/Escape/isComposing 交互）+ Aa 钮 + 导出钮（批 D 前占位禁用或隐藏）；GoalStrip 保持在 dock（目标 tab 语义不混标题）
- **C3 测试**：字号档位切换/持久化/还原；标题行内重命名三路径；无会话不渲染

### 批 D：产物索引 + 导出 HTML + 收尾

- **D1 产物索引**：SessionsPage 会话条目副行——runs 归档的 done attachments 聚合（批内精读 RunArchive 字段定口径：快照 attachments vs files_to_display；归档面缺字段则登记裁剪）
- **D2 导出 HTML**：console-ui `serializeTranscriptHtml(items, {cssText, title})` 纯函数——自包含单文件（`<!doctype html>` + 内联 `<style>` + 静态转录 DOM：结构复用 TranscriptView 的类名体系但无 React/无脚本）；extension 侧组态注入 cssText（vite `?raw` 读聚合 theme.css）；标题条导出钮 → Blob 下载（URL.createObjectURL + a[download]）
- **D3 验收自查**：①-⑤ 逐条锚点登记；e2e 扩展（可选：smoke-ui 增页签切换/导出断言——按 U2 惯例脚本就绪真机手动）
- **D4 测试**：serialize 纯函数（多轮/工具卡/等待态条目/空转录）；产物索引聚合

## 2. 设计决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | markdown 库进 console-ui（不进 core/extension） | 双宿主组件能力；核心包零新依赖铁律；宿主零感知（组件内封闭） |
| D2 | 聊天不占页签——缺省主视图 | 转录是核心交互形态（方案 §4 六区：header tab 是次级导航）；页签=任务/技能/调试三入口 |
| D3 | 调试页 isEnabled 是组态常量非设置项 | 方案验收③只要求可关；设置面加开关是 U4 打磨面（避免本期扩散） |
| D4 | 字号 localStorage（组件层）而非 tc_settings | 纯视图偏好不入 SW 设置面（SW 是单一写者纪律）；console-ui 无 chrome 依赖仍可用浏览器存储 |
| D5 | 导出走纯函数 + cssText 注入 | console-ui 不 import CSS 副作用进导出（vite ?raw 是 extension 宿主能力）；函数可测且 web-console 可复用 |
| D6 | lastError 不做 markdown | 错误原文含尖括号/反引号概率高，重排反而失真；finalResult（模型产出）才是 markdown 契约面 |

## 3. 风险

- react-markdown 安全面：默认不渲染 raw HTML 是第一道闸；urlTransform 白名单是第二道——测试锚定两道，不依赖单一防线
- highlight.js 体积（~1MB 全量）：按需 import 常用语言子集（common 或显式 list）——bundle 体积进 changelog 说明
- PageTabs 替换列表钮是交互回归点：新对话/设置钮位置不动，仅列表钮 → tab 条（e2e smoke-ui 若依赖旧钮位需同步）
- 导出 HTML 与面板一致性是抽查口径（类名体系同源保证结构性一致，像素级不承诺）

## 4. 进度

- [x] 批 A markdown 渲染管线 + 复制钮：console-ui 增 react-markdown/remark-gfm/rehype-highlight；MarkdownText（双闸：raw HTML 不渲染 + safeUrlTransform 协议白名单）+ CodeBlock（语言标签/复制钮/textContent 兜底）+ CopyButton（ClipboardUtil 收口，不可用静默降级）；FinalResult.finalResult 走 markdown（复制钮在头部行尾）、UserBubble 复制钮；markdown.css（排版 + hljs token 双主题派生配色）。**偏离 D7**：next_goal 保持行内文本（每步一行×几十步，块级 markdown 纵向炸开；qz 同为单行）。
- [x] 批 B PageRegistry + header tab + 技能页 + 调试日志页：PageRegistration/PageTabs（tablist 语义 + roving 键盘焦点，toggle 由宿主裁决）；SkillPage（list-skills/list-skill-drafts 双拉 + 采纳/丢弃经 OPTIONS_OPS——与 options 双宿主同面）；DebugLogPage（seq 排序原始事件流 + 快照头部 + 未知类型回退）；RunPanelHeader 增 tabs 插槽；sidepanel 静态注册（任务 10/技能 40/调试 50，isEnabled 由注入面推导）+ 列表钮退役（tab 承载）。
- [ ] 批 C 字号 + 会话标题条收拢
- [ ] 批 D 产物索引 + 导出 HTML + 验收自查
- 测试总账：console-ui 110→132（批 A +9、批 B +13）；extension 290 不变

## 5. 评审轮次登记（review-loop 填写）

（待各轮登记）

## 6. 备注

- manifest 本期无变更（页签/字号/导出全在组件与组态层）
- AOCI：分支合并后做认知收尾（届时说「aoci 收尾」）
