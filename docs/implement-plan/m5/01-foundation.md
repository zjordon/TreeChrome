# M5 段 A：基座（四包骨架 + WXT 脚手架 + @tw/protocol 类型面）

> 分支 `feat/m5-foundation`。前置：无。后续段的落点都在本段铺的骨架上。
> 验收：`pnpm build`（WXT 产物可生成）+ vitest 骨架测试绿 + 门禁 exit 0 + Chrome 手工加载 `.output/chrome-mv3` 成功（echo 消息通）。

## 0. 实施结果（2026-10-08 完成）

A1-A5 全部落地；全仓 typecheck/biome/测试全绿（新增 protocol 3 + cdp-chrome 3 + console-ui 3 例）+ 门禁 exit 0。headless chromium 真机冒烟 PASS（SW echo 往返 + sidepanel React 挂载 + 主题容器 data-tc-theme）。实施期修正与教训：

| # | 事实/修正 |
|---|---|
| 1 | **`@wxt-dev/react` 不存在**（npm 404）——WXT 的 React 接入是 `@vitejs/plugin-react` 经 `vite: () => ({ plugins: [react()] })`（官方 Frontend Frameworks 文档口径） |
| 2 | `imports: false` 下显式导入路径：`defineBackground` ← `wxt/utils/define-background`、`browser` ← `wxt/browser`（wxt 0.21.4 exports 实测） |
| 3 | apps/extension tsconfig 组合 `extends: [base, .wxt/tsconfig.json]` 后**必须显式 `"noUncheckedIndexedAccess": false`**——.wxt 默认开该档会把更严检查漏进被 import 的 core 源码（core 自身不用此档，报 8 处假错） |
| 4 | 不设 `postinstall`（避免安装期副作用），`wxt prepare` 并入 typecheck script 前置 |
| 5 | **background.ts 注册顺序教训**：消息路由先注册、宿主 API 探测放后——headless 无 sidePanel API 时 `browser.sidePanel.setPanelBehavior` 同步抛错会拖死同回调内后续所有注册（已修 + try/catch 特性探测） |
| 6 | headless 冒烟方法论（段 B e2e 固化的基础）：扩展页**不能**外部导航（`/json/new` 与直接导航都落 `chrome-error://`），必须 SW 上下文内 `chrome.tabs.create({url: chrome.runtime.getURL(...)})` 打开；`chrome.runtime.sendMessage` **不回投发送者自身上下文**（SW 自测 echo 恒「Receiving end does not exist」）——页面↔SW 往返才是有效验证；驱动通道=Node 原生 fetch/WebSocket 连 CDP（零依赖，脚本一次性放 D:\temp 不入仓） |
| 7 | 真机冒烟受 profile 缓存干扰（复用 user-data-dir 载过旧构建后页面加载怪异失败）——e2e 每跑用新 profile 目录 |


## 1. 包骨架

### 1.1 `packages/protocol`（@tw/protocol）

**纯类型包，零运行时代码**。依赖 `@tw/core`（type-only import）。

```jsonc
// package.json 要点
{ "name": "@tw/protocol", "type": "module",
  "exports": { ".": "./src/index.ts" },            // 同仓各包惯例：源码直出
  "peerDependencies": { "@tw/core": "workspace:*" } }
```

内容：

1. **事件类型 re-export**（type-only，单一事实源留在 core）：
   ```ts
   export type { TwEvent, TwEventType, StepStartEvent, /* …10 类全量 */ } from "@tw/core";
   ```
2. **SW↔UI 消息信封**（判别联合，Port 双向 + runtime.sendMessage 单发共用）：
   - SW → UI：`{ kind: "hello" }`（Port 建立握手，带当前 journal 概要）；
     `{ kind: "journal-snapshot"; runId; snapshot: RunJournalSnapshot }`（全量/恢复用）；
     `{ kind: "event"; seq; event: TwEvent }`（增量事件流）；
     `{ kind: "permission-request"; req: PermissionCardPayload; token: string }`（确认卡弹出）；
     `{ kind: "permission-cancelled"; token: string }`（超时/竞争取消）；
     `{ kind: "attachments"; items: AttachmentInfo[] }`（注册表变化推送）。
   - UI → SW：`{ kind: "journal-ack"; seq }`（事件确认，journal 释放已渲染事件）；
     `{ kind: "permission-resolve"; token; verdict: "allow-once"|"allow-always"|"deny" }`；
     `{ kind: "control"; action: "start"; task: string; attachmentIds: string[] }`
     `{ kind: "control"; action: "stop" | "pause" | "resume" }`；
     `{ kind: "attachment-add"; name; mimeType; base64 }`（选文件后送 SW）；
     `{ kind: "attachment-remove"; attachmentId }`；
     `{ kind: "diag"; command: "smoke:attach" | "echo"; payload?: unknown }`（段 B 探针/自检通道）。
   - options → SW：`{ kind: "settings-changed" }`（provider 卡变更通知，热生效）；权限/附件同上复用。
3. **Payload 类型**：
   - `RunJournalSnapshot`：webbrain RunUiJournal 快照形态的 TS 化（seq/ackedSeq/discardedBeforeSeq/
     status/events[]/startedAt/endedAt——细案 04 §4 定稿全字段）；
   - `PermissionCardPayload`：core `PermissionRequest` 的 UI 投影（capability/host/actionName/params/
     tabId/elementBbox/elementXpath + `label`（CAPABILITY_LABEL 直译）+ `expiresAt`）；
   - `AttachmentInfo`：`{ attachmentId; name; mimeType; size }`；
   - `ProviderCardDto`：ProviderConfig 的存储/表单形态（细案 04 §3.2）。
4. **校验函数不进本包**（纯类型；运行时校验由消费侧 `unknown` 收窄）。

测试：类型编译即验证 + 信封判别联合的 exhaustive switch 编译测试（`satisfies never` 惯例）。

### 1.2 `packages/cdp-chrome`（@tw/cdp-chrome）

骨架仅包壳：`package.json`（依赖 @tw/core type-only）+ `src/index.ts` 导出 `DebuggerApi` 接口
（chrome.debugger 最小签名面，段 B 实现）与 `ChromeDebuggerTransport` 占位。测试一个接口契约编译例。

### 1.3 `packages/console-ui`（@tw/console-ui）

骨架：package.json（peerDeps: react；devDep: @tw/protocol）+ vitest.config.ts（jsdom + coverage
threshold 85%，`coverage.exclude` 留好）+ 一个冒烟组件（`ThemedRoot`，主题 CSS 变量容器，段 E 扩）。
**biome.json overrides 新增**：`packages/console-ui/src` 禁 chrome.\*（noRestrictedImports/…与核心包同配置）。

### 1.4 `apps/extension`（WXT）

**不用 `wxt init` 交互向导，手工搭**（monorepo 内可控）：

```
apps/extension/
  package.json          # wxt ^0.21 + @wxt-dev/react + react/react-dom 19；workspace 依赖 @tw/core @tw/cdp-chrome @tw/protocol @tw/console-ui
  wxt.config.ts         # modules: ["@wxt-dev/react"]；manifest 权限（§2）；vite 配置继承 workspace tsconfig
  tsconfig.json         # extends 根 base；types: ["wxt/browser"]（chrome 类型经 wxt 提供）
  entrypoints/
    background.ts       # SW 壳：onInstalled 钩子（built-in skills 刷新占位）+ Port/消息 echo 路由（段 B 探针用 diag 通道）
    sidepanel/index.html + main.tsx + App.tsx   # 挂 console-ui 冒烟组件
    options/index.html + main.tsx + App.tsx     # 占位页
  assets/icon-*.png     # 占位图标（128/48/16）
```

关键配置决策：

- **关闭 WXT auto-import**（`imports: false`）——显式 import 符合仓库风格且避免 biome 未解析符号误报；
- **manifest 权限清单**（wxt.config.ts `manifest`）：
  `permissions: ["sidePanel", "storage", "unlimitedStorage", "tabs", "debugger", "downloads", "alarms"]`；
  `host_permissions: ["<all_urls>"]`（CDP 操作任意站 + LLM 端点 fetch；`http://localhost/*` 供 e2e mock）；
- **CSP 不额外放宽**（默认 `script-src 'self'`；LLM fetch 是 connect-src 由 host_permissions 覆盖，
  不需要 `connect-src` 声明——MV3 扩展页默认允许自身发起跨源 fetch 到 host_permissions 授权域）；
- ** MV3 SW 类型**：wxt 提供 `browser` 全局（类型即 chrome.*）——background.ts 是全仓唯一合法用 chrome.\* 的位置之一（biome 按路径不拦 apps/，纪律自觉：chrome 引用只进 `entrypoints/` 与 `src/host/` 粘合层）。

## 2. 工程接线

| 项 | 动作 |
|---|---|
| pnpm-workspace | `apps/*` 已在——零改动 |
| .gitignore | `+ .wxt/`、`+ apps/extension/.output/` |
| biome.json | `files.includes` 排除 `apps/extension/.wxt/**`、`.output/**`；overrides + console-ui 禁 chrome |
| scripts/gate.mjs | 无需改（目录扫描按既有 glob；`domain-skills/` 豁免先例在）——验证行数门对新文件生效即可 |
| tsconfig | 根 `tsconfig.base.json` 不动；apps/extension 自持一份（WXT 生成 `.wxt/tsconfig.json` 引用它） |
| vitest | apps/extension 的单测（SW 逻辑 mock chrome——段 D 起）进 `pnpm -r test`；WXT entrypoints 胶水 `coverage.exclude` 登记 |

## 3. 段内工作项

| # | 项 | 验收 |
|---|---|---|
| A1 | @tw/protocol 类型面（信封全量 + re-export）+ 编译级测试 | typecheck 绿；判别联合 exhaustive 用例在 |
| A2 | cdp-chrome / console-ui 包壳 | vitest 冒烟绿 |
| A3 | apps/extension WXT 骨架（manifest/entrypoints/图标） | `pnpm --filter extension build` 产物生成 |
| A4 | background echo/diag 路由 + sidepanel/options 冒烟挂载 | Chrome 手工加载：sidepanel 显示冒烟组件、diag:echo 往返通 |
| A5 | 工程接线（gitignore/biome/验证门禁） | `node scripts/gate.mjs pre-commit` exit 0 |

## 4. 出界项（登记）

- console-ui 真实组件（段 E）；cdp-chrome 实现（段 B）；skills 打包（段 D）。
- i18n：M5 全中文 UI 文案硬编码（单语用户）；i18n 框架后置。
- 主题只做 CSS 变量骨架（亮/暗跟随 `prefers-color-scheme`），视觉打磨后置。
