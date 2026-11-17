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

- [ ] 批 A 排队全链
- [ ] 批 B usage pill + 只读态
- [ ] 批 C 目标条 + commands + 预设
- [ ] 批 D 滚动意图
- [ ] 全量验收自查（§0 五条）

## 5. 评审轮次登记（review-loop 填写）

（待各轮登记）
