# 03 · 测试策略与 P1.6 真机对拍

> 纪律前提：单测不发真网络请求。**全部真机验证收敛到一个手动 smoke 脚本**（§3）——这是对总纲 3.1「对本地 Chrome 的单测（9222，task 级 integration，标记 slow）」的**计划修订**：vitest 集成用例会引入环境依赖（本机必须开着 9222 Chrome）与 CI 假绿面（skip 条件写错即静默全过），单入口 smoke 与 P2 `llm-smoke.mjs` 的先例一致。覆盖率 ≥85% 由 vitest 阈值强制（全 mock 可达）。

## 1. FakeWebSocket 注入面

`socketFactory` 注入的假套接字实现标准 `WebSocket` 消费面（`addEventListener("open"|"message"|"close"|"error")` / `send` / `close`），提供：

- **帧捕获**：`sentFrames` 数组（信封断言的依据——contract 测试锁 wire 形态）；
- **脚本化响应**：按 `id` 或 `method` 匹配的响应队列（`respond(method, result)` / `fail(method, {code, message})`）；
- **事件注入**：`emit(method, params, sessionId)`（测事件分发）；
- **连接行为**：`openOnConnect`（缺省 true）/ `failHandshake`（测 connect reject 与旧 ws_url 404 形态）/ `serverClose(code)`（测 pending reject + onClosed）；
- **坏帧**：`emitRaw(text)` 直接灌非 JSON 文本（测泵加固，01 §3 语义 8）。

`discoverWebSocketUrl` 用注入 `fetch` mock（200 带字段 / 非 200 / 无字段 / 网络 reject 四形态）。

## 2. 单测覆盖矩阵

### transport.test.ts（01 §3 十条语义逐条锚定）

| 组 | 用例 |
|---|---|
| 信封 | id 从 1 自增；params 缺省 `{}`；sessionId 真值才携带（`null`/`undefined` 均不发该键）；method/params 透传不改动 |
| 路由 | result resolve；error → `CdpCommandError{code, method, rawMessage}`；迟到响应警告不崩；并发 3 个 in-flight 交叉响应各自归位 |
| 生命周期 | connect 握手失败 reject（文案含 rediscover 引导）；stop 后 send 抛；stop 幂等；stop 时 in-flight reject `CdpConnectionClosedError` |
| 泵 | 服务端 close → pending 全 reject + onClosed 触发；坏帧 log+跳过后续帧照常；未预期形态警告 |
| 事件 | 多监听器都收到 `(params, sessionId)`；无监听器静默；监听器抛异常不影响其他监听器与泵；disposer 生效；sessionId 缺省传 `undefined` |
| 超时 | timeoutMs 到点 reject `CdpTimeoutError`；迟到响应落警告；缺省无超时（FakeClock 不推进也 resolve） |

### discovery.test.ts

四形态（§1）；`webSocketDebuggerUrl` 字段提取；错误文案含 host:port。

### session-primitives.test.ts（02 逐条锚定）

| 组 | 用例 |
|---|---|
| attach | 首 page target 选中 + flatten attach；无 page target 抛（文案锚定）；非 page 类型（iframe/browser）过滤 |
| navigate | 成功透传；`errorText` → `CdpNavigationError`（errorText 原文）；transitionType 键值锚定 |
| getTabs | page 过滤；url/title 缺省空串；错误透传（**不吞**，02 偏离 1） |
| switchTab | activate→attach 两命令序列 + 新 sessionId 返回 |
| cookie | url 三来源（显式 url / domain 拼 / localhost 兜底）；sameSite 未知值→Lax；expires ≤0 不发；success:false 不计数但继续；坏结构（非对象/无 cookies）抛；origins 忽略；返回计数 |

### contract.test.ts

`CdpWsClient` 赋值给 `CdpLikeClient` 类型的编译期断言（devDep `@tw/dom-snapshot`）；信封 wire 快照（首条命令的完整 JSON 文本比对——锁 `{id, method, params, sessionId}` 的键序无关但键集精确）。

## 3. P1.6 真机对拍 smoke（tools/page-parity-smoke.mjs）

### 3.1 流程（对齐 gen_fixtures.py 的形态）

```
node packages/cdp-ws/tools/page-parity-smoke.mjs --url <u> [--url ...]
  [--ws-url ws://…] [--wait 2.5] [--out _tmp/parity]

无 --ws-url 时自拉 headless Chrome（gen_fixtures.py:180-199 同参数形态：
  --remote-debugging-port=9224 --user-data-dir=<临时目录> --headless=new
  --no-first-run about:blank），结束即杀。

对每个 URL（背靠背、同会话）：
  ① Python 侧：subprocess 调 evals venv 的 gen_fixtures.py --ws-url <同ws> --out <tmp/py>
     （AGENTS.md 验收命令节的 venv 绝对路径；Python 侧 navigate→sleep(wait)→build_dom_state）
  ② TS 侧：discoverWebSocketUrl/直连 → CdpPageSession.attachFirstPageTarget →
     navigate(url) → sleep(wait) → dom-snapshot buildDomState(client, sessionId)
  ③ 对拍 ②产物 vs ① fixture 的 output（fixture 形态 gen_fixtures.py:134-146）
```

### 3.2 对拍口径（与 P1.5 golden 端到端同宽）

- `element_tree_text` **逐字节相等**（复用 dom-snapshot `test/golden-fixture.ts` 的 `expectByteEqual`；若该模块携 vitest 依赖不可移植，smoke 内置等价比较并在完成记录登记）；
- `selector_map` 八字段投影全等（backend_node_id/node_name/node_value/attributes/is_visible/is_scrollable/has_js_click_listener/xpath）；
- `file_input_backend_ids` / `file_inputs_meta` / `page_stats` 全等；
- `metrics`：degradationLevel / source_statuses / element_count 全等（对齐 P1.5 的 metrics parity）。

### 3.3 动态漂移处置

同页两次抓取（Python 先、TS 后）间隔秒级，动态内容（时间戳/轮播/推荐位）会造成假红：每页失败时**重抓一轮**（Python+TS 都重跑，新 fixture 对拍），两轮皆红才算真失败。验收页选静态稳定页（如 example.com/example.org/文档站），至少 3 个；`--url` 任意给，动态页失败输出差异首行供人工判断。

### 3.4 验收（总纲 §P1.6）

≥3 个真实页面对拍全绿 + 输出贴回本目录 README §6 完成记录（P2 smoke 先例）。smoke 本身**不进 CI、不进覆盖率**；退出码非 0 即失败（llm-smoke.mjs 的 exitCode 模式）。

### 3.5 附带验证点（顺路核验的风险项）

- README 风险 1：至少一页为重型真实页面（长列表/文档站），验证 undici WebSocket 大帧不截断（captureSnapshot 响应 MB 级）；
- README 风险 2：自拉起时 discovery 用 `localhost:9224` 而非 `127.0.0.1`（Host 校验）；
- README 风险 6：跑一次 dom-snapshot 全量测试，确认 `runCdpBatch` 对 `CdpCommandError` 的分类不受错误形态替换影响（P1 的 FakeCdpClient 抛原生 Error，形态面不同）。
