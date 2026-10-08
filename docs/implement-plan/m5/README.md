# M5 extension（WXT）实施计划

> 状态：2026-10-08 起草，待用户确认。
> 定位：架构 §2 `apps/extension`（WXT：SW 壳 + sidepanel + options + run journal）+
> §4 五接口的扩展实现 + §5 权限层 UI + §8 事件协议——**TreeChrome 第一个产品宿主**。
> 验收（架构 §9 M5 原文）：**抖音上传任务走通：权限卡 / submit 确认 / attachmentId 上传 / skill 注入**。
> 参照：webbrain（`D:\dev\git\z_jordon\webbrain`，设计取用代码重写）；TreeWalker @640d52a（无 UI，不涉及）；
> 本仓 core/P4+P4b/P5.5 已就绪面（见 §2 前置事实）。

## 1. 目标与产品形态

Chrome MV3 扩展：侧边栏输入任务 → SW 内跑 `@tw/core` Agent → `chrome.debugger` CDP 驱动当前活动 tab
→ 权限确认卡弹在侧边栏 → 事件流实时渲染 → run journal 落 `chrome.storage`（SW 被杀可恢复呈现）。

```
┌ sidepanel（React，@tw/console-ui）┐   Port 长连接    ┌ SW（WXT background）─────────────┐
│ TaskBar / RunTimeline / 权限卡 /   │◄──────────────►│ Agent 装配 + run 生命周期 +        │
│ SubmitCard / ControlBar / 附件选择  │  协议=@tw/protocol│ PolicyGate 交互桥 + run journal   │
└──────────────────────────────────┘                  │   ↓ 五接口扩展实现                  │
┌ options（React）──────────────────┐                  │ ChromeDebuggerTransport（@tw/cdp-chrome）│
│ provider 卡片 / always 授权管理 /   │                  │ IndexedDB SkillStore / OPFS Fs /    │
│ skill 列表（只读）                 │                  │ ChromeStorage settings/grants       │
└──────────────────────────────────┘                  └────────────────────────────────────┘
```

**任务绑定 tab**：起跑时附着当前活动 tab（`tc_runUi:<tabId>` journal 键与权限 once 授权都绑它）；
agent 的 navigate 自行跳起始页（任务文本含「起始页: URL」时由模型驱动）；tab 关闭 = run 中止。
**登录由使用者浏览器侧自行保证**（rerun 示例同款惯例，不做 cookie 注入）。

## 2. 前置事实（2026-10-08 侦察核验）

| 项 | 结论 |
|---|---|
| core 权限层 | **就绪**：`PolicyGate` + `decide` 决策表 + `GrantStore` + once/always 语义全量（P4.5）；扩展只需实现 `PolicyInteraction`（确认卡）+ `GrantStore`（chrome.storage） |
| core 事件 | **就绪**：EventBus + 10 类事件（step_start…session_end）含 usage 透传；`AgentOptions.eventBus` 注入口在位 |
| core skill | **就绪**：`SkillSource` 接口 + S4 匹配 + task-skill hit 日志（P5.5）；node-host `FsSkillSource` 为实现参照，扩展写 IndexedDB 版 |
| core upload | **路径制**（`DOM.setFileInputFiles`）；attachmentId 制是本计划 core 缝（§5 段 C） |
| submit 预确认 | **接口就位、无调用点**：`PolicyInteraction.confirmSubmit` 存在但 core 无 submit 特征检测——本计划补（段 C） |
| chrome.debugger 子会话路由 | **可行（webbrain 实证）**：`sessionId` 放 Debuggee 对象（`{tabId, sessionId}`）即 flat 多会话；`onEvent` source 带 sessionId（cdp-client.js:187-194） |
| 扩展内无路径上传 | **方案在案（webbrain 实证）**：`Runtime.callFunctionOn` 页面内 File+DataTransfer 注入（`setFileInputData`，cdp-client.js:2189）——attachmentId 模式执行端 |
| WXT | v0.21.4（2026-06）；sidepanel=HTML entrypoint 自动 manifest；React 官方模块 `@wxt-dev/react`；Vite 内核 |
| workspace | `apps/*` 已在 pnpm-workspace.yaml——零配置接入 |
| dom-snapshot golden | 复用 `test/fixtures/` 做 cdp-chrome 扩展内采集对拍基准（段 B 真机验证） |

## 3. 交付物：三新包 + 一应用

| 包 | 职责 | 关键纪律 |
|---|---|---|
| `packages/cdp-chrome`（@tw/cdp-chrome） | `CdpTransport` 的 chrome.debugger 实现（根会话适配 + tabs 重映射 + 事件路由） | 不依赖 WXT/扩展环境——收 `chrome.debugger` 形状的注入接口，Node 单测可 mock |
| `packages/protocol`（@tw/protocol） | 事件类型 re-export（自 core，type-only）+ SW↔UI 消息信封（Port 协议、journal 快照、权限卡往返、控制指令） | 零运行时代码（纯类型），console-ui 只依赖它不依赖 core |
| `packages/console-ui`（@tw/console-ui） | React 组件：RunView/步骤流/控制条/权限卡/submit 卡/附件选择/设置件 | **禁 `chrome.*`**（biome 同核心包规则）——chrome 交互留在 apps/extension 粘合层，M6 web-console 直接复用 |
| `apps/extension`（WXT） | SW 壳（agent 装配/run 生命周期/journal/Port 服务）+ sidepanel + options + built-in skills 打包 | webbrain 参照件只取设计；sidepanel.js 13k 行是反面教材，按组件拆分 |

## 4. 段划分（六段闸门分支制，沿用 P4 惯例）

每段独立分支 → 实施 → `/review-loop` → `--no-ff` 合并 → 删分支。小 diff 是评审收敛的第一变量。

| 段 | 分支 | 内容 | 细案 | 预估 |
|---|---|---|---|---|
| A 基座 | `feat/m5-foundation` | 四包骨架 + WXT 脚手架（manifest 权限/biome/gate/gitignore 接线）+ @tw/protocol 类型面冻结 + 最小 background（echo 消息，为段 B 探针铺路） | [01](./01-foundation.md) | 1d |
| B transport | `feat/m5-cdp-chrome` | cdp-chrome 全量（Debuggee 路由/根会话适配/switchTab 重映射/mock 单测）+ Playwright 加载扩展的 smoke：附着→采集→golden 对拍一页 | [02](./02-cdp-chrome.md) | 2~2.5d |
| C core 缝 | `feat/m5-core-seams` | upload attachmentId 二态（`FileSystemProvider.readAttachment` + `setFileInputData`）+ submit 预确认（特征检测 + `confirmSubmit` 调用点 + 字段摘要）。**Node 宿主行为逐字节不变**（红绿双向验证） | [03](./03-core-seams.md) | 1.5~2d |
| D SW 运行时 | `feat/m5-sw-runtime` | agent 装配（storage→ProviderConfig/AgentSettings）+ 五接口扩展实现（settings/grants/skills/settings secret/OPFS fs）+ attachment 注册表 + run journal + Port 事件转发 + SW 存活/被杀语义 + built-in skills 打包刷新 | [04](./04-sw-runtime.md) | 2.5~3d |
| E UI | `feat/m5-ui` | console-ui 组件全量（vitest+testing-library）+ sidepanel/options 装配 + 主题骨架 | [05](./05-ui.md) | 2.5~3d |
| F 验收 | `feat/m5-acceptance` | 抖音上传全链路真机（用户执行，剧本在案）+ Playwright e2e 三件（权限卡记账/SW 杀恢复 journal/mock LLM 端到端）+ 门禁收口 | [06](./06-acceptance.md) | 1.5~2d |

依赖序 A→B→C→D→E→F 串行（C 与 B 无依赖可对调，但 C 改核心包需独立评审聚焦，排 B 后）。
合计预估 **11~13.5d**。

## 5. 关键设计决策（已定，细则见各段细案）

1. **chrome.debugger 根会话适配**（段 B）：`chrome.debugger.attach({tabId})` 本身即 page session；
   core `connectSession` 的 `Target.getTargets/attachToTarget` 握手由 transport 拦截合成（附着 tab 即唯一
   page target；返回合成根 sessionId 标记）。OOPIF 子会话走真实 flat 协议（Debuggee 带 sessionId）。
   真机探针先行验证原生握手不可行后再落拦截方案。
2. **upload 二态**（段 C）：`ACTION_DEFINITIONS` 零改动（schema 是 prompt 契约）；attachment 引用形如
   `attachment:att_1` 塞进 `params.path`（自由字符串），命中 `readAttachment` 走 bytes 分支
   （DataTransfer 注入），未命中走原路径分支。附件清单由宿主写进任务文本（模型可见用法说明）。
3. **submit 预确认**（段 C）：PolicyGate 组合内 CLICK 放行后追加 `confirmSubmit` 二道门（AutoAllow
   恒 true 保评测零阻塞）；特征检测与字段摘要（≤8）为 core 纯件 + 小 JS 探测。
4. **skill 面**（段 D）：`domain-skills/` 三套 185 文件随扩展打包（built-in），onInstalled/onUpdated
   刷新进 IndexedDB（provenance 精确匹配才覆盖，架构 §6.2）；`ExtensionSkillSource` 实现 core
   `SkillSource` 读 IndexedDB。URL 导入与蒸馏后置 M7。
5. **SW 被杀 = run 终态 interrupted**（段 D，**有意偏离** webbrain run-reconnect）：不做消息历史
   checkpoint 续跑（过度工程）；journal 恢复呈现 + UI 提示重跑。保活策略（debugger 事件流重置 idle
   timer + alarms 兜底）真机验证。
6. **事件转发用 Port 长连接**（段 D）：`chrome.runtime.connect`（事件流高频，优于逐条 sendMessage）；
   协议类型全部收敛在 @tw/protocol（信封 + 判别联合）。
7. **console-ui 禁 chrome.\***（段 E）：组件收 props/回调，chrome 交互在 apps/extension 粘合层——
   M6 web-console 零改动复用的前提（架构 §1 原则 3）。
8. **不打包 content script**（简化，登记偏离）：架构 §5.4 的 file-picker-guard 双保险中，协议级
   `Page.setInterceptFileChooserDialog` 拦截 core 已常开（connection.ts `enableFileChooserIntercept`）；
   MAIN-world content script guard 层后置——若抖音真机暴露 OS 原生弹窗再补（风险登记 §7）。

## 6. 与既有纪律的衔接

- **核心包平台无关不受影响**：chrome.debugger/IndexedDB/chrome.storage 全部落在 cdp-chrome 与
  apps/extension（biome 的 noRestrictedImports 按路径只管 packages/dom-snapshot|core 的 src）；
  **新增** `packages/console-ui/src` 进 biome overrides 禁 chrome.*（设计决策 7）。
- **cdp-chrome 可测性**：不直接引用全局 `chrome`——定义 `DebuggerApi` 注入接口（attach/sendCommand/
  onEvent/getTargets/detach 的最小签名），SW 侧传入 `chrome.debugger`，Node 单测传 fake——与 core
  注入纪律同构（TransportFactory 先例）。
- **测试纪律**：单测零真网络零真 LLM（e2e 用 localhost mock provider 端点）；覆盖率 ≥85% 提交门
  对新包照常（WXT entrypoints 胶水文件 coverage.exclude，登记在段 A）。
- **移植保真**：段 C 两处 core 缝不改变 Node 宿主可观测行为（Python parity 锚点测试不动、全绿为验收项）。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| chrome.debugger 原生握手（getTargets/attachToTarget）行为与预期不符 | 段 B 首工作项=真机探针脚本（Node 经 CDP ws 对照扩展内 chrome.debugger 两种路径各跑握手序列），按探针结果在「拦截合成」与「原生直通」间定案；细案 02 §2 预置两方案 |
| switchTab 跨 tab 重映射（detach+attach）丢失页面状态/事件订阅 | 重发域序列 core 已有（enableSessionDomains，F9.4）；探针覆盖 switchTab 场景；transport 层事件监听与 Debuggee 解绑关系单测锚定 |
| MV3 SW 30s idle 被杀（30min+ 长任务） | 段 D 存活专项：chrome.debugger 事件流重置 idle timer（主流情形已够）+ alarms 30s 心跳兜底；真机长任务验证；被杀 → journal interrupted 终态（决策 5） |
| WXT 与 pnpm/biome 集成摩擦（.wxt 生成类型/auto-import 与 lint 冲突） | 段 A 落地时关闭 auto-import（显式 import 符合项目风格）、`.wxt/`/`.output/` gitignore+biome files 排除；骨架 smoke（build 产物可加载）为段 A 验收项 |
| Playwright e2e 依赖体量（chromium ~300MB） | devDep + allowBuilds 登记；e2e 独立 script 不进 vitest 默认跑；CI/本地二选一执行（本仓无 CI，本地手动） |
| 抖音真机受模型概率性行为影响（谎报完成三部曲前科） | 验收剧本以「动作回溯核对」为准（步骤日志逐条对上 9 项关键动作），不以模型自评为准（SR 同款口径） |
| 「正在被调试」横幅（chrome.debugger 固有 UI） | 产品形态接受（webbrain 同款）；侧边栏首跑提示文案说明；无技术对策（Chrome 行为） |
| vision 模式后台标签截图饿帧（记忆在案） | M5 默认 `useVision=false`（GLM 文本模式不受影响）；vision 跑批约束写进验收注意项，不在 M5 解 |
| IndexedDB 在 SW 的配额/演化风险 | chrome.storage.local（unlimitedStorage）兜底；SkillStore 抽象接口隔离（M6 可换实现） |

## 8. 验收（段 F 细化，架构 §9 M5 门的操作化）

1. **抖音上传全链路（真机，用户执行）**：加载未打包扩展 → options 配智谱 provider 卡 → 侧边栏输入
   抖音上传任务 + 选视频文件 → 权限卡（首次 click/type prompt + allow-always 记账）→ submit 确认卡
   （发布表单字段摘要）→ `upload_file path=attachment:att_1` 真实落文件（DataTransfer 注入）→
   douyin domain-skill 注入生效（日志 `[Domain Skill]` 段）→ done。动作回溯核对通过即验收（剧本见 06 §2）。
2. **Playwright e2e 三件**（本地 fixture 页 + mock LLM server）：权限卡交互与 always 授权持久化 /
   SW 手动 kill 后 journal 恢复呈现 interrupted / mock 端到端跑完一个本地任务。
3. **门禁收口**：`pnpm install && pnpm typecheck && pnpm test` 全绿（新增四包计入覆盖率门）+
   `node scripts/gate.mjs pre-commit` exit 0。
4. **Node 宿主回归**：examples 抽样 3 例（fast-agent/upload-file/sensitive）真机回归——core 缝零行为
   变化的端到端证据。

## 9. 评审轮登记（/review-loop）

> 段独立评审循环的处置账本（严重度门控与收敛规则见 .zcode/commands/review-loop）。

### 段 B `feat/m5-cdp-chrome`

- **轮 1（2026-10-08，diffBase=main，15 文件，18m31s）**：意见 6（high×3/medium×2/low×1）→
  **采纳 5 P2 + 1 P3 顺手**，驳回 0 / stale 0。
  - **[2] 探针仪器缺陷引发设计翻案（本轮最重）**：probe2 q4 漏发 setAutoAttach（假阴性证据）——
    修正探针后实证 `Target.setAutoAttach` 可用：Worker 子会话事件（source.sessionId）+ 子会话命令
    路由（Debuggee {tabId, sessionId}，Worker 上下文 evaluate 成功）双通；**撤 no-op 拦截改透传**，
    02 §0 事实表 #5 已改写（被拒的只剩显式 attachToTarget——根握手方案 S 不变；OOPIF 本机对不足
    触发，段 F 真机复核）。
  - [4] createTarget 透传后 targetInfosCache 不失效——navigate(new_tab) 链 activateTarget 必抛
    "not found"（100% 失败）：透传后置空缓存 + closeTarget 同族；动态世界 fake 回归（红绿双向）。
  - [5] 关当前锚定 tab → onDetach(target_closed) 永久击穿会话：suppressDetachForTab 抑制标记
    （core closeTab 随后 getTargets+switchTab 重锚照常）+ fake 派发 detach 回归。
  - [6] 事件源不按锚定 tab 过滤——switch 重叠窗/旧 tab detach 失败残留串扰（recentEvents/
    networkIdle/fileChooser 污染）：globalEventHandler 按 currentTabId 过滤（无 tabId 事件放行）。
  - [1] background smoke 兜底：core start() 失败分支只置 transportRef=null 不级联 stop——闭包
    transport 直接 stop（幂等）；TS CFA 窄化用 ref 对象持有关闭点。
  - [3] P3 顺手：probe1 死块（无超时等待下一事件，挂死风险）删除并改为完整 sid 立即路由验证。
  cdp-chrome 30→35 例（覆盖率 98.79%）；对拍 smoke 复跑 PARITY PASS（setAutoAttach 透传后全链
  一致）；门禁 exit 0。
  本轮 P1/P2：5（已实施）｜P3：1（顺手修）。
- **轮 2（2026-10-08，增量 diffBase=84a3c17，6 文件，15m13s）**：意见 2（high×1/medium×1）→
  **采纳 2 P2**，驳回 0 / stale 0。
  - [2] suppressDetachForTab 在 tabs.remove 抛错时未回滚——残留标记会吞该 tab 后续真实
    detach（canceled_by_user/replaced_with_devtools），markDetached 失灵：remove 失败清标记
    再上抛 + 回归（fake 抛 "cannot be edited" 后真实 detach 照常击穿）。
  - [1] probe2 setAutoAttach 作用域错位（q2 若成功则经新 tab 会话路由、worker 却在 tabA——
    假阴性）：固定根路由（当前实测 q2 恒败故未触发，工具健壮性收口）。
  cdp-chrome 35→36 例；门禁 exit 0。
  本轮 P1/P2：2（已实施）｜P3：0。

- **轮 1（2026-10-08，diffBase=main，30 文件，6m4s）**：意见 1（high/bug）→ **采纳 1 P2**。
  gate.mjs 把 console-ui 纳入 CORE_PACKAGES 但 `SRC_EXT`/`CORE_SRC_RE` 只认 `ts|mts|mjs`——
  .tsx 组件文件在 boundaries/hookEdit/size 三处扫描空转，「双强制」宣称对 gate 层 fail-open。
  修复：两处扩展名集合补 `tsx|cts`（与 biome files.includes 口径对齐）；CORE_SRC_RE 收口为导出的
  `isCoreSrcPath()`（hookEdit 消费同一实现）+ gate.test.mjs 补回归 6 例；红绿双向验证
  （注入 `import "chrome"` 进 themed-root.tsx → boundaries exit 2 拦截；还原后 exit 0）。
  驳回 0 / stale 0。门禁 exit 0（gate 单测 14 例绿）。
  本轮 P1/P2：1（已实施）｜P3：0。
- **轮 2（2026-10-08，增量 diffBase=9a49cc9，2 文件，2m15s）**：**零意见**——循环收敛。
  累计：2 轮，意见 1 / 采纳 1 / 驳回 0 / stale 0；分支 2 提交（9a49cc9 + 6b55b43）待授权合并。
