# @tw/node-host — Node 宿主共享件与 `tc` CLI

Node 侧宿主共享件（NodeFs / env→配置 / 控制台观测 / Agent 装配 / esbuild 引导），examples 与未来 web-console 共享。`bin/tc`（#25 M1 + #26 M1.5 + #27 M2）把本仓浏览器 agent 以两种形态供给其它 agent 调用：**任务级 one-shot**（`tc run`，本仓 LLM 驱动整段 loop）与**会话级 daemon**（`tc <动作>`，#27——调用方 LLM 直驱浏览器原语，daemon 内部无 LLM）。

## tc 快速开始（面向调用方 agent）

### 形态一：全局命令（推荐，任意目录可用）

```bash
# 仓库内构建（dist/ 不入库，按需生成）
pnpm --filter @tw/node-host run build:cli
# 全局安装 staging 包（无依赖，自包含单文件）
npm i -g packages/node-host/dist/tc-package
# 需要分发时出 tarball（可发同事 / 挂 Release 附件）
cd packages/node-host/dist/tc-package && npm pack
```

安装后任意目录：`tc run …`（卸载 `npm uninstall -g tc-cli`）。

### 形态二：仓内直启（开发/未安装时）

```bash
node packages/node-host/bin/tc.mjs run …
```

（pnpm 不为包自身的 bin 建链接，`pnpm --filter … exec tc` 不可用。）

### 前置

- **Chrome**：以 `--remote-debugging-port=9222` 运行；或 `tc run --auto-chrome` / daemon 自动拉起临时 headless 实例（用完回收，不碰日常 Chrome；显式 `CDP_WS_URL` 时为 no-op——调用方自管连接）；
- **凭据**（解析序：环境变量 > `TC_ENV_FILE` > `~/.tc/.env` > 当前目录 `.env`，逐键先到先得）：`tc run` 需 `ZHIPU_API_KEY`；会话式动作不需要 LLM 凭据（daemon 内部无 LLM）。全局安装场景建议放 `~/.tc/.env`。

### 任务级用法（tc run）

```bash
# 推荐：任务文本走 stdin（中文/多行最稳），零前置（无 Chrome 时自动拉起）
echo "帮我到 https://example.com 查 …" | tc run --json --auto-chrome

# 或位置参数 / 文件
tc run "打开 example.com 并把标题告诉我" --json
tc run --task-file task.txt --json

# 让你的 agent「天生会用」：安装用法卡到 ~/.claude/skills/tc/
tc skill install          # 或 tc skill install --print 查看内容
```

人类可读模式去掉 `--json`（过程日志 + 终态行走 stdout）。

### 任务文本解析序（已拍板：stdin 优先）

1. `--task-file <path>`：显式覆盖通道（UTF-8 文件）；
2. **stdin**（管道有内容）；
3. 位置参数。三者皆无 → 用法错（exit 2）。三通道均 trim 尾部换行/空白。

### `--json` 输出契约（camelCase）

`--json` 模式下 **stdout 只输出一个终态 JSON**，全部过程日志（agent/browser/llm/事件/权限门汇总）走 stderr——调用方解析 stdout 即可，不会被日志污染：

```json
{
  "isDone": true,
  "isSuccessful": true,
  "finalResult": "查到了…",
  "stopReason": null,
  "nSteps": 7,
  "finalizeDegradedSteps": 0,
  "attachments": ["out.csv"],
  "errors": [],
  "lastUrl": "https://…"
}
```

### 退出码

| 码 | 含义 |
|---|---|
| 0 | done 且成功 |
| 1 | 跑完但未成功（done 失败 / 未 done，带 stopReason） |
| 2 | 用法/前置失败（参数错、任务文本空、缺 `ZHIPU_API_KEY`、连不上 Chrome、Chrome 拉起失败） |

### 护栏（AutoAllow 无人值守，已拍板直用）

- `--max-steps <n>`：单 run 步数预算；
- 文件面白名单（可重复旗标，前缀匹配；透传 core 的 `allowedWritePaths/allowedReadPaths/allowedUploadPaths`）：
  - `--allow-write <path>` / `--allow-read <path>` / `--allow-upload <path>`；
  - **缺省不设 = core 默认全放行**——给外部 agent 调用时建议显式收紧（如 `--allow-write <工作目录>`）；
- 其余行为旋钮走 env（`AGENT_MAX_STEPS` / `AGENT_USE_VISION` / `AGENT_SKILLS_DIR` 等，全表见 `src/settings.ts` 头注释）。

### Windows 注意

- PowerShell 下中文输出乱码时先 `chcp 65001`；`--json` 输出恒为 UTF-8；
- 中文任务文本优先 stdin/`--task-file`（避开参数编码面）。

## 会话级用法（tc \<动作\>，#27 M2 daemon）

控制权反转：调用方 agent 的 LLM 逐步发单个动作命令，daemon（后台 Node 进程）常驻持有
BrowserSession + 动作注册表——两层 selector map / element index 活在进程内，跨调用保持
tab（**必须 daemon 化的根因**）；`get_state` 返回的 `elementTreeText`（dom-snapshot 表示）
是对外核心供给物。并发命令 FIFO 串行（单 Chrome 单 daemon——并发切 tab 会竞态）。

```bash
tc navigate --url https://example.com   # 首次调用自动拉起 daemon
tc get_state                            # elementTreeText + url/title/tabs/currentTargetId
tc click --index 12                     # 用 get_state 树里的 [12] 索引
tc input_text --index 8 --text "关键词"
tc evaluate --code "return document.title"
tc screenshot --save-path shot.jpeg     # 截图落盘（不给 --save-path 只回字节数回执）
tc tabs && tc switch_tab --tab-id 1a2b  # id 取 tabs 输出 targetId 后 4 位
tc daemon --status                      # pid/端口/空闲计时
tc daemon --doctor                      # 三类故障诊断：Chrome 没起 / daemon 僵死 / 端口占用
tc daemon --stop                        # 优雅关停（自拉 Chrome 按 PID 树回收）
```

- 动作全集（15）：`get_state / navigate / click / input_text / select_dropdown / scroll /
  find_text / read_grid / evaluate / screenshot / upload_file / go_back / tabs / switch_tab /
  close_tab`，参数细节 `tc --help`；
- **纪律**：index 类动作先 `get_state` 刷新索引再用其中的 `[N]`（过期索引找错元素）；
- 生命周期：首次调用自动拉起（detached 后台进程）；空闲缺省 15 分钟自动回收
  （`TC_DAEMON_IDLE_SECS`，`<=0` 关闭）；daemon 被杀后下一次调用自愈重拉；Chrome attach
  运行中的实例（`CDP_WS_URL` > 发现 `CDP_HOST:CDP_PORT`），不通则自动拉起临时实例随
  daemon 回收；
- 端口：缺省 `9780`（`TC_DAEMON_PORT` / `--daemon-port` 覆盖），绑定恒 `127.0.0.1`；
  运行态 `~/.tc/daemon/daemon.json`、日志 `~/.tc/daemon/daemon.log`；
- 输出契约：stdout 恒单 JSON；退出码沿用 0/1/2（1 = 动作执行失败，stdout JSON 的
  `error` 字段有因；2 = 用法/环境）；
- **安全边界（v1 拍板，登记偏离）**：daemon 无鉴权，暴露面与本机 CDP 9222 同级——仅
  127.0.0.1 可达；会话式 `upload_file`/文件动作不设白名单（调用方 agent 即信任边界；
  `tc run` 面的 `--allow-*` 护栏不受影响）。

## 构建产物（维护者）

`pnpm --filter @tw/node-host run build:cli` → `dist/tc.mjs`（版本构建期嵌入的自包含单文件）+ `dist/tc-package/`（staging 安装包）。`dist/` 在 .gitignore。

## 其余导出面

`loadKit()`（examples 散脚本的 kit 面）、`assembleAgent` / `runAgent`（Agent 装配与 one-shot）、`loadHostSettings` / `mergeHostSettings` / `applyDotEnv`（env→类型化配置；chain 模式与 `resolveEnvChain` 为 CLI 凭据链）、`launchAutoChrome`（--auto-chrome 基建）、daemon 面（`startDaemonServer` / `createDaemonSession` / `requestDaemon` / `probeHealth` / `stopDaemon` / `diagnoseDaemon` / `DAEMON_VERBS` 等）、`attachConsole`（事件观测）、`FsSkillSource`、`SKILL_CARD`（用法卡单源）、蒸馏钩子（`distillAfterRun`）。详见 `src/index.ts`。
