# SCRATCHPAD——sidepanel 改版 U4：补全与打磨

> 依据：docs/sidepanel-redesign-plan.md §6 U4。U1（#35）/U2（#37）/U3（#39）已合并。
> 本期单分支四批提交（U2/U3 已验证该节奏——评审循环按增量轮跑），评审登记见 §5。

## 0. U4 总目标与验收（引自方案 §6）

补全与打磨：聊天搜索浮层 + 通知回流 + 粘贴/拖入附件 + 「复制为新对话起点」弱替代 + 元素选择器评估。

验收四条：
1. 搜索计数/aria-live 播报正确
2. sidepanel 关闭时 done 通知出现且点击打开 sidepanel
3. 粘贴截图直接进附件清单，预算/拒绝明细路径与 📎 完全一致
4. 弱替代从任意历史 turn 一键开新会话且前情块为空

## 1. 工作项（提交分四批）

### 批 A：输入增强——粘贴/拖入附件 + 复制为新对话起点

- **A1 粘贴/拖入**：sidepanel-app 外层 wrapper（`display:contents` 不破布局）挂 `onPaste`（`clipboardData.files.length>0` 才接管——纯文本粘贴不拦截）/`onDrop`（恒 preventDefault 防导航；`dataTransfer.files`）/`onDragOver`（preventDefault 放行 drop）→ **直接调既有 `pickFiles`**（预算预检/拒绝明细/在途进度与 📎 完全同源——验收③结构性保证）；门与 📎 同款 `!running`
- **A2 弱替代**：TranscriptView 用户气泡增「↻ 以此开新对话」钮（`onReuseTurn?: (item: UserTurnItem) => void` prop，IconButton）；宿主 `newChat` 扩展 `newChat(prefill?)`：session-new + setTask(该 turn task) + 切回 chat 视图，**不自动起跑**；新会话零 turn → 前情块必空（continuity 同会话语义——验收④，测试锚定）
- **A3 测试**：TranscriptView reuse 钮渲染/回调；intake 守卫纯函数（粘贴接管条件）；continuity 空会话锚定（补断言）

### 批 B：聊天搜索浮层（当前会话内全文）

- **B1 纯函数**（console-ui/src/transcript-search.ts）：`findTranscriptMatches(items, query)` 跨条目有序命中表（itemKey → 命中数；全局总数）+ `splitTextByQuery(text, query)` 文本分段（渲染 mark 用）；大小写不敏感；空查询/空白查询零命中
- **B2 SearchOverlay 组件**：输入框（受控）+ ↑/↓ 导航 + 计数 `aria-live="polite"`（`第 n/N 处` / `无命中`）+ Esc 关；浮层绝对定位不占布局（layout.css 增 tc-search-pop 族）
- **B3 TranscriptView 集成**：`highlight?: { query: string; activeOrdinal: number } | null` prop——命中文本 mark 高亮（`tc-search-hit`），当前命中强标识（`tc-search-hit--active`）+ `scrollIntoView({block:"center"})`；不搜索时零开销（无 mark 节点）
- **B4 触发**：SessionTitleBar actions 增搜索钮（chat 视图且非 landing）；`Ctrl/Cmd+F` 窗口级 keydown（仅 chat 视图且设置浮层关时 preventDefault 拦截）
- **B5 测试**：纯函数（多命中/大小写/空查询/跨条目序）；SearchOverlay（计数播报/导航/Esc）；TranscriptView 高亮与 active 滚动锚定

### 批 C：通知回流 + 设置通用区

- **C1 manifest**：permissions += `notifications`（本期唯一权限变更，changelog 说明）
- **C2 chrome 绑定**：chrome-apis.ts 增 `NotificationsApi`（create/onClicked/clear 窄接口）与 `SidePanelApi`（open）真绑定访问器
- **C3 run-notifier**（apps/extension/src/host/run-notifier.ts）：`RunNotifier` 类——`notifyTerminal({status, sessionId, tabId, title})` 发通知（notificationId → 上下文 Map）；onClicked → 激活绑定 tab（tabs.update）+ `sidePanel.open({tabId})`；tab 已关/打开失败 fail-soft 记日志；全注入可测
- **C4 run-manager 钩子**：`drive()` finally 终态广播后——**终态 && `!deps.hasPorts()` && 设置开关** 才 notify（hasPorts 已在 RunManagerDeps——#37 在场门同源）；done/error/interrupted 分文案（title=会话标题，message=状态文案+finalResult/lastError 摘要截断）
- **C5 设置**：ExtensionSettings 增 `notifyOnRunDone?: boolean`（宽松收窄，缺省 true）+ `showDebugTab?: boolean`（缺省 true——收编 U3 D3 遗留的调试页开关）；OptionsApp 新「通用」区两 Switch（既有 save-settings 面）；sidepanel 设置读取 effect 增 showDebugTab → pages 注册 debug 项 isEnabled
- **C6 测试**：run-notifier（fake chrome 注入：创建/点击回流的 tab 激活与面板打开/失败降级）；run-manager 终态门（hasPorts=true 不发/开关关不发/三终态文案）；settings 解析；OptionsApp 通用区读写

### 批 D：元素选择器评估 + 验收自查收尾

- **D1 评估结论**（§6 登记）：技术路线（content script 需新增 scripting 权限 vs CDP 注入走既有 debugger 附着——drive-session 同构体但为 run 外空闲会话）/ 成本 4–5 人日 / 与自然语言任务心智重叠 / 裁决建议
- **D2 验收自查**：①–④ 逐条锚点登记；e2e 冒烟评估（smoke-ui 增断言可选——按惯例脚本就绪真机手动）
- **D3 测试总账与收尾**

## 2. 设计决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 粘贴/拖入与 📎 同门同源（`!running` + 同一 `pickFiles` 编排） | 验收③「路径完全一致」由单入口结构性保证；running 中 📎 本就禁用 |
| D2 | 搜索范围 = 用户气泡 task + run 块 finalResult/lastError | 对话语义面（qz 搜索的是消息非工具日志）；事件明细是调试面（调试页已承载原始流）；跨会话搜索裁剪不做（索引摘要面未建，远期） |
| D3 | 通知门 = 终态 × `!hasPorts()` × 设置开关；三终态都通知分文案 | 在场自然被 hasPorts 过滤（stop 时面板在场不发）；interrupted 的 SW 被杀/关 tab 场景用户不在场，通知有回流价值 |
| D4 | 通知点击 = tabs.update 激活绑定 tab + sidePanel.open({tabId}) | 通知点击是用户手势（Chrome 116+ sidePanel.open 可用）；tab 已关 fail-soft 记日志不炸 |
| D5 | 弱替代 = session-new + 预填 composer，不自动起跑 | 预填给用户改写空间（重发的核心诉求是改任务）；自动起跑错成本高 |
| D6 | 搜索高亮在 TranscriptView 内（mark + active 类 + scrollIntoView） | 高亮与滚动贴近数据渲染面；搜索关闭时零 mark 节点零开销 |
| D7 | Ctrl/Cmd+F 仅 chat 视图拦截（设置浮层开时不抢） | 原生 find 在页签页/设置浮层仍有价值；拦截范围最小化 |
| D8 | 元素选择器：评估裁决**远期独立提案**（本期不做） | 两条路线成本均 4–5 人日；自然语言任务已覆盖多数元素指涉场景；精确指涉（上传 input 歧义等）等真实需求显形再立项 |

## 3. 风险

- `sidePanel.open` 在通知点击的手势认定：Chrome 116+ 支持通知点击作为用户手势——真机 smoke 验证；失败已激活 tab 兜底（面板可 Ctrl+Shift+K 开）
- 粘贴大文件与 📎 同走 base64 分块——无新增风险面；clipboard 截图 File name 可能重名（image.png）——注册表按 transferId 无碰撞
- mark 高亮触发长文 rerender：仅搜索打开期间；条目 key 稳定不重挂
- jsdom 无 scrollIntoView：测试守卫（typeof 检查或组件级 stub）
- MV3 通知点击唤醒 SW：onClicked 监听器在 background 顶层同步注册（MV3 纪律——监听器晚注册丢事件）

## 4. 进度

- [x] 批 A 输入增强（55cf9ad）：整页粘贴/拖入接面（onPaste/onDrop/onDragOver + intakeFiles 守卫——!running 与 📎 同门、files 非空才接管）→ 既有 pickFiles 单一入口（验收③结构性同源）；TranscriptView「↻ 以此开新对话」钮（onReuseTurn）→ newChat(prefill)：session-new + 预填不自动起跑（D5）。
- [x] 批 B 聊天搜索浮层（2318288）：transcript-search.tsx（splitTextByQuery 大小写不敏感 / ordinalBasesOf 全局命中序——run 块内 lastError 先于 finalResult 与 DOM 序一致 / HighlightedText mark + data-search-ordinal）；SearchOverlay（<search> 语义地标 + Enter/Shift+Enter/Esc + 计数 aria-live="polite"）；TranscriptView highlight prop + scrollIntoView 居中（仅 query/active 变化触发）；FinalResult 搜索态终态降级纯文本（markdown 重排会使命中序错位）；标题条 🔍 钮 + Ctrl/Cmd+F（D7 仅 chat 视图且浮层关）；.tc-search-pop sticky 挂 main 顶部右侧。
- [x] 批 C 通知回流 + 设置通用区（307dbc5）：manifest += notifications（构建级实证：wxt build 过、产物 manifest 权限面含 notifications）；chrome-apis 增 notifications/sidePanel/tabs.update 窄接口（update receiver 敏感——API 对象方法调用形态）；RunNotifier（三终态分文案/任务截 40/结果截 80/点击回流激活 tab + sidePanel.open/设置门异步热读 fail-open/onClicked 构造时注册）；run-manager drive() 终态收口——!hasPorts() 才通知（D3）；OptionsApp 通用区（notifyOnRunDone + showDebugTab——收编 U3 D3 遗留）。
- [x] 批 D 元素选择器评估 + 验收自查（本提交）：评估结论见 §6（D8 远期）；验收①–④ 锚点见下。

### 验收自查（§0 四条）

1. **搜索计数/aria-live**：search-overlay.test（「2/5 处」/「无命中」aria-live="polite"）+ transcript-search.test（计数纯函数/序号表）+ transcript-view.test（跨条目全局序/当前命中强标识）✓
2. **通知回流**：host-run-notifier.test（basic 形态/设置门关不发/fail-open/点击激活+开面板/即取即清/fail-soft）+ runtime-run-manager.test（在场静默/离场 done·error 载荷门）；**真机手动项**——done 通知出现且点击打开 sidepanel（headless e2e 断言不了系统通知 UI）
3. **粘贴路径一致**：ui-glue.test intakeFiles 三态守卫（文件非空才接管/运行中拒绝/纯文本不拦）+ 同源 pickFiles 结构性保证（单一入口）；**真机手动项**——粘贴截图进附件清单与 📎 同径
4. **弱替代**：transcript-view.test（reuse 钮渲染/回调/缺省不渲染）+ continuity.test 既有锚点（buildContinuityBlock([]) → null——新会话零 turn 前情块必空）；glue 面薄（newChat(prefill) 单发 + setTask）

### 测试总账

console-ui 148→163（批 A +2、批 B +13）；extension 292→303（批 A +3、批 C +8）；protocol 3 不变。覆盖率门禁全轮过；wxt build 构建级实证（manifest 权限面）。分支提交：计划 + 四批共 5 个。

## 5. 评审轮次登记（review-loop 填写）

### 轮 1（2026-11-18，5 条全采纳：P1×3 / P2×2）

- **[1] P1 chromeTabsUpdate 形状错**：返回了解构出的 `tabs.update` 裸函数强转 `{update}` 对象形——`.update` 属性 undefined，通知点击回流真实路径 100% TypeError（测试用 `{update: vi.fn()}` fake 恰好同形掩盖）。修复：返回原生 tabs 命名空间对象（方法调用形态保 receiver，同 chromeTabsQuery 先例）；ChromeLike.tabs.update 改方法签名。
- **[2] P1 通知点击的 SW 冷启动失效**：contexts 内存 Map 在 SW 空闲回收（终态后 ~30s，keepalive 已清 + 无端口）后丢失——用户数分钟后点通知冷启动重建实例查无上下文静默 no-op，恰击穿「离开面板才收通知」核心场景。修复：tabId 内嵌通知 id（`run-terminal-<tabId>-<uuid>`）+ onClicked 解析恢复（`tabIdOfNotificationId`），弃内存 Map（二次点击幂等无害）；冷启动恢复路径测试锚定（新实例解析 id 回流——Map 实现下该测试必红）。
- **[3] P1 newChat 事件参数泄漏**：签名改 `(prefill?)` 后直传 `onNewChat`/`onNew`——点击事件对象被 setTask 写入 task state，Composer `task.trim()` 崩整页渲染。修复：两处调用点空参包装 `() => newChat()`。
- **[4] P2 粘贴接面收不到 body 焦点 paste**：React 18 根容器代理——面板刚打开/点不可聚焦区时焦点在 body，paste 目标不经过 #root，div onPaste 永不触发（主场景失效）。修复：document 级监听（intakeFiles 守卫复用）；pickFiles/send 链式 useCallback 稳定化（biome exhaustive-deps）；drop/dragover 基于指针位置保留在接面 div。
- **[5] P2 无条件 drop preventDefault 吞原生文本拖入**：纯文本拖入 composer/搜索框被拦截且不接管（原生插入被取消，静默无反馈——本变更前可用）。修复：文件受理才 preventDefault + pickFiles；纯文本落点在可编辑元素（INPUT/TEXTAREA/contentEditable）保留原生插入，其余恒 preventDefault 防 file:// 导航。
- 测试：extension 303→304（冷启动恢复 +1、即取即清改幂等语义）；console-ui 163 不变。

### 轮 2（2026-11-18，1 条采纳：P2×1）

- **[1] P2 running 门拒绝的文件 drop 落输入框污染草稿**：回退分支区分不了「无文件」与「running 拒绝文件」——running 时拖文件到输入框放行原生默认，file:// 路径被写入 DOM 且经后续 onChange 混入草稿 state（受理门与 📎 同款「静默拒绝」意图被破）。修复：带文件的 drop 恒 preventDefault（先判 hasFiles 再判落点），仅纯文本拖入保留可编辑元素原生插入。
- 测试：extension 304 不变（glue 面内联判定——intake 守卫已有单测锚定）。

## 6. 元素选择器评估（批 D，D8 裁决：远期独立提案——本期不做）

**是什么**：面板「引用页面元素」入口——选择模式下到目标页点选元素，元素指纹（稳定 selector/bbox/文本摘要）插入任务文本，模型获得精确指涉。

**技术路线**：

| 路线 | 依赖 | 成本 | 主要风险 |
| --- | --- | --- | --- |
| content script 选择模式 | manifest 新增 `scripting` 权限 + 注入声明；选择状态机（hover 高亮/Esc 退出）跑页面上下文 | ~3 人日 + 权限可见性变更 | SPA 路由下注入时机；多 frame；与页面脚本冲突 |
| CDP 注入（drive-session 同构体） | 零 manifest 变更（debugger 已有）；run 外空闲会话附着目标 tab，Runtime.evaluate 注入 | ~4–5 人日 | 附着信息栏常驻「正在调试此浏览器」（体验代价）；与 run 互斥（同一 tab 只能一个 debugger 附着——选择模式期间不可跑任务） |

**与 TC 心智的重叠**：自然语言任务已覆盖多数指涉场景（模型经 element_tree_text 感知页面）；增量价值集中在**高歧义精确指涉**（多上传 input 区分）——该场景已被任务级 skill 的 selectors.md 沉淀覆盖（domain-skills 现役形态），且 upload-identity 稳定指纹算法可复用。

**需求信号**：U1–U3 期间无用户/issue 需求指向元素选择器。

**再评估触发**：出现 ≥2 个真实场景（用户反馈/高频失败轨迹）表明自然语言指涉不足且 skill 沉淀未覆盖——届时按 CDP 路线独立立项（避开 scripting 权限）。

**跨会话搜索（D2 关联）**：裁剪不做——会话索引摘要面未建（SessionMeta 无摘要字段），标题搜索价值低（任务页 50 条 LRU 肉眼可扫）；留远期与索引摘要面同期评估。

## 7. 备注

- manifest 本期一处变更：notifications 权限（changelog 说明——方案 §7 权限可见性预登记）
- AOCI：分支合并后做认知收尾（届时说「aoci 收尾」）
