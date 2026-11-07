# SCRATCHPAD — issue #25 M1：任务级 one-shot CLI（tc run）

> 状态：**已实施并全量验证；评审循环 2 轮收敛（轮 1 三条全采纳、轮 2 零意见）。待 `/finish-issue` 收官。**
> 基准：issue #25（可行性 + browser-use CLI 3.0 调研 + 决策点拍板评论）；`docs/architecture.md` §2 cli 宿主规划；AGENTS 新功能工作流。
> 分支：`feat/issue-25-cli`（自 main）。计划已过人工审核（2026-11-07，bin 名 `tc`/D4 泛化/JSON 字段集一并通过）。

## 目标

`@tw/node-host` 提供 `tc` bin：`tc run` 从 **stdin（优先）**/argv/`--task-file` 读任务文本 → `runAgent`（AutoAllow）→ 人类可读或 `--json` 机器输出 → 退出码 0/1/2。调用方（其它 agent）零浏览器知识即可驱动本仓 agent。

## 已拍板决策（issue #25 评论）

1. **权限**：AutoAllow 直用；护栏 = `--max-steps` + 既有 allowedWritePaths / allowedUploadPaths（settings/env 面，不新增 CLI 专有开关）
2. **`--json` 键形**：camelCase（评测 snake_case 轨迹转换层不混入 CLI 面）
3. **包位**：`@tw/node-host` 加 bin（不建 apps/cli 薄壳）
4. **任务文本**：stdin 优先（stdin > argv 位置参数；`--task-file` 为显式覆盖通道）

## 设计

### D1 命令面（bin 名 `tc`）

- `tc run [task] [--json] [--task-file <path>] [--max-steps <n>]`；`tc --help` / `tc --version`（读包 version）
- M1 只此一个子命令（`tc` 裸调用 → help）；M2 会话式再扩子命令面
- 参数解析 Node 内置 `util.parseArgs`，零新依赖

### D2 任务文本解析序（`resolveTaskText` 纯函数）

1. `--task-file` 给定 → 读文件（UTF-8；缺失/读失败 → exit 2）
2. stdin 为 pipe（`!process.stdin.isTTY`）且内容非空白 → 用 stdin
3. argv 位置参数非空 → 用它
4. 皆无 → stderr 用法示例 + exit 2（browser-use 空 stdin 报错带示例同款）

### D3 输出契约

- **人类模式（缺省）**：过程日志照常 stdout（attachConsole 面）+ 终态行（`Task completed: <finalResult>` / 未完成与失败行，对齐 examples 文案）
- **`--json`**：**stdout 只出一个终态 JSON**；过程日志全部走 stderr——`runAgent({log})` 注入 stderr writer 即可（assembleAgent 的 `log` 与 attachConsole 的 `print` 同走该 sink，注入面已核实，零 core 改动）
- JSON shape（camelCase，`projectRunJson(history)` 纯函数投影）：

```json
{
  "isDone": true,
  "isSuccessful": true,
  "finalResult": "…",
  "stopReason": null,
  "nSteps": 7,
  "finalizeDegradedSteps": 0,
  "attachments": ["…"],
  "errors": [],
  "lastUrl": "https://…"
}
```

- **退出码**：`0` = isDone && isSuccessful；`1` = run 跑完但未成功（含 not-done / stopReason 非空）；`2` = 用法/前置失败（参数错、任务文本空、缺 key、连不上 Chrome——沿用 runAgent 的 Python 同款文案）

### D4 bin 引导（复用 boot.mjs 机制）

- `boot.mjs` 泛化：抽出 `loadEntry(entryRelPath)`（`loadKit()` 收敛为其调用，签名与行为不变）；新增 `src/cli-entry.ts`（组装入口 `main()`）
- `bin/tc.mjs`：薄壳 → `loadEntry("./src/cli-entry.ts")` → `main()`
- 每次调用 esbuild 现打包含启动开销（~200ms 量级），M1 接受；打包缓存不做
- `packages/node-host/package.json` 增 `"bin": {"tc": "./bin/tc.mjs"}`（private 仓不发布；workspace 内 `pnpm --filter @tw/node-host exec tc …` 直用）

### D5 逻辑层拆分（`src/cli.ts`，纯函数主战场）

- `parseCliArgs(argv)`：parseArgs 封装 + 校验（未知项 / `--max-steps` 非正整数 → 用法错 exit 2）
- `resolveTaskText({taskFile, stdinText, argvTask})`：D2 解析序（IO 外置注入可测）
- `projectRunJson(history)`：AgentHistoryList → D3 JSON（attachments 取 done 步 `r.attachments` 并集；errors 收集各步非空 `error`；lastUrl 取末步 `stateSummary.url`——键名以 finalize.ts 实际产出为准，实施时核对）
- `exitCodeOf(history)`：D3 退出码
- `main()`（cli-entry.ts）：resolveTaskText → `runAgent({task, log, overrides: {agent: {maxSteps}}})` → 按模式输出 → 置 `process.exitCode`

### D6 测试

- `cli.ts` 纯函数单测：parse 正常/边界（中文任务文本、非法 `--max-steps`、未知 flag）、resolve 四分支、project 三态（done 成功 / done 失败 / not-done）、exitCode
- 集成：fake transport + scripted LLM（node-host 既有测试模式）跑 `--json` 全链——断言 stdout 恰一个可解析 JSON、过程行全落 stderr、退出码正确
- 真机 smoke（手动，不入 CI）：`echo "任务" | pnpm --filter @tw/node-host exec tc run --json`（Chrome 9222 + ZHIPU_API_KEY）

### D7 文档

- 新建 `packages/node-host/README.md`：面向**调用方 agent** 的使用说明（对应 browser-use SKILL.md 角色）——前置（Chrome/9222、env 面）、stdin heredoc 示例、`--json` 契约与退出码表、Windows 编码注意（chcp 65001）

## 实施步骤

1. `boot.mjs` 泛化 `loadEntry`；`src/cli.ts` 纯函数 + 单测
2. `src/cli-entry.ts` + `bin/tc.mjs` + package.json `bin` 字段
3. `--json` 全链集成测试；`packages/node-host/README.md`
4. `pnpm typecheck` / `pnpm test` / `pnpm lint` 全绿；`node scripts/gate.mjs pre-commit`；真机 smoke
5. `/review-loop` 评审收敛 → `/finish-issue` 收官

## 验收

- `echo "…" | tc run --json`：stdout 恰一个 camelCase JSON，过程日志全 stderr，退出码语义正确
- 无 stdin 无参数：用法提示 + exit 2；缺 ZHIPU_API_KEY / Chrome 未起：Python 同款文案 + exit 2
- 人类模式终态可读；`--max-steps` 透传生效（overrides 面已有机制）
- 全仓 typecheck/test 绿；node-host 覆盖率 ≥85%；gate 全绿

## 不做（M1 边界）

daemon/会话式（M2 另期）、MCP server、Chrome 自动拉起、npm 发布、bin 打包缓存、finalResult 额外脱敏（与 examples 同口径——sensitiveData 占位符机制在上游已处理）

## 待人工审核

1. bin 名 **`tc`** 是否合意（备选 `tw` / `treewalker`）
2. D4 boot.mjs 泛化方案（vs bin 内复制一份引导——前者单源，倾向采纳）
3. `projectRunJson` 字段集是否够用（调用方视角：isDone/isSuccessful/finalResult/stopReason/nSteps/attachments/errors/lastUrl）

## 实施记录（2026-11-07）

**落地文件**

- `packages/node-host/boot.mjs`：泛化出 `loadEntry(entryRel)`（esbuild stdin re-export 形态）；`loadKit()` 收敛为其预置入口调用，examples 消费面零改动
- `packages/node-host/src/cli.ts`（新）：纯逻辑层——`parseCliArgs`（util.parseArgs strict 封装，help/version 先于子命令校验）/ `resolveTaskText`（stdin 优先序，三通道 trim）/ `projectRunJson`（camelCase 投影）/ `exitCodeOf` / `renderHumanResult` / `main(deps)`（IO 全注入：argv/stdin/readFile/out/err/run/version）
- `packages/node-host/bin/tc.mjs`（新）：薄壳——版本号运行时直读包 package.json（bin 不经打包器），`loadEntry("./src/cli.ts")` → `main()` → `process.exitCode`
- `packages/node-host/package.json`：`bin: {"tc": "./bin/tc.mjs"}`
- `packages/node-host/src/index.ts`：cli 面导出（main/纯函数/USAGE）
- `packages/node-host/test/cli.test.ts`（新）：22 条——纯函数四组 + main 壳契约（--json stdout 恰一 JSON/过程日志走 stderr/stdin 优先/task-file 覆盖/退出码 0-1-2/护栏旗标透传 overrides）
- `packages/node-host/README.md`（新）：面向调用方 agent 的使用说明（前置/stdin 示例/JSON 契约/退出码表/护栏/Windows 编码）

**对计划的两处实施期裁定**

1. **白名单旗标扩展（D1 面扩大）**：计划假设文件面白名单走「既有 settings/env 面」——实施发现 `allowedWritePaths/allowedReadPaths/allowedUploadPaths` **无 env 键**（env 面只有 AGENT_MAX_STEPS 等），且 core 缺省 `null = 全放行`（`whitelistAllows(null)=true`）。CLI 调用方若无通道设白名单，AutoAllow 直用即文件面无限制，违背 issue 风险条款（"必须成为 CLI 级开关"）。落地为三个可重复旗标 `--allow-write/--allow-read/--allow-upload` → `overrides.agent.*`（暴露既有 settings 键，非新增 capability 开关；缺省不设 = core 默认，README 明示建议显式收紧）
2. **cli-entry.ts 取消（D4 简化）**：`loadEntry` 直连 `src/cli.ts` 即可（cli.ts 自含 main 与依赖闭包），无需中间入口文件

**验证**

- `pnpm --filter @tw/node-host typecheck` 绿；node-host 116 tests 全绿（cli 22），覆盖率 stmts 96.17%/branch 88.76%（阈值 85%）
- 全仓 `pnpm test`：7 包 1851 tests 全绿；`pnpm lint` 仅 main 既有 warning（sidepanel-app.tsx 未用导入，非本次面）
- bin 离线冒烟：`--help`/`--version`(0.2.0)/空任务→exit 2、Chrome 未起→Python 同款文案 + exit 2 且 `--json` 下 stdout 零污染
- **真机 smoke**：临时 profile headless Chrome(9222) + .env 真实 ZHIPU_API_KEY——中文任务经 stdin → `--json` stdout 恰一行（`isDone:true/isSuccessful:true/finalResult:"Example Domain"/nSteps:1/lastUrl 正确`），16 行过程日志全落 stderr，exit 0；smoke 实例与临时目录已按 profile 特征精确清理

## 评审轮登记

- **轮 1**（2026-11-07）：3 条意见（自评 high/medium/low；triage 定级 **P1×1 + P2×2 + P3×0**）**全采纳**，25m07s：
  1. [P1] `--task-file` 就绪时仍无条件 `await stdin.text()`——coding agent 以缺省 pipe stdio spawn（stdin 永不关闭）永久挂起。修复：task-file 通道就绪即跳过 stdin 读取（「stdin 优先」只在 stdin 与 argv 间裁决）
  2. [P2] stdin 读取在 try 外——`error` 事件未处理拒绝崩成 exit 1，违背「前置失败=2」契约。修复：try/catch 收口 stderr + exit 2
  3. [P2] bin/tc.mjs 顶层无兜底——esbuild 缺失等启动失败崩成 exit 1。修复：顶层 catch → stderr + exit 2（bin 在包根不入单测覆盖，代码检视级修复 + 契约同构于 [2] 的已测路径）
  - 测试 +1（含挂起防护双分支 + EPIPE 收口）；117 全绿；双向验证过（旧实现下新测试必红）；gate 退出码 0（一次瞬态 ec=2 判定为背靠背 vitest 全量跑的覆盖率目录锁竞争，两次复跑均绿）
- **轮 2**（2026-11-07）：**零意见、状态 complete——循环收敛出口**（增量 diff = 修复提交 033bcc7，3m54s）。插曲：首发误把增量基线写成 `lastCommit`（= 分支 tip）得 `skipped` 空档；修正为「上一轮评审覆盖到的 tip」（f6a1906）重发。累计 stats：2 轮 / 3 意见 / 采纳 3 / 驳回 0 / stale 0。
