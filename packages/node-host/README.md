# @tw/node-host — Node 宿主共享件与 `tc` CLI

Node 侧宿主共享件（NodeFs / env→配置 / 控制台观测 / Agent 装配 / esbuild 引导），examples 与未来 web-console 共享。`bin/tc`（issue #25 M1）把本仓浏览器 agent 以**任务级 one-shot CLI** 供给其它 agent 调用。

## tc 快速开始（面向调用方 agent）

前置（一次性）：

1. 仓库根 `pnpm install`；
2. Chrome 以远程调试口运行：`chrome --remote-debugging-port=9222`；
3. 配置 LLM：环境变量 `ZHIPU_API_KEY`（或 `cwd/.env` 同名键；`LLM_MODEL` / `LLM_BASE_URL` 等可选）。

用法（workspace 内）：

```bash
# 推荐：任务文本走 stdin 管道（对中文/多行最稳，避开 Windows 参数编码面）
echo "帮我到 https://example.com 查 …" | pnpm --filter @tw/node-host exec tc run --json

# 或位置参数
pnpm --filter @tw/node-host exec tc run "打开 example.com 并把标题告诉我" --json
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
| 2 | 用法/前置失败（参数错、任务文本空、缺 `ZHIPU_API_KEY`、连不上 Chrome） |

### 护栏（AutoAllow 无人值守，已拍板直用）

- `--max-steps <n>`：单 run 步数预算；
- 文件面白名单（可重复旗标，前缀匹配；透传 core 的 `allowedWritePaths/allowedReadPaths/allowedUploadPaths`）：
  - `--allow-write <path>` / `--allow-read <path>` / `--allow-upload <path>`；
  - **缺省不设 = core 默认全放行**——给外部 agent 调用时建议显式收紧（如 `--allow-write <工作目录>`）；
- 其余行为旋钮走 env（`AGENT_MAX_STEPS` / `AGENT_USE_VISION` / `AGENT_SKILLS_DIR` 等，全表见 `src/settings.ts` 头注释）。

### Windows 注意

- PowerShell 下中文输出乱码时先 `chcp 65001`；`--json` 输出恒为 UTF-8；
- 中文任务文本优先 stdin/`--task-file`（避开参数编码面）。

## 其余导出面

`loadKit()`（examples 散脚本的 kit 面）、`assembleAgent` / `runAgent`（Agent 装配与 one-shot）、`loadHostSettings` / `mergeHostSettings`（env→类型化配置）、`attachConsole`（事件观测）、`FsSkillSource`、蒸馏钩子（`distillAfterRun`）。详见 `src/index.ts`。
