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

- [ ] 批 A 输入增强
- [ ] 批 B 聊天搜索浮层
- [ ] 批 C 通知回流 + 设置通用区
- [ ] 批 D 元素选择器评估 + 验收自查

## 5. 评审轮次登记（review-loop 填写）

（待评审）

## 6. 元素选择器评估（批 D 填写）

（待评估）

## 7. 备注

- manifest 本期一处变更：notifications 权限（changelog 说明——方案 §7 权限可见性预登记）
- AOCI：分支合并后做认知收尾（届时说「aoci 收尾」）
