# M5 段 B：@tw/cdp-chrome（chrome.debugger transport）

> 分支 `feat/m5-cdp-chrome`。前置：段 A 骨架。
> 对拍基准：webbrain cdp-client.js（Debuggee sessionId 事实与生命周期模式，设计取用代码重写）+
> core `browser/transport.ts` 的 `CdpTransport` 契约（形状与 cdp-ws 鸭子兼容的既定口径）。
> 验收：mock 单测全绿 + Playwright 加载扩展真机 smoke：附着 → dom-snapshot 采集 → 与 Node 侧
> cdp-ws 同页产物对拍一致（golden 方法：同一页两通道产出 `element_tree_text` 逐字节一致）。

## 1. DebuggerApi 注入接口（可测性根基）

包**不直接引用全局 `chrome`**。定义 chrome.debugger 的最小签名面（比 webbrain 的用法面窄——
只收我们用到的）：

```ts
export interface Debuggee { tabId?: number; targetId?: string; sessionId?: string }
export interface TargetInfoDto { targetId: string; type: string; title?: string; url?: string;
  attached?: boolean; tabId?: number }
export interface DebuggerApi {
  attach(debuggee: Debuggee, version: string): Promise<void>;
  detach(debuggee: Debuggee): Promise<void>;
  sendCommand(debuggee: Debuggee, method: string, params?: object): Promise<unknown>;
  onEvent.addListener(cb: (source: Debuggee, method: string, params: unknown) => void): void;
  onEvent.removeListener(cb: (source: Debuggee, method: string, params: unknown) => void): void;  // 同一 cb
  onDetach.addListener(cb: (source: Debuggee, reason?: string) => void): void;
  getTargets(): Promise<TargetInfoDto[]>;
}
export const chromeDebuggerApi: DebuggerApi = /* 从全局 chrome.debugger 适配（apps/extension 侧 import 用） */;
```

- `chromeDebuggerApi` 是本包**唯一**接触全局 chrome 的文件（Adapter 出口；biome 不拦本包，纪律注释声明）；
  Node 单测注入 fake，SW 侧也可注入 fake 跑 SW 逻辑测试。
- MV3 chrome.debugger API 本身 Promise 化（Chrome 116+）——适配层不做回调桥。

## 2. 根会话适配（本段技术风险点，探针先行）

### 2.1 问题

core `connectSession`（connection.ts:54-105）的握手序列：`Target.getTargets` → 取首个 `type==="page"`
→ `Target.attachToTarget({targetId, flatten:true})` → 得 `currentSessionId` → 此后 `s.send` 全带该
sessionId。这是浏览器级 WS 端点的语义。chrome.debugger 的语义不同：**`attach({tabId})` 本身就建立了
page target 的会话**（Debuggee 不带 sessionId 即路由到该会话）。

### 2.2 方案与探针决策

**探针（首工作项）**：真机 Chrome `--load-extension` 后经段 A 的 `diag` 通道驱动，依次实测：

1. 附着后发原生 `Target.getTargets` → 返回的 targetInfos 是否包含附着 tab 自身（`attached:true`）；
2. 对自身 targetId 发 `Target.attachToTarget({flatten:true})` → 成功（返回新 sessionId 且
   `{tabId, sessionId}` 可路由）/ 失败（"Already attached" 类错误）；
3. 若成功，`Target.setAutoAttach` 后 OOPIF 子会话事件（`onEvent` source.sessionId）与命令路由；
4. `chrome.debugger.getTargets()` 的 targetInfos 是否带 tabId（targetId↔tabId 映射可用性）。

**方案 R（原生直通）**：若 2 成功——transport 零拦截，握手原样透传（cdp-ws 同构，最理想）。
**方案 S（拦截合成）**：若 2 失败——transport 拦截两条握手命令：

- `Target.getTargets` → 不发往 Chrome，改由 `getTargets()` 合成 `{targetInfos:[附着 tab 的 info]}`
  （type "page"、真实 targetId——attach 后 `getTargets()` 里能拿到自身条目；探针 1/4 确认来源）；
- `Target.attachToTarget` → 不发往 Chrome，返回合成 `{sessionId: ROOT_SESSION_ID}`（常量
  `"__root__"`）；send 路由时 `sessionId === ROOT_SESSION_ID || !sessionId` → Debuggee 省略 sessionId。

两方案对 core 完全透明（transport 内部分支）。**switchTab 重映射（§4）两方案都需要**（跨 tab attach
不能经 Target.attachToTarget——chrome.debugger 按 Debuggee 附着）。

### 2.3 send 路由

```ts
send(method, params, sessionId?) {
  const debuggee: Debuggee = { tabId: this.tabId };
  if (sessionId && sessionId !== ROOT_SESSION_ID) debuggee.sessionId = sessionId;
  return this.api.sendCommand(debuggee, method, params ?? {});
}
```

错误归一：chrome.debugger 的 `lastError` 形态（runtime.lastError 文本）与 CDP 错误对象（`code/message`）
对齐成 Error（message 原文透传——core 的错误分罪谓词按文本匹配，**不吞不译**）。

## 3. 事件路由（CdpTransport.on）

`chrome.debugger.onEvent` 是全局单播源 → transport 内部多播表（method → Set<listener>）：

```ts
on(method, listener) {
  // 惰性装全局监听（首个订阅时装，stop 时拆）；source.sessionId 透传第二参
  // 返回解订函数（core eventDisposers 惯例）
}
```

- OOPIF 子会话事件：`source.sessionId` 存在 → 透传；根会话事件 → `undefined`。
  core 各消费方（dialog/network-idle/file-chooser）按 method 匹配，sessionId 语义天然对齐 cdp-ws。
- `onDetach`（用户手点横幅「取消」/标签关闭/Chrome 政策剥离）：转成 transport 级
  `"detached"` 内部状态 + 向 pending send 注入 Error（`"Debugger detached: <reason>"`）+
  事件订阅者收 `transport` 自定义通知（供 SW 层 run 中止决策——细案 04 §6）。

## 4. tabs 重映射（getTabs / switchTab / closeTab）

core tabs.ts 语义：`Target.getTargets` 列 tab；`Target.attachToTarget(targetId)` 切 tab。扩展形态：

- **`Target.getTargets` 拦截**（两方案统一）：改由 `api.getTargets()` 合成 targetInfos
  （chrome.debugger.getTargets 天然带 tabId + type "page"）——core `getTabs` 的投影字段对齐
  （TabInfo：targetId/url/title——细查 core tabs.ts 投影后补齐字段映射表）。
- **`Target.attachToTarget({targetId})` 且 targetId ≠ 当前附着 target**（switchTab 路径）：
  拦截 → `api.detach({tabId: 当前})` + `api.attach({tabId: 映射})` + `this.tabId = 新 tabId` →
  返回根 sessionId（方案 S 合成值 / 方案 R 下重新实测值）。**attach 与 detach 顺序**：先 attach 新再
  detach旧 可避免竞态窗口（探针验证 Chrome 是否允许同 tab 双 debugger——不允许则先 detach）。
  attach 成功后 core 的 `enableSessionDomains` 全套重发自然走新会话（F9.4 序列复用）。
- `Target.closeTarget`（closeTab）：透传原生命令（targetId 路由）——探针确认跨 target 命令可发性；
  不可发则拦截转 `chrome.tabs.remove`（需在 DebuggerApi 外补一个最小 TabsApi 注入口）。

## 5. 生命周期

| 操作 | 行为 |
|---|---|
| 工厂（TransportFactory 注入 core） | `attach({tabId})` → `new ChromeDebuggerTransport(api, tabId)`；附着失败（横幅拒绝/重复附着）抛原文 Error |
| stop() | 解订全局监听 → `detach({tabId})`；幂等（已 detach 静默） |
| 重连语义 | core `acquireTransport` 自愈重试工厂一次——工厂侧对 `detached` 状态先清再 attach |

## 6. 测试设计

**mock 单测（fake DebuggerApi，全分支）**：

- send 路由矩阵：根（省略 sessionId）/ ROOT_SESSION_ID / 真实子会话 id → Debuggee 形状断言；
- 握手拦截（方案 S 分支与方案 R 分支各自用例——探针定案后保留实际分支用例，另一分支删）；
- 事件多播：多 listener / 解订幂等 / onDetach 注入错误；
- switchTab 重映射序列（detach→attach 顺序、失败回滚：新 attach 失败时保持旧附着并抛错）；
- 错误归一（lastError 文本 / CDP 错误对象两形态）。

**真机 smoke（Playwright，本段引入 e2e harness 雏形）**：

- `apps/extension/e2e/` 目录 + `@playwright/test` devDep（allowBuilds 登记）；
- 脚本：launch chromium `--load-extension=.output/chrome-mv3 --headless=new`（headless=new 支持扩展）
  → 打开本地静态 fixture 页（复用 dom-snapshot golden 的页面之一，本地起 http server）→
  CDP 侧（Playwright 自带 CDPSession）或经 diag 通道驱动 SW：`BrowserSession.start()` →
  `get_state()` → 导出 `element_tree_text` → 与 `packages/dom-snapshot/test/fixtures/` 对应 golden 比对；
- 对照通道：同页用 cdp-ws（Node 9222 直连）跑一遍产物对拍（golden 方法闭环）。
- smoke 不进 vitest 默认跑（`pnpm --filter extension e2e:smoke` 独立 script，真机依赖显式触发）。

## 7. 出界项（登记）

- Network/download 域行为差异（扩展下载落盘路径由 Chrome 决定）——段 D FileSystemProvider 处理；
- content script 层（README §5 决策 8）；
- cdp-chrome 不做消息压缩/限流（事件流预算在 journal 层，细案 04）。

## 8. 段内工作项

| # | 项 | 验收 |
|---|---|---|
| B1 | 真机探针（§2.2 四问）+ 方案定案记录（探针输出贴进本文件实施结果节） | 方案 R/S 定案有实证 |
| B2 | DebuggerApi + ChromeDebuggerTransport 全量（send/事件/生命周期） | mock 单测全绿 |
| B3 | tabs 重映射 + switchTab | mock 单测（含失败回滚）绿 |
| B4 | Playwright e2e harness 雏形 + golden 对拍 smoke | smoke 真机过（一页逐字节一致） |
| B5 | 门禁 | typecheck/test/gate exit 0 |
