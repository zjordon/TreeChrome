# 项目规范

> 参照姊妹项目 `treeforge/AGENTS.md` 移植，按 TreeChrome 实际裁剪。架构决策的唯一权威是 `docs/architecture.md`，本文件与它冲突时以它为准。

## 强制执行（hooks，先读）

以下规则已由机器强制，**无需记忆、也无需手动执行**；被拦截时按提示修复即可：

| 规则 | 强制方式 |
|---|---|
| 核心包（`packages/dom-snapshot|core` 的 `src/`）禁 `chrome.*` / `process.*` / ambient env | Biome `noRestrictedImports`/`noRestrictedGlobals`（AST 级，配置在 `biome.json`）+ ZCode `PostToolUse` 即时检查 + 提交门 |
| 代码风格（2 空格/双引号/分号/行宽 100/lint 规则集） | Biome：`pnpm lint` 检查，`pnpm format` 修复，提交门强制 |
| 单源文件 ≤ 3000 行（巨石文件强制重构；>1000 行软提醒拆分） | 提交门 `size` 检查 + `PostToolUse` 对被改文件即时拦截 |
| 提交前 biome + typecheck + 测试 + 覆盖率 ≥ 85% 全绿 | 提交门（见下） |
| 临时文件（`_` 前缀草稿）、`.env`、`node_modules/`/`dist/`/`coverage/` 不入库 | 提交门（staged 检查） |

提交门 = ZCode `PreToolUse`（拦截 agent 的 `git commit`）+ 版本化 git hook（`.githooks/pre-commit`，拦截人工提交），两者共用 `scripts/gate.mjs`，可手动跑 `node scripts/gate.mjs pre-commit`。注意：`.githooks` 需每克隆执行一次 `git config core.hooksPath .githooks` 启用。

## 架构铁律

- **核心包平台无关**：对宿主能力的需求一律走 `docs/architecture.md` §4 的五个接口（CDPTransport / PolicyInteraction / Storage / Secret / FileSystem）。import 层面已被 hook 强制；接口设计层面仍需自觉。
- **配置是显式传入的类型化对象**，不是全局单例。宿主负责把 chrome.storage / env 映射成配置对象（教训：TreeWalker runner.py issue #1）。
- **移植保真高于重构**：从 Python 移植的代码，命名与行为对齐原实现；`element_tree_text` 等输出格式是与 LLM prompt 的契约，必须逐字节一致。
- **移植代码的测试期望值必须锚定 Python 参考实现实跑结果**（不是"看起来对"）：参考值生成见 `packages/dom-snapshot/test/models.test.ts` 头部；golden fixture 见验收命令。

## 设计规范

- **面向对象风格**：状态与行为收进类，跨组件共享的可变状态必须挂在明确的实例上；对宿主能力一律构造注入（§4 五接口），不做服务定位器。
- **优先套用经典设计模式**，本项目已预留的映射：
  - Strategy：动作 handler（每个动作独立策略类）、`PolicyInteraction` 实现（交互确认卡 / 评测 AutoAllow）
  - Registry：动作注册表（Python `ActionRegistry` 的移植形态）
  - Observer：EventBus → `@tw/protocol` 事件流
  - Adapter：`CDPTransport` 双实现（chrome.debugger / WebSocket）、评测的 CDPPageAdapter
  - Facade：`BrowserSession` 作为 agent 侧统一入口
  - Template Method：step pipeline 五阶段骨架（钩子步骤可覆写）
  - Chain of Responsibility：`_execute_actions` 的守卫链（stop/pause/权限门/漂移截断）
  - 不硬套：纯函数工具（`sha256Hex`、`roundHalfEven`）保持函数式，不为模式而模式。
- **单源文件 ≤ 3000 行是硬门槛**（提交门与 PostToolUse 拦截，超过强制重构）；>1000 行会收到拆分提醒。巨石文件是反面教材：TreeWalker `actions.py`（3264 行）、webbrain `agent.js`（25000+ 行）——**移植时按职责拆分模块，不照抄原项目的文件结构**。

## 代码风格

- **格式化与 lint 由 Biome 强制**（`biome.json`）：2 空格缩进、双引号、分号、行宽 100、`trailingCommas: all`、recommended 规则集。`pnpm lint` 检查，`pnpm format` 修复。
- **模块导入带 `.js` 扩展名**（`./types.js`）：tsconfig 是 `moduleResolution: bundler`。
- TS `strict` 全开；不写 `any`（逃生用 `unknown` + 收窄）。
- 模块顶部中文注释一句话写职责与移植来源；行内注释只写代码说不出来的约束。
- 核心包的 import 边界规则（禁 chrome/process）在 `biome.json` 的 `overrides` 里按路径生效，`scripts/gate.mjs` 的正则扫描作为 PostToolUse 即时反馈保留（快但粗，AST 规则是权威）。

## 运行环境

- Windows + Git Bash。优先专用工具：读文件 Read、搜索 Grep/Glob、改文件 Edit。
- 路径分隔符：仓库内引用用正斜杠 `/`。
- 中文经 shell 传参会乱码：commit message 用 `git commit -F <UTF-8 文件>`；gh 中文标题/body 走 `gh api --input <UTF-8 JSON>`（详见 `/finish-issue` 踩坑清单）。

## 包管理

- pnpm workspace；`pnpm install` / `pnpm -r run <script>` / `pnpm --filter <pkg> <script>`。不要用 npm/yarn。
- 新依赖改对应包 `package.json` 后 `pnpm install`；`pnpm-lock.yaml` **入库**。需要 postinstall 的依赖在 `pnpm-workspace.yaml` 的 `allowBuilds` 登记。
- **核心包不引入 LLM SDK**——LLM 客户端用原生 fetch 手写（架构 §3.4）。

## 单元测试要求

- **任何代码改动后必须跑相关测试全绿再结束**；新增/修改功能必须同步补测试（正常路径 + 关键边界）。覆盖率 ≥ 85% 由提交门自动强制，本地自查用 `pnpm test:coverage`。
- **测试不发真网络请求、不真调 LLM**：LLM 用注入 mock client，CDP 用 fixture / 假 transport。
- vitest 配置在各包 `vitest.config.ts`（含覆盖率阈值）；纯类型文件不参与覆盖率统计。
- golden fixture 只在刻意更新基准时重新生成，提交信息注明原因。

## 验收命令

```bash
pnpm install && pnpm typecheck && pnpm test   # 日常
node scripts/gate.mjs pre-commit               # 提交门（人工自查）
```

生成 golden fixture（借用 evals 仓 venv，它 editable 装了 tree_walker + dom-snapshot）：

```bash
D:/dev/git/z_jordon/evals/webarena/.venv/Scripts/python.exe \
  packages/dom-snapshot/tools/gen_fixtures.py --url <页面> [--url ...]
```

核对 Python 参考值（哈希/xpath/序列化片段）同样用该 venv 实跑取值。

## 目录约定

- `packages/dom-snapshot/` —— CDP 三源融合 DOM 快照；`src/protocol.ts` 三源线格式，`test/fixtures/` golden 基准。
- 其余包与 apps 见 `docs/architecture.md` §2 布局表与 §10 移植对照索引。
- `docs/` —— 架构基准；改架构先改 `architecture.md`。
- `.zcode/commands/` —— 项目斜杠命令；`.zcode/config.json` —— workspace hooks；`scripts/gate.mjs` —— 门禁；`.githooks/` —— git hook。
- 参照仓库（只读）：TreeWalker、webbrain、evals/webarena、treeforge、dom-snapshot，路径见 `docs/architecture.md` 头部。

## Git 提交规则

- **不主动 `git commit` / `git push`**；任务结束时**不主动询问"要不要提交"**——完成改动、测试全绿后直接汇报结束。
- 只有用户明确要求提交时才执行；授权后仍遵守：不 force push、不 amend 已发布提交、不跳过 hooks。
- 当前默认分支 `main`；大改动先开功能分支，除非用户要求直接在 `main` 上做。
