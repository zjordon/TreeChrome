# 01 · BrowserSession（browser 层）

> 参照：TreeWalker `browser/session.py`（5081 行，class 起于 :1538；模块级工具 :48-1535）+ `browser/{views,network_idle,highlight,html_source,circuit_breaker,image_utils}.py`。行号锚点均属基准 `640d52a`。
>
> 本文档冻结：CdpTransport 接口形状、session.py → TS 模块的拆分映射（含边界）、连接/事件/get_state 行为契约、batch1 方法面。Python 与本文档冲突时以 §6 偏离清单为准；清单未提的差异算缺陷。

## 1. CdpTransport 接口（core 侧定义，架构 §4 修订项）

```ts
// packages/core/src/browser/transport.ts
export interface CdpEventListener {
  (params: unknown, sessionId: string | undefined): void;
}
export interface CdpTransport {
  send<T>(method: string, params?: object, sessionId?: string): Promise<T>;
  /** 订阅 CDP 事件（method 全名），返回解订函数 */
  on(method: string, listener: CdpEventListener): () => void;
  close(): void;
}
```

- **为什么 core 自己定义而 import cdp-ws**：core 必须宿主中性（cdp-chrome 也实现它）；形状与 `CdpWsClient` 鸭子兼容。兼容性由 cdp-ws 侧新增 contract test 断言（`const t: CdpTransport = client`，core devDeps `@tw/cdp-ws` 仅测试/Smoke 用，运行时零依赖）。
- `close()` 同步void：cdp-ws `stop()` 是同步发起（pending 全 reject），对齐即可（以实测签名微调，登记完成记录）。
- architecture.md §4 的 `CdpTransport` 行随之改为带上表 `on`（4.0 提交）。

## 2. 模块拆分映射（session.py 5081 行 → 16 个 TS 模块）

拆分原则：**按 Python 的功能族切，不按 public/private 切**；被 actions.py 调用的 4 个私有方法（`_is_element_occluded`/`_clear_text_field`/`_force_set_value`/`_read_active_text`）随族入模块并导出，Facade 不再暴露私有面。

| TS 模块（core/src/browser/） | Python 来源（行区间） | 职责 |
|---|---|---|
| `transport.ts` | —（新） | CdpTransport 接口（§1） |
| `views.ts` | views.py 全量 142 行 | TabInfo / BrowserEvent / BrowserStateSummary（字段照搬；DOM 类型从 @tw/dom-snapshot re-export，对齐迁移期 shim 语义） |
| `circuit-breaker.ts` | circuit_breaker.py | 阈值/恢复期熔断（session :1556 实例化、:2087-2104 消费、reconnect :1866 reset） |
| `network-idle.ts` | network_idle.py 全量 148 行 | inflight 集合 + 长连接剔除（WebSocket/EventSource）+ stability window 判 idle；4 个 Network 事件回调 :65-68 |
| `highlight.ts` | highlight.py 全量 166 行 | Overlay.highlightNode + JS 点击反馈/调试序号标签；方法面 highlight_element/highlight_click_point/remove_highlights/add_debug_highlights |
| `html-source.ts` | html_source.py 全量 123 行 | documentBodyToHtml（剥 script/style、门控 a/img）——extract 依赖 |
| `connection.ts` | session :1541-2039 + :48-107 | 构造/start/stop/reconnect/is_connected、_connect 握手自愈、域 enable 序列、事件注册（dialog/下载/file chooser/recent_events）、get_current_url、cookie 注入（§5.3） |
| `navigation.ts` | :2350-2436 + :2866-2985 + :3542-3613 | navigate / go_back / `_wait_for_page_settle`（readyState）/ `wait_for_page_settle`（requirejs 稳定 + `_kick_frozen_data_grid`）/ scroll |
| `element-pointer.ts` | :2440-2747 | click_at / get_element_coordinates（三级回退）/ _best_quad_rect / _get_viewport_size / click_element / isElementOccluded / jsClick |
| `text-input.ts` | :2749-2862 + :3193-3429 + :720-902 | typeText / readActiveText / forceSetValue / clearTextField / _type_char / _trigger_framework_events / requiresDirectValueAssignment + 键码映射常量表 |
| `keyboard.ts` | :3431-3538 | sendKeys 三路由（组合键/命名特殊键/纯文本）+ Enter 后 0.1s |
| `tabs.ts` | :3617-3670 | getTabs / switchTab（重挂 file chooser 拦截）/ closeTab / createTab |
| `evaluate-basic.ts` | :3674-3688 + :4505-4529 + :437-689 | executeJs / evalFunctionOnNode + JS 通道工具（validateAndFixJavascript / normalizeEvalResult / 定界符扫描与语法修复候选）。**增强版 `evaluate`（frame 切换/args/elements/return_element_ids/语法自愈重试）整体 P4b** |
| `dom-access.ts` | :3690-3712 | getPageHtml（DOM.getDocument depth=-1 pierce → html-source） |
| `screenshot.ts` | :2206-2346 | takeScreenshot（超时护栏）/ printToPdf（含 5 纸张表；action 侧 save_as_pdf 在 P4b，方法先行移植因体量小且 get_state 依赖截图） |
| `grid-meta.ts` | :3116-3191 | readGridMeta + _GRID_META_JS（**get_state 保真需要**，[Grid] 段来源；read_grid 动作本身 P4b） |
| `session.ts`（Facade） | :2041-2143 等 | BrowserSession：组装上述模块、get_state 九步（§4）、两层 selector_map 缓存（§3.5）、currentSessionId/currentTargetId 访问器、rawSend 逃生口（§5.4）、injectStorageState（§5.3） |

每模块 ≤ ~700 行；Facade ≤ ~500 行。**batch2 预留槽**（P4b 填实现，P4 不建空文件）：`search-find.ts`（:3920-4321 find_text/search_page/find_elements + XPath 工具 :48-109）、`dropdown/`（:4323-4990 25 方法 + 17 个 JS 常量 :904-1523）、`upload.ts`（:1745-1849 + :4994-5081）、`grid-read.ts`（read_ui_grid :2938-3191 主体）、`evaluate-enhanced.ts`（:3714-3918）。

## 3. 连接、事件与生命周期契约

### 3.1 构造与 start（connection.ts）

```ts
class BrowserSession {
  constructor(transportFactory: () => Promise<CdpTransport>, settings: BrowserSessionSettings);
  async start(opts?: { trackDownloads?: boolean; enableRecentEvents?: boolean }): Promise<void>;
}
```

- `BrowserSessionSettings` 字段面 = Python BrowserSettings（config.py:306-335）**去掉 ws_url**（被工厂取代，有意偏离）：circuitBreakerThreshold/RecoveryS、cdpFirstTimeout/cdpRetryTimeout/maxIframes/heavyPageElementThreshold、highlight、autoHandleJsDialog、networkIdleTimeout/StabilityWindow/PollInterval、pageSettleTimeout/PollInterval、screenshotTimeout、waitBetweenActions。
- `start()` = `transportFactory()` → `_connect()` → 可选 screencast 自启（**P4 不实现 screencast**，槽位留给 M5——当前生产零调用方）→ 下载追踪/recent_events 开关。

### 3.2 _connect 序列（session :1642-1721，顺序保真）

1. networkIdleTracker.reset()（:1650）
2. 握手；失败自愈一次：重新走 transportFactory（对齐 `_rediscover_ws_url` :1722-1744 的语义——Node 宿主的工厂内部用 `discoverWebSocketUrl` 实现；**core 不感知 url，只重调工厂**，有意偏离）。无重试循环、无退避，单次自愈
3. `Target.getTargets` → 第一个 type=="page" → `Target.attachToTarget(flatten:true)` → currentSessionId（:1669-1680，找不到 raise）
4. 域 enable 固定顺序：`Page.enable`(:1682) → `DOM.enable`(:1683) → `_setup_event_tracking`（dialog 回调，try/except 降级，:1688）→ `Network.enable`(:1694) + networkIdleTracker 注册（:1695，失败降级 disabled）→ `Target.setAutoAttach(autoAttach, waitForDebuggerOnStart:false, flatten)`(:1701-1704，best-effort) → file chooser 拦截（:1714）
5. highlight 接线（:1719-1720）
6. **不调用** Runtime/Overlay/Accessibility.enable（Accessibility 由 dom-snapshot 按需）

### 3.3 事件注册面（单例纪律）

| 事件 | 处理 | 注册时机 |
|---|---|---|
| `Page.javascriptDialogOpening` | recent_events 入队 + 自动处理调度（beforeunload→accept，其余 dismiss） | _connect 无条件（:1684-1690；挂起 dialog 冻结 Runtime.evaluate——WebArena 493 教训） |
| `Browser.downloadWillBegin` / `downloadProgress` | _pending/_completed_downloads | start(trackDownloads) |
| `Page.fileChooserOpened` | 记录 _lastFileChooser（backendNodeId/mode/frameId/ts） | _connect 与 **switchTab 每次重发** `Page.setInterceptFileChooserDialog`（per-session 语义，Bug-1 回归源 :1757-1759/:3647-3649） |
| Network 4 事件 | NetworkIdleTracker | Network.enable 后 |

线程模型偏离：Python ws 读线程 + `call_soon_threadsafe` 移交 loop；TS 单线程，cdp-ws 泵直接分发——dialog 自动处理经微任务调度 + 任务集登记（对应 `_dialog_tasks`），异步处理器异常不穿透泵。

### 3.4 重连（reconnect :1856-1874）与 stop（:2004-2026）

reconnect = 解订全部事件 disposers → transport.close() → 重调工厂 → 清两层 selector_map 缓存 → 熔断 reset → _connect；失败置 transport=null 返 false。**重连循环在 agent 侧**（step.py:1936-1949，固定 1s 间隔无指数退避——03 文档），session 只提供单次 reconnect。
stop 幂等：清缓存 → 删上传临时副本登记（P4b 上传族的槽，空实现）→ client.stop。

### 3.5 两层 selector_map 缓存（新元素 `*` 前缀的根基）

`_cached_selector_map` / `_previous_cached_selector_map`；**5 处失效**：navigate(:2364)、go_back(:2387)、switch_tab(:3639)、reconnect(:1864)、stop(:2006)。get_state 每次轮转（:2065）。单测逐处覆盖（风险 4）。

## 4. get_state 九步（session :2041-2143，顺序保真）

1. 可选 `waitSettle` → `_wait_for_page_settle`（readyState 轮询）
2. 可选 `waitNetworkidle` → networkIdleTracker.waitUntilIdle()（**排在 settle 之后**）
3. 缓存轮转 previous ← cached
4. 一次 `Runtime.evaluate` 取 {url, title}
5. `getTabs()`
6. DOM 采集：熔断器 open → EMPTY_DOM_STATE；否则 `buildDomState(transport, sessionId, previousMap, config)`（@tw/dom-snapshot，P1 产物）；FAILED/异常计熔断；cached ← 结果 selectorMap
7. debug 高亮移除 → 可选 `takeScreenshot`（失败降级 null）→ 高亮回注（顺序耦合：高亮只给人看不进 LLM 图）
8. `readGridMeta(url)`（非网格 URL 缓存跳过）
9. 返回 `BrowserStateSummary{url,title,tabs,domState,screenshot,gridMeta,recentEvents:consumeRecentEvents()}`

options 形态：`getState(opts?: { includeScreenshot?: boolean; waitSettle?: boolean; waitNetworkidle?: boolean })`（Python 同款默认 true/true/false 待核：:2041-2056 的默认值照搬）。

## 5. batch1 方法面（Facade 公共导出）

agent/step 侧 8 方法（探查锚点）：`start / stop / navigate / get_state / get_current_url / consume_completed_downloads / reconnect / current_target_id`。
actions batch1 十动作消费的增量面：`wait_for_page_settle`(公开版) / `highlight_element` / `click_element` / `type_text` / `send_keys` / `scroll` / `go_back` / `get_tabs` / `switch_tab` / `get_page_html` / `take_screenshot`（extract 落盘前的预览、动作内部）/ `execute_js`（基础版）。
评测契约面（§runner）：`get_current_url` / `navigate` / `evaluate`（**P4b 才有增强版**——评测 Tier1 对 adapter.evaluate 的依赖在 P5 前，由 P4b 补齐；登记总纲 P4b 范围）。

### 5.3 cookie 注入（core 重实现）

`injectStorageState(state: StorageState): Promise<{ injected: number; failed: number }>`——语义照搬 runner.py:80-156 + P3 cdp-ws 已验证行为：显式 url > scheme://domain+path > scheme://localhost+path（**localhost 域 cookie 必须 url 参数绑定**，runner.py:128-139 坑）；name/value 非字符串跳过；path 默认 "/"；sameSite 未知值→Lax；expires>0 才发；`result.success===false` 计失败并继续。发送走 `send("Network.setCookie", params, currentSessionId)`。与 `CdpPageSession.injectCookies` 的有意重复见 README 决策 4。

### 5.4 裸 CDP 逃生口

Python step.py:598-601 与评测 CDPPageAdapter 都直接用 `browser.client.send` + `current_session_id`。TS Facade 暴露 `rawSend<T>(method, params?)`（绑定 currentSessionId）+ `readonly currentSessionId / currentTargetId`。**不暴露 transport 本体**（防止宿主耦合泄漏）。

### 5.5 人工时序间隔清单（风险 3，勿优化）

click 三段 50/80/300ms（:2458/:2470/:2482）；点击效果等待 0.6s（actions `_CLICK_EFFECT_WAIT`）；Enter 后 0.1s（:3537-3538）；scroll 后固定 0.2s 且**不用** readyState settle（:3575-3577）；动作间 wait_between_actions。单测用 vi.useFakeTimers 断言序列。

## 6. 有意偏离清单

| # | 偏离 | 理由 |
|---|---|---|
| 1 | transportFactory 注入替代 ws_url 直连与 `_rediscover_ws_url` 内置 | 宿主中性（README 决策 3） |
| 2 | 事件订阅：cdp-ws 多播 + Session 自管 disposers（重连先解订再注册），替代 cdp-use 覆盖式的「注册即幂等」 | P3 01 §5.2 既定；语义等价但需显式管理 |
| 3 | 线程模型：单线程事件循环 + 微任务调度替代读线程 + call_soon_threadsafe | TS 运行时差异 |
| 4 | screencast 三方法不移植（当前零生产调用方） | M5 直播功能再入 |
| 5 | 增强版 evaluate / 搜索族 / 下拉族 / upload / grid-read / printToPdf 之外的 FS 族不移植 | batch2（README §3） |
| 6 | 标识符 camelCase；CDP 协议字段（backendNodeId 等）与 LLM 可见字符串保原样 | README 决策 7 |
| 7 | 日志：logging → 构造注入 logger（P3 惯例） | 核心包禁 ambient |
| 8 | 上传临时文件登记簿（:5071）建空槽，P4b 填 | upload 族 P4b |

## 7. 导出面（core/src/browser/index.ts）

`BrowserSession` / `CdpTransport`（类型）/ `BrowserSessionSettings` / `TabInfo` / `BrowserStateSummary` / `BrowserEvent` / `StorageState`（cookie 注入入参类型）/ `describeConnectionError`（连接类错误判定辅助，对齐 step.py `_is_connection_error` 的模式表 :2139-2147——放 core 供 agent 复用）。
