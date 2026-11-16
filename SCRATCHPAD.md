# issue #32：扩展 mcp-bridge M2——会话级直驱（15 动词过桥 + epoch 失效 + 在场策略）

> 分支 `feat/issue-32-mcp-bridge-m2`（自 main @cd13239）。issue：
> https://github.com/zjordon/TreeChrome/issues/32（**四决策点已拍板**，2026-11-15
> 评论 issuecomment-6894177493：① epoch 失效 ② sidepanel 在场放行+审计
> ③ verb 规格补缺进 core ④ upload 路径模式）。前置 #31 已合并（桥/私线/runtime
> 垫好）。参照实现：node-host daemon #27（session-holder 同构体）。
> **状态：实施计划待人工审核——未过审不写实现代码。**

## 0. 目标与非目标

**目标**：调用方 LLM（Claude Code 等）经 MCP **会话级逐步直驱**日常 Chrome——
15 动词与 tc daemon 同源同参（get_state 键 elementTreeText），跨调用保 tab；
SW 会死的事实以 epoch 失效显式暴露（index 动作 EPOCH_STALE → 重 get_state）；
全部动作受 sidepanel 在场门 + 审计覆盖。

**非目标**：任务级 run 面任何改动（M1 确认卡语义不变）；daemon 侧改动（CLI
解析层原地不动）；多浏览器/多会话并发；steering 与表单问答；upload 分块暂存
（路径态零传输无需）；审计查看 UI。

## 1. 总体设计

```
MCP 客户端 ──/mcp──▶ 桥（16 新工具：15 动词 + session_stop）
                        │ enqueue drive{verb,params,epoch?}（index 类自动附 epoch）
                        ▼ /v1/tc 私线（M1 既有）
              扩展 SW bridge-runtime ──▶ drive-gateway
                        │ 在场门+审计 → epoch 校验 → run 互斥 → core 调用表
                        ▼
              drive-session：惰性单例 BrowserSession+Tools
              （chrome.debugger transport + keepalive hold + idle 15min 回收 + epoch）
```

- **epoch 簿记在桥侧**（每 MCP 会话记 lastObservedEpoch，drive 响应信封携带
  epoch 更新；index 类动词发送时自动附带）——调用方零新参数，15 工具 schema
  与 daemon 契约完全同形（决策点 ③ 的形态目标）。不符 → EPOCH_STALE 信封 +
  「重 get_state」提示。epoch 只捕捉会话重建（SW 死/空闲回收）；同代次内
  并发 get_state 换 map 的索引过期仍由「先 get_state」纪律覆盖（与 daemon
  同语义，文档注明）。
- **单飞互斥延伸**：run 活动期 drive → BUSY；drive 会话活动期 run_task →
  DRIVE_SESSION_ACTIVE（两种供给形态共享同一台 Chrome 的 debugger 附着）。
- **在场门 + 审计**（决策点 ②）：drive-gateway 逐动词经 core
  `resolveCapability` 分类——只读放行；写类须 Port 在场
  （`portServer.isConnected()` 注入），否则 SIDEPANEL_REQUIRED；全部动词
  审计留痕（会话 EventBus → console + chrome.storage 环形缓冲 200 条）。

## 2. 扩展侧（apps/extension）

| 文件 | 职责 |
|---|---|
| `src/runtime/drive-session.ts`（新） | SW 会话持有同构体：lazy `BrowserSession`+`Tools`（transportFactory=debugger-api 既有工厂）；首动词绑活动可驱动 tab（run-manager 同款挑选）；keepalive hold/release（既有）；idle 15min alarm 检查回收（stop+release+epoch+1，SW 冷启同效）；`sessionStop()` 幂等 |
| `src/runtime/drive-gateway.ts`（新） | drive 派发：core 调用表（`Tools.execute` / `browser.getState`/`getTabs`）；epoch 校验（index 类无 lastEpoch → INDEX_REQUIRES_STATE；不符 → EPOCH_STALE）；在场门+审计；run 互斥两方向 |
| `src/runtime/bridge-runtime.ts` | `COMMAND_METHODS` 增 `drive`/`session_stop`；dispatch 分流到 drive-gateway |
| `src/runtime/port-server.ts` | 增 `isConnected()` 公共查询（在场门注入面，~5 行） |
| `entrypoints/background.ts` | boot 装配 drive-session/gateway（runManager 之后，注入 bridge runtime deps） |

## 3. 桥侧与共享面

- **core 补缺**（决策点 ③）：`packages/core/src/tools/verb-specs.ts`——浏览器级
  动词 `get_state`/`tabs` 规格（go_back/switch_tab/close_tab/navigate 等已是
  Tools 动作，规格单源 = models.ts `ACTION_DEFINITIONS` 既有）+ 15 动词全表
  常量导出（纯数据+校验，平台无关不违铁律）。**架构文档登记**非 TreeWalker
  移植来源的新导出面（docs/architecture.md 一笔）。
- **桥 `src/verbs.ts`**（新）：core specs → MCP inputSchema 生成器（参数名
  kebab→camel、required、类型映射）+ 15 工具目录 + `session_stop`；index 类
  动词（click/input_text/select_dropdown/upload_file/scroll——按规格含 index
  目标者）发送前附 lastEpoch。
- `state.ts`/`tools.ts`：enqueue 新命令 `drive`/`session_stop`；`McpSession`
  增 lastObservedEpoch（drive 响应信封更新）。
- `@tw/protocol/src/bridge-wire.ts`：`BridgeDriveCommand{verb,params,epoch?}`、
  响应信封 `{ok,result|error,epoch}`、`BridgeCommandMethod` 扩展（纯类型）。

## 4. MCP 工具面（16 件新增，总数 5+16=21）

15 动词同名工具（get_state/navigate/click/input_text/select_dropdown/scroll/
find_text/read_grid/evaluate/screenshot/upload_file/go_back/tabs/switch_tab/
close_tab）+ `session_stop`。`upload_file` 收 `path`（决策点 ④：
`DOM.setFileInputFiles` 由 Chrome 读盘，大文件零传输；不设白名单；审计记
完整绝对路径）。错误信封带 code：`EPOCH_STALE` / `SIDEPANEL_REQUIRED` /
`BUSY` / `DRIVE_SESSION_ACTIVE` / `INDEX_REQUIRES_STATE` / 动词参数校验错。

## 5. 验收硬指标

无 sidepanel 连接时写类动词 → SIDEPANEL_REQUIRED（只读照常可用）；SW 杀 →
index 动作 EPOCH_STALE → 重 get_state 恢复，只读跨代次可用；run 与 drive
互斥两方向成立；upload 审计含全路径；/mcp 信任模型与 M1 拍板一致不变。

## 6. 阶段计划（每阶段末 typecheck + 相关包 test 全绿）

- **P0** wire 类型（drive/session_stop + 信封）+ core verb-specs + 架构文档
  登记 + 单测（规格表/校验）
- **P1** 扩展 drive-session（假 transport 单测：lazy 装配/tab 绑定/hold/idle
  回收/epoch 递增/sessionStop 幂等）
- **P2** drive-gateway + runtime 接线 + port-server isConnected + 单测
  （派发表/epoch 三态/在场门正反/审计落痕/互斥两向/动词校验错映射）
- **P3** 桥 verbs 面 + epoch 簿记 + 单测（InMemoryTransport 全链 + HTTP 面
  schema 生成快照锚定）
- **P4** e2e `smoke-drive.mjs`：配对 → 直驱 navigate/get_state/click 副作用 →
  在场门反例（关 sidepanel 页）→ 杀 SW → EPOCH_STALE → 恢复 → upload 路径态
  一例（仓库内小文件）
- **P5** 全仓门禁收口 + e2e 连跑两次

规模预估：实现 ~1200-1400 行 + 测试 ~800（core ~120 / 扩展 ~550 / 桥 ~350 /
e2e ~300）。

## 7. 开放问题（实施中定，不阻塞）

1. scroll 是否 index 类——按 verb 规格参数定（含 index 目标形态则纳入）。
2. drive 首动词绑 tab 的挑选与 run-manager 复用面（抽小函数或就地下 10 行）。
3. 审计环形缓冲 key 与淘汰策略（`tc_driveAudit`，200 条 FIFO）。
4. e2e 在场门反例构造：CDP 关 sidepanel 页后 Port 断开的判定时机（宽限 2s）。

## 8. 实施记录

- **P0（2026-11-15）**：wire 类型 + core 动词面落成。`@tw/protocol` bridge-wire 增
  drive 面（`BridgeCommandMethod` 扩 drive/session_stop；`BridgeDriveParams{verb,
  args, epoch?}`、`BridgeDriveOk/Error` 信封恒携 epoch、`BridgeSessionStopResult`）。
  `core/src/tools/verb-specs.ts`（~250 行）：15 动词宿主中立表 `DRIVE_VERBS`
  （tool/browser 双派发、snake_case 参数/必填/XOR、locator 标记）+
  `findDriveVerb`/`validateDriveParams`（类型窄校验，空串/str[] 口径对齐 daemon
  buildParams）；core index 导出（非移植来源新面，架构 §3.3 已登记）。**开放问题
  1 定案：scroll 非 locator（只 direction/amount）——locator 类恰四件 click/
  input_text/select_dropdown/upload_file（element_id 同属 map 定位）**。node-host
  增 verb-parity 锚定测试（DAEMON_VERBS ↔ DRIVE_VERBS 逐项一致；invert 是 CLI
  呈现细节不在比对面）。测试 +12（core 9 / node-host parity 3），core 1403 /
  node-host 175 全绿，覆盖率过线；全仓 typecheck 绿。
- **P1（2026-11-15）**：扩展直驱会话持有落成。`src/runtime/drive-session.ts`
  （~200 行，零 chrome 依赖全注入）：惰性单例（并发单飞）——`ensure()` 挑活动
  可驱动 tab → makeCore（BrowserSession+Tools 注入装配）→ start → keepalive
  hold → epoch+1 持久化（`tc_driveEpoch`）→ 空闲计时；死会话（isConnected
  false）ensure 自动收口重建；`stop()` 幂等（stop+release+清计时）；空闲
  15min 回收（idleMs 可注入，检查粒度 ≤60s 且 ≤idle/2）；epoch 持久化单调——
  每次**会话创建** +1，跨 SW 死亡保证桥侧 lastObserved 必失配。**关键事实**：
  cdp-chrome transport 已内建 Target.attachToTarget/closeTarget/activateTarget
  拦截重锚（switch_tab/close_tab 经 core 原样正确——会话不重建，daemon 同构
  成立）。tab 挑选从 run-manager 抽出 `src/runtime/tab-pick.ts` 共享（降级链
  语义逐字不变，run-manager 改调用——开放问题 2 定案：抽共享不复制）。
  测试 +13（drive-session 11 + tab-pick 2：惰性全链/复用/自愈/stop 幂等/并发
  单飞/start 失败/无 tab 两态/epoch 冷启接续/idle 回收+touch 重置+关闭/降级链
  ×2）；扩展包 205 全绿，覆盖率 96.55/85.53；全仓 typecheck 绿。
- **P2（2026-11-15）**：直驱命令面与 SW 挂载——「MCP → 桥 → 扩展 → drive 会话」
  全链打通。`src/runtime/drive-gateway.ts`（~250 行）：gate 链序定死（动词校验→
  BUSY（run 互斥，先查后 ensure 不白附 debugger）→ 在场门（**只读单源 = core
  resolveCapability "none"**，写类 SIDEPANEL_REQUIRED）→ ensure（NO_ACTIVE_TAB
  等透传）→ locator 代次（INDEX_REQUIRES_STATE/EPOCH_STALE 携当前 epoch）→
  core 派发（特殊面直调 browser / 工具动词 tools.execute 走 lastState 线程）→
  响应恒携 epoch）；**领域错走信封值不走 throw**（runtime 兜底会抹成
  TOOL_EXECUTION_FAILED）。审计：createDriveAuditWriter（tc_driveAudit 环形 200
  条、storage 读改写串行链；upload 记 detail.path——决策点 ④）。core verb-specs
  增响应投影三件（DriveActionResultOut/StateOut/TabsOut，daemon 同形；架构
  §3.3 补记）。bridge-gateway 增 isDriveActive → DRIVE_SESSION_ACTIVE（双向互斥
  另一半）；bridge-runtime 白名单 +drive/session_stop；background 装配 DriveSession
  （makeCore=BrowserSession+Tools(fs=OPFS)）+ 按 method 分流 router；在场门 =
  portServerRef.hasPorts 晚绑定（**port-server 已有 hasPorts——计划中的
  isConnected 增量不需要**）。修正：protocol index 点名再导出补 M2 wire 类型
  （P0 漏挂，typecheck 抓回）。测试 +14（gate 全链/链序五态/session_stop 幂等/
  upload 审计/环形缓冲淘汰/runtime 白名单转发/反向互斥）；扩展 219 全绿
  （96.69/85.48），core 1403 全绿，全仓 typecheck 绿。
- **P3（2026-11-16）**：桥侧直驱工具面落成。`src/verbs.ts`：core DRIVE_VERBS
  单源生成 15 动词 MCP 工具（snake→camel 属性名/required/四类型映射；XOR 用
  描述表达）+ session_stop——共 16 件，tools/list 总数 5→21；`tools.ts` 接线：
  camel 入参→snake 派发（未知参数拒绝）、validateDriveParams 信封级双保险、
  **locator 动词自动附桥侧簿记 epoch**（无观察记录本地快速失败
  INDEX_REQUIRES_STATE 不入队）、扩展侧领域错信封（EPOCH_STALE 等）转 MCP
  isError 信封且 epoch 仍簿记（自动愈合面）；`server.ts` McpSession 增
  lastEpoch，createMcpServer 按会话接线 driveEpoch/onDriveEpoch 闭包。
  **依赖变更：@tw/mcp-bridge 增 @tw/core workspace 运行时依赖**（决策点 ③
  单源的必然结果——M1 时桥只依赖 protocol 类型；lockfile 已更新）。
  测试 +10（verbs 4：目录顺序/schema 生成/互转/描述；tools 5：get_state→click
  epoch 自动附/无簿记快速失败/错信封透传+簿记/camel→snake+未知拒绝/session_stop；
  server 1：HTTP 面直驱 epoch 全链）——mcp-bridge 90 全绿（97.35/87.21），
  全仓 typecheck 绿。教训：locator 集合（click/input_text/select_dropdown/
  upload_file）写测试用例时别拿 input_text 当「非 locator」示例（用 evaluate）。
  **P4 待办**：e2e smoke-bridge 的 tools/list 断言 5→21。
- **P4（2026-11-16）**：e2e `smoke-drive.mjs` 全链 PASS（连跑两次稳定）+ M1
  smoke-bridge 回归 PASS（21 工具断言已更新）。链路：真桥子进程 → headless+
  扩展 → 配对真链路 → MCP initialize → tools/list 21 → **在场门反例（无
  sidepanel 的 navigate → SIDEPANEL_REQUIRED）** → 开 sidepanel 后 navigate/
  get_state（真实索引）/click（CLICKED-A-1）→ **upload 路径态（Chrome 读盘 →
  title UP:drive-upload.txt）** → 杀 SW → 45s 唤醒 → **click EPOCH_STALE → 重
  get_state → click CLICKED-A-2** → session_stop。直驱无 LLM——本 smoke 不起
  mock 服务端。**e2e 揪出两个真缺陷（均修复+测试锚定）**：
  1. **SW 死后 debugger 旧附着残留**——Chrome 不随 SW 回收释放本扩展 attach，
     新 SW 重挂报 "Another debugger is already attached"（run 路径同样会踩的
     产品级 bug）。修复：cdp-chrome 工厂 attach 撞 already attached → 强制
     detach 回收残骸 → 重试一次（cdp-chrome +2 用例：回收成功/残骸拿不掉上抛）。
  2. **路径态上传的 fs 校验走错地址空间**——drive Tools 拿 OPFS，OS 路径
     isFile/stat 必 false。修复：`driveUploadFs` 包装（OS 绝对路径 resolve 恒等/
     isFile 放行/stat 非空——校验权交 Chrome 与调用方信任边界；OPFS 路径全量
     委托，screenshot save_path 照常）+3 用例。测试侧教训：DOM.setFileInputFiles
     不保证派发 change 事件——副作用断言用轮询不依赖事件。扩展 222 全绿
  （96.71/85.48）。
- **P5（2026-11-16）**：全仓门禁收口——typecheck 0 / biome 0（仅两条先在告警：
  sidepanel-app.tsx unused import、auto-chrome.test.ts 未用参数，均非本分支
  引入）/ 全包 test 全绿：mcp-bridge 90、extension 222、core 1403、node-host
  175、cdp-chrome 39、dom-snapshot 176+3skip、console-ui 75、cdp-ws 51、
  protocol 3——覆盖率全过 85 阈值。e2e：smoke-drive 连跑两次 PASS +
  smoke-bridge 回归 PASS（P4 已完成）。#32 五阶段（P0-P5）实施完毕。


## 9. 评审记录

- **轮 1（2026-11-16，glm-5.3，17m，全量 main..分支 26 文件）**：3 条意见
  （high 1 / medium 2）**全部采纳**——三条并发正确性缺陷，全部代码级核实成立：
  1. **[P1] run ↔ drive 双向 TOCTOU**（bridge-gateway.ts:80）：bridge-runtime 同批
     命令并发派发下双向门控检查都穿透——run 侧 isDriveActive 只看 active
     （core!==null），ensure 在途数百 ms 为假；drive 侧 BUSY 查 journal 而
     RunManager.starting 同步占位、journal.begin 晚两个 await → 两路先后 attach
     同一 tab 互踢。修复三层：DriveSession 增 `busy`（core!==null ||
     creating!==null）；run_task/drive/session_stop 经 `dispatch-chain.ts` 串行链
     派发（前者 resolve 时状态已可见——get_snapshot 只读保持并发）；
     isDriveActive 改接 busy。
  2. **[P1] ensure/stop 并发不闭合**（drive-session.ts:79）：死会话收口挂在
     browser.stop() 期间 core/creating 双空，并发 ensure 直闯 create() → 双建
     （epoch 跳步/双 attach 互踢/孤儿附着）；session_stop 撞在途 create 空操作
     假报 stopped:false 困住 run_task 15min。修复：「条件 stop+create」整体进
     flight（creating 首个 await 前同步置位）；stop() 先并入在途 flight 再收口；
     session_stop 用 busy 判定 stopped。
  3. **[P2] epoch 持久化失败静默吞掉**（drive-session.ts:155）：原注释「失配方向
     仍是失配」不成立——桥 lastEpoch 由响应信封学得，persist 失败的会话照常以
     E 服务，SW 死后新 SW 冷启载 E-1 再 +1=E → **假匹配**（旧 map 索引点错
     元素）。修复：fail-closed——await persist，失败回滚计数+回收会话+
     SESSION_START_FAILED 上抛（宁不可用不可错点）。
  测试 +8（drive-session 4 / dispatch-chain 3 新文件 / drive-gateway 1），
  扩展 222→230 全绿；双向验证：还原旧实现 5 条新测试恰全红、28 条既有全绿。
  修复提交 `d36b85c`。
- **轮 2（2026-11-16，glm-5.3，8m45s，增量 b45bf23..d36b85c = 修复提交）**：
  **零意见**（range 头核验无误，状态 complete）——循环收敛。累计 2 轮 /
  3 意见全采纳 / 0 驳回；分支 2 提交（b45bf23 实现 + d36b85c 修复）；扩展
  测试 222→230，门禁与覆盖率阈值全绿。
