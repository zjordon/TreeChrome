# SCRATCHPAD — issue #26 M1.5：tc 供给面产品化（全局命令 + --auto-chrome + skill 分发）

> 状态：**已实施并全量验证（全仓 1869 tests 绿 + gate 0 + 四重真机 smoke 全过）；待 `/review-loop` 评审收敛。** 四决策点已拍板（a 全局直装+pack 顺带 / env 链仅 CLI / ~/.claude/skills/tc / --keep-chrome）。
> 基准：issue #26 正文；#25 M1 已交付契约（stdin 优先序 / --json camelCase / 退出码 0-1-2）**全部不动**。
> 分支：`feat/issue-26-cli-m15`（自 main `1ce3d2b`）。

## 目标

把 #25 的仓内工具形态升级为 browser-use 级供给面：任意目录 `tc run --json --auto-chrome` 零前置可用 + agent 侧零学习（skill 分发）。

## 设计

### D1 自包含单文件构建 + 全局命令（issue ①）

- **构建**：`packages/node-host/scripts/build-cli.mjs`（esbuild API，复用 devDep）：`src/cli-main-entry.ts`（新，`main()` 全装配 + 版本经 esbuild `define __TC_VERSION__` 构建期嵌入 + 顶层 catch=评审轮 1 [3] 同款兜底）→ `dist/tc.mjs`（bundle/format esm/platform node，自包含 core/cdp-ws；dist 在 .gitignore，按需构建不入库）
- **staging 包**：构建同时产出 `dist/tc-package/`（package.json `{name:"tc-cli", version, bin:{tc:"tc.mjs"}}` + tc.mjs + README 拷贝）——**无 dependencies**，绕开 workspace:* 不可独立安装问题；全局安装 `npm i -g packages/node-host/dist/tc-package`（或 `npm pack` 出 tarball 分发）
- **script 面**：package.json 增 `"build:cli": "node scripts/build-cli.mjs"`
- **凭据链**（修「.env 按 CWD」跨项目坑）：`applyDotEnv` 增链式选项（多个文件**全部**应用、no-override=先到先得，不再「首个存在即停」——现有单文件缺省行为不变保 examples 兼容）；CLI main 按 **TC_ENV_FILE > ~/.tc/.env > cwd/.env** 序传入（OS env 恒最高——applyDotEnv 不覆盖既有键，语义天然成立）。runAgent 缺省行为**不改**（仅 CLI 面启用链）
- 仓内 dev 形态（`node bin/tc.mjs` + loadEntry）保留不变

### D2 Chrome 自动拉起 `--auto-chrome`（issue ②）

- 新模块 `src/auto-chrome.ts`（IO 全注入）：二进制发现（`CHROME_PATH` env > Win/macOS/Linux 标准路径表）、临时 profile 目录（mkdtemp）、spawn（POSIX detached 进程组）、`waitForCdp`（轮询 `/json/version`，注入 sleep）、`killTree`（win: `taskkill /PID x /T /F`；posix: 进程组 kill——**绝不按映像名杀**，只按我们 spawn 的 pid）
- **main 接线**：`--auto-chrome` 且 settings.browser.wsUrl === null（无显式 CDP 目标）→ 先发现；失败则 spawn + 等待就绪 → 解析出 wsUrl **显式传给 runAgent**（runAgent 零改动）→ finally 按 profile 特征收尾（`--keep-chrome` 保留调试；清理失败仅告警不失败退出）
- 显式 `CDP_WS_URL` 时 `--auto-chrome` 为 no-op（调用方自管连接，issue 已定）

### D3 skill 用法分发（issue ③）

- `packages/node-host/skills/tc/SKILL.md`（手写中文卡，与 README 同源同步义务登记在两文件头）：frontmatter（name/description）+ **When Not to Use**（curl/fetch 能拿的别开浏览器）+ 前置（9222 或 --auto-chrome；凭据链）+ 三调用形态 + JSON 契约与退出码表 + 护栏旗标 + Windows 编码
- `tc skill install [--dir <path>] [--print]`：缺省拷到 `~/.claude/skills/tc/SKILL.md`（Claude Code 个人 skill 目录）；`--dir` 自定义；`--print` 出 stdout 供管道进任意 agent 配置
- parseCliArgs 扩第二子命令 `skill`（M1 的 `run` 单子命令结构顺势扩展）

### D4 测试

- settings：applyDotEnv 链式（多文件全应用/先到先得/单文件缺省回归）
- cli/auto-chrome：二进制发现表、main 接线（发现失败→spawn→wsUrl 显式传递→finally 清理 / keepChrome 跳过 / 显式 wsUrl no-op / spawn 失败 exit 2）——discover/spawn/kill 全注入 fake
- skill install：注入 writeFile，断言目标路径/内容/`--print` 分支
- **真机 smoke（手动不入 CI）**：无 Chrome 状态 `node bin/tc.mjs run --json --auto-chrome --max-steps 5` → 自动拉起→单行 JSON→零残留（进程+临时目录）；`npm i -g dist/tc-package` 后任意目录 `tc --version`

## 实施步骤

1. settings env 链 + cli 旗标/子命令扩展 + 单测
2. auto-chrome 模块 + main 接线 + 单测
3. build-cli 构建脚本 + staging 包 + SKILL.md + `skill install` + 单测
4. `pnpm typecheck/test/lint` + gate + 真机 smoke（含全局安装）
5. `/review-loop` → `/finish-issue`

## 验收（对齐 issue #26）

- 任意目录（非仓库 CWD、无本地 .env）：`echo 任务 | tc run --json --auto-chrome --max-steps 10` 零前置跑通，stdout 单 JSON，run 后无残留 Chrome 进程/临时目录
- `npm i -g` 后 `tc --version` 显示构建嵌入版本；凭据解析 TC_ENV_FILE > ~/.tc/.env > cwd/.env
- skill 卡装入一个真实 agent 目录验证（`tc skill install` → `~/.claude/skills/tc/`）

## 不做

daemon/会话保持（#27）、npm 公网发布、权限模型变更、runAgent 缺省 env 行为变更、SKILL.md 自动生成（手写+同步义务登记）

## 待人工审核

1. **全局安装载体**：staging 目录 `npm i -g <dir>`（建议）vs 只 `npm pack` tarball vs 仅文档化 PATH
2. **env 链范围**：仅 CLI 启用（建议，examples/runAgent 行为零变更）vs runAgent 缺省也升级
3. **skill install 缺省目标** `~/.claude/skills/tc/`（Claude Code）+ `--dir/--print` 出路，是否合意
4. `--keep-chrome` 命名与语义（保留拉起的 Chrome 不清理，调试用）

## 实施记录（2026-11-08）

**落地文件**：`src/auto-chrome.ts`（新，IO 全注入）/ `src/skill-card.ts`（新，用法卡 TS 常量单源）/ `src/cli-main-entry.ts`（新，dist 构建入口）/ `scripts/build-cli.mjs`（新）/ settings.ts（applyDotEnv chain 选项 + resolveEnvChain）/ cli.ts（run|skill 双子命令 + 凭据链 + auto-chrome 接线 + wsUrl 显式透传）/ index.ts / package.json（build:cli）/ vitest.config.ts（cli-main-entry 出覆盖率）/ 测试 134（+17）/ README 重写供给面章节。

**实施期三处裁定/修正**

1. **SKILL 卡改 TS 常量单源**（`src/skill-card.ts`）：计划原写 `skills/tc/SKILL.md` 文件——但 dist 场景运行时读包内文件在 loadEntry 临时打包形态下会断（import.meta.url 指向 temp 目录）；TS 常量随 bundle 走、单源无同步义务
2. **真机实证一（Windows import 坑）**：build-cli 动态 import esbuild 绝对路径须 `pathToFileURL`（与 boot.mjs 同款，初版漏）
3. **真机实证二（npm shim 坑）**：dist 缺 shebang 时 npm 的 sh shim 落回 sh 解释 .mjs（`var: command not found`）——esbuild `banner` 注入 `#!/usr/bin/env node` 修复
4. **真机实证三（句柄竞态）**：`taskkill /F` 后立即 rm 撞文件锁留残留目录——stop() 补「kill 后 300ms 短候 + rm 三次重试（500ms 步进）」，穷尽才 warn（可手删）

**验证**

- 全仓 7 包 1869 tests 绿（node-host 117→134）；覆盖率 stmts 95.9%/branch 85.8%；gate 退出码 0
- 真机 smoke 四连：① dist 二进制跨 CWD `--auto-chrome`（Chrome 冷启动→exit 0→**零残留**）② 全局 `npm i -g` 后任意目录 `tc --version`/`tc --help` ③ `tc skill install --dir`（frontmatter 正确）④ **验收句**：任意目录 `echo 任务 | tc run --json --auto-chrome` → 单行 JSON + exit 0 + 零残留（进程/临时目录/端口全清）

## 评审轮登记

- **轮 1**（2026-11-08）：5 条意见（自评 high/medium×3/low；triage **P1×1 + P2×3 + P3×1**）**全采纳**，10m13s：
  1. [P1] spawn 失败（路径是目录/EACCES/TOCTOU）时无监听的异步 `error` 事件 → 整进程崩 exit 1 破坏契约。修复：`child.on("error", () => {})` 吞异步（pid=-1 已同步收口）
  2. [P2] detached 未 `unref()` → `--keep-chrome` 下终态已打印但事件循环被 child 句柄占住、tc 永不退出。修复：spawn 后 `unref()`；**真机验证过**（--keep-chrome exit 0 自行退出）
  3. [P2] 就绪超时路径裸 `rm` 撞锁会顶替「就绪超时」原始错误。修复：抽 `rmBestEffort`（短候+三重试+吞清理失败）统一三处清理点
  4. [P2] 测试 `AppData\\Local` 断言依赖宿主平台 join 分隔符（非 Win CI 必红）。修复：断言前归一
  5. [P3 顺手修] pid<=0 拉起失败路径泄漏 mkdtemp 目录。修复：抛错前 `rmBestEffort`；双向验证过（还原旧实现新测试必红）
  - 测试 +2（超时 rm 恒败不顶替 / pid<=0 回收断言）；134 全绿；gate 0；dist 已重建含修复
