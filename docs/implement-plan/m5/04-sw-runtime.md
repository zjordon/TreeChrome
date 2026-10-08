# M5 段 D：SW 运行时（agent 装配 + 五接口扩展实现 + run journal）

> 分支 `feat/m5-sw-runtime`。前置：段 A（骨架/协议）、段 B（transport）、段 C（core 缝）。
> 参照：webbrain run-ui-journal.js（journal 模式，代码重写）+ node-host agent-boot.ts（装配形态）。
> 验收：mock 全链单测绿（fake chrome/IndexedDB）+ 真机 smoke：扩展内跑通一个本地 fixture 任务
> （mock LLM 端点，经 Playwright 驱动），journal 落盘、事件流到侧边栏（段 A 冒烟组件升级为日志视
> 图前的临时渲染）。

## 1. SW 模块布局（apps/extension/src/）

```
src/
  host/                    # chrome 交互粘合层（全仓 chrome.* 合法区之二）
    debugger-api.ts        # chrome.debugger → DebuggerApi 适配（段 B 出口的消费）
    settings-store.ts      # chrome.storage.local ⇄ 扩展配置（§3）
    grant-store.ts         # GrantStore 的 chrome.storage 实现（tc_permissions）
    skill-store.ts         # IndexedDB SkillStore + built-in 打包刷新（§5）
    skill-source.ts        # ExtensionSkillSource（实现 core SkillSource）
    secret-provider.ts     # 敏感数据占位符配置（chrome.storage，§3.2）
    opfs-fs.ts             # FileSystemProvider 的 OPFS 实现（§6）
    attachment-registry.ts # 附件注册表（内存 Map + 淘汰，§7）
    keepalive.ts           # SW 存活策略（§8）
  runtime/
    assemble.ts            # Agent 装配（storage → ProviderConfig/AgentSettings → Agent；node-host agent-boot 的扩展同构体）
    run-manager.ts         # run 生命周期（start/stop/pause 单飞互斥、tab 绑定、onRemoved 中止）
    journal.ts             # RunJournal（webbrain 模式重写，§4）
    policy-bridge.ts       # PolicyInteraction 的侧边栏桥（Port 往返 + 超时/竞争，§4.3）
    event-forwarder.ts     # EventBus → Port 事件流（seq 编号，§4.2）
    port-server.ts         # Port 监听/路由（协议 @tw/protocol 信封分发）
    message-router.ts      # runtime.sendMessage 单发路由（options 页/settings-changed/diag）
```

纪律：`src/host/`+`entrypoints/` 之外不出现 chrome.\*；runtime/ 全部收注入接口（单测 fake）。

## 2. Agent 装配（assemble.ts）

对齐 node-host agent-boot 的形态（env→配置换成 storage→配置；**配置是显式传入的类型化对象**
铁律不变）：

```
settings-store 读取 tc_settings
  → ProviderConfig 卡（active 卡 + fallback 链）→ createLLMClient(card)
  → AgentSettings（resolveAgentSettings(扩展覆盖)：submitConfirmEnabled=true、
     enableSkillInjection=true、enableTaskSkillInjection=true——架构 §6.1「TreeChrome 默认开启」）
  → taskSkill/judge/extract 附属卡（缺省复用主卡——node-host 三态语义同款：卡面缺省=
     复用主卡，显式 null=强制关闭）
  → new BrowserSession(transportFactory: () => cdp-chrome 工厂（绑定 run tabId）,
     settings.browser)
  → new Agent({ task: 任务文本+附件清单（段 C §1.4 拼接）, llm, browser, settings,
     policy: new PolicyGate(sidepanel 桥, chrome GrantStore),
     skillSource: ExtensionSkillSource, eventBus: 新 EventBus, fs: opfs-fs,
     downloadsPath: null })     // 扩展不开 trackDownloads（Chrome 自管落盘；登记偏离）
```

## 3. settings-store（tc_settings）

### 3.1 存储键（chrome.storage.local）

| 键 | 内容 |
|---|---|
| `tc_settings` | `{ providerCards: ProviderCardDto[]; activeCard: string; taskSkillCard?: string\|null; judgeCard?: string\|null; extractCard?: string\|null; sensitiveData?: Record<string,{value,urls}>; agent?: { useVision?: boolean; maxSteps?: number } }` |
| `tc_permissions` | GrantStore 的 always 授权数组（core Grant 形状直存——grant-store.ts 适配 load/save） |
| `tc_runUi:<tabId>` | run journal 快照（§4） |

### 3.2 ProviderCardDto ↔ ProviderConfig

Dto = ProviderConfig 存储/表单形态（apiKey 明文存 local——webbrain 同款；扩展本地边界内，
不做 OS 级加密，登记）。映射规则：protocol/baseUrl/apiKey/model/maxTokens/thinkingEffort/
capabilities/contextWindow 直传；`testConnection` 用 core LLMClient 原生能力（options 页按钮）。

变更通知：options 写入后发 `settings-changed` → run-manager 热读（**只影响下一次 run**；
运行中不换卡——run 装配一次性，与 node-host 同款）。

## 4. run journal（journal.ts）+ 事件转发

### 4.1 形态（webbrain RunUiJournal 语义重写，字段收敛到本仓需要）

```ts
interface RunJournalSnapshot {
  runId: string; tabId: number; status: "running"|"awaiting-permission"|"awaiting-submit"
        | "done"|"error"|"interrupted";
  seq: number; ackedSeq: number; discardedBeforeSeq: number;
  events: JournalEvent[];              // {seq, type: TwEventType, ts, data(压缩投影)}
  task: string; startedAt: number; endedAt: number | null;
  finalResult: string | null; isDone: boolean; isSuccessful: boolean | null;
  stepCount: number; lastError: string | null;
  attachments: AttachmentInfo[];
}
```

- 事件环上限 256 + 落盘预算（512KB，tight 128KB——webbrain 数值沿用）；`tool_result`/文本投影
  字段级截断（对齐 webbrain compactRunUiData 的取舍：success/error(1000)/summary(2000)）；
- 落盘节流：200ms debounce + 关键事件（awaiting-permission/done/error）立即 flush
  （webbrain RunUiPersistenceScheduler 模式）；
- ack 语义：sidepanel 渲染后回 `journal-ack` → 释放已渲染事件（存储瘦身）；
  `discardedBeforeSeq` 只记真实淘汰（webbrain 后期修正的语义）。

### 4.2 事件转发（event-forwarder + port-server）

- EventBus 订阅（core 10 类全转）→ journal.record（seq 编号+压缩）→ Port 广播
  `{kind:"event", seq, event}` + debounce 落盘；
- Port 连接管理：多 sidepanel 副本同连（webbrain 场景）→ 广播；断连不中断 run；
  sidepanel（重）连 → `hello` + `journal-snapshot`（快照+`discardedBeforeSeq` 提示，UI 提示
  「N 条早期事件已释放」）；
- 消息体大小护栏：单事件超 1MB 截断标记（model_result 的长文本）——Port 消息无硬限但防御性截断。

### 4.3 policy-bridge（PolicyInteraction 的侧边栏实现）

- `requestPermission(req)`：journal 置 `awaiting-permission` + flush → Port 广播
  `permission-request`（token）→ 挂起 Promise；`permission-resolve`（token 匹配）→ resolve；
  竞态护栏：同 token 二次 resolve 忽略；UI 无连接（sidepanel 关闭）时 → **立即 deny**
  （fail-closed 边界纪律：无人确认=拒绝，文案同 deny）；
- `confirmSubmit(req+summary)`：同机制，`awaiting-submit` 态 + submit 卡广播；
- PolicyGate 自带 300s prompt 超时兜底（core 既有）——桥层不重复计时。

## 5. skill 面（skill-store + skill-source）

- **IndexedDB**：db `treewalker-skills`，store `cards`（keyPath `[host+slug]`）——
  SkillCard schema = 架构 §6.2 原文（host/slug/sop/selectors/quirks/meta/status/provenance）；
- **built-in 打包**：`domain-skills/` 三套 185 文件经 WXT 构建进 bundle（`public/domain-skills/`
  拷贝或 vite 插件——实施时按 WXT 资产机制定，`_task.json` 随目录）；
- **刷新**：onInstalled/onUpdated → 遍历打包目录 → upsert（`provenance.sourceType==="built-in"`
  精确匹配才覆盖——import/distilled 卡不碰）；`newestDistilledAt` 变化触发任务卡目录重建；
- **ExtensionSkillSource implements core SkillSource**：`loadHostSkill(hostKey)`（三件套读序
  对齐 FsSkillSource：缓存/miss=null）、`taskCatalog()`（`_task.json` 目录扫描形态改 IndexedDB
  索引）、`taskCardText()`（无头 "\n\n" join——P5.5 冻结口径）；S4 匹配日志/run 注入全走 core 既有面。
- M5 不做：URL 导入安全链、蒸馏、draft 审阅流（M7）；options 只读列表（段 E）。

## 6. OPFS FileSystemProvider（opfs-fs.ts）

- `navigator.storage.getDirectory()` 根 = 虚拟工作区；`resolve()` = OPFS 内路径归一
  （无 OS abspath 语义——白名单前缀比对在 OPFS 名空间内自洽）；
- write/append/read/stat/readHead 全实现（write_file/read_file/replace_file/截图落盘/done 附件
  全链可用）；`readAttachment` 不实现（附件走注册表——段 C 缝在 ToolsOptions.fs 之外单注）；
- **登记偏离**：done 附件（files_to_display）在扩展形态只入 journal（UI 可点击预览文本类），
  不出 OS 文件系统；write 的 OS 落盘（downloads 目录）后置 M6。

## 7. attachment-registry

- `Map<attachmentId, {bytes: Uint8Array; name; mimeType; size}>`；id 形如 `att_1`（自增）；
- `attachment-add`（base64 → bytes）入表 + attachments 推送；run 结束清表（绑 run 生命周期）；
- **SW 被杀=注册表丢**：附件在 journal 的 attachments 字段有元信息——恢复呈现时 UI 提示
  「附件已失效，请重新选择后重跑」（与 interrupted 终态一致，不做字节级持久化——
  chrome.storage 塞大视频不合理；**登记有意偏离**）；
- 上限：单附件 100MB / 总 200MB 硬限（video 场景够用；超限拒绝文案）。

## 8. SW 存活与被杀语义（keepalive.ts + run-manager）

- **保活**：run 进行中 chrome.debugger 事件流（onEvent 回调）持续重置 idle timer——
  预期已够（webbrain 无 alarms 依赖长跑先例）；兜底 `chrome.alarms.create("tc-keepalive",
  {periodInMinutes: 0.5})`（run 启动创建/结束清除）——真机长任务（抖音 ~10min）验证；
- **被杀=终态 interrupted**：SW 重启（任意事件唤醒）→ run-manager 初始化时读 journal
  snapshot `status==="running"/"awaiting-*"` 且无活 run → 置 `interrupted` + lastError=
  `"Service worker was killed during the run"` → 广播。**不做消息历史 checkpoint 续跑**
  （README 决策 5；续跑能力后置登记）；
- `onDetach`（用户点横幅取消）→ run abort（InterruptedError 语义文案「用户中断」）；
- tab `onRemoved`（绑定 tab 被关）→ run abort + journal 置 interrupted。

## 9. run-manager 生命周期

- 单飞互斥：同 tab 仅一活 run（扩展单 agent 口径）；跨 tab 起跑 → 拒绝文案（「请先停止当前任务」）；
- start：绑定活动 tab → 装配（§2）→ `agent.run(keepAlive=true)`（永不关用户浏览器）→
  Promise.race(abort) → session_end → journal done/error；
- stop：AbortController（core AgentOptions 已有中断语义——实施时核实 abort 信号接线位，
  agent.ts run 循环 stop 检查位）；
- pause/resume：core 守卫链 pause 检查位（act 层）——同 stop 信号位核实后接 UI。

## 10. 测试设计

- runtime/ 全件 fake chrome（storage Map 化/Port stub/IndexedDB → fake-indexeddb devDep 或
  抽象接口注入 fake）单测：装配映射（卡片→ProviderConfig 字段全等）、journal 记录/淘汰/ack/
  恢复、policy-bridge 往返与 fail-closed、keepalive 闹钟创建/清除、run 生命周期状态机
  （start→…→终态矩阵，含 abort/interrupted 置位）；
- skill-store：built-in upsert 幂等 + provenance 保护（import 卡不被覆盖）；
- 真机 smoke（Playwright，段 B harness 扩展）：mock LLM localhost 端点（剧本化响应——
  一个 navigate+click+done 三步任务）→ 全链：起跑消息 → 权限卡请求经测试脚本代答 →
  journal 落盘断言 → done。

## 11. 段内工作项

| # | 项 | 验收 |
|---|---|---|
| D1 | host/ 八件（settings/grants/skills/secret/fs/attachments/keepalive/debugger-api） | 各自单测绿 |
| D2 | journal + event-forwarder + port-server | 单测（淘汰/ack/恢复/广播）绿 |
| D3 | policy-bridge + assemble + run-manager | 状态机单测 + fail-closed 用例绿 |
| D4 | built-in skills 打包刷新 | 真机：加载后 IndexedDB 有 185 文件投影；重装幂等 |
| D5 | Playwright mock-LLM 全链 smoke | 真机过（journal 断言 + 事件流通） |
| D6 | 门禁 | typecheck/test/gate exit 0 |
