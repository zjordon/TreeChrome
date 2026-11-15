# issue #31：扩展 mcp-bridge M1——回环桥 + 配对 + 任务级供给面

> 分支 `feat/issue-31-mcp-bridge`（自 main @19c144f）。issue：
> https://github.com/zjordon/TreeChrome/issues/31（四决策点已拍板：独立包 / 最小三件 /
> CLI URL 配对 / TC_BRIDGE_PORT=18730；**决策点 2 修订（2026-11-15，#31 评论）：
> 最小三件 → 三件 + watch_task 长观察**）。参照实现：qz-browser-agent @572267c
> （Apache-2.0，模式移植注明出处）。**状态：实施计划待人工审核——未过审不写实现代码。**

## 0. 目标与非目标

**目标**：编码 agent（Claude Code 等）经本地 MCP 桥驱动**用户日常 Chrome**——任务级
run 委派给扩展内 agent 循环（登录态可用、免 --remote-debugging-port、确认卡照常出
sidepanel），观察走只读快照（`get_snapshot` 轮询或 `watch_task` 长观察——qz 同款
挂起至终态 + progress 过程流）。

**非目标**（#31 已拍板，决策点 2 修订后）：会话级直驱 15 动词（#32）；steering 与
表单问答（send_message/respond_to_user_input——依赖 core waiting_user 语义）；
远程附件上传；多浏览器注册表；sidepanel 连接状态 UI；自包含 dist 产品化。

## 1. 总体设计

```
Claude Code ──MCP Streamable HTTP──▶ 桥（127.0.0.1:18730，独立包 @tw/mcp-bridge）
                                        │ /mcp（无 Origin 请求才放行）
                                        │ /v1/tc/pair|poll|result|disconnect（仅扩展 Origin）
                                        ▼
                       扩展 SW bridge-runtime（fetch 长轮询 25s + alarms 0.5min 兜底）
                                        │ dispatch
                                        ▼
                       bridge-gateway → RunManager（单飞互斥）/ journal 只读投影
```

- **无 WebSocket**（qz 实证路线）：长轮询超时 25s < SW 30s 空闲窗（事件节律自持活），
  空闲期命令拾取延迟 ≤30s（alarm 唤醒）。
- **manifest 零改动**：fetch 127.0.0.1 由既有 `<all_urls>` host_permissions 覆盖；
  alarms 权限已有。

## 2. 桥服务（新包 `packages/mcp-bridge`，@tw/mcp-bridge）

**文件**：`package.json`（bin `tc-bridge`；runtime dep `@modelcontextprotocol/sdk`
1.x——本包专属，核心包零改动）+ `bin/tc-bridge.mjs`（薄壳，esbuild 运行时装载 TS——
对齐 node-host `bin/tc.mjs` 先例）+ `src/`：

| 文件 | 职责 |
|---|---|
| `server.ts` | node:http 路由：Host 头白名单（421）/ Origin 双门禁（/mcp 拒一切 Origin；/v1/* 仅 `chrome-extension://<32位>` + CORS 回声）/ `GET /health` / `GET /tc-connect`（内置 HTML，CSP 收口）/ `POST /mcp`（SDK StreamableHTTPServerTransport，会话 idle 30min 回收，断连转 MCP cancelled）/ `/v1/tc/*` 私线 |
| `state.ts` | BridgeState：配对表（单扩展先到先得）、请求队列、poll 长轮询挂起/唤醒、180s 缺省超时、instanceId（进程身份） |
| `tools.ts` | MCP 工具目录（5 件，见 §4）+ 入队桥接 |
| `watch.ts` | watch_task 观察循环：入队 get_snapshot → 终态判定 → progress 通知（progressToken 存在时）；超时/取消只撤观察不触 run |
| `connect-page.ts` | 配对页 HTML 常量 |
| `cli.ts` | `tc-bridge serve / connect / status` |

**配对流程**（安全语义：用户在浏览器内显式确认 + 令牌双向核验）：

1. `tc-bridge connect` 生成一次性 bridgeToken（10min TTL）→ 打印
   `http://127.0.0.1:18730/tc-connect?t=<bridgeToken>`；
2. 用户在装扩展的浏览器打开 → 页面按钮「允许 TreeChrome 扩展连接」→ 同源 POST
   confirm → 桥置 `pendingPairing`（t 已确认）；
3. 扩展 runtime 探测 `/health` 见 `pendingPairing` → POST `/v1/tc/pair`
   {t, extensionId, pairingToken(扩展生成)} → 桥校验 t 已确认 → 落配对；
4. 凭据落点：扩展 `chrome.storage.local`（键 `tc_bridge`）+ 桥 `~/.tc/bridge.json`
   （桥重启免再确认——扩展带原 token re-pair 即通过；instanceId 变更触发
   BRIDGE_INSTANCE_CHANGED 重连）。

**accepted 边界**（对齐 qz）：/mcp 面无令牌——回环 + 无 Origin + Host 校验即边界
（本机任意进程可驱动；与 tc daemon :9780 同级信任模型）。pairingToken 防**冒充桥**
骗扩展，不防本机进程。

## 3. 扩展侧（apps/extension）

| 文件 | 职责 |
|---|---|
| `src/runtime/bridge-runtime.ts` | 轮询状态机（disabled/connecting/connected/reconnecting/paused，落 `tc_bridge` 键，SW 冷启动恢复）；未配对→每 2s 探 /health；配对→poll 领批（≤4）逐条 dispatch、结果回投；`BRIDGE_POLL_ALARM`（0.5min）兜底唤醒；**默认 enabled**（无 UI；paused 由 alarm 唤醒自动重试一轮——桥不在时回环失败成本可忽略） |
| `src/runtime/bridge-gateway.ts` | 命令面 dispatch 表（§4 三件实现）：调 RunManager / journal 投影；abort 传播（桥下发 cancel_request → AbortController） |
| `src/host/chrome-apis.ts` | 增 `StorageOnChangedApi`（配置热更新）注入面；runtime 层零 chrome 依赖照旧 |
| `entrypoints/background.ts` | boot 同步段挂载：alarm/storage 监听器注册先于首个 await（MV3 纪律，挂载点在 distill 监听注册同段）；runtime 构造在 runManager 之后（gateway 依赖它） |

**wire 类型落点**：`packages/protocol/src/bridge-wire.ts`（纯类型：pair/poll/result
信封、命令请求/结果、状态枚举）——protocol 保持零运行时，两侧各自防御收窄（扩展
惯例已如此）。

## 4. MCP 工具面（5 件）

| 工具 | 入参 | 出参/语义 |
|---|---|---|
| `tc_bridge_status` | – | 桥版本/配对态/连接态/队列深度（诊断件，计划新增） |
| `run_task` | `task: string` | **异步受理**：{accepted, runId}；已在跑→busy 错误码（run 分钟级，不等终态） |
| `get_snapshot` | – | journal 只读投影，camelCase 对齐 tc run 口径：runId/status/isDone/isSuccessful/finalResult/stopReason/nSteps/errors/lastUrl + 时间线尾部摘要；**只读、从不重发** |
| `watch_task` | `runId?, waitTimeoutSeconds?, stream?` | 挂起至终态返回完整快照；stream 时逐事件发 MCP progress 通知；**只读观察边界**——超时/取消只结束本地观察、绝不杀 run（决策点 2 修订新增） |
| `stop_run` | – | ControlResult |

**SW 内锚点**（已核实）：`RunManager.control()`（sidepanel 停止钮同路径，start/stop
经 `UiControlMessage` 语义复用）、`RunManager.hello()`（runId + RunJournalSnapshot
投影源）、单飞互斥/绑活动 tab/确认卡 fail-closed 均为既有语义不改。M1 `run_task`
只收 task 文本（maxSteps 等护栏走扩展设置，留 #32 评估）。

## 5. 安全四件套（验收硬指标）

非扩展 Origin 打 /v1/* → 403；任意 Origin 打 /mcp → 403；Host 头非
`127.0.0.1:<port>`/`localhost:<port>` → 421；未配对（无 pairingToken）poll → 拒。

## 6. 阶段计划（每阶段末 typecheck + 相关包 test 全绿）

- **P0** 包骨架 + `@tw/protocol` wire 类型 + server 路由骨架（/health + Host/Origin
  门禁）+ 单测（门禁四件套）
- **P1** pair/poll/result/disconnect 私线 + 队列/租约/超时 + connect 页 + cli 三命令
  + 单测（假扩展回环，fake timers）
- **P2** MCP 面：SDK 接入 + 5 工具（含 watch_task 观察循环与 progress 通知）+ 会话回收 + cancelled 传播 + 单测
- **P3** 扩展 bridge-runtime（状态机/轮询/alarm/storage 热更新）+ 单测（fake
  fetch/alarms 注入）
- **P4** bridge-gateway 三命令 + background 挂载 + 单测（fake RunManager/journal）
- **P5** e2e `smoke-bridge.mjs`（lib-harness 起 headless+扩展 → 子进程起真桥 → CDP
  唤醒 SW → 配对 → MCP JSON-RPC 调 run_task（mock LLM 剧本，复用 smoke-sw-runtime
  注入先例）→ watch_task 挂起至终态断言（含 progress 通知收讫；get_snapshot 轮询
  路径同测）→ SW 中杀恢复断言）+ 全量门禁收口

规模预估：桥 ~1100-1300 行（含 watch 循环）、扩展 runtime+gateway ~650 行、
protocol 类型 ~120 行、测试 ~1400 行（覆盖 85% 门禁照常）。

## 7. 开放问题（实施中定，不阻塞开工）

1. `run_task` 与 sidepanel start 完全同互斥（是——同一 RunManager 单飞）；run 期间
   sidepanel 时间线照常同源可见（验收句已含）。
2. 桥 `~/.tc/bridge.json` 与 daemon 的 `~/.tc/daemon/` 并存——目录布局实施时统一。
3. e2e 里 SW 内 storage 读取（拿 pairingToken）走 CDP Runtime.evaluate（lib-harness
   既有能力）。

## 8. 实施记录

- **P5（2026-11-15）**：e2e `smoke-bridge.mjs` 全链 PASS（连跑两次稳定）——真桥子
  进程（--pairing-path 临时目录）→ headless Chrome + 扩展 → **配对真链路**（admin
  签发 → tabs.onUpdated 捕获 connect URL 的 t → 扩展 Origin 私线 pair，零注入）→
  MCP initialize → run_task（mock LLM 三步剧本，真实索引 click）→ watch_task 终态
  done + progress 通知 → fixture 点击副作用 → **场景 2：run#2 首个 LLM 请求 mock
  挂起（journal running 200ms 防抖落盘）→ 杀 SW target → alarm 唤醒 → runtime
  恢复轮询 → get_snapshot 返回 interrupted + 正确 runId**。cli 增 `--pairing-path`；
  轮询周期 25s→5s。**四条 e2e 实证教训（均已代码修复并测试锚定）**：
  1. SW 的 `fetch` 与 chrome API 同样 receiver 敏感——裸传丢 this 报 Illegal
     invocation（箭头函数包裹，e2e 探针实证）；
  2. chrome.storage 回读把对象键**按字母序重排**——插入序比对使每次自身写盘都
     误判外部变更触发假性热重启（revoke 杀在途 poll）→ 递归 canonical 比较
     （canonicalConfigJson，回声用例锚定）；
  3. **25s 长轮询的在途 fetch 不维持 SW 生命期**——挂起后响应写进死连接、携带
     命令的批次直接丢失（命令已出队成孤儿）→ 5s 短轮询（响应必落事件后 30s
     存活窗内；run 起跑后由 chrome.debugger 事件流自持——keepalive.ts 主通道）；
  4. mock 剧本构造：judge 调用**也带 tools**（挂起判定必须按任务文本精确匹配，
     否则误伤 run#1 的 judge）；杀 SW 前需确保 journal 已落盘（awaiting 态立即
     flush / running 态 200ms 防抖——mock 挂起比卡计数可靠）。
  门禁：全仓 typecheck + test 全绿（mcp-bridge 74 / extension 190 / node-host 172 /
  cdp-chrome 37 / console-ui 75 / protocol 3 + core / dom-snapshot），覆盖率全过
  85 阈值；biome 零新增告警（sidepanel-app.tsx 一条先在告警未动）。
- **P4（2026-11-15）**：命令面与 SW 挂载——「MCP → 桥 → 扩展 → 日常 Chrome」全链
  打通。`src/runtime/bridge-gateway.ts`：run_task 复用 `RunManager.control("start")`
  单飞互斥（前置非终态 → RUN_IN_PROGRESS，control 拒绝 → RUN_START_FAILED）；
  get_snapshot = journal 只读投影（camelCase 终态口径，lastUrl 暂 null——journal 无
  该聚合，M1 登记 #32 评估；时间线尾 5 条、摘要 160 字符截断）；stop_run =
  control("stop")（无活动 → NO_ACTIVE_RUN）。`background.ts` boot 同步段挂
  BridgeRuntime（tabs/storage/alarms 监听器在首个 await 前注册——MV3 纪律）。
  10 用例（受理/互斥/拒绝映射/投影/截断/awaiting 透传/stop）；扩展包 188/188 全绿，
  覆盖率 stmts 96.53 / branch 85.25。
- **P3（2026-11-15）**：扩展侧 runtime 落成。`src/runtime/bridge-runtime.ts`
  （~530 行，零 chrome 依赖全注入）：状态机 connecting/connected/reconnecting/paused
  （落 `tc_bridge` 键、SW 冷启动恢复、paused 冷启动即重置预算）；长轮询 25s 事件节律
  自持活 + `BRIDGE_POLL_ALARM` 0.5min 兜底（paused 自愈——M1 无 UI 拍板）；配对三路
  ——tabs.onUpdated 捕获 connect URL 的 t / 冷启动 tabs 扫描补捕获 / 落盘 token
  re-pair（t 空）；poll 409（PAIRING_REQUIRED/INSTANCE_CHANGED）自动回探活层；
  cancel_request → AbortController 中止在途 dispatch；未知动词白名单丢弃；
  自身写入回声忽略（lastWritten 比对）防 storage 热更新自触发循环。
  `chrome-apis.ts` 增 StorageOnChangedApi/TabsOnUpdatedApi/chromeRuntimeId +
  TabsQueryApi.url + AlarmsApi.onAlarm.removeListener。19 用例（配对三路/轮询回投/
  cancel/409 回探/预算→paused→alarm 自愈/热更新禁用/回声/stop/边界错误面/纯函数）；
  扩展包 178 用例全绿，覆盖率 stmts 96.43 / branch 85.24（包阈值过线）。
  遗留：sidepanel-app.tsx 一个**先在**的 unused import 告警（非本分支引入，未动）。
- **P2（2026-11-15）**：MCP 面落成（`@modelcontextprotocol/sdk` ^1.32，esbuild 打包验证
  可跑）。`src/tools.ts` 5 工具（tc_bridge_status/run_task/get_snapshot/watch_task/
  stop_run；未配对快速失败、参数校验、错误信封带 code）+ `src/watch.ts` 观察循环
  （首拍全量/后续 seq 增量、TASK_CHANGED、超时带 lastSnapshot、只读边界）；
  `server.ts` 接线 /mcp——StreamableHTTP 会话簿（initialize 建会话/mcp-session-id）、
  idle 30min 回收、**断连把标准 cancelled 注入 transport → SDK 中止工具 signal →
  桥向扩展下发 cancel_request**、关停给在途响应 1s 出口。CLI 透传包版本至
  serverInfo。74 用例（含 InMemoryTransport 全链、HTTP 面真 initialize/tools-call/
  断连取消传播、DELETE 会话）；覆盖率 stmts 97.43 / branch 87.79 / funcs 96.1；
  **真 bin 冒烟通过**（serve → initialize → tools/list 五工具，SSE 容忍解析）。
  实测教训：SDK Streamable HTTP 的 POST 响应是 SSE 流——响应头先到，fetch 已
  resolve，abort 只掐流不断 promise（测试断言按此写）。
- **P1（2026-11-15）**：私线 + 配对 + CLI 全链落成。`src/state.ts` BridgeState——
  配对状态机（一次性邀请 t、re-pair 凭落盘 token 免再确认、单扩展先到先得
  BRIDGE_CLIENT_IN_USE）、命令队列（长轮询领取/结果回投/180s 超时/中断即
  cancel_request）；`src/server.ts` 接线 /admin/pairing（反 Origin 门）、/tc-connect
  配对页（CSP 收口）+ /tc-connect/state（同源进度面——同源 GET 浏览器不发 Origin，
  门禁放行空 Origin）、/v1/tc/{pair,poll,result,disconnect}；`src/cli.ts` +
  `boot.mjs` + `bin/tc-bridge.mjs`（esbuild 运行时引导，对齐 node-host 先例）。
  ocr include 增 packages/*/bin/*.mjs 与 boot.mjs。**真 bin 冒烟通过**（usage exit 2
  → serve 起停 → status 拉 health）。53 用例（state 17/server 22/cli 14），覆盖率
  stmts 98.69 / branch 86.85 / funcs 98.03；typecheck + biome 零告警。测试侧教训：
  fake timers 下 reject 断言必须先行附加；同源 GET 不带 Origin 是浏览器事实。
- **P0（2026-11-15）**：`packages/mcp-bridge` 骨架落成。`src/server.ts` 门禁链定死
  （Host 白名单 421 → Origin 双门禁 403 → OPTIONS/health → POST content-type 415 →
  404 接线位）+ `listeningPort` 防御抽出可测；`@tw/protocol` 新增 `bridge-wire.ts`
  13 个 wire 类型（type-only，protocol 保持零运行时）。11 用例全绿（门禁四件套 +
  500 兜底 + Origin 形态 + listen 地址防御），覆盖率 stmts 98.26% / branch 85.71% /
  funcs 100%；typecheck + biome 通过；`pnpm install` 已注册新包（lockfile 更新待入库）。


## 9. 评审记录

（/review-loop 轮次登记——待实施完成后）
