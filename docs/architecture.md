# TreeChrome 架构基准文档

> 状态：开工基准（2026-09-20 定稿）。本文是六轮设计讨论的沉淀，是后续所有实现的对照物；修改架构决策须先改这里。
>
> 三个参照仓库：
> - **TreeWalker**（`D:\dev\git\z_jordon\TreeWalker`，Python + CDP）：引擎细节的唯一权威——agent loop、DOM 快照、动作、评测调用的经验全部来自这里
> - **webbrain**（`D:\dev\git\z_jordon\webbrain`，Chrome MV3 扩展）：只取权限分级与动作确认的设计，以及存储/导入/惰性加载等工程模式
> - **evals/webarena**（`D:\dev\git\z_jordon\evals\webarena`，Python）：评测 harness，其 runner.py 调用契约就是本仓库核心包的公共 API 规格

## 1. 项目定位与三条原则

TreeChrome = **TreeWalker 核心能力的 TypeScript 实现**，以 monorepo 形式组织：平台无关的核心包 + 多个宿主应用。Chrome 扩展是第一个产品宿主；未来的 TS 版 TreeWalker（TUI/web/CLI）是薄壳宿主。**评测工程不放进本仓库**——延续今天 `evals/webarena` 的独立仓库形态（TS 后继仓），经 pnpm `link:` 依赖本仓库的核心包（等价 Python 的 `uv pip install -e`，见 §7）。**Python 版 TreeWalker 在评测 parity 达标后退役**——本仓库的核心包就是 TS 版 TreeWalker 的本体。

1. **集两家之长，不堆砌代码**：引擎（DOM 获取 / tools / agent loop）以 TreeWalker 为准（抖音上传任务实测占优）；权限分级与动作确认取 webbrain 的设计；skill 双层取 TreeWalker，管理工程取 webbrain。
2. **核心是库，宿主是壳**：核心包禁 `chrome.*`、禁 `process.*`、禁读 ambient env；对宿主的能力需求全部走接口（§4）。配置是显式传入的类型化对象（教训：TreeWalker runner.py issue #1——口径开关曾因新建默认 settings 而从未生效）。
3. **同一逻辑只写一遍（含 UI）**：侧边栏与 web 控制台共享 `console-ui` 组件包，消费同一事件协议。
4. **面向对象 + 经典模式 + 小文件**：优先套用经典设计模式（Strategy/Registry/Observer/Adapter/Facade/Template Method/守卫链，映射见 AGENTS.md 设计规范）；单源文件 ≤ 3000 行为硬门槛（提交门强制），移植 Python 巨石文件（如 TreeWalker `actions.py` 3264 行）时必须按职责拆分。

## 2. 仓库布局

```
packages/
  @tw/dom-snapshot      CDP 三源融合 DOM 快照（移植自 dom-snapshot 库）
  @tw/core              Agent loop / step pipeline / actions / registry / prompts
                        / skills 匹配与蒸馏 / 权限门逻辑 / Judge / EventBus
  @tw/cdp-ws            WebSocket CDP transport（Node 宿主；等价 Python 的 cdp-use）
  @tw/cdp-chrome        chrome.debugger transport（扩展宿主）
  @tw/protocol          事件协议类型（EventBus schema），宿主转发、UI 消费
  @tw/console-ui        React 控制台组件包（RunView/步骤流/控制条/技能编辑器/历史）
apps/
  extension             TreeChrome 扩展（WXT：SW 壳 + sidepanel + options + run journal）
  web-console           Node HTTP/SSE 宿主（承接 tw-web，SSE 协议兼容现有 web_ui）
  （未来）cli / tui     TS TreeWalker 宿主；优先级 web-console > cli > tui

评测工程（独立仓库，不在本仓库内）
  evals/webarena 的 TS 后继仓，pnpm link: 依赖本仓库 packages/core 与 cdp-ws
```

## 3. 核心包 @tw/core：从 TreeWalker 移植什么

### 3.1 agent loop（五阶段 step pipeline）

对照 `TreeWalker/src/tree_walker/agent/agent.py` + `step.py`：

| 阶段 | Python 来源 | 移植要点 |
|---|---|---|
| run 外层 | agent.py:281 | 初始导航 → 任务级 skill 匹配（一次）→ 步循环（max_steps=100、连续失败 5 次停、stop/pause 检查）→ done 后跑 Judge |
| Sense | step.py:284 | `get_state()`（DOM+URL/tabs+可选截图）→ 循环检测指纹 → 组装 state 消息（**替换式**，保留最近 2 份）→ `<agent_history>` 滑动窗口 → 步数预算警告 → done-only schema 降级 |
| Think | step.py:760 | `_trim_messages`（20 条硬限）→ LLM 调用（120s 超时）→ 响应归一化 → done 门禁 → 每步最多 5 个动作 → 无效动作重试梯（澄清重试 1 次 → fallback done） |
| Act | step.py:1274 | 动作严格顺序执行（每动作 30s 超时）；5 个中断守卫 + **权限门（新增，挂点见 §5.2）**；动作后 URL/target 漂移即截断余下动作 |
| Post/Finalize | step.py:1518/1602 | 失败计数（仅单动作步 error 计 consecutive_failures；**deny 不计**）→ AgentHistory 追加（model_output + results + interacted_element 投影 + 截图） |

错误处理三分支保留：InterruptedError（用户停）/ 连接类错误（重连循环）/ 其他（计失败）。

### 3.2 公共 API 规格（来自 evals/webarena/runner.py:34 的调用契约）

```ts
// @tw/core 对外导出的形态（移植验收 = 这组 API 能支撑 runner 同构流程）
createLLMClient(config): LLMClient
class BrowserSession { start(); stop(); navigate(url); getState(opts); /* 自持 vs 附着两种模式 */ }
class Agent { constructor(opts: { task, llm, browser, settings }); run(opts?: { keepAlive }): Promise<AgentHistory> }
// AgentHistory 提供: isDone(), isSuccessful(), finalResult(), steps.length, interactedElement 投影
```

关键 API 决策：`keepAlive` 一等公民（评测判分需要活浏览器；扩展形态永不关用户浏览器）；cookie 注入（storage_state → `Network.setCookie`，localhost 必须用 `url` 参数的坑）收进核心。

### 3.3 动作空间

首期移植 10 个核心动作：navigate / click / input_text / scroll / extract / wait / go_back / switch_tab / send_keys / done。`ACTION_DEFINITIONS` 三元组扩为四元组：`(params 模型, 描述, terminates_sequence, capability)`。`page_patterns` 只影响 LLM 可见性不拦截执行——**不能当权限用**（运行时强制由权限门负责）。

### 3.4 LLM 客户端（多协议）

原生 fetch（无 SDK，既有决策），**兼容主流三种协议**，Strategy 模式一协议一适配器：

| 协议适配器 | 覆盖面 |
|---|---|
| `openai-completions`（`/v1/chat/completions`） | OpenAI、智谱 GLM、DeepSeek、Kimi、Qwen、Groq、OpenRouter、vLLM/Ollama 本地服务——事实标准，一个适配器覆盖最广 |
| `anthropic-messages`（`/v1/messages`） | Claude 官方、智谱 Anthropic 兼容端点（TreeWalker 现役默认，保持行为对齐便于 parity 对照） |
| `gemini`（`generateContent`） | Google 原生 |

设计要点：

- **内部规范消息格式**：core 内部使用自有中立类型（规范 message/tool/toolCall），不采用任何一家的协议形状；`LLMProvider` 接口收发规范格式，三个适配器各自做双向归一化。
- **`agent_response` 强制工具调用的三协议映射**：OpenAI `tools` + `tool_choice:{type:"function",…}`；Anthropic `tool_choice:{type:"tool",name}`；Gemini `functionConfig mode=ANY`。
- **能力声明**：provider 配置声明 `supportsTools` / `supportsVision`（TreeWalker `model_supports_vision` 白名单的泛化）；不支持强制工具的端点走 prompt 约束 + JSON 解析兜底——继承 `client.py` 的 `_try_parse_json` 语义。开源兼容端点对 forced tool_choice 的支持参差不齐，**这条兜底链在多协议下是承重墙**。
- **配置形态 = provider 卡片**：`{name, protocol, baseUrl, apiKey, model, capabilities, contextWindow}`；扩展宿主存 chrome.storage，Node 宿主存配置文件（管理 UI 后置到 M5，复用 webbrain 的 provider 卡片模型）。
- **保留的 TreeWalker 行为**：URL 缩写（≥100 字符→`[uN]`）、敏感值占位符替换/还原、fallback 模型单向切换（fallback 链按协议各自配置）。
- **暂不做**：流式（`agent_response` 是整块工具调用，流式收益低）；Azure/Bedrock 包装协议（用到再加）。
- 参考实现：webbrain `providers/base.js` 的接口形状（`chat()` / `supportsTools` / `supportsVision` / `testConnection()`）与 `anthropic.js` 的格式互转逻辑。

## 4. 宿主接口（依赖倒置，仅五个）

```ts
interface CdpTransport {                       // 实现：cdp-chrome / cdp-ws
  send<T>(method: string, params?: object, sessionId?: string): Promise<T>;
}
interface PolicyInteraction {                  // 实现：扩展侧边栏交互卡 / 评测 AutoAllowPolicy
  requestPermission(req: { capability, host, action }): Promise<'allow-once'|'allow-always'|'deny'>;
  confirmSubmit(req: { host, summary, fields }): Promise<'once'|'deny'>;
}
interface StorageProvider { /* KV + 结构化存储：chrome.storage/IndexedDB vs 本地文件 */ }
interface SecretProvider { /* 占位符→真值，按 URL 限定 */ }
interface FileSystemProvider { /* 扩展：downloads/OPFS；Node：fs */ }
```

权限门的评测策略是 `AutoAllowPolicy`（无人值守放行并记入口径标注）——这保证了评测对权限层零阻塞，也强制权限逻辑与 UI 解耦。

## 5. 权限层（设计取自 webbrain，挂点取自 TreeWalker）

### 5.1 门模型

- 确定性映射 `(capability, host) → allow | deny | prompt`：不读页面内容、不问 LLM、语言无关、注入免疫（人是信任锚）。
- host 计费：navigate/download 按目标 URL；click/type 按当前页；iframe 动作按帧 host；host 识别不出 → fail-closed 拒绝。
- Grant：`{capability, host, allow/deny, once/always}`；once 绑 tab，always 持久化（`tc_permissions`）；回合结束清 once；设置页可查看/撤销。
- 拒绝回流给模型：`{success:false, denied:true, error:"用户拒绝在 <host> 上 <动词>，不要重试，可改道或询问"}`，且**不计 consecutive_failures**。
- 边界纪律：计划审批（后置功能）永不预授权动作；任何确认卡的超时/异常返回一律按 deny。

### 5.2 capability 映射（TreeWalker 动作集）

| 门行为 | 动作 |
|---|---|
| 不过门（只读） | extract / find_elements / find_text / search_page / read_grid / dropdown_options / screenshot / wait |
| CLICK | click、select_dropdown、send_keys（含 Enter） |
| TYPE | input_text、send_keys（普通键） |
| NAVIGATE | navigate（按目标 URL）/ go_back / search / switch_tab / close_tab |
| UPLOAD | upload_file（attachmentId 模式：用户在侧边栏亲手选文件，agent 只能引用句柄） |
| EXECUTE_JS | evaluate |
| FS/DOWNLOAD | write_file / replace_file / save_as_pdf |

### 5.3 挂点与确认流

挂点 = `_execute_actions` 中 ToolCallEvent 之后、`wait_for(execute)` 之前（紧邻现有 stop/pause 检查，Python step.py:1364）。逐动作确认（不是逐批）；确认卡带元素 bbox/xpath 高亮；等待批准复用 per-action Future（对应 Python 的 `_resume_event` 模式）；批准后执行前重跑元素校验，元素漂移走既有漂移守卫。submit 预确认：检测 submit 特征的 click 单独确认，展示变更字段摘要（≤8）。

### 5.4 扩展形态新增

等待确认期间 MV3 SW 可能被杀 → 挂起状态进 run journal（`tc_runUi:<tabId>` 模式）。原生 OS 文件对话框 CDP 控不住 → 移植 webbrain 的 file-picker-guard（页面 MAIN world 打补丁拦 `input[type=file].click()`，5s TTL，引导走 `DOM.setFileInputFiles`）。

## 6. Skill 系统（骨架取 TreeWalker，工程取 webbrain）

### 6.1 双层模型

- **站点级**：`domain-skills/<host_key>/` 三件套（`_sop.md` 流程 / `selectors.md` 元素指纹 / `quirks.md` 坑），host 精确匹配（含端口形态 `localhost_7780`），每步跟随当前页注入。
- **任务级**：`tasks/<slug>/` 三件套 + `_task.json` 元数据；LLM-as-ranker 单选匹配（两轴模型：实体值是参数永不拒绝；模板是判据；置信 high/medium 过，否则降档未命中）；`match_kind=same_template` 注入头明确"实体值属于原实例，照抄步骤序列替换实体"。**TreeChrome 默认开启注入（与 TreeWalker 的评测默认关闭不同）；评测口径经配置关闭。**
- 注入点：state message 的 `[Task Skill]`（前）`[Domain Skill]`（后）段，不进 system prompt；双卡同命中则都注入。

### 6.2 存储 schema（扩展侧 IndexedDB，与 TreeWalker 目录格式互导）

```ts
interface SkillCard {
  host: string; slug: string;            // 站点卡 slug 为空
  sop: string; selectors: string; quirks: string;
  meta: { taskDescription?: string; taskKeywords: string[]; sourceTraces: string[]; distilledAt: string };
  status: 'active' | 'draft';            // draft = 蒸馏产出待人工审阅
  provenance: { sourceType: 'built-in' | 'import' | 'distilled'; sourceUrl?: string };
}
```

打包技能随扩展更新自动刷新（provenance 精确匹配才覆盖）；URL 导入安全链（HTTPS、拒重定向、500KB 上限）；技能**永不携带权限授予**（采纳草稿时可展示"涉及 douyin.com 的 click/type/upload，是否预先授权"作一次性引导，grant 只由用户点击产生）。

### 6.3 自进化闭环（TreeChrome 新增，两家都没有）

```
run 结束 → 门槛：done(success) 且 Judge 复核通过
  → 轨迹已在 run journal（动作+结果+interacted_element 投影）
  → 后台小模型蒸馏（队列异步；参考 treeforge 的蒸馏 prompt 与实体值规则：易变具体值不写死）
  → 草稿 status='draft'，侧边栏/设置页提醒审阅 → 采纳（可编辑）/丢弃
  → 合并：同 host 同模板更新既有卡（sourceTraces 并集、distilledAt 刷新）；新模板新 slug
  → 下次匹配命中注入
```

人工审阅门是安全必需：技能内容注入未来 prompt，自动生效会打开"页面内容 → 轨迹 → 技能 → 此后所有任务"的 prompt 注入持久化通道。

## 7. 评测（独立仓库，质量发动机）

- **评测工程在独立仓库**（evals/webarena 的 TS 后继），不放进本仓库——延续今天 Python 侧"评测独立仓 editable 依赖 tree_walker"的形态，评测不被被测方牵制。依赖方式：评测仓 package.json 用 pnpm `link:` 指向本仓库的 `packages/core` 与 `packages/cdp-ws`（等价 `uv pip install -e` 的 TS 形态）；评测结果记录当次指向的 TreeChrome commit 保证可复现。本仓库对评测的唯一义务是**核心包公共 API 稳定**（§3.2 契约）。
- **Tier 1 引擎评测**（SR 产生层，在评测仓）：Node 进程内 import `@tw/core` + `@tw/cdp-ws`（连 9222 Chrome），形态同今天 runner.py 对 tree_walker 的调用。evaluator 连同加固逻辑与测试（`test_cdp_evaluator.py` 等）在评测仓移植 TS；CDPPageAdapter 鸭子类型模式 1:1 移植（TS 无 beartype/同步桥问题）。口径 A/B/C 开关经核心配置传入。**SR parity（同模型同口径，与 Python TreeWalker 差距进噪声区间）= Python 退役验收门槛。**
- **Tier 2 扩展 e2e**（在本仓库）：Playwright `--load-extension` 驱动 SW，测 SW 被杀恢复、run journal、权限卡 UX、侧边栏。
- **golden fixture 方法**：`packages/dom-snapshot/tools/gen_fixtures.py` 属于 dom-snapshot 移植验收，留在本仓库，与评测仓无关。生成器调用 Python 库的 `_collect_cdp_sources` + `build_dom_state`，同时落盘三源原始输入与序列化产物；TS 端移植完成后对 `element_tree_text` **逐字节对拍**。单元级锚点：Python 参考值（xpath / stable_hash / 类过滤）烤进 vitest。
- 看门狗、断点续跑、增量落盘、reset_env、口径报告等批量工程全部留在评测仓。

## 8. 事件协议与 UI

`@tw/protocol` 定义事件类型（移植 TreeWalker `observability/events.py`）：`step_start / skill_active / model_call / model_result / tool_call（含 params+元素 bbox/xpath）/ tool_result / step_end / anomaly / session_end`。事件流双宿主同构：core EventBus → 扩展 SW `chrome.runtime.sendMessage` → 侧边栏；core EventBus → SSE 队列 → web_console 浏览器。`@tw/console-ui`（React）只消费协议类型。web-console 保留扩展替代不了的功能：远端 screencast 直播、历史 CRUD/重放/CSV 批量、技能编辑热更新、任务单槽互斥；SSE 桥接格式与现有 web_ui 兼容（旧 React 前端可先接入过渡）。

## 9. 里程碑与验收

> 战术排序、工作项拆分与逐项验收细则见 `docs/implementation-plan.md`——**TreeWalker 的 agent loop/tools 仍在完善，基础层（M1/M2）前置，core 主体（M3）等上游稳定后启动**。

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 | `@tw/dom-snapshot` 移植 | golden fixture 逐字节对拍通过；三源降级链单测 |
| M2 | 基础层：LLM 多协议客户端（`core/src/llm` 先行）+ `@tw/cdp-ws` | 三协议 mock 单测全绿；真机 smoke 走通 |
| M3 | `@tw/core` 主体移植（loop/actions/prompts/守卫链）——前置检查点：TreeWalker 稳定 + 快照审查 | 公共 API 支撑 runner 同构流程；10 核心动作单测 |
| M4 | parity 闸门（在评测仓执行） | 同模型同口径 vs Python TreeWalker，SR 差距进噪声区间 |
| M5 | `apps/extension`（WXT） | 抖音上传任务走通：权限卡/submit 确认/attachmentId 上传/skill 注入 |
| M6 | web-console + console-ui | 旧 web_ui 经 SSE 兼容接入；历史/重放/技能编辑可用 |
| M7 | 自进化闭环 + cli/tui + Python 退役评审 | 成功轨迹→草稿→采纳→二次任务命中注入 全链路演示 |

## 10. 移植对照索引

| Python（TreeWalker / dom-snapshot） | TS 目标 | 备注 |
|---|---|---|
| dom_snapshot/models.py | `@tw/dom-snapshot/src/types.ts` | 全量移植；hash 用 bigint（Python int 64 位超 JS 安全整数） |
| dom_snapshot/collector.py | `@tw/dom-snapshot/src/collector.ts` | 三源并行采集 + 融合 + 降级链 |
| dom_snapshot/serializer.py | `@tw/dom-snapshot/src/serializer/` | 五步过滤 + 编号 + selector_map；输出格式是 prompt 契约 |
| dom_snapshot/interactive.py / paint_order.py | `@tw/dom-snapshot/src/` | 交互判定 / 遮挡标记 |
| tree_walker/agent/{agent,step}.py | `@tw/core/src/agent/` | §3.1 表 |
| tree_walker/tools/{models,registry,actions}.py | `@tw/core/src/tools/` | 四元组（加 capability） |
| tree_walker/llm/client.py | `@tw/core/src/llm/` | fetch 直连多协议（§3.4：openai-completions / anthropic-messages / gemini 三适配器；webbrain providers 为参考） |
| tree_walker/prompts/system_prompt.py | `@tw/core/src/prompts/` | state 消息分段保持一致 |
| tree_walker/skills/{loader,task_loader,task_matcher}.py | `@tw/core/src/skills/` | §6 |
| tree_walker/observability/{event_bus,events}.py | `@tw/core/src/events/` + `@tw/protocol` | §8 |
| tree_walker/agent/judge.py | `@tw/core/src/judge/` | 事后 LLM 复核；兼作自进化门槛 |
| webbrain permission-gate.js 设计 | `@tw/core/src/policy/` | §5（设计照搬，代码重写） |
| evals/webarena/runner.py + cdp_evaluator.py | 独立评测仓（TS 后继） | §7；经 pnpm `link:` 消费 `@tw/core`，runner.py 调用契约即其对 core 的调用面 |
