# 01 · WebSocket transport（CdpWsClient）

> 契约冻结文档。cdp-use `client.py` 是行为基线，本文档的偏离清单（§6）是唯一允许的差异面。架构 §4 `CdpTransport` 的 ws 实现就是本类。

## 1. 定位与满足的契约

`CdpWsClient` 是 cdp-use `CDPClient` 的 TS 对等物：单条 WebSocket 连接上的 flat 协议客户端——一个连接承载所有 session（命令信封带 `sessionId`），不是每 target 一条连接。

必须结构满足两个既有接口（零依赖，靠结构化类型，不 import 对方包）：

```ts
// packages/dom-snapshot/src/protocol.ts:15 —— P1 已冻结
interface CdpLikeClient {
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string | null,
  ): Promise<T>;
}
```

- 架构 §4 `CdpTransport`（签名同上，`sessionId?: string`）。
- **契约锁定方式**：`packages/cdp-ws` 的 devDependencies 加 `@tw/dom-snapshot`（workspace:*），test 里一条类型断言 `const _c: CdpLikeClient = new CdpWsClient(...)`（仅类型层，防漂移）；运行时零 workspace 依赖。

## 2. 公共 API 冻结

```ts
// ── 发现（对齐 TreeWalker config._fetch_ws_url + gen_fixtures.wait_version）──
export async function discoverWebSocketUrl(
  host: string,           // 传 "localhost"（Chrome 端点 Host 校验，README 风险 2）
  port: number,
  deps?: { fetch?: typeof fetch },
): Promise<string>;       // GET http://host:port/json/version → webSocketDebuggerUrl
                          // 非 200 / JSON 无该字段 / 网络失败 → 抛 Error（文案含 host:port）

// ── transport 本体 ──
export interface CdpWsOptions {
  wsUrl: string;                                    // 直接持有（BrowserSession(ws_url=...) 形态）
  socketFactory?: (url: string) => WebSocket;       // 缺省 () => new WebSocket(url)（原生 undici）
  timeoutMs?: number;                               // 缺省 undefined = 无限（§5 分层决策）
  logger?: (message: string) => void;               // 缺省 no-op（对齐 LlmDeps.log 注入模式）
}

export class CdpWsClient {
  static async connect(opts: CdpWsOptions): Promise<CdpWsClient>;
      // await open；握手失败（含 Chrome 重启后旧 url 404 形态）→ reject，
      // 错误文案引导 rediscover（对齐 session.py:1729 自愈提示）
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string | null,
  ): Promise<T>;
  on(
    method: string,
    listener: (params: unknown, sessionId: string | undefined) => void,
  ): () => void;                                     // 返回 disposer
  onClosed(listener: (event: CloseEvent) => void): () => void;   // 重连决策归上层
  async stop(): Promise<void>;                       // 幂等（cdp-use stop 的 ws None 检查同款）
}
```

初始化路径只有 `connect`（构造函数私有）——不存在「未 start 就 send」的状态面（cdp-use 的 `RuntimeError("Client is not started")` 分支因此消亡，见 §6 偏离 5 的反面）。

## 3. 消息泵语义（cdp-use 逐条对照）

| # | 语义 | cdp-use（client.py 行号） | TS 形态 |
|---|---|---|---|
| 1 | 出站信封 | `{id: 自增, method, params: params ?? {}, sessionId?}`（send_raw 372-386）；**sessionId 仅在真值时携带** | 完全一致；id 从 1 起 |
| 2 | 响应路由 | `id ∈ pending` → pop → resolve `result` / reject `RuntimeError(error)`（313-327） | resolve `result`；reject `CdpCommandError`（§4，结构化替代 RuntimeError 包 dict） |
| 3 | 迟到/重复响应 | id 不在 pending → `logger.warning` 跳过（325-327） | 一致 |
| 4 | 事件分发 | `method` 帧 → registry `(params, sessionId)`（330-340） | listener 列表逐个调用（§5 语义差异）；无 listener 静默 |
| 5 | 未预期形态 | 既无 id 又无 method → `logger.warning`（343-344） | 一致 |
| 6 | 连接关闭 | pending 全部 reject `ConnectionError("WebSocket connection closed")`（346-352） | reject `CdpConnectionClosedError`；同时触发 `onClosed` |
| 7 | stop | 取消泵 → pending reject `ConnectionError("Client is stopping")` → 关 ws（280-300） | 一致（错误类型 §4）；再次 stop no-op |
| 8 | 泵的健壮性 | 整个泵在一个 try 里——**单帧 JSON 解析失败会杀泵并把全部 pending reject**（302-359） | **加固**：单帧 parse 失败 → log 警告 + 跳过该帧，泵不死（偏离 4） |
| 9 | handler 异常 | registry 内 catch + log，不影响泵（registry.py:59-66） | 一致：listener 异常 catch + log，逐个隔离 |
| 10 | 并发 send | future 先注册再 `ws.send`（382-386），天然并发安全 | 一致 |

## 4. 错误家族

cdp-use 把错误 dict 直接塞 `RuntimeError` 第一参（`future.set_exception(RuntimeError(data["error"]))`），消费方无法判别 code/message——TS 侧结构化：

```ts
export class CdpError extends Error { /* 基类：name 恒类名（错误断言锚点，P2 轮 15 先例） */ }
export class CdpCommandError extends CdpError {
  readonly code: number;       // CDP error.code（如 -32000）
  readonly method: string;     // 出站命令名，归因
  readonly rawMessage: string; // CDP error.message
}
export class CdpConnectionClosedError extends CdpError { /* 连接关闭杀掉的 pending */ }
export class CdpTimeoutError extends CdpError { /* timeoutMs 到点（§5） */ }
```

超时到点的命令：reject `CdpTimeoutError`，**pending 条目同时移除**——迟到响应落入语义 3（警告跳过），不会 resolve 已放弃的调用。

## 5. 两个设计决策

### 5.1 超时分层——transport 缺省不超时

cdp-use 无 per-call 超时（`send_raw` 裸 await future）；TreeWalker 的命令超时在 dom-snapshot 的 `cdp_timeout.py` 层。TreeChrome 同款分层已存在：**P1 的 `runCdpBatch` 已实现两阶段超时 + 选择性重试**。若 transport 再默认挂超时，双层超时会打架（内层放弃的命令外层还在重试等）。

决策：`timeoutMs` 是 opt-in（缺省无限），消费方分层——dom-snapshot 管命令批超时（现状不变），P4 BrowserSession 管会话级预算。transport 层超时只服务直连宿主（评测 Tier1 的简易路径）。

### 5.2 事件订阅——监听器列表，不复刻覆盖式

cdp-use registry 是**单回调覆盖式**（`_handlers[method] = callback`，registry.py:37）；TreeWalker 为此写注释防踩踏（session.py:1686「注册幂等（cdp_use 单回调覆盖式）」）。覆盖式是历史包袱：两处注册同方法名即静默互踩。

决策：`on()` 返回 disposer 的监听器列表。列表语义是覆盖式的超集——P4 移植 session.py 需要覆盖式时，用「先 dispose 旧句柄再注册」自行管理单例。回调签名 `(params, sessionId)` 对齐 cdp-use（registry 不过滤 session，过滤归 listener）。

## 6. 有意偏离清单（文档 vs cdp-use 的全部差异面）

| # | 差异 | 理由 |
|---|---|---|
| 1 | 错误形态：`CdpCommandError{code, method, rawMessage}` 替代 `RuntimeError(error_dict)` | cdp-use 形态不可判别；cdp-batch/P4 需要稳定分类面 |
| 2 | 事件订阅：监听器列表 + disposer 替代单回调覆盖式 | §5.2 |
| 3 | 超时：opt-in `timeoutMs`（cdp-use 无） | §5.1 分层纪律 |
| 4 | 泵加固：单帧解析失败 log+跳过（cdp-use 会杀泵 + 全量 reject） | 坏帧不该有炸弹半径 |
| 5 | 生命周期：私有构造 + `connect()` 工厂（cdp-use 允许先构造后 start，存在 not-started 发送面） | 消灭非法状态而非防御它 |
| 6 | `onClosed` 显式暴露连接层关闭（cdp-use 无，TreeWalker 靠 pump 日志感知） | 重连决策归上层，但感知面必须有 |
| 7 | `discoverWebSocketUrl` 独立导出（cdp-use 无发现层；TreeWalker 在 config/session 各有一份） | TreeWalker 自愈路径的公共化，单一来源 |

## 7. 目录结构

```
packages/cdp-ws/
  src/
    transport.ts            # CdpWsClient + 消息泵（本文件 §2/§3）
    errors.ts               # §4 错误家族
    discovery.ts            # discoverWebSocketUrl
    session-primitives.ts   # 02 文档（3.2）
    types.ts                # CdpWsOptions / TabInfo / Cookie 注入类型
    index.ts                # 导出面（架构 §3.2 公共 API 的一部分）
  test/
    fake-websocket.ts       # 03 §1 注入面
    transport.test.ts / discovery.test.ts / session-primitives.test.ts
    contract.test.ts        # CdpLikeClient 类型断言 + 信封 wire 断言
  tools/
    page-parity-smoke.mjs   # 03 §3（P1.6）
```

`socketFactory` 注入类型用标准 `WebSocket`（DOM 类型；Node ≥22 原生实现签名一致）。包内禁 `chrome.*`（biome 核心包边界照抄 dom-snapshot 的 overrides 配置）；`process.*` 仅 tools/ 脚本可用，src/ 禁。
