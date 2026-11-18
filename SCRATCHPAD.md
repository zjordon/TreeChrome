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
- [x] 批 C 字号 + 会话标题条收拢：FontSizePopover（Aa 弹卡三档 sm/md/lg，localStorage `tc:font-size` 持久化，档位类挂 documentElement——base.css html 档位规则缩放 .tc-root，双主题 token 继承）；SessionTitleBar（标题行内重命名 Enter/Escape/isComposing 三路径 + actions 插槽）；sidepanel 聊天区顶部条件渲染（有会话非落地页），actions=字号（导出批 D 接入）。
- [x] 批 D 产物索引 + 导出 HTML + 验收自查：SessionMeta.attachmentCount（writeRecord 单点派生——所有写路径覆盖，返回派生 record 供 index 刷新；parseMeta 旧索引回 0）；SessionsPage 条目副行 📎 计数；serializeTranscriptHtml 纯函数（自包含零脚本：doctype + 内联 cssText + 转录类名体系 + EventLine 同口径事件行，验收④）；sidepanel 标题条导出钮（vite ?raw 注入聚合主题 CSS + Blob 下载）。**偏离 D8**：导出面 markdown 不重渲染（无 JS 环境）——finalResult 以 pre-wrap 文本呈现；**裁剪登记**：产物索引口径 = turns 输入附件聚合（RunArchive 无 done 产物通道——files_to_display 未归档）。
- 验收自查（§0 五条）：①批 A 安全样例集（markdown.test 5 例）；②SkillPage 同 OPTIONS_OPS 面（skill-page.test 双拉/采纳/丢弃）；③isEnabled=false 页签不出现（sidepanel 组态 filter + page-tabs 空数组不渲染）；④serialize 纯函数测试（多轮/等待态/转义/工具卡行）+ 离线人工抽查待真机；⑤font-size.test（持久化/坏值回退/档位类）——双主题由 token 继承（结构保证）。
- 测试总账：console-ui 110→145（批 A +9、B +13、C +7、D +6）；extension 290→292（attachmentCount 派生 + 旧索引收窄）；protocol 3 不变。分支提交：计划 + 四批共 5 个

## 5. 评审轮次登记（review-loop 填写）

### 轮 1（2026-11-18，7 条全采纳：P1×2 / P2×4（两组同根））

- **[1]+[4] P1 导出 HTML 零样式**：theme.css 是纯 @import 聚合入口，vite ?raw 不展开——导出内联的是 6 条相对 @import，离线 404 全裸。修复：console-ui exports 增 `./theme/*.css` 子路径模式，宿主六分片逐件 ?raw 拼接实体文本；构建级实证（bundle 内含 `html.tc-font-sm` 原始 CSS 文本、CSS 资产 0 @import）。
- **[2] P1 页签整页 remount**：视图工厂声明在组件体内，作 JSX 元素类型渲染时每次 dispatch（事件流高频）换引用 → SessionsPage/SkillPage/DebugLogPage 整页重挂，输入/焦点/折叠态全丢。修复：渲染处改函数调用 `activePage.Component()`（工厂无 hooks，输出模块级组件元素树按类型 reconcile）；PageRegistration.Component 类型改 `() => ReactElement` 工厂签名。
- **[3]+[6] P2 markdown 字号脱离档位**：.tc-md 正文/标题/代码/表格固定 px 显式覆盖继承基线——字号档位对最核心阅读面（finalResult 长文）不生效。修复：字号全改相对单位（h1 1.3em/h2 1.15em/code 0.92em 等），.tc-md 删 font-size 走继承；复制钮控件几何保持 px（全仓控件惯例）。
- **[5] P2 node 垃圾属性**：react-markdown 向 components 注入 hast node prop，未剔除铺成 `node="[object Object]"` DOM 属性。修复：CodeBlock 解构剔除（测试断言 pre 无 node 属性）。
- **[7] P2 档位无冷启动恢复**：applyFontSizeClass 唯一调用点是弹卡 effect，欢迎页/页签页不挂载 → 持久化档位被无视（回落 13px 进会话才突跳）。修复：导出 initFontSize()，sidepanel-app 模块级调用一次；双向验证（破坏挂类 → initFontSize 用例必红）。
- 测试：console-ui 145→148（node 属性 1 + initFontSize 2）；extension 292 不变；wxt build 实证 ?raw 六连链路。

### 轮 2（2026-11-18，零意见——循环收敛）

- complete / 0 条（增量 = 轮 1 修复提交 4d0e79f，实审 7 文件 2m18s）。首轮被会话中断重发（输出 JSON 缺失非孤儿，干净重跑）。
- **累计：2 轮 / 7 条全采纳（P1×2 + P2×4 两组同根）/ 驳回 0 / stale 0**；console-ui 110→148、extension 290→292、protocol 3；分支 7 提交（计划+四批+轮 1 修复+本登记）；全程门禁 exit 0 + 双向验证两处（initFontSize 红绿 / wxt build 构建实证）。

## 6. 备注

- manifest 本期无变更（页签/字号/导出全在组件与组态层）
- AOCI：分支合并后做认知收尾（届时说「aoci 收尾」）
