# examples 移植（第一批：getting_started）

> 分支 `feat/examples`（自 main 97733c5）。基准：TreeWalker @640d52a。
> 前置：@tw/node-host 已合并（merge 4bf404f），薄壳模式（`loadKit` → `runAgent`）就位。

## 1. 背景与范围

本批移植 `TreeWalker/examples/getting_started/` 全部 5 个示例。逐个依赖核对结论：

| Python 示例 | 依赖核对 | 结论 |
|---|---|---|
| data_extraction.py | 纯任务驱动（runAgent 即可） | 直接薄壳 |
| form_filling.py | 纯任务驱动 | 直接薄壳 |
| multi_step_task.py | 纯任务驱动 | 直接薄壳 |
| fast_agent.py | 3 个缺口（§3） | **补线后**薄壳 |
| form_filling-pingkai.py | skills_dir 磁盘源 + save_history 均未移植；个人数据/调试残留 | **本批跳过**（§5 登记） |

## 2. 零阻力三例的薄壳形态

与 `examples/basic-agent.mjs` 同模板（~20 行）：头部注释（一句话职责 + Python 源路径）→ `loadKit()` → `runAgent({ task })` → `isDone()/finalResult()`。TASK 逐字保留 Python 原文。目录 `examples/getting-started/`，文件名 kebab-case（`data-extraction.mjs` / `form-filling.mjs` / `multi-step-task.mjs`）。

## 3. fast_agent 的三个缺口与补线

fast_agent.py 需要 `output_mode="flash"`（LLM 覆盖）+ `wait_between_actions=0.1` / `page_settle_timeout=0.5`（Browser 覆盖）。核对结果：

**output_mode 的 Python 消费面**（全仓 grep 收敛，排除 `output_model` 变体 B 误匹配——views/models/actions 的命中全是后者，已移植）：

- `config.py:285` LLMSettings 字段（缺省 `"standard"`）+ `:601-604` env `LLM_OUTPUT_MODE`（非法值 warn + 回退 standard）
- `llm/client.py:147` `self.output_mode = s.output_mode`（LLMClient 存实例字段）
- `agent/agent.py:218` `getattr(llm, "output_mode", "standard")` + `:254` 初始 tool schema
- `agent/step.py:702/759/775` 三处 `get_tool_schema(output_mode=...)`
- `registry.py:155/193/223` flash/thinking schema 分支——**TS registry.ts:200/:234 已完整实现，但从未被传入**（4 个调用点全部缺参，见缺口 A）

### 缺口 A：outputMode 全链路（core，移植保真补线）

- `LLMClient` 卡片加可选 `outputMode?: string`，实例 `readonly outputMode`，缺省 `"standard"`。
- `Agent` 构造读 `llm.outputMode ?? "standard"`（getattr 带默认值等价；注入的 fake client 无该字段 → undefined → standard，兼容既有测试）。
- `StepCtx` 加 `outputMode`；`sense.ts` 三处 + `agent.ts` 初始 `getToolSchema` 共 4 个调用点传参。
- think 层无需改动：缺字段已按 `typeof === "string" ? … : ""` 收窄（think.ts:103-119），flash 响应（只有 action）天然兼容。

### 缺口 B：Agent.waitBetweenActionsS 接线（core）

- 现状：agent.ts:185 硬编码 `0`（注释自认「Python 读 BrowserSettings.waitBetweenActions——宿主经 browser 设置传入」，但没有任何传入路径）。
- Python agent.py:93：`self.wait_between_actions = browser._settings.wait_between_actions`——从 BrowserSession 实例读。
- 补线：`BrowserSession` 暴露 public `readonly waitBetweenActionsS`（构造时取 `settings.waitBetweenActions`，Python 私有字段读取的公开化）；`Agent` 构造改读 `options.browser.waitBetweenActionsS`。
- 消费侧已就位：act.ts:42 `ctx.waitBetweenActionsS > 0` 时步内动作间隔 sleep。

### 缺口 C：node-host 设置透传

- `HostSettings.llm` 加 `outputMode`（env `LLM_OUTPUT_MODE` 解析：合法值直传，非法 warn + 回退 `"standard"`，config.py:601-604 同款；空串 = 未设置）。
- `HostSettings.browser` 加可选 `pageSettleTimeout` / `waitBetweenActions`——**不加 env**（Python 这两字段无 env，fast_agent 经 `replace()` 硬编码；保持 programmatic 口径）。
- `assembleAgent`：BrowserSession 第二参 `{}` → 透传 browser 覆盖；LLM 卡片带 `outputMode`。
- `runAgent` 加 `overrides?: { llm?; browser?; agent? }`：env 装载后合并（对应 Python `replace(settings.llm, output_mode="flash")` 模式）。合并器 `mergeHostSettings(base, overrides)` 独立导出（直连 assembleAgent 的宿主也要用）。

## 4. fast-agent.mjs 目标形态

```js
const history = await kit.runAgent({
  task: TASK,
  overrides: {
    llm: { outputMode: "flash" },
    browser: { waitBetweenActions: 0.1, pageSettleTimeout: 0.5 },
  },
});
```

## 5. form_filling-pingkai.py 跳过（偏离登记）

1. **skills_dir 磁盘源未移植**：core 只有 skillSource 注入接口（sense.ts:319 `loadHostSkill` / agent.ts:369 `taskCatalog` 消费面就位），无 `domain-skills/<host>/{_sop,selectors,quirks}.md` 读取实现，AgentSettings 也无 `skillsDir` 键（settings-defaults 对拍 EXCLUDED 名单在列）。这是**特性移植**（host 侧技能源 + 目录约定），超出示例移植范围。
2. **save_history 未移植**：rerun 录制族按 P4 立项决策整体偏离（`rerunHistoryDir` 仅存目录名，`Agent.saveHistory()` 不存在）。
3. **文件性质**：form_filling 的个性化调试变体——内嵌真实姓名+手机号、`DUMP_STEP_DOM` 调试残留（issue #157）；skill 注入与录制缺失时退化为普通 form_filling，无独立移植价值。

→ 待 skill 源 / rerun 族立项后按需补。

## 6. 测试矩阵

core（缺口 A/B）：
- LLMClient：outputMode 缺省 `"standard"` / 卡片显式 `"flash"`。
- Agent：读 llm.outputMode → 初始 toolSchema 为 flash 形态（仅 action 必填）；llm 无字段 → standard。
- StepCtx 透传：forceDoneOnLastStep / forceDoneAfterFailure 两分支 schema 含 outputMode（flash 下 done-only schema 也走 flash 形态）。
- BrowserSession：公开 waitBetweenActionsS = 设置值（缺省 0.0 / 自定义 0.1）。
- Agent：waitBetweenActionsS 从 browser 实例读取（fake browser 带 0.1 → agent 字段 0.1）。

node-host（缺口 C）：
- settings：`LLM_OUTPUT_MODE` 合法（flash）/ 非法（warn + 回退 standard）/ 空串（= 未设置）。
- mergeHostSettings：三面（llm/browser/agent）各自覆盖与保留语义。
- assembleAgent/runAgent：browser 覆盖落 BrowserSession 实例；llm.outputMode 落卡片。

真机（行为改动验收）：
- `fast-agent.mjs` headless 9333 冒烟（flash 接线是本批唯一行为改动，必须真机）。
- `data-extraction.mjs` 薄壳冒烟（任一零阻力例代表）。
- 用户网络复验（沿 basic-agent 惯例）。

## 7. 实施步骤

1. core 补线（缺口 A + B）+ 单测。
2. node-host 透传（缺口 C）+ 单测。
3. 4 个薄壳示例落 `examples/getting-started/`。
4. 真机冒烟（fast-agent + data-extraction）→ `pnpm typecheck && pnpm test` 全绿 → 门禁。

## 8. 验收

- `pnpm typecheck && pnpm test` 全绿（含新增测试）；`node scripts/gate.mjs pre-commit` exit 0。
- fast-agent.mjs 真机跑通（flash schema 生效：请求体 tool schema 仅 action 必填）。
- 4 个示例各自 `node examples/getting-started/<name>.mjs` 可直接运行（.env 配 key + Chrome 9222/9333）。

**实施结果（2026-09-30）**：全仓 1550 例绿（dom-snapshot 167 + cdp-ws 51 + core 1283 + node-host 49），typecheck/biome 过。真机冒烟（headless 9333 + .env key）：
- fast-agent.mjs：6 步 246s done（HN 站点网络不可达，模型自行降级 Algolia API 完成任务——环境因素非代码问题）；flash 全程生效（每步「目标」为空 = flash 无 next_goal 字段形态，think 层空串收窄如设计）。
- data-extraction.mjs：3 步 46s done=true successful=true（5 条名言+作者全对）；标准模式「目标」字段有值——与 flash 空目标形成正对照，模式差异线上真实生效。
- 单测锚定 wire 证据：output-mode.test.ts 断言 LLM 每步收到的 tool.parameters.required——flash 普通步与 LAST STEP done-only 步均 `["action"]`，standard 对照组四必填字段。

## 9. 评审与合并记录

（实施后填写：/review-loop 轮次、意见数、采纳情况、merge commit）
