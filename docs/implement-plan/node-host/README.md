# node-host —— Node 宿主共享件包（@tw/node-host）

> 状态：**已确认（2026-09-29 用户确认开工，冻结实施）**。
> 工作流：本方案 → 人工确认 → 自 main 开 `feat/node-host` 实施 → `/review-loop` → 授权合并（见 AGENTS.md「新功能与重构工作流」）。

## 1. 背景

- `examples/basic-agent.mjs`（basic_agent.py 的首个移植）327 行 vs Python 55 行：多出的 ~200 行是四类宿主配套件——esbuild 加载器（50）/ NodeFs（64）/ env→配置（16）/ 控制台观测（32），外加 main 里的组装胶水。
- Python 版的 55 行是薄壳假象：`load_settings()` 一行背后是 config.py 约 240 行库代码；TreeWalker 核心直接白嫖语言运行时（`open()`/logging），TreeChrome 核心按架构铁律禁 ambient 能力，配套件必须由宿主实装注入。
- 用户决策（2026-09-29）：共享层**不能等到 M6**——① Python examples 大都要移植且要跑通才能继续开发，不能每个 example 背 ~200 行重复代码；② 核心要跑在扩展 / cli / web-console 三形态上，后两个 Node 宿主应共享代码。

## 2. 目标与非目标

**目标**
1. Node 宿主形态（examples / 未来 cli / web-console）共享一套宿主配套件，消灭散脚本重复。
2. `examples/basic-agent.mjs` 缩回薄壳（≤ 50 行）；后续 example 移植只付「任务 + 差异配置」的成本。
3. 架构文档同步：architecture.md §2 布局表加包、§4 FileSystemProvider 注明 Node 实现、§10 加 config.py→node-host 移植对照行。

**非目标（明确不做）**
- **不做包构建（tsc dist / 发布形态）**——exports 指向 `src/index.ts` 的现状不变，散脚本仍靠 esbuild 运行时引导（Node 不认 TS，esbuild 认）。dist 留到评测仓 `link:` 对接时再议（那是第一个真正需要它的消费者），届时引导段塌缩成一行 import。
- **不全量移植 config.py 的 ~60 个 env 变量**——只移植 examples 实际消费的子集，随后续每个 example 按需扩面。
- **不迁移 `tools/` 两个 smoke 的自有加载器**——验收工具刻意自包含，改动动 P4 已验收面；登记为机会性后续。
- **不移植 rerun/replay 族 example**（csv_rerun / replay.py 等）——依赖的 rerun 家族是 P4 登记偏离 3（不移植）。

## 3. 已定决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | 新包 `packages/node-host`，名 `@tw/node-host`，`private: true`，workspace 内部消费 | 与 `@tw/cdp-ws` 同级——都是「某宿主形态的配套件」定位；架构 §2 无此包，实施首个提交先改 architecture.md |
| 2 | 依赖 `@tw/core` + `@tw/cdp-ws`（workspace:*）；src 允许 `node:*` / `process.env` | 不在核心三包的 biome 限制路径内；依赖倒置的另一半——核心禁 ambient env，env→配置的合法归宿在宿主件 |
| 3 | 散脚本引导 = 包根 `boot.mjs`（纯 JS，**全仓唯一一份** esbuild 加载器），打包入口 `src/boot-entry.ts` re-export 三包导出面；包名解析走 exports→src 的 `.ts` 路径（esbuild 认） | smoke 打包 core 时 `@tw/dom-snapshot` 已走通同一条链（包名→node_modules 符号链接→exports→src/*.ts），模式已验证 |
| 4 | 两级 API：`runAgent`（one-shot）+ `assembleAgent`（拿零件） | 简单 example 用 one-shot；debug 探针类要裸 BrowserSession 逐帧驱动 |
| 5 | 权限门缺省 `AutoAllowPolicy`（注入口开放） | examples 无人值守；web-console/扩展接自己的 PolicyInteraction |
| 6 | 单段实施（不开多段闸门） | 体量约一个 P4b 段（src ~500 行 + 测试 ~400 行） |
| 7 | 本方案文件随 `feat/node-host` 分支首个提交入库（不再像 P4b 那样单独提交 main） | 新工作流（AGENTS.md）：方案落盘→确认→开分支；main 只接已评审合并 |
| 8 | **默认值口径：核心内置默认 = Python `load_settings()` 无 env 时的产出（运营默认），不等于 dataclass 裸默认**；env 层不引入第二套数值默认（见 §5.1） | Python examples/runner 实跑用运营默认；对拍口径必须一致（2026-09-29 用户评审发现） |

## 4. 模块布局

```
packages/node-host/
  package.json / tsconfig.json / vitest.config.ts   # 覆盖率阈值同各包 85%；esbuild 已在 allowBuilds
  boot.mjs                  # 纯 JS esbuild 引导（唯一一份；examples 相对路径 import）
  src/
    node-fs.ts              # NodeFs：FileSystemProvider 的 node:fs 实现
                            # （严格 utf-8/appendTextFile/stat/readHead 全九成员）
    settings.ts             # loadHostSettings(env?)：env→类型化配置（config.py load_settings 的宿主侧移植）
                            # + applyDotEnv（cwd/.env，override=false）+ checkReady（Python 原文案 key 检查）
                            # + resolveWsUrl（CDP_WS_URL ‖ discoverWebSocketUrl，async）
    console.ts              # describeEvent / attachConsole(bus) / clip —— ≈ logging.basicConfig(INFO)
    agent-boot.ts           # assembleAgent(opts) / runAgent(opts)：LLMClient + transportFactory +
                            # BrowserSession + PolicyGate(AutoAllow) + EventBus + NodeFs + Agent 共享组装
                            # + finally 收口（bus.close / browser.stop / AutoAllow 记账汇总）
    boot-entry.ts           # 散脚本打包入口（re-export core + cdp-ws + node-host 导出面）
  test/
    node-fs.test.ts / settings.test.ts / console.test.ts / agent-boot.test.ts / helpers/
```

计划中的公开 API 面（评审用，非实现）：

```ts
loadHostSettings(env?): HostSettings          // { llm, browser, agent } —— 同步，不 fetch
applyDotEnv(env?, paths?): void               // cwd/.env，override=false
checkReady(settings): { ok, message? }        // "Error: Set ZHIPU_API_KEY environment variable"
resolveWsUrl(browserCfg): Promise<string>     // CDP_WS_URL ‖ discoverWebSocketUrl(host, port)
assembleAgent(opts): { agent, browser, bus, autoAllow }   // 全注入点暴露
runAgent(opts): Promise<AgentHistoryList>     // one-shot：组装→run→finally 收口
attachConsole(bus, opts?): void               // 事件逐行打印
```

## 5. env 面（首批，名字逐字对齐 config.py）

`ZHIPU_API_KEY` / `LLM_MODEL`（缺省 **glm-5.3**，偏离见 §7）/ `LLM_BASE_URL`（缺省智谱 anthropic 端点 `https://open.bigmodel.cn/api/anthropic`）/ `LLM_MAX_TOKENS`（16384 = DEFAULT_MAX_TOKENS）/ `CDP_HOST`（localhost）/ `CDP_PORT`（9222）/ `CDP_WS_URL` / `AGENT_MAX_STEPS`（100）/ `AGENT_USE_VISION`（false）。

扩展点（随对应 example 移植时进入）：`FALLBACK_LLM_*`、`AGENT_JUDGE_MODEL`、`AGENT_LLM_SCREENSHOT_SIZE`、`SENSITIVE_DATA`。

### 5.1 默认值口径与对账（2026-09-29 用户评审补充）

**机制**：默认值不靠 env 层提供——核心包内置 `DEFAULT_AGENT_SETTINGS`（`resolveAgentSettings` 合并 partial）与 `DEFAULT_BROWSER_SESSION_SETTINGS`（`BrowserSession` 构造合并），env 只是覆盖通道；「env 子集」影响的仅是哪些键可从环境变量覆盖，loop 永远拿到完整 settings。

**问题**：Python 有两套默认——dataclass 裸默认与 `load_settings()` 的 env 缺省（**运营默认**，examples/runner 实跑用一个）；P4 移植的 `DEFAULT_AGENT_SETTINGS` 锚的是 dataclass。逐键对拍（2026-09-29）发现 3 处漂移（其余 AgentSettings 全键 + Browser 全键对齐）：

| 键 | TS 现值 | Python 运营默认 | 性质 |
|---|---|---|---|
| `enablePlanning` | false | **true**（config.py:501） | 锚了 dataclass（:163 false）；Python 默认开 PlanManager（初始规划 + replan nudge），TS 默认关——消息流行为差异 |
| `explorationActionabilityTimeout` | 2.0 | **1.5**（:538，dataclass 同 1.5） | 两套都对不上；2.0 疑似误取 rerun 家族 `rerun_actionability_timeout=2.0`（:218） |
| `explorationActionabilityReceivesEvents` | false | **true**（:540，dataclass 同 true） | 两套都对不上；false = 探索端 L1/L2 receives-events 检查默认跳过 |

**对账与防复发（随本段实施）**：
1. 核心包修正三处默认值至运营默认（`enablePlanning→true` 属行为变更：默认启用 PlanManager，相关测试跟随改写；偏离 7 中「exploration_* 不入 AgentSettings」半句已被 P4 实施演进取代，在此说明不再回改历史文档）。
2. **env 层单源纪律**：`loadHostSettings` 返回的 agent 覆盖**只携带 env 显式设置的键**，未设置的键不传（核心默认生效）；数值缺省一律引用 core 常量（`DEFAULT_MAX_TOKENS` 等）派生。宿主层自有缺省仅 `model` 名一处（glm-5.3，偏离 §7-1）。env 子集怎么扩都不会引入第二套默认。
3. **fixture 对拍兜底**：venv 实跑 `load_settings()`（无 env）dump 为 fixture（剔除宿主卡片面：api_key/base_url/ws_url/model），core 侧测试逐键断言 `DEFAULT_AGENT_SETTINGS`——防两侧未来漂移，符合「锚定 Python 实跑」纪律。

## 6. 测试矩阵（无网络、无真 LLM/CDP）

| 对象 | 覆盖要点 |
|---|---|
| NodeFs | 全九成员（tmpdir 真 fs）：严格 utf-8 非法字节 reject / append 不触旧内容 / readHead 越界与缺文件 → null / maxChars 省略全读 |
| settings | 缺省值矩阵 / 每个 env 覆盖 / 非法整数告警忽略 / 空串按未设置 / .env override=false（已设 env 不被覆盖）/ checkReady 文案逐字 / **覆盖只含显式键（未设键不出现）** |
| core 默认对拍 | venv fixture（`load_settings()` 无 env 产出，剔除宿主卡片面）逐键断言 `DEFAULT_AGENT_SETTINGS`（§5.1 兜底；fixture 归 `packages/core/test/fixtures/python-anchors/`） |
| console | describeEvent 各事件形态 + 未消费事件返回 null + clip 截断 |
| agent-boot | 假 transport + 本地 scripted provider：装配实例类型 / 门注入 / 事件流；runAgent 早退路径；happy-path 一例（FakeCdpTransport 模式本包自持小假件） |
| boot-entry | 一例 import 断言导出面存在（连带覆盖 re-export 行） |

## 7. 偏离清单（预期登记）

| # | 偏离 | 理由 |
|---|---|---|
| 1 | 模型缺省 glm-5.3（Python config.py 为 glm-5.1） | 沿用 llm-smoke 已验证卡片；`LLM_MODEL` 可覆盖 |
| 2 | `.env` 只查 `cwd/.env`（Python 查模块根 + cwd 两处） | 库包内「项目根」不可判定；override=false 语义一致 |
| 3 | env 子集而非 config.py 全量 | 按 example 需求渐进；全量移植 = 死代码 |
| 4 | 权限门缺省 AutoAllow | TreeChrome 新增层，Python 无；注入口开放 |
| 5 | **核心默认值三处修正至运营默认**（§5.1：enablePlanning→true / actionabilityTimeout→1.5 / receivesEvents→true）——非对 Python 的偏离（那才是保真），是对 TS 现状的**行为变更登记**：TS 默认行为从「不开 PlanManager」变为「开」，相关测试跟随 | 运营默认才是 examples/runner/评测对拍口径 |

## 8. 后续 example 移植路线（本段只做第 1 项）

| 类别 | 项 | 依赖 |
|---|---|---|
| **本段** | basic_agent.py → 薄壳化（重写现有 327 行版为 ≤50 行，目标形态见 §8.1；三条验证路径重跑：无 key / 无 Chrome / 假 key 组装链） | — |
| 变便宜 | upload_file*.py（P4b 上传链）/ vision_mode.py、smoke_vision_glm53.py（视觉通道）/ multi_act_demo.py | 已就位 |
| 受阻 | replay / csv_rerun（rerun 族 = 偏离 3）/ serve_web.py（web-console 形态 M6） | 未移植 |
| 按需 | debug_* 探针族（随诊断需要移植，assembleAgent 可驱动） | 逐个评估 |

### 8.1 薄壳化目标形态（验收预览，~26 行）

```js
#!/usr/bin/env node
// 示例：在简单搜索任务上跑通 TreeChrome agent（移植自 TreeWalker examples/basic_agent.py）。
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行；设置 ZHIPU_API_KEY。
// 用法：$env:ZHIPU_API_KEY="your_key"; node examples/basic-agent.mjs（PowerShell）
// 可选 env 与默认值口径见 packages/node-host/src/settings.ts 模块头注释。

import { loadKit } from "../packages/node-host/boot.mjs";

// 任务文本逐字保留 Python 版
const TASK =
  "帮我到'https://www.google.com/'搜索与'浏览器自动化'相关的信息然后获取前三条的标题告诉我";

try {
  const kit = await loadKit();
  const history = await kit.runAgent({ task: TASK });
  if (history.isDone()) {
    console.log(`\nTask completed: ${history.finalResult()}`);
  } else {
    console.log("\nTask did not complete within max steps");
  }
} catch (e) {
  console.error(`[basic-agent] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
```

要点：`runAgent` 内部完成 `loadHostSettings → checkReady → resolveWsUrl → 组装 → run → finally 收口`（缺 key/连不上 Chrome 时 throw 的即 Python 原文案，示例 catch 干净打出）；结尾 done/未完成双分支（Python 原文）留在示例层。后续 example 的边际成本 = 头注释 + 任务文本 + 可选覆盖（如 `settings: { useVision: true }`），同为 ~25 行形态；debug 探针类用 `assembleAgent` 拿零件不走 one-shot。

## 9. 风险

1. esbuild 走包名解析 `@tw/core`（exports→src/*.ts）——smoke 链已验证同模式，低风险；首个打包测试即证实。
2. 胶水包覆盖率 ≥ 85%——runAgent 全循环是主要风险点；预案：scripted happy-path 或收窄 runAgent 保证单元面。
3. 与未合并的 `feat/p4b-grid-eval` 无文件交集（只加新包 + 改 examples/ + architecture.md），自 fresh main 开分支，合并顺序无关。

## 10. 实施步骤（获批后）

1. `git checkout -b feat/node-host`（自 main；architecture.md §2/§4/§10 修改随实现提交）。
2. 实现包与薄壳化 example → §5.1 对账（core 三处默认修正 + venv fixture 对拍测试）→ `pnpm install` → typecheck / 测试 / 覆盖率全绿 → `node scripts/gate.mjs pre-commit` exit 0。
3. 三条路径真机复验（无 key / 无 Chrome / 假 key + headless Chrome 组装链）→ 提交。
4. `/review-loop --from main --to feat/node-host`（用户发起）→ 授权合并。

## 11. 评审与合并记录

### feat/node-host（2026-09-29）

- **轮 1（diffBase=main，全量 79921a7）零意见即收敛**：状态 complete、19 文件、耗时 10m43s、模型 glm-5.3——零发现零驳回，无 P3 backlog。与 p4-foundation、p4b-grid-eval 同为最干净一轮。
- 分支提交：79921a7（实现）+ 本登记提交。
- 验证快照：node-host 44 例（99.38/91.78/89.28）；core 1153 例（93.62/85.35）；门禁 exit 0；example 三路径真机 + agent-loop-smoke 两变体全过。

### 评审后修复登记（2026-09-29，用户手动测试发现）

- **core llm client 移植缺口**：用户真机首跑 basic-agent（glm-5.3 真回路）首步即 `<dict:params>` 假畸形三连 → fallback done，浏览器零操作。全真调试定位（真 Chrome + 真 key + 打点 fetch 抓 wire）：模型按 schema 返回 `action` 数组（multi_act 标准形态、name 完好，仅条目多一个顶层杂键），但 **Python client.py :559-605 的 action→actions 物化未移植**——think 层 `normalizeModelOutput` 把整个数组当单条目（`Object.keys` 数组只得被追加的 params 键）→ 假 `<dict:params>`。smoke 剧本手工双填 action+actions 两字段掩盖了缺口（真实模型从不双填）；core 管线测试全走接口级假 client，也不经过真 LLMClient。
- 修复：`materializeActionsMirror` 进 `okResult`（Python 语义：action 数组解包为 actions、非列表包裹单元素、镜像首元素、空列表→{}、`action: null` 保持 null 原样——`get` 缺省只在键缺失时生效；缺 action 键不注入，judge/extract 响应零污染）；smoke 剧本改 wire 形态（只填 action 数组）；新增 6 例回归测试 + 4 处旧断言补 actions 镜像。core 1153→1159 例全绿（93.63/85.38）。
- 真机复验：全真闭环（真 key + headless Chrome）5 步完整跑通——google 三连超时后模型自主改道 Bing 取前三条标题、诚实降级 done（沙箱网络限制，用户网络可达 google）；agent-loop-smoke 两变体回归全过。

