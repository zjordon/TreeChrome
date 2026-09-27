# P3 cdp-ws transport · 实施计划

> 状态：2026-09-27 起草，待评审后冻结。实施计划总纲见 `docs/implementation-plan.md` §P3；架构依据见 `docs/architecture.md` §2（`@tw/cdp-ws` 定位行）/ §4（CdpTransport 接口）。
>
> **P3 与 P2 的基准差异**：P2 无逐字节移植锚点，文档即唯一对拍基准；P3 有真实参照实现——cdp-use 的 transport 核心（约 100 行实质逻辑）与 TreeWalker session.py 的会话原语段。因此 P3 的对拍基准是双层：**本文档冻结契约与有意偏离，Python 参照冻结行为语义**。参照与文档冲突时，以文档的「有意偏离清单」（01 §6 / 02 §4）为准；偏离清单没提到的差异算缺陷。

## 1. 输入与参考物

| 参考物 | 用途 | 精确位置 |
|---|---|---|
| cdp-use `client.py`（402 行，其中 ~220 行是日志格式化器） | **transport 语义基线**：信封格式、id→pending 映射、消息泵、连接关闭语义、stop 语义 | `evals/webarena/.venv/Lib/site-packages/cdp_use/client.py:229-402`（CDPClient） |
| cdp-use `cdp/registry.py`（82 行） | 事件订阅语义：**单回调覆盖式**（`_handlers[method] = callback`）、handler 异常吞掉+log | 同包 `cdp/registry.py` |
| TreeWalker `browser/session.py` | **会话原语基线**：连接自愈、tab 管理、navigate 语义 | `_connect` 1642-1720、`_rediscover_ws_url` 1722-1740、`navigate` 2350-2376、`get_tabs` 3617-3635、`switch_tab` 3637-3651、`close_tab`/`create_tab` 3653-3672 |
| TreeWalker `config.py` | ws_url 发现（`_fetch_ws_url`：GET `/json/version`）与环境变量形态（CDP_PORT=9222 / CDP_WS_URL） | `config.py:616-623` |
| 评测仓 `runner.py` | **cookie 注入基线**：storage_state → Network.setCookie 全字段映射与 localhost url 坑 | `evals/webarena/runner.py:76-156`（`inject_webarena_cookies`） |
| dom-snapshot `tools/gen_fixtures.py` | P1.6 对拍的 Python 侧抓取流程与 Chrome 拉起形态 | `gen_fixtures.py:40-58`（wait_version）、`:60-124`（BrowserSession 抓取流）、`:180-199`（headless 拉起） |
| dom-snapshot `protocol.ts` | **必须满足的契约**：`CdpLikeClient.send(method, params?, sessionId?)` | `packages/dom-snapshot/src/protocol.ts:15-21` |
| chrome-remote-interface（不引依赖） | 工程模式参考：消息泵顺序、发现接口、边界形态 | 上游仓库，仅读设计 |

## 2. 范围

**做**（`packages/cdp-ws`，Node 宿主 WebSocket CDP transport）：

- WebSocket transport：连接（直连 ws_url 或 `/json/version` 发现）、flat 协议 send、事件订阅、超时、连接关闭语义——实现 `CdpLikeClient`（等价架构 §4 `CdpTransport` 的 ws 实现）
- 会话原语最小集：attach page target、navigate、getTabs/switchTab、cookie 注入（storage_state → Network.setCookie）
- P1.6 真机对拍 smoke：连真实 Chrome 抓 ≥3 个真实页面，TS 管线产物与同会话 Python 产物对拍（总纲 §P1.6 验收）
- `@tw/cdp-ws` 包脚手架（对齐 dom-snapshot / core 形态）

**不做**（明确出界，防止蔓延）：

- BrowserSession 语义——点击/输入/等待页面稳定/selector_map 缓存/截图/文件选择器拦截/dialog 处理（session.py 的主体，**P4** 移植进 `@tw/core`）
- 自动重连策略（连接死了 reject pending + `onClosed` 通知，重建决策归上层；提供 `discoverWebSocketUrl` 工具函数供上层自愈）
- chrome.debugger 适配器（`@tw/cdp-chrome`，扩展宿主，M5 前置；webbrain `cdp-client.js` 是它的参考）
- 应用层心跳/keepalive（cdp-use 的 PING 日志只是观测；Chrome 自带协议级 ping，长空闲断连风险登记到 §6）
- 评测仓对接（Tier1 评测经 pnpm link: 消费本包，P5+）

## 3. 文档导航

| 文档 | 内容 | 冻结什么 |
|---|---|---|
| [01-transport.md](01-transport.md) | `CdpWsClient` 公共 API、消息泵语义（cdp-use 逐条对照）、错误家族、超时分层决策、事件订阅设计决策、依赖注入 | transport 的行为契约（工作项 3.1 的实现基准） |
| [02-session-primitives.md](02-session-primitives.md) | 会话原语（attach/navigate/tabs）与 cookie 注入规格，TreeWalker / 评测仓行号锚定 + 有意偏离清单 | 3.2 的行为契约 |
| [03-testing-and-smoke.md](03-testing-and-smoke.md) | FakeWebSocket 注入面、单测覆盖矩阵、P1.6 真机对拍 smoke 设计与验收口径 | 测试怎么算过、对拍怎么算过 |

## 4. 任务拆分与顺序

分支约定：`feat/p3-cdp-ws` 单分支，按工作项一笔一提交。每项完成跑 `node scripts/gate.mjs pre-commit`。

| # | 工作项 | 内容 | 验收 | 预估 | 依赖 |
|---|---|---|---|---|---|
| 3.0 | cdp-ws 包脚手架 | package.json（`@tw/cdp-ws`，零运行时依赖）/ tsconfig / vitest（阈值 85%）/ `src/index.ts` 占位；biome 核心包边界对 `packages/cdp-ws/src/**` 生效（沿用 dom-snapshot 形态验证） | `pnpm -r typecheck/test` 绿 | 0.25d | — |
| 3.1 | WebSocket transport | 01 文档全部落地：`transport.ts` / `errors.ts` / `discovery.ts`；FakeWebSocket 单测全绿 | 单测矩阵（03 §1）全绿；`CdpWsClient` 经类型断言满足 `CdpLikeClient`；**01 文档评审通过后才动工** | 1d | 3.0 |
| 3.2 | 会话原语 + cookie 注入 | 02 文档落地：`session-primitives.ts`；单测全绿 | 单测矩阵（03 §2）全绿 | 0.75d | 3.1 |
| 3.3 | P1.6 真机对拍 smoke | `tools/page-parity-smoke.mjs`（esbuild stdin 打包，复用 P2 smoke 的 resolveDir 方案） | ≥3 个真实页面 TS↔Python 对拍逐字节一致（03 §3 口径） | 0.75d | 3.2 |

合计 ~2.75d（总纲原估 1.5~2.5d；cookie 注入规格与对拍流程细化后上调，本表为准）。

## 5. 风险与未决

| # | 风险 | 处置 |
|---|---|---|
| 1 | **Node 原生 WebSocket（undici）的大帧承载**：cdp-use 显式设 `max_ws_frame_size=100MB` 防 `DOMSnapshot.captureSnapshot` 大页面截断；undici WebSocket 无该配置项，按 spec 无帧上限 | 3.3 smoke 必含一个重型真实页面（长列表/文档站）；若截断，退路是注入 `ws` 库作为 socketFactory（签名已按标准 `new WebSocket(url)` 对齐，替换零改动） |
| 2 | **Chrome 调试端点的 Host 校验**：`/json/version` 要求 Host 是 `localhost` 形态（`127.0.0.1` 会被拒），gen_fixtures.py:50 用 localhost 形态 | discovery 固定按传入 host 拼接并在文档标注；smoke 拉起 Chrome 用 127.0.0.1 端口时 discovery 传 `localhost` |
| 3 | **旧 ws_url 失效形态**：Chrome 重启后 `/devtools/browser/<UUID>` 变化，旧 url 握手 404（session.py:1729-1732 实证） | `connect` 失败错误信息引导；`discoverWebSocketUrl` 导出供上层自愈（对齐 TreeWalker `_connect` 的自愈路径，但重建决策不进 transport） |
| 4 | **事件订阅语义偏离**（覆盖式→列表，01 §5）：P4 移植 session.py 时若照抄「注册幂等」注释会踩语义差 | 01 §6 偏离清单显式登记；P4 启动检查点复核 |
| 5 | 对拍页面动态漂移：同页两次抓取（Python→TS）间内容变化会假红 | 03 §3 的「背靠背抓取 + 失败重抓一轮 + 静态页优先」口径 |
| 6 | cdp-batch 错误判别面：P1 的 `runCdpBatch` 对 `client.send` 拒绝值的消费方式（cdp-use 是 `RuntimeError` 包装） | 3.1 实现时核对 `cdp-batch.ts` 的分类逻辑对 `CdpCommandError` 的兼容性；若其按错误名/消息分类则补充适配（登记到完成记录） |

## 6. 完成记录

（随实施逐项补记：工作项提交 hash、偏离清单修订、smoke 结果。）
