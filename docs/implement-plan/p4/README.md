# P4 core 主体移植 · 实施计划

> 状态：2026-09-27 起草，待评审后冻结。实施计划总纲见 `docs/implementation-plan.md` §P4；架构依据见 `docs/architecture.md` §3（core 移植面）/ §4（宿主接口）/ §5（权限层）。
>
> **P4 的对拍基准与 P3 同构（双层）**：本文档冻结契约与有意偏离，Python 参照（TreeWalker @ `640d52a`）冻结行为语义。P4 与 P3 的差异在体量——参照实现约 1.4 万行 Python（session.py 5081 + step.py 2238 + actions.py 3264 + agent.py 705 + models/registry/prompts/skills/judge/config 等），因此**范围裁剪是本文档的第一决策**（见 §3），裁剪掉的都以「接口槽预留」方式留位，后续批次只填实现不改设计。

## 1. 前置检查点（总纲 P4 启动条件，已核验）

| # | 条件 | 结论 |
|---|---|---|
| 1 | TreeWalker 相关目录连续无结构性提交，用户确认稳定 | **满足**：用户 2026-09-27 确认；`640d52a`（2026-09-21）以来上游无新提交，architecture.md 定稿（09-20）后仅 4 个提交且均为 fix/docs（#194/#195/#197/#198） |
| 2 | 快照审查：§3 移植要点表与实际代码比对 | **已做**，漂移清单见 §2 |
| 3 | 记录基准 commit | **`640d52a`**——P5 parity 对照以此为 Python 侧版本 |

## 2. 快照审查结论（architecture.md 定稿后的上游漂移）

五阶段行号全部漂移（+36~+89），两处行为漂移是 architecture.md 定稿当天/次日的 #194、#197 合入所致：

| architecture.md 断言 | 现状（640d52a） | 影响 |
|---|---|---|
| Sense step.py:284 / Think :760 / Act :1274 / Post :1518 / Finalize :1602 | **:320 / :796 / :1357 / :1601 / :1691**；`_step` 编排器 :216-297 | 行号修订（§3.1 表） |
| 权限门挂点 step.py:1364（wait_for(execute) 附近） | 实际执行点 **step.py:1502-1505**；且 Python 侧 grep 全 agent/llm/tools **无任何 deny/权限概念**——确认权限门是 TreeChrome 净新增 | 挂点相对位置不变（ToolCallEvent :1447-1464 之后、actionability 等待 :1479-1499 之前） |
| 无效动作重试：澄清 1 次 → fallback done | **#197 双梯**：外梯（畸形动作）2 次，第 2 次起去图 + 形状定向澄清文案；内梯（参数校验）3 次（`_PARAM_VALIDATION_MAX_RETRIES` :68）；诊断用 `action_shape.describe_action_entry` | Think 阶段契约重写（03 §3.2） |
| （未记载） | **#194 infra 三层退避**：client 层 L2 退避（重试 5 次 / 预算 max(30, 0.75×llm_timeout)，P2 已移植为 `setCallWindow`）+ step 层 Branch 2.5（`infra_failures` 指数退避 5/10/20/40/60s + `_skip_step_increment` 豁免步数）+ run 层 `max_infra_failures=8` 独立死法 | 错误处理三分支扩为四分支（03 §3.6） |
| 连续失败 5 次停 / max_steps=100 / 20 条硬限 / 120s / 30s / 5 动作 | 属实（config.py:124-137）；20 条限制在 agent.py `_trim_messages` :675-698（compactor 启用时放宽 60），不在 message_compactor.py | 无 |
| §3.2 BrowserSession 的 cookie 注入 | Python session.py **无 cookie API**——runner.py:80-156 裸调 `client.send.Network.setCookie`；TS 侧收进核心（§3.2 决策不变） | 01 §5.3 |
| §10 移植对照索引 | 缺 `browser/session.py`（5081 行最大单件）与 action_shape/actionability/loop_detector/message_compactor/network_idle/circuit_breaker/highlight/html_source/extract_markdown/upload_identity 共 11 个模块的映射行 | 4.0 补录 |
| §5.2 capability 表 | scroll 动作缺行 | 4.0 补「不过门」行 |

## 3. 范围

**做**（`packages/core` 主体，P2 的 `src/llm/` 并入后的完整形态）：

- **4.2 browser 层**：core 侧 `CdpTransport` 接口（send + **事件订阅**，§4 架构修订项）+ `BrowserSession` Facade（连接/重连/域 enable/事件态/get_state/两层 selector_map 缓存/熔断）+ 子件（network-idle / circuit-breaker / highlight / html-source）——**batch1 方法面全量**，batch2 方法在类型层预留槽
- **4.3 tools 层**：25 个动作的参数模型与 `ACTION_DEFINITIONS` 四元组（+capability）全量定义、`ActionRegistry`（schema 三 mode / page_filters / 指纹）、`Tools` 编排器、**batch1 十动作** handler（Strategy 拆分）、extract-markdown、P2 client 扩面（`extract` / `structuredCall`）
- **4.4 agent 层**：五阶段 step pipeline（Template Method 拆分）、run 外层、prompts（字节保真）、消息管理、action_shape / loop_detector / message_compactor / actionability / plan_manager、skills 三件（loader / task_loader / task_matcher）、Judge
- **4.5 policy 权限门**：capability×host 确定性映射、grant 三态、fail-closed、`_execute_actions` 挂点、denied ActionResult 通道、评测 `AutoAllowPolicy`
- **4.1 EventBus + 事件类型**（9 类事件，core 内部；`@tw/protocol` 独立包后置 M5）
- **4.6 真机 smoke**：ScriptedLLM（不发真网络）驱动完整 agent loop 跑通本地静态页任务
- **4.0 架构修订 + 类型基座**：architecture.md §2/§3/§4/§5/§10 修订（§2 清单）+ views/action_shape 纯函数基座

**不做**（明确出界，防止蔓延）：

- **batch2 十五动作**（search / close_tab / find_elements / find_text / screenshot / save_as_pdf / dropdown_options / select_dropdown / upload_file / write_file / read_file / replace_file / evaluate / search_page / read_grid）及其 session 侧族（下拉 25 方法 / upload / grid 三通道 / evaluate 增强 / 文件三动作）——**P4b**（P5 parity 前置，预估 4~5d），见 02 §7 索引；models/registry/BrowserSession 接口层为它们预留完整槽位
- `agent/rerun.py`（1662 行）+ `variable_detector` + `recorder/`——web 控制台重放与蒸馏录制（M6/M7），确认非引擎核心（StepPipeline 不依赖 RerunMixin）
- `tui/`、`web/server.py`——宿主形态（M5/M6）
- `@tw/cdp-chrome`（扩展宿主 transport，M5 前置；webbrain cdp-client.js 为底稿）
- `@tw/protocol` 独立包（core 先导出事件类型，M5 抽包时纯类型搬迁）
- **vision resize 实现**（`resize_screenshot_bytes`）：use_vision 默认 false（评测口径 A 无视觉）；类型层支持到位，无宿主注入 resizer 时 warning + 发原图，登记风险 8
- config.py 的 env 装配层（Settings 是显式类型对象，宿主负责装配——架构铁律 2）；signal/Stdin 的 pause 交互（core 提供 stop/pause/resume API，SIGINT 双击与 Enter 恢复归宿主）
- 流式、自进化蒸馏闭环（M7）、扩展壳、submit 预确认的表单摘要 UI（M5；P4 只落 capability 门 + 确认接口）

## 4. 关键决策（评审重点）

| # | 决策 | 理由 |
|---|---|---|
| 1 | **动作分两批：P4 = 10 核心动作为验收门**（navigate/click/input_text/scroll/extract/wait/go_back/switch_tab/send_keys/done），batch2 十五个动作独立成 P4b | 总纲 §P4 原文即 10 动作；P5 parity 需要全集但不必与核心引擎同批——P3 实证「小 diff + 冻结契约」是评审零意见的主因，batch2 拆出可保 P4 可评审 |
| 2 | **core 侧自定义 `CdpTransport`（send + on + close），架构 §4 增补事件订阅**；cdp-ws 以 contract test 断言兼容，core 运行时零依赖 cdp-ws | BrowserSession 的事件态（dialog/下载/network idle/file chooser）必须订阅事件；core 不得绑定 ws 或 chrome 任一宿主 |
| 3 | **BrowserSession 收 `transportFactory` 注入，不收 ws_url** | 连接方式是宿主能力（Node=cdp-ws，扩展=chrome.debugger）；对齐「配置显式传入」铁律，reconnect = 弃 transport 重调工厂 |
| 4 | **cookie 注入在 core 重实现**（`injectStorageState`，~60 行纯逻辑），cdp-ws 的 `CdpPageSession.injectCookies` 保留 | core 禁止依赖 cdp-ws；有意重复，行为同以 runner.py:128-139 坑清单为准 |
| 5 | pydantic 运行时校验 → **手写 validator**（exactly-one / xor / 范围 / extra 拒收），语义以 Python 实跑样例锚定 | TS 无 pydantic 等价物；校验只发生在 step 预检梯（执行路径 raw dict 不校验——Python 同款「memory: action-params-no-runtime-validation」语义照搬） |
| 6 | markdownify → **turndown + 噪声 strip 规则对齐**；`chunk_markdown_by_structure` 算法保真移植 | extract 输出喂 LLM 非字节契约（element_tree_text 才是）；偏离登记（02 §5） |
| 7 | TS 标识符 camelCase；**LLM 可见字符串与 JSON 字段保 snake_case 字节保真**（`evaluation_previous_goal` 等——P2 已同款） | 移植保真的对象是行为与输出格式，不是标识符拼写 |
| 8 | skills 存取经 **`SkillSource` 接口**（宿主注入：读目录 / IndexedDB / 打包资源），core 不碰 fs | 架构铁律；loader.py 的目录读序/分段格式是 SkillSource 实现的契约 |

## 5. 文档导航

| 文档 | 内容 | 冻结什么 |
|---|---|---|
| [01-browser-session.md](01-browser-session.md) | CdpTransport 接口、session.py 5081 行 → 16 个 TS 模块的拆分映射、连接/enable/事件契约、get_state 九步、batch1 方法面与 batch2 槽位 | 4.2 的行为契约与模块边界 |
| [02-tools-actions.md](02-tools-actions.md) | models 25 参数模型 + 四元组、registry schema 生成、Tools 编排器、十动作 handler 详案、extract-markdown、P2 client 扩面、batch2 索引 | 4.3 的行为契约 |
| [03-agent-loop.md](03-agent-loop.md) | Agent 公共形态（runner 契约）、run 外层、五阶段逐阶段契约（含 #194/#197 全机制）、消息管理、prompts/skills/judge、sensitive 接线与 thinking 槽位 | 4.4 的行为契约 |
| [04-policy-and-events.md](04-policy-and-events.md) | 权限门模型与 capability 映射、挂点与 denied 通道、AutoAllowPolicy、EventBus 与 9 类事件 | 4.1/4.5 的行为契约 |
| [05-testing-and-smoke.md](05-testing-and-smoke.md) | FakeCdpTransport/ScriptedLLM 假件、Python 锚定值清单与生成方法、单测矩阵、agent-loop smoke 设计 | 测试怎么算过、smoke 怎么算过 |

## 6. 任务拆分与顺序

分支约定（2026-09-27 评审后修订：**单分支改 5 段闸门**——P2/P3 评审循环实证 diff 体量是收敛质量的第一变量，P4 全量单分支不可评审）：按下表 5 个分支串行实施，每段独立走完「开分支（自最新 main）→ 按工作项提交 → `/review-loop --from main --to <branch>` → 合并 --no-ff → 删分支」，下一段从更新后的 main 开。段内提交粒度不变（笔笔过门）。4.2 若评审体量失控可再对半拆（纯子件先行 / Facade+交互族后行），预先不拆死。

| 分支 | 覆盖工作项 | 体量 |
|---|---|---|
| `feat/p4-foundation` | 4.0 架构修订+类型基座 + 4.1 EventBus | ~0.75d |
| `feat/p4-browser` | 4.2 browser 层 | 2.5~3d |
| `feat/p4-tools` | 4.3 tools 层 + llm 扩面 | 1.5~2d |
| `feat/p4-agent` | 4.4 agent 层 | 2~2.5d |
| `feat/p4-policy-smoke` | 4.5 policy 门 + 4.6 真机 smoke | ~1.25~1.5d |

每项完成跑 `node scripts/gate.mjs pre-commit`。

| # | 工作项 | 内容 | 验收 | 预估 | 依赖 |
|---|---|---|---|---|---|
| 4.0 | 架构修订 + 类型基座 | architecture.md §2 清单落地；`agent/views.ts`（AgentHistory/AgentState/ActionResult 族）+ `action_shape.ts` 纯函数 + Python 锚定值 fixture 生成 | 总纲 P4 检查点登记完成；锚定 fixture 入库；typecheck 绿 | 0.5d | — |
| 4.1 | EventBus + 事件类型 | `events/`：EventBus（容错/熔断/通配）+ 9 类事件 discriminated union | 单测绿（04 §4） | 0.25d | 4.0 |
| 4.2 | browser 层 | 01 文档全部落地（16 模块 + Facade） | 单测矩阵（05 §3）全绿；cdp-ws contract 断言绿；**01 文档评审通过后才动工** | 2.5~3d | 4.1 |
| 4.3 | tools 层 + llm 扩面 | 02 文档落地：models/registry/Tools + 十动作 + extract-markdown + `LLMClient.extract/structuredCall` | 单测矩阵全绿；schema 生成锚定 Python 实跑 | 1.5~2d | 4.2 |
| 4.4 | agent 层 | 03 文档落地：五阶段 + run 外层 + prompts + skills + judge + 配套 tracker | 单测矩阵全绿；prompts 字节锚定全绿 | 2~2.5d | 4.3 |
| 4.5 | policy 门 + 挂点 | 04 文档落地：决策表 + denied 通道 + AutoAllowPolicy + `_execute_actions` 集成 | 决策表驱动单测全绿 | 0.75d | 4.4 |
| 4.6 | smoke + 完成记录 | `tools/agent-loop-smoke.mjs`（05 §4）；README §8 完成记录补登 | 本地 headless Chrome 真机跑通（ScriptedLLM 三步剧本，exitCode 0） | 0.5~0.75d | 4.5 |

合计 **8~9.75d**（M3 原无逐项预估；P4b batch2 另计 4~5d）。公共 API 验收（架构 §3.2 / 总纲 M3）：runner 同构流程所需的 `BrowserSession` / `Agent` / `AgentHistoryList` / `createLLMClient` 全部就位——由 4.4 的 runner 契约测试（mock transport + ScriptedLLM 全流程）与 4.6 真机 smoke 共同背书。

## 7. 风险与未决

| # | 风险 | 处置 |
|---|---|---|
| 1 | **session.py 体量**：5081 行拆 16 模块，拆分边界漂移会引入行为回归 | 01 §2 的行区间→模块映射表逐段锚定；每模块单测覆盖其方法面；Facade 只组装不实现 |
| 2 | cdp-ws 多播事件 vs Python 单回调覆盖式（重连注册幂等语义） | BrowserSession 自管 disposers：重连先全量解订再注册（01 §3.4，P3 01 §5.2 预留的复核项） |
| 3 | **人工时序间隔勿被「优化」**：click 三段 50/80/300ms、点击效果等待 0.6s、Enter 后 0.1s、scroll 后 0.2s | 01 §5 逐条列出；单测用 fake timers 断言间隔序列 |
| 4 | 两层 selector_map 缓存 **5 处失效纪律**（navigate/go_back/switch_tab/reconnect/stop） | 单测逐处覆盖（01 §3.5） |
| 5 | 手写 validator 与 pydantic 语义差（extra=forbid / 类型 coerce / exactly-one 报错文案） | 无效参数样例集锚定 Python 实跑（05 §2） |
| 6 | 敏感值接线与 P2 面的核对：Agent 构造需把 sensitive_data 灌入 client（Python 写 `llm._sensitive_map`，agent.py:184） | 4.4 实施时核对 P2 `LLMClient` 是否已有 setter，缺则补（小改，登记完成记录） |
| 7 | undici WebSocket 长会话稳定性（agent 数分钟多步、事件+命令交错；P1.6 只验证了短会话大帧） | 4.6 smoke 覆盖；退路仍是注入 ws 库 socketFactory（P3 风险 1 同款） |
| 8 | vision 路径半实现（resize 缺）：use_vision=true 时发原图可能被端点拒 | 类型层支持 + 无 resizer 时 warning 发原图（fail-visible 不静默）；resize 实现与口径进 P4b/M5 |
| 9 | evaluate 增强 JS 通道（语法自愈/UTF-16 列偏移）整体在 batch2，但 `execute_js`/`eval_function_on_node` 是 batch1 内部依赖 | 01 §2 只移植基础版，增强版连同 evaluate 动作进 P4b——边界在 02 §7 显式登记 |
| 10 | Windows 路径/中文文件名（batch1 的 extract 落盘、done 附件经 FileSystemProvider） | FS 可选注入，未注入降级 + metadata 标注；smoke 用 ASCII 路径 |

## 8. 完成记录

### feat/p4-foundation（4.0 + 4.1，2026-09-27）

| # | 提交 | 内容 | 验收 |
|---|---|---|---|
| 分支修订 | 7da244f | §6 分支约定改 5 段闸门（评审后定） | — |
| 4.0 | 7b044cf | agent/action-shape.ts + agent/views.ts + tools/gen-anchors.py + python-anchors fixtures + architecture.md 六处修订 | 59 例全绿（34+25），期望值锚定 Python 实跑 |
| 4.1 | 80262c7 | events/events.ts（9 类 + 工厂）+ events/event-bus.ts + index.ts 导出面 | 9 例全绿（行为语义对齐，时间戳跨语言不可锚） |

全仓 672→731 例（core 454→522）；core 覆盖率 97.11%。对计划的小偏离：

- **锚定生成脚本从 `_` 前缀草稿改为入库 `tools/gen-anchors.py`**（05 §2 已同步修订）——对齐 dom-snapshot gen_fixtures.py 惯例；P5 基准更新需要确定性再生能力（复跑与已提交 fixture 零差异已验证）。实施中踩过一次路径坑：脚本移入 tools/ 后 `__file__.parent` 相对定位漂移写出错位置，已改 `parents[1]` 并清理残渣。
- `describeActionEntry` 的类型名按 Python 字面量渲染（`typeName`：str/int/float/bool/NoneType）——它进 #197 的 LLM 可见澄清反馈，是 prompt 契约的一部分（03 文档未显式列出，实施时定性为字节保真对象）。
- `ActionResult.render()` 的 Python f-string 布尔字面量（True/False/None）逐字节保真（进 `[Previous Action Results]` 段）——03 §1 已有原则，此处落为实现。
- 事件 timestamp 用 JS `toISOString()`（毫秒 Z 后缀）而非 Python isoformat 微秒形态——无跨语言字节可比性，文件头注登记。

#### 评审轮 1（review-p4-foundation-1.json，2026-09-27）

9 文件 6m35s，**2 条意见均为 P3 级（low/maintainability，gen-anchors.py 死代码：未使用 `import sys` + 未调用 `dump()`）**，0 P1/P2。两条核实属实且满足「改动极小 + 当轮触碰文件」顺手修条件 → 采纳实施；修复后脚本复跑 fixture 零差异验证。采纳 2 / 驳回 0 / stale 0。

#### 评审轮 2（review-p4-foundation-2.json，2026-09-27，增量基线 36afc15）

状态 `skipped: no items were selected`——增量 diff 仅含 .py 工具脚本与 README 文本，rule.json include（真实代码）未选中条目，0 意见。语义等同「本轮无 P1/P2」；与轮 1 连续两轮无 P1/P2，**循环收敛终止**。累计：2 轮，2 条意见（全 P3），采纳 2 / 驳回 0 / stale 0，无 P3 backlog 遗留。分支 6 提交待合并。

### feat/p4-browser（4.2，2026-09-27）

提交 e8708c4：session.py 5081 行按 01 §2 映射落成 16 模块 + Facade（batch1 方法面全量，
batch2 槽位 P4b）。core 522→587 例全绿（新增 65：子件 16 + 连接 12 + 交互 27 + Facade 10），
覆盖率 92.89%/分支 88.04%。对计划的小偏离与实施要点：

- **CdpTransport 拆卸方法定名 `stop()`**（01 §1 预留项落地）：cdp-ws 公共面是 `stop()`，
  契约测试（`CdpWsClient extends CdpTransport` 编译期断言）倒逼 core 接口对齐，零适配层。
- **evaluate-basic 含 `evaluateScript`（单发路径）**：settle/kick/grid-meta 需要 evaluate 通道，
  取增强版 evaluate 的无 args/elements 子集；语法自愈重试接线留 P4b（02 §7 边界不变）。
- **连接自愈=重试工厂一次**（无 url 比较——discover 语义在宿主工厂内，Python 的
  `_rediscover_ws_url` 无宿主中立对应物）；失败抛**原始**握手异常。
- **downloadsPath 必须显式传入**：Python 的 env/~/Downloads 回退属宿主职责（核心包禁 ambient）。
- Facade 上下文装订为单一 ctx 对象（getter/setter 直达会话字段），模块收 `SessionInternals`
  首参——Python `self` 的显式化；时序（click 50/80/300ms 等）经注入 sleep 断言。
- 踩坑记录：validateAndFix 规则 7 正则初版丢前导 `/`（已修）；switch_tab 的
  activateTarget 曾笔误复数（对照源码 3641 修正）。

### feat/p4-policy-smoke（4.5+4.6，未开始）
