# 03 · agent 层：五阶段 pipeline / prompts / skills / judge

> 参照：TreeWalker `agent/agent.py`（705）/ `agent/step.py`（2238）/ `action_shape.py`（306）/ `agent/{views,loop_detector,message_compactor,actionability,plan_manager,judge}.py` / `prompts/system_prompt.py`（368）/ `skills/{loader,task_loader,task_matcher}.py` / 评测仓 `runner.py` 调用契约。行号锚点均属 `640d52a`（快照审查后的**新行号**，与 architecture.md §3.1 旧表不同）。
>
> 冻结：公共 API 形态（runner 契约即验收规格）、run 外层与五阶段逐阶段契约（含 #194/#197 新机制）、消息管理设计、prompts 字节保真清单、skills/judge 行为。

## 1. 公共 API（架构 §3.2；runner.py 契约即验收）

```ts
// runner.py:34-36 / :457-507 的调用面 —— TS 同构形态
const browser = new BrowserSession(transportFactory, settings.browser);
await browser.start();
await browser.injectStorageState(storageState);        // runner.py:80-156（Python 裸调 client.send）
const agent = new Agent({ task, llm, browser, settings: agentSettings });  // settings 必须整对象传入（runner.py:484-488 教训：不得新建默认 settings 丢口径开关）
const history = await withTimeout(agent.run({ keepAlive }), taskTimeout);  // runner.py:495-498
history.isDone(); history.isSuccessful(); history.finalResult(); history.history.length;  // :504-507
```

- `AgentHistoryList`（views.py:259-285）：`isDone()`（末步任一 result.is_done）/ `isSuccessful()` / `finalResult()`（倒序找 is_done 且 extracted_content）/ `history[i].stateSummary`（轨迹转换用，runner.py:370）。
- `AgentHistory` 步字段（views.py:134-147）：stepNumber / modelOutput / result / stateSummary / interactedElement / metadata / screenshotPath。**类型字段名 camelCase，序列化给评测的 JSON 键保 snake_case**（build_webarena_trajectory 消费形态，评测仓对接时以 Python 输出为字节基准）。
- `run({ keepAlive })`：keepAlive=true 时 finally 不调 browser.stop()（评测判分需要活浏览器）。
- task 里的 URL 提取 `_extractUrl`（agent.py:700-705 正则）照搬；skill 匹配**优先用导航目标 URL 而非读当前页**（agent.py:538-548 竞态注释——navigate 应答可能早于新文档 commit）。

## 2. run 外层（agent.py:287-373）

流程保真：`browser.start`(:289) → 初始导航（失败仅 warning，:294-299）→ **任务级 skill 匹配一次**（:302-312，全异常捕获=不注入）→ `while nSteps <= maxSteps`(:314)：stopped 破环 / consecutiveFailures≥maxFailures 破环(:319-324) / **infraFailures≥maxInfraFailures(=8) 破环（#194）**(:329-334) / paused 等待 resume / `done = await _step()`(:344) → finalize 降级 ≥3 步升级终止（先跑 judge，:348-356）→ done 后 `_runJudge()` 再 break(:357-360) → finally：降级计数入 history / `_finalizeSession` / 非 keepAlive 时 browser.stop。

- 构造参数：`{ task, llm, browser, tools?, settings, sensitiveData?, outputModel? }`（agent.py:55-64）；tools 缺省自建；extract 专用 LLM 与 task-skill 匹配 LLM 缺省复用主 llm（:74-78/:160-163）。
- **stop/pause/resume 是公共 API**（:375-390）；SIGINT 双击与 stdin Enter 恢复**不移植**（宿主职责，README §3）。
- `AgentSettings` 字段面 = 探查清单全量（maxSteps=100/maxFailures=5/maxInfraFailures=8/llmTimeout=120/actionTimeout=30/reconnectTimeout=30/maxActionsPerStep=5 + 渲染开关族 + 口径开关族 + truncation + skillsDir 经 SkillSource 取代 + rerun 族**不入 P4**）。env 装配不移植（宿主负责）。

## 3. 五阶段（Template Method 拆分）

```
core/src/agent/step/
  pipeline.ts      // _step 编排器 :216-297 + 公共小件（nudge ack / 消息 setter / 预算警告）
  sense.ts think.ts act.ts post.ts finalize.ts
```

### 3.0 编排器 `_step`（:216-297）

sense(:229) → compactor(:230-231) → stop/pause 短路(:232-233) → 清上步 state 注入(:238-239) → think(:241；None=LLM 期间停止) → ack 止损档位(:249) → act(:253) → post(:254) → done/连败判定(:256-259) → 异常交 `_handleStepError`（处理器自身失败降级日志 :260-269）→ **finally：finalize（异常兜住并计 finalizeDegradedSteps）+ `nSteps += 1` 单一所有点（#194 `_skipStepIncrement` 豁免 infra 步）**(:270-295)。

### 3.1 Sense `_prepareContext`（:320-486）

清上步 context 注入(:324) → `get_state({ includeScreenshot: visionGateOpen() })`(:331-333；visionGate = useVision && provider.capabilities.supportsVision **逐步评估** :490-498) → 循环检测指纹记录（url + element_tree_text + selectorMap 数量，:343-349) → nudge 汇编（loop nudge :369-379 / failureStreak **peek 只暂存** :380-385 / zeroResult peek :388-392；ack 在 :249）→ 下载通知(:394-403) → pageStats/gridMeta/sensitive/domain-skill/task-skill 装配(:405-426) + SkillActiveEvent(:432-442) → 视觉开时升级 `[text,image]` blocks（:464-470，`buildStateBlocks`）→ **state 消息替换式**（§4）→ `<agent_history>` 滑窗消息每步替换(:473-475) → 步数预算警告 ≥75%(:477-478) → done-only schema 降级两处（最后一步 :480-481+:748-762；连败达限 :483-484+:764-781；均重建 `getToolSchema({ includeActions:["done"], maxActions:1 })`）。

### 3.2 Think `_getNextAction`（:796-929）+ 双梯（#197）

- `_trimMessages()`(:802)（§4）→ `llm.setCallWindow(llmTimeout)`（#194 步级退避窗口，:823-825）→ `withTimeout(_getActionWithRetry(trimmed), llmTimeout)`(:826-829) → LLM 后 stop 检查 ×2（:841-846/:879-902，丢弃输出）→ 归一化(:853) → **动作数硬截断** `_truncateActions`（:861/:931-954，cap=maxActionsPerStep）→ ModelResultEvent(:863-876) → 决策日志（脱敏）。
- **外梯**（畸形动作，:1016-1089）：首调(:1042-1046) → 有效则过内梯+done 门禁 → 重试 **2 次**（`_INVALID_ACTION_MAX_RETRIES=2` :69）：attempt≥1 用 `copyMessagesWithoutImages` 去图（:1061-1062）+ **形状定向澄清** `_invalidActionFeedback`（:74-100，按实际畸形给病灶+示例；诊断用 `describeActionEntry`）→ 仍无效 `_fallbackDoneOutput`(:110-121)。
- **内梯**（参数校验，:1202-1281）：**3 次**（`_PARAM_VALIDATION_MAX_RETRIES=3` :68）；无效动作与参数错**共用预算**；第 2 次起去图(:1240-1251)；校验 = registry paramModel + `_flattenParams` 同源（:1283-1326）。
- **done 门禁** `_gateUncertainSuccessDone`（:1091-1200）：只拦 success=true 的 done；每 run 封顶 2 次(:2234)；内层超时按剩余预算(:1169-1171，常量 60s :2238)；不确定标记扫描 `scanUncertaintyMarkers`(:2204-2229)。
- LLM 调用统一 `llm.getAction({ systemPrompt, messages, toolSchema })`（P2 面，4 处调用点：首调/外梯澄清/门禁验证/内梯重试）。

### 3.3 Act `_executeActions`（:1357-1597）

入口 stop 检查(:1390) → 严格串行 for(:1397)：**权限门挂点（TreeChrome 新增，04 §3：ToolCallEvent :1447-1464 之后、actionability :1483-1499 之前，逐动作）** → Guard#1 列表中段 done 截断(:1407-1412) → 动作间 waitBetweenActions(:1416-1417) → 中断守卫（stop/pause→InterruptedError，:1425-1430）→ per-action 日志脱敏(:1435-1443) → actionability 等待（白名单 {click,input_text,select_dropdown}，降级不抛）→ pre-action URL/target 采样(:1466-1477) → `withTimeout(tools.execute(...), actionTimeout)`(:1502-1505)（超时→error 结果；InterruptedError/连接错误 re-raise；其他包 error，:1506-1517) → streak 记录(:1525/:1545-1549) → ToolResultEvent(:1552-1560) → Guard#2/#3 is_done/error 截断(:1564-1565) → Guard#4 terminatesSequence(:1570-1576) → Guard#5 **URL/target 漂移截断**(:1582-1595)。

### 3.4 Post `_postProcess`（:1601-1687）

lastResult/lastModelOutput 存 state(:1615-1616) → 下载并入 done attachments(:1621-1622) → plan 更新(:1625-1626，PlanManager) → loop detector 记录（豁免 wait/done/go_back，:1631-1636）→ **#194：infraFailures 清零在单动作失败 early return 之前**(:1647-1648) → 计数规则：**仅「单动作步且 error」计 consecutiveFailures+1 并 early return**(:1649-1652)；多动作步任何失败不计（仅日志 :1653-1660）；非计数步清零(:1662-1664)。**TreeChrome 增补：denied 结果同规则排除**（04 §3）。

### 3.5 Finalize `_finalize`（:1691-1757）

modelOutput 非空守卫(:1708) → stateSummary（url/title/duration；仅 done 步带 domExcerpt，cap=truncation.domExcerptMaxChars，:1709-1725) → 截图落盘 `<rerun_history_dir>/screenshots/step_NNN.png`(:1730-1734；**FS 未注入时跳过落盘只留内存引用**——screenshotPath=null，登记降级) → AgentHistory 追加(:1735-1743；interactedElement 投影 :1777-1821：等长按位、uploadClue 覆盖、index/elementId 别名) → StepEndEvent(:1745-1753)。

### 3.6 错误处理四分支 `_handleStepError`（:1872-1970）

| 分支 | 锚点 | 行为 |
|---|---|---|
| 1 InterruptedError | :1881-1886 | 不计失败 |
| 2.5 **LLM infra（#194）** | :1895-1925 | `isInfraError`（P2 已有，仅 RateLimit/Connection）→ infraFailures+=1；预算耗尽不退避，否则指数退避 **5/10/20/40/60 封顶**（常量 :2135-2136）→ `_skipStepIncrement=true` → truthful lastResult。**非 infra 错误到达即清零 infraFailures**（:1933-1934） |
| 2 连接类错误 | :1937-1949 | `isConnectionError`（core browser 导出的模式表，:2123-2128/:2139-2147）→ 循环 reconnect（固定 1s 间隔）成功即返；耗尽 stopped=true |
| 3 其他 | :1951-1970 | consecutiveFailures+=1；解析类错误加模型名诊断 |

## 4. 消息管理（agent.ts + pipeline.ts）

- **内部信封**：pipeline 持 `Array<{ message: ChatMessage; kind: "state" | "history" | "plain" }>`（Python 的 `_type` 内部键的显式化）；`getAction` 前映射为纯 `ChatMessage[]`（P2 类型，`assertValidMessages` 已有）。
- **state 替换式保留最近 2 份**（step.py:633-663 `_setStateMessage`）：typing 关时回退纯 append(:648-650)；删更老 state(:653-1655)；保留的旧 state **丢图留文**（:656-662）。
- `<agent_history>` 滑窗：`_buildAgentHistoryDescription`（agent.py:599-649）——首条+省略行+最近 N 条；`Step {n}: [{eval}] Goal: {goal} | {action_str} -> {result_str}`；action_str 截 150 字符；N=`_effectiveMaxHistoryItems`（compactor 启用时 min(N,5)，:593-597）。经 `_setHistoryMessage`(:674-687) 每步替换。**格式字节锚定**。
- `_trimMessages`（agent.py:675-698）：默认尾部 20 条；compactor 启用放宽 60；返回前剥信封。
- **MessageCompactor**（message_compactor.py:139 全量）：双门（步间隔+字符数）→ 压成 [first, summary, tail 4]；可配独立压缩 LLM（`structuredCall` 复用）。

## 5. 配套纯件

| 模块 | Python | 契约 |
|---|---|---|
| action_shape.ts | action_shape.py 306 全量 | normalizeModelOutput / normalizeActionsList 策略表 / honestDone 带外标记 / dropUnregisteredActions / describeActionEntry / actionsOf/nameOf/paramsOf。纯函数，锚定 Python 实跑 |
| loop-detector.ts | loop_detector.py 357 全量 | 页面指纹 sha256(dom_text)[:16]；动作哈希按类型归一化 sha256[:12]；窗口 20/5；nudge 阈值 5/8/12+页面停滞≥5；**FailureStreakTracker（阈值 2/4，done 豁免，peek/ack）与 ZeroResultStreakTracker（阈值 2）**。sha256Hex 复用 dom-snapshot 同款实现 |
| actionability.ts | actionability.py 154 全量 | 白名单 {click,input_text,select_dropdown}；isActionable(visible+enabled+receives-events)；wait：deadline+poll+降级不抛 |
| plan-manager.ts | plan_manager.py 91 全量 | plan_update 整替 / currentPlanItem 前进 / replan 与探索 nudge（enablePlanning 默认关） |

## 6. prompts（system_prompt.py，**字节保真**）

- `SYSTEM_PROMPT`（:11-101 分 8 段）+ 条件段 `FILE_UPLOAD_RULES`（:107-122，action_descriptions 含 upload_file 才追加——batch1 不触发，锚定样例用 batch2 动作集生成）/ `DROPDOWN_RULES`（:130-145）/ decision attribution 段（:165-167）。
- `buildSystemPrompt(actionDescriptions, task, enableDecisionAttribution, maxActions)`（:148-168）；构造时与**每步按当前页重算**两个调用点照搬（agent.py:246-251 / step.py:705-709）。
- `buildStateMessage` **17 段顺序**（:171-337）：[Task]→[Task Skill]→[Domain Skill]→[Available Secrets]→[Previous Goal/Evaluation/Memory]→[Previous Action Results]→[Current Plan]→[Current URL/Page Title]→[Page Stats]→[Grid]→[Open Tabs]→[Recent Events]→[Page DOM]→[File Inputs]→[Downloads]→[System Notice]→[Planning Suggestion]。
- `buildStateBlocks`（:340-368）Anthropic blocks 版（文本复用 buildStateMessage + image block）。
- **锚定方法**：`_gen_p4_anchors.py`（`_` 前缀不入库）经 evals venv 实跑上述函数落 fixture（05 §2）；vitest 断言逐字节相等。

## 7. skills（架构 §6.1 双层）

- **`SkillSource` 接口**（README 决策 8）：`loadHostSkill(host): Promise<{sop;selectors;quirks} | null>` / `taskCatalog(hostKey): Promise<TaskCardMeta[]>` / `taskCardText(meta): Promise<string>`。core 不碰 fs；Node 宿主实现读目录（读序与分段格式照搬 loader.py:17-21/:67-106 `[SOP]/[SELECTORS]/[QUIRKS]`；TaskCardMeta.catalogLine 格式 task_loader.py:37-41）。
- **task_matcher**（task_matcher.py 270 全量）：system/user prompt（:21-77，两轴规则：ENTITY=参数永不拒绝；TEMPLATE=三族全同）+ 输出 schema（:79-110）**字节锚定**；置信 high/medium 过，low/缺失降档(:254-263)；`buildTaskSkillText` 三段头（:113-138）字节锚定；匹配走 `llm.structuredCall`，失败重试 1 次，任何失败=不注入(:192-270)。
- 注入点：任务级 run() 一次（agent.py:302-312）；站点级每步（step.py:419-423）。口径 B/C 开关 = AgentSettings.enableSkillInjection / enableTaskSkillInjection（**TreeChrome 默认开任务级注入与评测默认关的差异经配置表达**，架构 §6.1）。

## 8. judge（judge.py 266 全量）

system prompt（:25-56，不信自评/URL+Page excerpt 交叉验证/impossible+captcha 字段）与 tool schema（tool 名同为 `agent_response`，:59-88）**字节锚定**；`judge()` 两轮尝试（`structuredCall` 底座 + 60s 级超时语义照搬 :100-147）；trace 序列化保留全部步、done 步带 Page excerpt、尾部截断 40000 字符(:149-171)；verdict 写入最后一步 done result 的 `judgement` 字段（agent.py:437-458）。done(success) 才跑（run 外层 :357-360）；JudgeSettings 独立模型/开关。

## 9. sensitive 接线与 thinking 槽位（P2 遗留决策）

- **sensitive**：Agent 构造把 `sensitiveData`（Record<占位符,真值>）灌入 llm（Python agent.py:184 写 `llm._sensitive_map`）。P4 核对 P2 `LLMClient` 的注入面：构造配置已有则直用；缺 setter 则补 `setSensitiveMap(map)`（getAction 的替换/还原 P2 已实现，仅需入口）。**敏感描述进 [Available Secrets] 段**（system_prompt :213-214）与决策日志脱敏（`_SENSITIVE_ACTION_FIELDS` views.py + redactSensitiveString）照搬。
- **thinking signature canonical slot（P2 轮终局遗留）**：定案——signature 挂在 `ToolCall.signature`（P2 types.ts:68-72 已有，gemini thoughtSignature 形态）随 assistant 消息**原样回放**；step 层构造 assistant 消息时必须保留 getAction 返回的 toolCalls 数组引用（不得重建/裁剪字段）；thinking 文本不回放（ChatResponse.reasoningText 仅观测，P2 语义）。Anthropic thinking 块的 drop-with-warning 留在适配器层（P2 现状即终局），不再上移。

## 10. 有意偏离清单

| # | 偏离 | 理由 |
|---|---|---|
| 1 | 信封数组显式化 `_type` 内部键 | 类型安全；getAction 前剥离，wire 形态不变 |
| 2 | SIGINT/stdin 交互不移植，stop/pause/resume 为纯 API | 宿主职责（README §3） |
| 3 | rerun/RerunMixin/variable_detector 不移植 | M6 重放功能；StepPipeline 无依赖 |
| 4 | 截图落盘/skill 目录读经可选注入（FS/SkillSource），未注入降级不抛 | 核心包禁 ambient |
| 5 | obs 订阅装配（metrics/recorder）不移植；EventBus 发射点保留 | recorder M7；事件类型先就位 |
| 6 | log_formatter 的 ANSI 彩色输出 → 注入 logger 的结构化字段 | 宿主自渲染 |
| 7 | settings 不读 env；rerun_*/exploration_* 字段族不入 AgentSettings | 铁律 2 / 重放不移植 |
| 8 | done 门禁/退避/阈值等常量集中 `agent/constants.ts`（散落 Python 模块顶部的 :68-69/:2135-2138/:2234-2238 收拢） | 等价重组，数值逐一对照 |
