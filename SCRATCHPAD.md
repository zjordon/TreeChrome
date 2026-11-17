# SCRATCHPAD——sidepanel 改版 U2：干预与状态

> 依据：docs/sidepanel-redesign-plan.md §6 U2。U1（#35）已合并：会话模型/转录形态/Composer/任务页就位；
> 协议 queue-add/remove kind 与 steer 预留、快照 origin 字段、SessionTurn.status 含 queued 均已在 U1a 落地。
> 本期单分支多提交（评审循环按增量轮跑——U1 已验证），评审登记见 §7。

## 0. U2 总目标与验收（引自方案 §6）

run 进行中可发后续任务入队可视化、终态后自动续跑；上下文用量常驻状态条；bridge 发起的 run 面板只读可视化；快捷键与预设降建卡门槛；滚动跟随。

验收五条：
1. run 进行中发送 → 入队可见且转录出现排队标记；done 后 ≤2s 自动开跑下一条；开跑前撤销有效
2. stop 后队列清空且对应 turn 标 cancelled（转录可查）
3. bridge 发起 run，sidepanel 显示外部卡 + 只读条，stop 可用
4. usage pill 数值与 diag 导出的 model_result.inputTokens 一致，分母 = activeCard.contextWindow
5. e2e 冒烟：排队 3 条中途 stop 的全状态断言

## 1. 工作项（提交分四批）

### 批 A：排队全链（SW + UI，强耦合同批）

- **A1 协议**：queue-add 载荷 {sessionId, task, attachments?}、queue-remove {turnId} 实质化（kind 已在）；queue-add 应答 {ok, turnId}；SW→UI 复用 session-updated(reason:"queue")
- **A2 SW 排队器**（run-manager 内聚，不另立模块）：
  - queue-add：同 session queued turns <5 → repo 追加 queued turn（runId null）→ 无活 run 且无在途 create 时立即尝试出队；有则等终态
  - 终态收口（drive finally 归档后）：同 session 有 queued → 2s 节流出队（start 语义，显式 sessionId）；出队前 turn 转 running（复用 beginRun 路径——queued→running 需 repo 支持 updateTurn 补 runId）
  - control.stop：清空当前 session 全部 queued turns 标 cancelled（连播语义——用户叫停整个队列）
  - SW 重启：恢复扫描时 queued→cancelled（与「不续跑」决策 5 同构——无人值守起跑不可接受）
  - 出队与 drive/run 互斥：出队走既有单飞互斥（starting 标志），失败即下一条不烧
- **A3 repo**：appendQueuedTurn / activateQueuedTurn(turnId, runId)（queued→running）/ cancelQueued(sessionId)——变更链内串行
- **A4 session-handler**：queue-add/queue-remove 实装（替换 not-supported）；queue-add 上限/空任务校验
- **A5 UI**：composer 运行中可输入（canSend 语义反转——running 时仍可发→queue-add）；排队消息条（当前 session queued turns 列表 + 逐条撤销，数据面=session-open 应答已含 queued turns）；TranscriptView 排队 turn 气泡（状态章「排队中」——projectTranscript 已支持 queued 状态，补 run-block 缺省渲染）
- **A6 测试**：排队器状态机（入队/节流出队/撤销/stop 清空/重启 cancelled/上限拒绝/与互斥窗口竞态）+ repo 三方法 + handler 两 op + UI reducer/组件 + e2e 冒烟脚本（smoke-queue.mjs：mock LLM 三步 run ×3 入队中途 stop）

### 批 B：usage pill + 外部直驱只读态

- **B1 usage**：UI reducer 从 events 取最近 model_result.inputTokens/outputTokens（已有数据面）；contextWindow 经 optionsRequest get-settings 热读（设置变更后拉一次）；RunStatusBar 加 usage pill（比例条+数值 title）
- **B2 只读态**：snapshot.origin==="bridge" 时——①转录顶部外部卡（静态说明：外部客户端直驱中/此处只读/停止可用；连接命令显示 tc-bridge 用法行，不含可复制配对 URL——扩展侧不回读 bridge 配置，登记偏离）②composer 禁用+提示条（发送钮隐藏）③停止钮保留（既有）
- **B3 测试**：usage 投影（多 model_result 取最新）、只读态渲染、origin 缺省不触发

### 批 C：目标条 + chrome.commands + 预设模板

- **C1 目标条**：session-open 应答带 targetUrl（SW tabs.query(tabId) 现查）；新 op session-focus（tabs.update 激活）；composer 顶部条件行（有会话时显示 host+路径截断，点击聚焦）
- **C2 commands**：manifest commands：_execute_action（Ctrl+Shift+K 开面板——setPanelBehavior 已接）+ open-model-switcher（Ctrl+Shift+M）；background onCommand：switcher → sidePanel.open + 端口广播 model-switch-request（新 SW→UI kind）；UI 收到弹 ProviderList 快速切换 overlay（选卡 → save-settings activeCard）
- **C3 预设**：console-ui 常量 PRESETS（智谱/OpenAI/DeepSeek/Kimi/OpenRouter：baseUrl+protocol+model 示例）；ProviderCardForm 新建时预设下拉预填
- **C4 测试**：目标条/聚焦 op/switcher 广播链/预设表单

### 批 D：滚动意图裁剪版

- TranscriptView 容器：sticky-bottom 跟随 + 上滚解除（阈值 28px）+ 回底恢复 + 解除时新事件浮钮「↓」；纯组件（scroll 事件 + ref），测试 jsdom 模拟 scrollTop

## 2. 设计决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 排队器内聚 run-manager（不另立 queue 模块） | 出队= start 语义、互斥/节流/收口都在 run-manager 生命周期内——另立模块要双向接线 |
| D2 | stop 清空的是「当前 session」队列 | 连播语义：用户叫停的是这个会话的后续任务，不动他会话残留（他会话 queued 由其自身收口/重启处理） |
| D3 | SW 重启 queued→cancelled | 与「run 不续跑」同构；无人值守自动起跑撞权限卡模型不可接受 |
| D4 | 外部卡不含可复制 URL | bridge 配对 URL 属 tc-bridge 进程配置（扩展侧不回读）；显示用法行，完整 URL 由 tc-bridge connect 自身输出——方案 §5.6 的「连接命令模板」按此降级，登记偏离 |
| D5 | Ctrl+Shift+M 先开面板再广播 | 面板未开时切换器无处渲染；sidePanel.open 需用户手势上下文，commands 回调是合法手势 |
| D6 | 批 A-F 四批提交 | 排队链强耦合不可拆；B/C/D 相互独立可分段评审 |

## 3. 风险

- 出队节流窗（2s）内用户手动 start：互斥拒绝→队列保留，下次收口再试（不丢）
- queue-add 与终态收口竞态（终态 finally 中 repo 写 vs queue-add 追加）：repo 变更链串行天然安全；出队触发点在收口尾部统一检查
- SW 被杀丢失在内存的「待出队」定时器：重启 cancelled 兜底（D3）
- commands 快捷键与浏览器/其他扩展冲突：chrome://extensions/shortcuts 用户可改，文档注明

## 4. 进度

- [x] 批 A 排队全链（5f81fd5）：repo 六方法（appendQueuedTurn/firstQueuedTurn/activateQueuedTurn/cancelQueuedTurn/cancelQueued/cancelAllQueued，上限 5）；run-manager 队列器（queueFollowUp 入队即试出队/终态 2s 节流续播/stop 连播清空/queueTurnId 激活复用+回落新建/出队失败留队重试）；session-handler 实装 queue-add/remove（SessionQueueFace 注入）；background 接线 + boot cancelAllQueued 兜底（D3）；UI 发送分流（运行中→入队）+ QueueStrip
- [x] 批 B usage pill + 只读态（5c2e647）：RunStatusBar usage pill（formatTokens 短写/≥90% 警色/缺省不渲染）；contextWindow 经 get-settings 热读；事件流倒序取最近 model_result；origin==="bridge" → ExternalDriveCard + composer 禁用（停止保留；连接命令不含配对 URL——D4 偏离）
- [x] 批 C 目标条 + commands + 预设（1fd06c4）：session-open 带 targetUrl（SW 现查）+ GoalStrip（点击 session-focus 激活）；manifest commands Ctrl+Shift+K/M + model-switch-request 广播（模块级 uiBroadcastRef 桥 MV3 时序）；ModelSwitcher overlay（点选即 save-settings）；PRESET_CARDS 五条预填
- [x] 批 D 滚动意图（209c8c8）：TranscriptView 自有滚动面（贴底跟随/上滚解除 28px/回底恢复/浮钮）+ isAtBottom 纯函数
- [x] e2e 冒烟（smoke-queue.mjs，随批 D 提交）：mock LLM 挂起窗 → 入队×3 → stop → interrupted + 3 cancelled + 零续跑断言（脚本就绪——真机实跑按仓库惯例手动执行 `pnpm --filter extension e2e:queue`，先 `npx wxt build`）
- [x] 全量验收自查（§0 五条）：①②③④单测锚点齐（run-manager 排队四例/usage pill/ExternalDriveCard）；⑤ e2e 脚本就绪待真机实跑
- 测试总账：extension 272→290（批 A-D +283；评审轮 1 +6、轮 2 +1）、console-ui 95→110；分支提交：计划 + 四批 + 评审修复

## 5. 评审轮次登记（review-loop 填写）

### 轮 1（2026-11-17，10 条全采纳：P1×2 / P2×8）

- **[1] P1 滚动面宿主失效**：`.tc-shell-main` grid auto 行高下 `.tc-transcript--scroll` 恒等于内容高、自身永不溢出——跟随/解除/浮钮在唯一真实宿主（sidepanel/web-console 均 AppShell）整体 inert，jsdom 无布局测不出。修复：main 改 flex 列（其余子项靠 min-height:auto 默认不缩，行为与 grid 等价）+ 转录面 `flex:1 1 auto`（overflow 非 visible 时自动最小高为 0）。
- **[9] P1 出队拒绝 FIFO 头阻塞**：无重试调度无终态收口——附件指涉任务（queue-add 不落附件 + clearForRun 清表）永久 queued 且阻塞后续。修复：queueFollowUp 附件指涉拒绝（可行动文案）；出队拒绝退避重试（drainRetryMs 缺省 10s）×3 后头阻塞解除（转 cancelled + session-updated 广播 + 立即续试下一条）。
- **[2] P2 跨会话排队搁浅**：单 timer 字段不分会话——A 运行中给 B 入队，drain(B) 让位即丢触发，A 终态只调度 A，B 永久「排队中」。修复：drainTimers per-session Map + 让位重排；stop 只清被停会话的 timer。
- **[3] P2 激活错过回落新建**：出队多 await 窗口内 queue-remove 撤销 → activateQueuedTurn miss → 回落 beginRun 把已撤销任务跑起来。修复：激活前置到 assemble 后/journal.begin 前——miss/存储异常即无副作用中止（skipped 标记，drainQueue 不计退避立即试下一条）。
- **[10] P2 续播抢活动页**：出队走 pickActiveDrivableTab——agent 在用户当前浏览的任意页面执行任务 + rebindTab 静默改绑会话目标。修复：tabByIdDrivable 校验会话绑定 tab（http/https），出队显式带 tabId；tabId 0（未绑定）回落活动页挑选。
- **[4] P2 external 全局判定**：bridge run 在他会话时 composer/外部卡张冠李戴。修复：external 加 runViewEligible 会话门（与转录层同款）。
- **[5]+[8] P2 targetUrl 无归属守卫/同会话重入丢失**：组件态 targetUrl 缺 forSessionId 守卫且自动跟随路径不清；同会话重入误清后无恢复通道。修复：收进 reducer（session-target 动作 + 归属守卫），session-current/hello/journal-snapshot/notFound 四分支同步清，同会话重入早退不清。
- **[6] P2 运行中静默无操作**：running && 无当前会话（删除活跃会话/LRU/无会话面）时发送钮可点但什么都不发生——相对旧禁用是回归。修复：canSend 补 `!running || queueable`。
- **[7] P2 usage 分母不随换卡**：ModelSwitcher 关闭不在 contextWindow 热读触发器——快速换卡后 ratio 按 stale 分母。修复：effect 增 modelSwitcherOpen 触发器。
- 双向验证：[2] 破坏让位重排 → 跨会话用例必红；[5] 破坏换会话清 → reducer 用例必红；还原复绿。extension 283→289，console-ui 110 不变，门禁 exit 0。

### 轮 2（2026-11-17，1 条采纳：P2×1；另有增量基线操作修正）

- **[1] P2 退避计数跨代沿用**：drainAttempts 清零只在 drainQueue 三出口——queueRemove（撤销头 turn）与 stop→cancelQueue（清空队列）均不清零，且 stop 清 timer 连「队列空兜底出口」一并取消。头 turn 被拒 2 次后换代，新任务首拒即 3 达上限被静默取消（违背三次语义）。修复：queueRemove/cancelQueue 成功即 delete(sessionId)（用户干预重置计数；换代必经三出口——append 只尾插不改头，boot cancelAllQueued 时实例已新建）。测试锚定拒绝日志计数（旧 1 + 新 3 = 4；修复前 3）。双向验证：破坏清零 → 用例必红（3≠4）。
- **操作修正**：轮 2 首发误用 lastCommit（= 分支 tip）作 --from → range 空 skipped（#35 轮 3 同款）；改用 reviewedTip e667605 重发。已同步修正 .claude/.zcode 双栖 review-loop 命令文档（diffBase 基线改 reviewedTip + 状态文件字段补登）。
- 测试总账：extension 289→290；门禁 exit 0。
