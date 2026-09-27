# 02 · 会话原语与 cookie 注入

> 契约冻结文档。基线：TreeWalker `session.py`（tab/navigate）与评测仓 `runner.py`（cookie）。**只搬 transport 相邻的最小集**——BrowserSession 语义（缓存清理/页面稳定等待/文件选择器/dialog）是 P4 的活，这里出现即越界。

## 1. 类形态

```ts
export class CdpPageSession {
  constructor(readonly client: CdpWsClient);
  attachFirstPageTarget(): Promise<{ targetId: string; sessionId: string }>;
  navigate(url: string, sessionId: string): Promise<void>;
  getTabs(): Promise<TabInfo[]>;          // { targetId, url, title }
  switchTab(targetId: string): Promise<{ targetId: string; sessionId: string }>;
  injectCookies(storageState: unknown, sessionId: string): Promise<number>;
}
```

状态只有 `client`（无缓存、无 current 跟踪——**调用方显式传 sessionId**，与 dom-snapshot `buildDomState(client, sessionId)` 的显式风格一致；「当前 tab」状态机是 P4 BrowserSession 的领土）。

## 2. 各原语规格（Python 行号锚定）

### 2.1 attachFirstPageTarget —— session.py `_connect` 1669-1680 的抽取

```
Target.getTargets({}) → targetInfos 里第一个 type==="page"
→ Target.attachToTarget({ targetId, flatten: true }) → { sessionId }
无 page target → 抛 Error（文案对齐 Python："No page target found. Is Chrome running
with --remote-debugging-port?"）
```

`Page.enable` / `DOM.enable` / `Network.enable` / `Target.setAutoAttach`（session.py:1682-1706）**不搬**——那是 BrowserSession 启动序列，dom-snapshot 的三源命令（DOM.getDocument / DOMSnapshot.captureSnapshot / Accessibility.getFullAXTree）不需要域 enable。P4 移植 session.py 时按原序列补。

### 2.2 navigate —— session.py:2350-2376 的薄化

```
Page.navigate({ url, transitionType: "address_bar" }, sessionId)
→ result.errorText 存在（CDP：present iff navigation failed）→ 抛 CdpNavigationError
   （Error 子类，带 errorText，如 net::ERR_NAME_NOT_RESOLVED）
```

不搬：`new_tab` 参数（开 tab 归 getTabs/switchTab 组合）、selector_map 缓存清理（P4）、`_wait_for_page_settle`（P4；3.3 smoke 用显式 sleep 对齐 gen_fixtures 的 `--wait` 形态）。

### 2.3 getTabs —— session.py:3617-3635

```
Target.getTargets({}) → targetInfos.filter(type === "page")
→ [{ targetId, url: t.url ?? "", title: t.title ?? "" }]
```

差异：Python 整体 try/except 吞异常返回 `[]`——那是 BrowserSession 的容错语义；**TS 透传错误**（薄原语不吞，P4 决定在哪一层吞）。

### 2.4 switchTab —— session.py:3637-3651 的抽取

```
Target.activateTarget({ targetId }) → Target.attachToTarget({ targetId, flatten: true })
→ 返回 { targetId, sessionId }（新会话句柄，调用方切换）
```

不搬：缓存清理、file-chooser 重启用、`_wait_for_page_settle`（皆 P4）。`close_tab` / `create_tab`（3653-3672）**本轮不做**——P1.6 与评测 Tier1 都不需要，P4 随 BrowserSession 移植（避免为对齐而写无测试锚定的代码）。

### 2.5 injectCookies —— runner.py:76-156 的移植

输入：Playwright storage_state JSON（`unknown` 收窄：非对象 / 无 `cookies` 数组 → 抛 Error，对齐 runner.py:102-110 的文件级告警语义升级为显式失败；`origins` 忽略——CDP 用不到，runner.py:93 同注释）。

每条 cookie 的 CDP 参数映射（runner.py:118-146 逐字段）：

| CDP 参数 | 来源 | 缺省 |
|---|---|---|
| `name` / `value` | `c.name` / `c.value` | 必填（缺 → 该条失败计数） |
| `path` | `c.path` | `"/"` |
| `secure` / `httpOnly` | `c.secure` / `c.httpOnly` | `false` |
| `sameSite` | 映射 `{"Strict","Lax","None"}`，**未知值 → "Lax"** | — |
| `url` | 见下（作用域绑定，**恒用 url**） | — |
| `expires` | `c.expires`，**仅 > 0 时携带**（-1 是会话 cookie） | 不发 |

**作用域规则（localhost 坑，runner.py:127-141 实测注释）**：`Network.setCookie` 用 `domain="localhost"` 会返回 `{success:true}` 但 cookie **不进 jar**——所以恒用 `url` 参数：cookie 显式带 `url` 用之；否则 `scheme://domain/path`（scheme 按 secure）；domain 也无 → 兜底 `scheme://localhost/path`。

执行：逐条 `Network.setCookie(params, sessionId)`，`result.success !== false` 计入成功数；单条失败 log 不中断；返回成功数。**不做并行**（runner.py 顺序执行；cookie 间无依赖但保序可复刻）。

## 3. 不做清单（本轮防蔓延）

- 域 enable 序列、file-chooser 拦截、dialog 处理、网络空闲追踪、screencast（全 P4）
- close_tab / create_tab / go_back（P4；2.4 已说明）
- storage_state 的 localStorage（origins）注入
- cookie 读取/导出（P4 需要时加 `Network.getCookies` 包装）

## 4. 有意偏离清单（文档 vs Python 的全部差异面）

| # | 差异 | 理由 |
|---|---|---|
| 1 | getTabs 透传错误（Python 吞异常返回 []） | 容错层级是 BrowserSession（P4）的决策，薄原语不预吞 |
| 2 | attachFirstPageTarget 只做首 page target（Python `_connect` 还带域 enable + 自愈重试） | 域 enable 归 P4；自愈归上层（transport 已提供 discoverWebSocketUrl + connect 失败文案） |
| 3 | navigate 无 new_tab / 缓存清理 / settle | BrowserSession 语义（§2.2） |
| 4 | injectCookies 输入校验从「文件级 warning 继续」改「结构级抛错」 | 函数收 JSON 值而非路径；坏结构静默返回 0 会掩盖注入失效 |
| 5 | switchTab 返回句柄而非改内部 current 状态 | 无 current 状态机（§1） |
