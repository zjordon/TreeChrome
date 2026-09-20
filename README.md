# TreeChrome

TreeWalker 核心能力的 TypeScript 实现。本仓库是一个 monorepo：**平台无关的核心包**（agent loop、DOM 快照、动作、技能、权限门）+ **多个宿主应用**（Chrome 扩展、WebArena 评测 harness、web 控制台，以及未来的 TS 版 TreeWalker）。

> 设计原则：同一逻辑只写一遍。核心包是未来 TS 版 TreeWalker 的本体；Python 版 TreeWalker 在 WebArena 评测 parity 达标后退役。

## 快速开始

```bash
pnpm install
pnpm test        # vitest（含与 Python 参考实现对拍的单测）
pnpm typecheck
```

## 仓库布局

| 路径 | 状态 | 说明 |
|---|---|---|
| `packages/dom-snapshot` | 🚧 移植中 | CDP 三源融合 DOM 快照（移植自 `D:\dev\git\z_jordon\dom-snapshot`） |
| `packages/core` | 📋 规划 | Agent loop / step pipeline / actions / skills / 权限门 / Judge |
| `packages/cdp-ws` | 📋 规划 | Node 宿主的 WebSocket CDP transport |
| `packages/cdp-chrome` | 📋 规划 | 扩展宿主的 chrome.debugger transport |
| `packages/protocol` | 📋 规划 | 事件协议类型（EventBus schema，双宿主转发、UI 消费） |
| `packages/console-ui` | 📋 规划 | React 控制台组件包（侧边栏与 web 控制台共享） |
| （评测工程） | 📋 独立仓库 | evals/webarena 的 TS 后继，经 pnpm `link:` 依赖本仓核心包 |
| `apps/extension` | 📋 规划 | TreeChrome 扩展（WXT） |
| `apps/web-console` | 📋 规划 | Node HTTP/SSE 宿主（承接 tw-web） |

完整架构设计：[docs/architecture.md](docs/architecture.md)
