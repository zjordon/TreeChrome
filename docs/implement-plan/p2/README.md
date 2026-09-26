# P2 LLM 多协议客户端 · 实施计划

> 状态：2026-09-23 起草，待评审后冻结。实施计划总纲见 `docs/implementation-plan.md` §P2；架构依据见 `docs/architecture.md` §3.4 / §3.2。
>
> **为什么 P2 要先写详细计划**：P1 的每行代码都有 Python 参考实现可逐字节对拍；P2 不同——行为层（重试梯/兜底/缩写/退避）虽源自 TreeWalker `client.py`，但三协议 wire 层是全新设计（webbrain 只有接口形状可借，无 gemini provider），契约只能靠本文档冻结。**文档即对拍基准**：类型（01）、wire 映射（02）、行为语义（03）与实现偏差都算缺陷。

## 1. 输入与参考物

| 参考物 | 用途 | 精确位置 |
|---|---|---|
| TreeWalker `llm/client.py`（812 行，2026-09-23 快照） | **行为基线**：get_action 梯子、`_try_parse_json`、URL 缩写/敏感值占位、退避与预算、fallback 单向切换、滤图、usage 捕获 | `D:\dev\git\z_jordon\TreeWalker\src\tree_walker\llm\client.py` |
| TreeWalker `config.py` | 配置形态（LLMSettings / FallbackLLMSettings）与视觉白名单 `model_supports_vision` | `config.py:25-43`、`:266-285` |
| webbrain `providers/base.js` | **接口形状**：`chat()` / `supportsTools` / `supportsVision` / `contextWindow` / `testConnection()` | `webbrain/src/chrome/src/providers/base.js` |
| webbrain `providers/anthropic.js` | 格式互转细节：连续 tool_result 合并（400 地雷）、data-URL 图片映射、usage 归一（含 cache 字段）、直连浏览器头 | 同目录 `anthropic.js` |
| webbrain `providers/openai.js` | 新 OpenAI 契约（gpt-5/4.1/o 系 → `max_completion_tokens`、temperature 400）、`reasoning_content` 提取 | `openai.js:167-196`、`:913` |
| 三协议官方 API 规格 | wire 层唯一权威 | OpenAI Chat Completions API、Anthropic Messages API、Gemini `generateContent`（ai.google.dev） |

两条事实约束设计：

1. **webbrain 没有 gemini provider**——gemini 适配器纯按官方规格设计，是三家中风险最高的，排在最后实现（2.4），并由 smoke 实测兜底。
2. **TreeWalker 现役默认是智谱 Anthropic 兼容端点**（`https://open.bigmodel.cn/api/anthropic`，model=glm-5.1）——anthropic-messages 适配器是 parity 对照的主通道，最先实现（2.2）。

## 2. 范围

**做**（`packages/core` 仅 `src/llm/` 先行，`implementation-plan.md` 既定边界）：

- 规范消息格式与 `LLMProvider` 接口（Strategy，一协议一适配器）
- 三协议适配器：`openai-completions` / `anthropic-messages` / `gemini`，含 `agent_response` 强制工具调用的三协议映射
- `LLMClient` 行为层：`getAction()` 全套（URL 缩写、敏感值占位/还原、text-not-tool 重试梯、JSON 兜底、退避与预算、fallback 链、滤图、usage）
- `createLLMClient(config)` 公共 API（架构 §3.2 契约的第一块）
- `@tw/core` 包脚手架（package.json / tsconfig / vitest，biome 核心包边界已配置）
- 真机 smoke 脚本 `packages/core/tools/llm-smoke.mjs`（手动跑，不入 CI）

**不做**（明确出界，防止蔓延）：

- 流式（架构 §3.4 暂不做——`agent_response` 是整块工具调用，收益低）
- step.py 消息管理（`_trim_messages`、state 消息组装——P4）
- `extract()` / `structured_call()`（Python client.py 的另两个方法，消费者都在 P4；届时基于同一 `chat()` 薄封装，半天量）
- `output_mode`（standard/flash/thinking——GLM 输出模式，影响 prompt 与 step 层，不影响 wire；属 P4 settings）
- Azure / Bedrock / Vertex 包装协议、OAuth（webbrain 有，我们用到再加）
- provider 卡片管理 UI（M5）
- 评测仓对接（P5+）

## 3. 文档导航

| 文档 | 内容 | 冻结什么 |
|---|---|---|
| [01-types-and-api.md](01-types-and-api.md) | 规范消息/工具/用量类型、`LLMProvider` 接口、ProviderConfig（provider 卡片）、错误分类、依赖注入、目录结构、公共导出面 | 三适配器共守的契约（对应工作项 2.1 的"类型冻结评审"） |
| [02-adapters.md](02-adapters.md) | 共享 http 层；三协议端点/头/请求体/响应体规格，canonical↔wire 双向映射表，兼容地雷清单 | 每个适配器的 wire 行为与测试断言口径 |
| [03-client-behaviors.md](03-client-behaviors.md) | `getAction()` 状态机：梯子、兜底、退避、fallback、滤图；**Python 行为对照表与有意偏离清单** | 行为语义与 client.py 的对应关系 |
| [04-testing.md](04-testing.md) | mock fetch/假时钟注入、wire fixtures、Python 锚定方法（evals venv 实跑）、覆盖矩阵、smoke 设计 | 测试怎么算过、锚定值从哪来 |

## 4. 任务拆分与顺序

分支约定：`feat/p2-llm-client` 单分支承载全部 P2，按工作项一笔一提交（P2 各项耦合在同一契约上，拆分支收益低于 P1 的移植件切分）。每项完成跑 `node scripts/gate.mjs pre-commit`。

| # | 工作项 | 内容 | 验收 | 预估 | 依赖 |
|---|---|---|---|---|---|
| 2.0 | core 包脚手架 | `packages/core`：package.json（`@tw/core`，对齐 dom-snapshot 形态）/ tsconfig / vitest（阈值 85%，纯类型文件排除）/ `src/index.ts` 占位 | `pnpm -r typecheck/test` 绿；biome 核心包边界对 `packages/core/src/**` 生效（biome.json 已含，验证即可） | 0.25d | — |
| 2.1 | 规范类型 + Provider 接口 + 错误分类 | 01 文档全部类型落地：`types.ts` / `config.ts` / `errors.ts` / `provider.ts` / `deps.ts`；`index.ts` 导出 | 类型层单测绿（消息不变量、错误谓词）；**本文档 01 评审通过后才动工** | 0.5d | 2.0 |
| 2.2 | anthropic 适配器 + 行为层 | 02 的 anthropic 规格 + 03 的 `LLMClient.getAction` 全套（transforms / 退避 / fallback / 滤图 / usage）；含共享 `adapters/http.ts` | mock fetch 全路径单测（04 覆盖矩阵 anthropic 列 + client 行全部）；Python 锚定值烤入（04 §3） | 2d | 2.1 |
| 2.3 | openai-completions 适配器 | 02 的 openai 规格（含新契约开关、arguments guard-parse、reasoning 捕获）+ forced-tool 不支持时的 prompt 约束 + JSON 兜底（承重墙，架构 §3.4） | mock 单测同 2.2 口径；**兜底路径专项用例**（capabilities 关闭 forced tool → 纯 prompt + `_try_parse_json`） | 1d | 2.1 |
| 2.4 | gemini 适配器 | 02 的 gemini 规格（systemInstruction / contents 角色映射 / functionResponse / mode=ANY / schema sanitize） | mock 单测同 2.2 口径；schema sanitize 白名单有专项用例 | 1d | 2.1 |
| 2.5 | smoke + 收尾 | `tools/llm-smoke.mjs` 对智谱 OpenAI 端点 + 智谱 Anthropic 端点各发一次最小 `agent_response` 强制调用；`implementation-plan.md` 完成记录 | 手工跑通两端点，产物（请求/响应摘要）贴回本文档 §7；不入 CI（费用与密钥纪律） | 0.5d | 2.2、2.3 |

预估合计 ~5.25d（总纲估 4.5d；细化后行为层与 anthropic 合并项从 1.5d 调到 2d，因退避/窗口/fallback 的移植语义比总纲预估重）。

## 5. 关键设计决策摘要

细节都在分文档，这里是评审要重点过的十条：

1. **规范格式中立**（01）：core 内部 message/tool/toolCall 用自有形状，不采用任何一家的协议形状（架构 §3.4 明文）；system prompt 是 `chat()` 的独立参数而非 message role。
2. **toolCall.args 恒为已解析对象**（01）：canonical 层不传 JSON 字符串——openai 的字符串形态在适配器内 guard-parse（截断容错，03 §偏离 6）。
3. **错误分类为"分罪"服务**（01）：429/连接类是退避谓词 `isInfraError` 的唯一成员（对齐 Python `is_llm_infra_error`）；401/403/4xx/5xx 不退避，走 fallback-切换-否则-抛。
4. **I/O 全注入**（01）：`{fetch, now, sleep}` 三件套从 `createLLMClient(config, deps)` 传入——测试零真网络，退避单测冻结时钟（Python `_mono` 间接引用的 TS 版）。
5. **墙钟预算直接实现为 deadline signal**（03）：梯子内所有请求/sleep 共享一个 AbortSignal；到点在飞请求被中止、终点异常恒为 `LLMTimeoutError`——结构性消除 Python 侧 `wait_for` 把终点异常变形为 TimeoutError 的 #194 死法（有意改进，非逐字节移植）。
6. **getAction 返回判别联合而非 dict**（03）：`{kind:"ok", toolInput, usage}` | `{kind:"empty"}`；R1 耗尽的 honest-done 合成移到 P4（依赖 action_shape，上游未稳定）。
7. **不原地改调用方 messages**（03 偏离 1）：Python 的原地滤图/替换是 #197 类 bug 温床；TS 侧函数式拷贝。
8. **anthropic 适配器必须合并连续 toolResult**（02）：Anthropic 对"一个 tool_use 块的多个 tool_result 分散在多条 user 消息"报 400——webbrain 已踩，映射表冻结。
9. **openai 兼容地雷靠配置声明**（02）：`maxTokensField`（默认 `max_tokens`，OpenAI 新契约模型声明 `max_completion_tokens`）；temperature 默认不发（Python 同款，webbrain 的 0.7 默认不采纳）。
10. **gemini schema sanitize**（02）：functionDeclarations.parameters 只收 OpenAPI 子集，适配器内做白名单清洗；白名单以 smoke 实测收敛。

## 6. 风险与未决

| # | 风险 | 缓解 |
|---|---|---|
| 1 | 智谱 Anthropic 兼容端点与官方规格的偏差（thinking 块、stop_reason、usage 字段） | 2.5 smoke 实测锚定，不猜；wire fixtures 以实测样本为准修订 |
| 2 | 开源兼容端点（vLLM/Ollama 形态）对 forced tool_choice 支持参差 | 承重墙路径（prompt 约束 + JSON 兜底）是 2.3 的专项验收用例；capabilities 由 provider 卡片显式声明 |
| 3 | gemini 真机差异：schema 子集（`$schema`/`additionalProperties` 等键不被接受）、thinking 模型 thoughtSignature 回传 | 适配器白名单清洗 + 清洗事件告警（02 §5.3，轮 6/9 补观测与收口）；thoughtSignature 透传已按官方规格实现（轮 6 #17）——**真机核对项（轮 9 #11）**：官方 GenAI SDK 把签名附到下一回合 functionResponse part，当前实现在 functionCall part 上回传，若真机按 functionResponse 校验需调整位置；smoke 只测智谱两端点，gemini 真机验证顺延到有 key 时 |
| 4 | P2/P4 哨兵契约返工：P4 快照审查时 step 梯子语义若与 `{kind:"empty"}` 不匹配 | 03 §4 偏离清单已写明契约意图；P4 启动检查点重新对照 client.py |
| 5 | 外部取消穿透（用户 stop 时 SW 被杀/信号竞争） | `AbortSignal` 全链路传递，取消异常不吞（Python #186 教训）；单测有用例 |
| 6 | 文档冻结后协议漂移（官方 API 演进） | 02 头部声明"以本仓 fixtures + smoke 为准，文档是导航不是权威"；fixtures 更新须在提交信息注明 |

## 7. 完成记录

实施（分支 `feat/p2-llm-client`，一项一提交，2026-09-23）：

| # | 工作项 | 提交 | 验收证据 |
|---|---|---|---|
| 2.0 | core 包脚手架 | bd43dbf | `pnpm -r typecheck/test` 绿；biome 核心包边界（禁 chrome.*/process.*）对 `packages/core/src/**` 验证生效 |
| 2.1 | 规范类型 + Provider 接口 + 错误分类 | a4bac60 | 47 测试全绿（不变量/视觉白名单 Python 锚定/isInfraError 矩阵），覆盖率 100% |
| 2.2 | anthropic + http + transforms + client 行为层 | a984e64 | 119 测试全绿（96.76%）；Python 锚定值烤入（tryParseJson 9 例/URL 缩写 tag 序/敏感值插入序/退避 2,4,8,16,30,30 + retry-after 容错/R4·R1 文案）——evals venv 实跑，命令与输出存 `transforms.test.ts` 头部 |
| 2.3 | openai-completions | a0fdfef | 132 测试全绿（97.06%）；maxTokens 双轨/arguments guard-parse 专项；跨协议 fallback（主 anthropic + fallback openai）专项 |
| 2.4 | gemini + schema-sanitize | 2522d12 | 146 测试全绿（96.72%）；断言锚定 02 冻结规格——无内部参考，真机差异待有 key 实测修订（风险 3 顺延） |
| 2.5 | smoke 脚本 | （本提交） | `node packages/core/tools/llm-smoke.mjs`（需 GLM_API_KEY）；链路验证见下 |

smoke 产物摘要：

- **2026-09-23 假 key 链路验证**（无费用，验证打包与 wire，不发真 LLM 调用）：esbuild 打包 src/index.ts → 两端点真实 401 → `LLMAuthError`；智谱错误体 `{"error":{"message":"令牌已过期或验证不正确"}}` 走通通用 message 提取；URL/headers 与 02 规格一致——openai 端点 `POST /api/paas/v4/chat/completions`（Bearer）、anthropic 端点 `POST /api/anthropic/v1/messages`（x-api-key + anthropic-version + dangerous-direct-browser-access）。
- **真机 agent_response 往返**：待 `GLM_API_KEY` 实跑（模型可用 `SMOKE_OPENAI_MODEL`/`SMOKE_ANTHROPIC_MODEL` 覆盖，以账号可用为准）；产物贴回此处，端点与官方文档的偏差 → 修订 fixtures 时提交信息注明（风险 1 的闭环动作）。

### 评审轮 1（review-p2-llm-client-1.json，2026-09-23，35 条）

采纳 31 条 / 驳回 4 条，修复提交见 git log。要点与契约修订：

**三组实质缺陷**：
- `ProviderConfig.temperature` 死配置（#24/29/31）：三适配器补回退链 `req.temperature ?? config.temperature`（与 maxTokens 同款；两级缺省仍不发）。
- 连续同角色消息不折叠（#25/30）：canonical 允许 `[user, user]`，而 anthropic/gemini 要求角色交替会 400——与 toolResult 折叠同族地雷，02 计划时遗漏。适配器层 `pushMerged` 折叠（含"toolResult 折叠出的 user 消息 + 紧随 user 观察"的相邻场景）。**附带收益：R1 梯子追加的 user 指令不再产生连续 user wire 消息**（严格交替端点上的潜在 400 由折叠消除）。
- `resp.text()` 不在错误分类内（#4）：超时若发生在 body 读取阶段会裸抛 AbortError 被误判为外部取消——fetch 与 resp.text() 共用 `classifyFailure`。

**契约修订**（同步进 01/03）：LlmDeps 增 `log?: (message) => void`（缺省 console.warn，#22）；`setCallWindow(timeoutMs | null)` 支持清除（#16）；`createProvider` 签名放宽为 `LlmDeps = {}`（#35）；schema-sanitize 键名归一化写入 + `type: ["string","null"]` 联合类型拆 nullable（#6/32）；gemini 补 `cachedContentTokenCount → cacheReadTokens`（#28）；`assertValidMessages` 拒绝重复 toolCall id（#23）；http 错误体兼容 `{error:"str"}`/顶层 `{message}`（#9）；testConnection 公共化进 adapters/common.ts 且带 10s 兜底超时（#7/18/27）。

**驳回 4 条**：
- #15 梯子缺省超时——Python get_action 同样无内部上界（外层 wait_for 提供，P4 step 恒传），按 03 冻结契约仅在 GetActionOptions 文档写明调用契约。
- #17 敏感值占位扩展到 toolResult.text——Python `_filter_sensitive_in_messages` 明确只处理 text block（P5 parity），修改属上游契约变更；已在函数注释记录取舍，P4 接 SecretProvider 时一并裁决。
- #7 的"折叠骨架参数化共享"子项——两协议折叠的块形状/排序语义不同，抽象收益低于可读性损失；仅抽公共小件（isRecord/stripTrailingSlash/defaultTestConnection）。
- #12 仅部分采纳：MockFetch 删除未用的 expect/expectFor；queueMany 耗尽抛错保留为编排失败信号。

### 评审轮 2（review-p2-llm-client-2.json，2026-09-23，17 条）

采纳 16 条 / 驳回 1 条（#15 行为改动，按其备选方案登记取舍）。要点：

- **canonical 层防御前移**：toolResult 的 toolName 与配对 toolCall.name 一致性校验（gemini 按 name 关联，失配不再发到端点才 400）；anthropic/openai 缺失/空 id 的 tool_call 丢弃+log（回传历史 id="" 会被官方端点 400）；tool_choice 补 `tools !== null` 守卫（孤立 tool_choice 400，与 gemini 对齐）。
- **错误分型补洞**：错误响应体读取阶段的超时按超时分型（原 `.catch(()=>\"\")` 会把超时误报为状态码错误 → 不可重试 + 误触 fallback）；fallback 卡片构造失败不再掩盖触发切换的原始错误（cause 保留根因，分罪不变形）。
- **视觉白名单边界收紧（偏离 Python，已注释+测试锁定）**：`v`/`flash` 后加 `(?![a-z0-9])`——glm-4voice 类伪型号不再误判视觉；真实型号（v 后结尾或连字符）不受影响。Python 无此断言，属有意偏离。
- **工具链**：gemini model 路径段 encodeURIComponent；覆盖率门禁收敛到 package.json test 脚本（单文件/watch 不再被全局阈值假性卡死）；FakeClock 未收敛改 throw（fail fast 带 due/t 线索）；MockFetch 队列耗尽先 console.error（防被 ConnectionError 分类吞掉线索）；嵌套三元改 if/else；common.ts 死类型删除；schema-sanitize 复用 common.isRecord；敏感值还原侧对称滤空键。
- **驳回 #15**（滤图改纯能力驱动）：白名单外真视觉模型（qwen-vl/gpt-4o）缺省 supportsVision=false，恒滤图会把图从视觉模型静默剥掉——比现状更糟；按评审备选方案登记到 03 §4 偏离清单第 9 条，宿主侧用白名单外主卡时显式声明 capabilities。

测试 173 例全绿（覆盖率 97.04%）。

### 评审轮 3（review-p2-llm-client-3.json，2026-09-23，13 条）

采纳 13 条（其中 #5/#6 按折中方案：锚定命令的 venv 绝对路径改为指向 AGENTS.md「验收命令」节的相对引用——P1 dom-snapshot 惯例是命令放 docs、测试头部只引用）。要点：

- **真缺陷**：`replaceAll` 字符串 replacement 会解释 `$$`/`$&`/`$'` 特殊模式——还原侧的真实敏感值/URL 含 `$` 序列时被静默篡改（`pa$$word`→`pa$word`），Python `str.replace` 是字面替换。全部改回调形式 + `$` 序列往返专项用例。
- **smoke**：maxTokens 4096→`DEFAULT_MAX_TOKENS`(16384)（思考模型 4096 会被 reasoning 写满 → getAction 落 empty → smoke 假失败）；脱敏统一 `redact()`——URL、header 值（按值含 key 即替换，覆盖 extraHeaders 注入的任意名认证头）、异常消息（http 层错误消息内嵌完整 URL/网关回显体）全走一遍。
- **双时钟域消除**：ladder deadline 计时从原生 setTimeout 改为经 `deps.sleep` 的 watcher（与退避预算同注入钟域），getAction 收尾 abort 取消不留悬挂定时器；FakeClock 用例随注入时钟推进 deadline 触发。
- **一致性**：trySwitchToFallback 先局部构造成功再提交（构造失败不再留下 config=fallback/provider=旧卡的错配状态）；MockFetch 队列耗尽改抛 AbortError 形态（可穿透 postJson/callWithBackoff/getAction 各层分类，编排错误立即失败而非挂到 5s 超时）；ConnectionError 耗尽用例补请求次数断言（与 429 版对称）；hanging fetch 桩提取参数化工厂。
- **测试组织**：新增 test/llm/http.test.ts 集中覆盖 http.ts 导出面（parseRetryAfterMs 矩阵、状态→错误类、错误体三形态、500 截断、2xx 非 JSON、网络层），anthropic.test.ts 撤走重复的 http 层用例（保留 provider 集成矩阵）。

测试 192 例全绿（覆盖率 97.39%）；smoke 假 key 链路复验（max_tokens=16384 上 wire、401 分罪、exitCode 1）。

### 评审轮 4（review-p2-llm-client-4.json，2026-09-23，18 条）

采纳 18 条。要点：

- **真 bug（#6/#7）超时分型在真实运行时失效**：`AbortSignal.timeout` 到点时 fetch 以 abort reason（name="TimeoutError" 的 DOMException，DOM 规范行为）拒绝——isAbortError 只认 AbortError，真实超时被误分型为 LLMConnectionError（infra 可重试，与到点强杀语义相反）；错误体读取阶段同因被吞成状态码错误。测试从未暴露是因为 mock 全用 AbortError 形态构造。修复：classifyFailure/错误体读取改**状态优先**（timeoutSignal.aborted 即按超时分型）+ isAbortError 兼收 TimeoutError + mock 改 reject(signal.reason) 复刻真实形态 + 真实超时回归用例。
- **gemini 两处（#16/#17）**：stopReason 改从**保留**的调用推导（被丢弃的幻觉调用不再置位，toolCalls 空不误报 tool_call）；无参 functionCall 的 args 缺失兜底 {}（proto3 JSON 省略空 Struct，与 anthropic input 口径对齐）。
- **滤图条件修订（#15，承接轮 2 登记）**：当前卡显式声明 `supportsVision=false` → 恒滤（声明即生效）；未声明 → 保留原取舍（仅 fallback 后按推导滤）——文本主卡显式配 false 即受静默致盲保护，白名单外视觉主卡不被误滤。03 §4 偏离 9 已同步修订。
- **观测补齐（#9）**：getAction 丢弃非目标 toolCall 时留 WARNING（名字列表），兑现 deps.log 声明的观测契约；sensitiveMap 的 JSDoc 标注 toolResult 不在替换范围 + 补对应锚定用例（与 URL 侧对称，#8）。
- **smoke（#3/#4/#10）**：esbuild 显式入 devDependencies（借道 vitest 闭包降级为兜底——vitest rolldown 化后闭包会消失）；rmSync 清理 best-effort（Windows 文件锁）；顶层兜底 catch 输出过 redact（stack/cause 链）。
- **测试口径统一与去重（#1/#2/#5/#11/#12/#13/#14/#18）**：headers 断言统一 toEqual 全量锁定（三文件）；temperature 回退链抽 common.temperatureEntry；跨协议用例复用 setup；LONG_URL/drainBackoffLadder 提入 fixtures/helper；两处 queueMany 多余响应删除（保住队列耗尽 fail-fast）。

测试 197 例全绿（覆盖率 97.35%）；smoke 假 key 链路复验。

### 评审轮 5（review-p2-llm-client-5.json，2026-09-23，19 条）

采纳 17 条 / 驳回 2 条（均因事实前提不成立）。要点：

- **取消穿透补洞（#12，本轮最重要）**：外部取消/窗口 deadline 恰逢**错误响应体读取**时，http 层把 abort 吞成状态码 LLMError（如假性 429）→ 误触发 fallback 单向切换（不可逆）+ 以已中止 signal 补发注定失败的请求。callWithBackoff 在错误分类（含切换）前先查 `req.signal.aborted`，已中止即还原为取消原样上抛。附带语义修正：窗口 deadline 恰逢失败响应的终点从"最后错误"变为 LLMTimeoutError——正符合偏离 5「到点恒 Timeout」（原行为是 abort 无人消费的竞态产物）；回归用例锁"穿透 + 单向锁未消耗"。
- **stopReason 三协议统一（#5/#6）**：anthropic/openai 补 hasKeptToolCall 守卫（与 gemini 轮 4 口径一致）——调用全部被丢弃时不置 tool_call（避免 toolCalls 空却报 tool_call 误导排障）；保留调用推导优先于 finish_reason（openai 用例 length→tool_call 随之更新）。
- **无参工具调用三协议对齐（#16 + 轮 4 #17 收口）**：openai arguments 缺失/空串兜底 {}（vLLM/Ollama 对无参工具的合法形态），仅"有内容但解析失败"才丢弃。
- **gemini 合成 id 跨响应唯一（#17）**：provider 实例级自增序号（宿主可能以 toolCallId 作跨回合键，对齐真实端点全局唯一行为；每实例从 0 起保持测试确定性）。
- **http 层打磨**：错误体三条 JSON 提取路径统一截断 500（#7）；超时分型抽 throwIfTimedOut 防两处模板漂移（#8）；testConnection maxTokens 5→16（o 系/gpt-5 的 max_completion_tokens 最小值 16，5 会 400 假阴性，#9）。
- **smoke**：兜底 catch 显式遍历 cause 链（Error.stack 不含 cause，#2）；SMOKE_TIMEOUT_MS 覆盖（#3）；串行意图注释（#4）；ok 路径校验 toolInput.action.name（防 text-JSON 兜底假通过，#13）；redact 追加 URL query 值掩码（网关令牌非 GLM key 本身，#14）。
- **schema/测试**：type:["null"] 边界兜底 "string"（#10）；gemini fixture 补 minimum 使标题声称的删除路径真实执行（#15）；openai baseReq 上移（#11）；okResult 注释修正——还原顺序与请求侧**同序**（Python parity，刻意不取严格互逆，碰撞窗口注释记录，#19 折中）。

驳回 2 条（事实前提不成立）：
- **#1**（test:coverage 死入口）：根 package.json `test:coverage` 与 gate.mjs quality 步骤均按名调用 `pnpm -r run test:coverage`，删除即让 core 在提交门失去覆盖率校验；"dom-snapshot 不跑覆盖率"亦不实（其 config enabled:true 恒开）。两脚本同文保留。
- **#18**（package.json 未声明 engines）：packages/core 的 `engines: node >=22` 已在轮 1 声明（>20.3 满足 AbortSignal.any），前提不成立，不做运行时降级。

测试 200 例全绿（覆盖率 97.24%）；smoke 假 key 链路复验（exitCode 1）。

### 评审轮 6（review-p2-llm-client-6.json，2026-09-23，19 条）

采纳 17 条（#1 采纳其"文档化别名"子项）/ 驳回 2 条。要点：

- **gemini thoughtSignature 透传（#17，本轮最重要）**：2.5/3 系 thinking 模型的 functionCall part 携带 thoughtSignature，官方要求后续回合随 part 原样回传、缺失即 400 INVALID_ARGUMENT——多轮工具调用第二轮即断。canonical `ToolCall` 增可选 `signature`（仅 gemini 适配器读写，其余协议恒缺省）；解析捕获、回传时随 functionCall part 写回；按官方规格实现并锚定 mock 用例，真机验证随风险 3 顺延。
- **tools 空数组三适配器一致过滤（#5/#6/#16）**：`tools: []` 此前原样发空列表（anthropic 官方端点 400；openai 兼容端点 vLLM/Ollama 同类风险），且与 forced toolChoice 组合会产生孤立 tool_choice/toolConfig——统一按长度过滤，forced 守卫同口径收严。
- **schema 清洗删除告警（#7）**：白名单外键（anyOf/oneOf/$ref/minimum…）删除不再无痕——`onDroppedKey` 上报归一化键名（顶层+嵌套递归），provider 实例级按键名去重（工具 schema 逐请求固定，重复告警只有噪音），约束丢失留下排障线索。
- **smoke 打磨（#2/#10/#11）**：redact/SENSITIVE_HEADERS/cause 链格式化提取为模块级共享（主循环与兜底 catch 用同一份实现，防两处口径漂移）；per-card catch 补 cause 链输出（LLMTimeoutError/LLMConnectionError 的底层网络错误恰在此路径抛出，原先只打 name:message 丢最关键排障信息）；SMOKE_* 环境变量 `??`→`||`（空串 env 会把 baseUrl 置空变形为 "Failed to parse URL"）。
- **transforms 注释与锚定（#9）**：还原侧"与请求侧对称滤空键"表述失实——请求侧只滤空 real（Python 两侧都不滤，均为 TS 防御性收严）；空占位符条目的请求侧语义 = 删除敏感值（`replaceAll(real, '')`，Python 同款不可逆），还原侧无从恢复跳过；补请求侧删除语义锚定用例，注释改写为准确表述。
- **测试补强（#3/#12/#13/#14/#15/#18/#19）**：Retry-After 回落集补 HTTP-date 样例（Python 口径显式不支持，锁定边界）；gemini 补 tools:null+forced 用例（三协议契约矩阵闭盲区）；合成 id 跨响应续增用例（防退化为按响应内编号造成跨回合碰撞）；maxTokensField 卡片声明补反向断言（两字段并存会被新契约网关拒收）；2xx 非 JSON 补长响应体用例锁定 200 截断阈值；hangingBodyFetch 扩 headers 参数复用（轮 5 用例的 ~15 行重复桩消除）；R4 梯子用例标题与 3 次编排对齐。
- **注释修正（#4/#1 子项）**：FakeClock 收敛参数注释对齐实现（超限 throw 非 warn）；vitest.config.ts 注明 `test:coverage` 是 `test` 的纯别名（根脚本与 gate.mjs 按名引用的跨包契约）。

驳回 2 条：
- **#1 删除子项**（删 `test:coverage`）：gate.mjs quality 步骤按名调用 `pnpm -r run test:coverage`（轮 5 #1 已核实同款），删除即让 core 在提交门失去覆盖率校验；按评审自己的备选方案文档化为纯别名。
- **#8 行为扩展子项**（请求侧 sensitiveMap 扩展到 toolResult.text）：P5 parity 裁决在案（transforms.test 锁定，轮 1 #17 同源驳回），P4 接 SecretProvider 时一并裁决；其文档诉求已在位——GetActionOptions.sensitiveMap JSDoc 已明示"工具输出中的敏感值会明文出站"。

测试 211 例全绿（覆盖率 97.28%）；smoke 假 key 链路复验（exitCode 1，脱敏生效）。

### 评审轮 7（review-p2-llm-client-7.json，2026-09-24，12 条）

采纳 12 条。要点：

- **stripImageBlocks 滤空改降级（#5，本轮唯一行为翻转）**：image-only 历史 + 滤图条件（fallback 切换或显式 supportsVision:false）此前抛 LLMProtocolViolationError——一次瞬时 429 触发 fallback 切换会被放大成步级硬失败。Python 原实现降级为空串继续（已核实源码），TS 降级为占位文本块 `[image omitted]`（满足 canonical 非空不变量，保住"继续而非失败"的 parity 精神）；锚定测试同步翻转。
- **错误体读取的外部取消穿透（#8，轮 5 #12 同族收口）**：外部 signal 恰逢**错误体读取**时 AbortError 被 statusToError 吞掉——取消误报为真 429（可重试 + 误触 fallback 单向切换）。此前靠 callWithBackoff 的 signal 预检兜底，现 http 层本地即原样上抛（与成功体路径 classifyFailure 对称），「取消必须穿透」不变量在层内自洽。
- **观测补洞（#4/#6）**：toolResult 文本命中敏感 real 值 → WARNING（明文出站的暴露可观测；wire 形态不动、维持 P5 parity，P4 收口）；滤图首次真正生效 → WARNING 一次（实例级去重）——白名单外真视觉卡被误滤时宿主有迹可循，ProviderConfig.capabilities 注释补 fallback 未声明按白名单推导的提示。
- **无参调用兜底口径统一（#1/#9）**：openai `arguments:null`、gemini `args:null` 并入缺失/空串兜底 {}——null 与缺失语义相同（无参工具），个别兼容网关/转换型网关以此形态表示无参，此前整调用被静默丢弃。
- **schema type 清洗闭环（#3）**：单值 `type:"null"` 此前原样透传（不在 Gemini 枚举内仍会被拒收，与文件头"清洗必须闭环"矛盾）；数组元素非字符串的病态值同样漏过——统一并入 `["null"]` 同款兜底路径并按 typeof 收紧。
- **归因与防御（#10/#11/#12/#7/#2）**：三适配器 parseResponse 的"响应不是对象"违例 provider 从协议字面量改为卡片 name（errors.ts 契约，fallback 同协议双卡可归因）；restoreInStrings 对 Map/Set/Date 等非普通对象原样保留（按 entries 递归会静默清空成 {}——现调用点只喂纯 JSON 产物，防御未来复用）；NEW_CONTRACT_PREFIX 注释登记前缀清单随新模型发布漂移的维护义务与 o1/o3/o4 误匹配场景。

测试 218 例全绿（覆盖率 97.93%）。

### 评审轮 8（review-p2-llm-client-8.json，2026-09-24，12 条）

采纳 11 条（#3 代码统一采纳、其补测子项按事实驳回）/ 驳回 1 条子项。要点：

- **URL 缩写尾界排除全角标点（#10，本轮唯一行为改动，03 §4 偏离 10 登记）**：Python `https?://\S+` 尾界贪婪到空白——中文书写 URL 后紧跟「，。」等全角标点（无空白）会把后续中文吞进「URL」整体换 [uN] tag：请求侧静默删中文、还原侧产出带中文尾巴的损坏 URL。中文语境是本项目宿主常态，按视觉白名单 `(?![a-z0-9])` 同款纪律做登记式收紧（ASCII 标点保持 Python 同款吞入，英文/空格锚定用例不受影响）。
- **LLMBlockedError provider 归因（#2/#8）**：gemini promptFeedback 拦截的 provider 硬编码 "gemini" → 卡片 name（轮 7 #10-12 同族漏网；fallback 双 gemini 卡可区分），用例补 provider 断言。
- **观测与一致性（#3/#11）**：client 层丢弃非目标调用的告警统一为「目标命中与否都按 dropped 判定」（原目标缺失分支才算、命中分支静默）；openai 非请求工具名的 tool_call 丢弃补告警（anthropic/gemini 已有，三适配器口径一致）。**#3 的补测子项驳回**：经 getAction 恒发 tools=[tool]，适配器层已按 requestedNames 上游过滤+告警——client 层 dropped 恒空，该分支是防未来适配器不过滤的纵深防御（已注释写明），评审建议的用例在现有注入面下不可编写；可观测路径的锁定在适配器层用例。
- **注释与文档（#4/#5）**：退避序列注释修正为 2,4,8,16,30 共 5 次睡眠（Python 注释即五值；RETRY_MAX=5 下第 6 次睡眠不存在，describe 标题同步）；LLMClient 类文档声明非并发安全约束（串行 agent loop 设计；fallback 单向切换变异实例状态、窗口登记跨步复用须重登记）。
- **测试打磨（#1/#6/#7/#9/#12）**：schema 告警断言与文案解耦（只锁键名序列：去重/归一化/首现序）；client.test 抽 setupWithLogs/setupRealClock 变体收敛 5 处手工样板；补 r500 镜像用例（无 fallback 直抛 LLMServerError 1 次请求 / 有 fallback 触发切换——5xx 独立分类在行为层锁定）；anthropic 六状态矩阵改 instanceof-only + 429 单点 message 抽样（message 提取属 http 层职责，与 http.test 分工对齐）；滤图去重用例第二次调用改用带图消息（原无图调用测不到去重，删掉 loggedImageFilter 也能通过）。

测试 222 例全绿（覆盖率 97.94%）。

### 评审轮 9（review-p2-llm-client-9.json，2026-09-24，18 条）

采纳 18 条。要点：

- **外部取消与 deadline 竞态优先分类（#8，本轮最重要）**：windowExpired 由 deadline watcher 异步翻位——外部 abort 先发生、deadline 恰在异常 unwind 期间到点时，外部取消会被变形为 LLMTimeoutError（污染 step 层按异常类型分罪的依据，违背 #186 不变形契约）。catch 判定补 `!external?.aborted`（竞态同时触发按外部取消穿透）。回归用例以「真实宏任务延迟 reject + FakeClock deadline」确定性构造临界，已验证无修复必失败。
- **无 deadline 时单请求 600s 兜底超时（#9）**：此前调用方漏传 timeoutMs 且未 setCallWindow 时一次挂死 fetch（TCP 黑洞）会无限阻塞——无超时无取消无错误。`CHAT_HTTP_TIMEOUT_DEFAULT_MS=600_000`（对齐 Anthropic/OpenAI SDK 缺省请求超时；Python 侧同款上界本就来自 SDK）仅在无梯子 deadline 时下发，有 deadline 时仍由 ladder signal 强杀；梯子总时长仍无上界（契约不变，JSDoc 同步）。600s 到点路径涉真实计时器不可入单测，三元逻辑由全量用例行覆盖。
- **schema 清洗闭环与观测泛化（#13/#17）**：onDroppedKey 泛化为 onSchemaIssue（detail 字符串）——type 联合多成员窄化（string\|number→string）、items 元组窄化首元素、items/属性子 schema 非对象（含 draft-06+ 布尔 schema）归一空 schema，全部不再静默且不再原样透传被端点 400；「非对象子项原样透传」旧锚定用例随之翻转（自建 fixture 非 Python 锚定）。
- **前缀清单现役缺口（#18）**：gpt-oss 系（2025-08 起在售 reasoning 模型）补入 NEW_CONTRACT_PREFIX——已核实兼容端点对 reasoning 模型拒收 max_tokens；补 maxTokens 双轨用例。
- **smoke（#1/#2/#3）**：MASK_QUERY_RE 键名收 `[^&=]+`（`?api.key=`/`?auth/token=` 点斜杠键此前整条失配、token 明文漏出——假 key 网关 URL 实测掩码生效）；MESSAGES 注释独占一行（轮 6 引入的格式失误）；删冗余 label 字段（日志直接用卡片 name）。
- **观测一致性与注释（#16/#12/#11/#10）**：gemini functionCall 非对象 part 丢弃补 log（与 name 非字符串同口径）；openai assistant 历史图块静默丢弃补协议约束注释；thoughtSignature 回传位置列入风险 3 真机核对项（官方 SDK 附在 functionResponse part，现按 functionCall part 回传）；窗口派生比率 0.75 提为 WINDOW_BUDGET_RATIO 常量。
- **测试打磨（#4/#5/#6/#7/#14/#15）**：敏感值 WARNING 用例补反向断言（观测通道自身不得泄露明文）；client.test 的 "agent_response" 硬编码统一 TOOL.name 单源（承重墙 prompt 断言是 Python 锚定文案，保留字面）；轮 5 回归用例改「text() 打点 + await 后 abort」确定性同步（缺省 sleep 用例补微任务排空注释）；schema 告警断言注释修正（关键词+「」格式是契约的一部分，非完全解耦）；变换往返用例短路写法改分步断言；transforms.test 头注释补锚定归属（指数梯子在 client.test、retry-after 在 http.test）。

测试 224 例全绿（覆盖率 97.91%）；smoke 假 key 复验（exitCode 1、`?api.key=` 点号键掩码生效）。

### 评审轮 10（review-p2-llm-client-10.json，2026-09-24，9 条）

采纳 9 条。要点：

- **schema 白名单扩约束键（#1，行为改动，02 §4.4 已同步修订）**：官方 v1beta Schema 文档明确支持 `minimum`/`maximum`/`pattern`/`minLength`/`maxLength`/`minItems`/`maxItems`——此前一律删除会让数值/长度约束静默丢失、模型生成越界参数直接进入工具执行。补入白名单；多词键按官方 camelCase 发射（本模块写入键统一小写，新增 EMIT_KEY 还原拼写）。附 camelCase/大小写变体透传用例。
- **required 值形态收口（#2）**：`required: null` 等非 string[] 原样透传同有 400 风险——删除并上报（与 type 联合/items 元组/布尔子 schema 的轮 9 收口口径对齐）；旧「不在本轮收口范围」的 toEqual 锚定随之翻转。
- **thoughtSignature 双携带（#9，行为改动）**：官方两处口径并存——错误文案"missing thought_signature **in functionCall parts**"指向 functionCall part（现有实现），官方 SDK 组装形态与文档"随 functionResponse 回传"指向 functionResponse part。按文档在 functionResponse part 补挂签名（functionCall part 携带保留），双携带待真机核验收敛（风险 3）；往返用例补 functionResponse 断言。
- **abort reason 透传（#5）**：onExternalAbort `controller.abort(external?.reason)`、defaultSleep/FakeClock reject `signal.reason ?? 缺省`——宿主以自定义 reason（如 "user-stop"）区分停止来源时不再在 getAction 边界被抹平为默认 AbortError；补自定义 reason 穿透用例。
- **600s 兜底测试锚定（#6）**：决策提为导出函数 `resolveChatHttpTimeoutMs`（index 导出注明仅为测试锚定）——`undefined→600_000 / 有 deadline→undefined` 单测锁定，防未来重构静默丢兜底。
- **去重集上限（#3）**：warnedSchemaIssues 以完整事件文案为键，动态工具 schema（属性名随页面变化）在长生命周期实例上无界增长——设 128 条上限（上限后新事件静默），130 唯一事件用例锁定 128 条封顶。
- **测试组织（#4/#7/#8）**：fixtures 增 setupProvider 装配（三适配器 setup 收敛为委托，卡片仍留各自文件）；anthropic/openai 的「tools null+forced / 空数组」两用例从响应解析 describe 归位到请求构造（与 gemini 口径对齐）。

测试 228 例全绿（覆盖率 97.95%）。

### 评审轮 11（review-p2-llm-client-11.json，2026-09-25，11 条）

采纳 10 条 / 驳回 1 条（#6，同源第三次的 parity 裁决维持）。要点：

- **schema 值形态闭环补全（#1/#9，本轮主要实质改进）**：properties 非对象（`properties: "foo"`）与 type 标量非字符串（`type: 5`）、enum 非 string[]、nullable 非布尔此前都经 else 分支原样透传——端点 400 形态。对齐 required/items 的既有口径：properties/enum/nullable 删除并上报、type 标量兜底 "string" 并上报；附专项用例。
- **预中止分支 reason 透传（#7）**：external 已 aborted 时 `controller.abort()`（无参）与事件路径 `abort(external.reason)` 行为不一致——轮 10 #5 修复的漏网分支，宿主自定义 reason 在该路径仍被抹平；一行补齐。
- **测试基建（#4/#5）**：MockFetch.bodyAt/lastBody 越界或缺 body 时原先抛无线索的 SyntaxError（JSON.parse(String(undefined))）——补守卫报错携带 calls 数量（与队列耗尽的显式报错对称）；三份「挂起响应体」桩（hangingBodyFetch / 轮 5 markBodyRead 内联桩 / 轮 9 delayedAbortFetch）提取为 mock-fetch 的 `makeHangingBodyFetch({ok,status,headers,onBodyRead,rejectDelayMs})` 参数化工厂——signal.aborted 预检与 reason 兜底等分型语义细节不再散在三份拷贝里。
- **注释与口径（#8/#11/#3/#2/#10）**：LLMBlockedError 注释去掉与实现不符的「openai content_filter 保留」表述；provider.ts testConnection 注释同步 maxTokens=16；去重上限断言先过滤再计数（与姊妹用例口径对齐，防无关日志误红）；anthropic.test 清理 setupProvider 抽取后的死导入；setupRealClock 注入静音 log（被测对象是缺省时钟/睡眠，非缺省日志——退避用例不再向控制台刷 backoff 日志）。

驳回 1 条：
- **#6**（toolResult.text 纳入敏感值占位 / opt-in 确认）：同源第三次（轮 1 #17、轮 6 #8、轮 7 #4）——`_filter_sensitive_in_messages` 只处理 text block 是 Python parity 的 P5 裁决在案行为，transforms.test 锚定；修复点登记在 P4 接 SecretProvider 时一并裁决（彼时才有 opt-in 面与还原语义的完整设计上下文）。当前版本以 WARNING 保证明文出站可观测（轮 7 #4），不构成静默泄露。P4 启动时优先处理此项。

测试 229 例全绿（覆盖率 97.97%）。

### 评审轮 12（review-p2-llm-client-12.json，2026-09-25，15 条）

采纳 14 条 / 驳回 1 条（#14，核验不支持按备选口径登记）。要点：

- **redactToolResults opt-in（#4，敏感值议题第四次评审的落点）**：`GetActionOptions.redactToolResults?: boolean`——缺省 false 维持 P5 parity（明文出站 + WARNING），true 时对 work 副本的 toolResult.text 做同款 real→placeholder 占位（合规宿主即刻阻断泄露；模型回显占位符经响应还原自然闭合）。P4 接 SecretProvider 时统一收口此开关。前三次驳回的是「改默认行为」，本次 opt-in 不动默认契约故采纳。
- **R4 回显文本占位（#5，parity 缺口修复）**：核实 Python R4 经递归 get_action 重跑 `_filter_sensitive_in_messages`——回显文本本应占位，TS 循环结构漏掉了：模型回显的敏感值会在重试请求中二次明文出站且回显路径无告警。补齐占位（刻意不重跑 URL 缩写——tag 域冲突，保守偏离已注释）。
- **并发哨兵（#6）**：getAction 重入显式失败（LLMInvalidRequestError）——「非并发」从类文档约束升级为运行时防护，误用不再表现为静默串卡/窗口错乱；拆 getActionInner 保持 finally 复位。
- **temperature 协议钳制（#7）**：anthropic 0-1 / openai/gemini 0-2——卡片误配（如智谱 anthropic 兼容卡 1.5）不再整链每请求硬 400（非 infra 不重试），与 maxTokens=16 同款「主动拆解 400 地雷」思路；三协议钳制用例。
- **预算耗尽日志归因（#15）**：deadline = min(预算, 窗口)，耗尽日志区分 window deadline / budget 秒数——步级窗口先到不再被误导成预算记账错误（setCallWindow(20s) 用例锁定）。
- **观测口径收齐（#8/#9/#11/#12/#13）**：openai 形态异常 tool_call 丢弃补 log；anthropic input 病态非对象（非缺失/null）从静默兜底 {} 改为丢弃+log（与 gemini args/openai arguments 对齐——空参静默执行是排障盲区）；三适配器的丢弃类告警（截断 args/缺失 id/非请求名/病态形态）全部补测试断言，重构丢 log 不再静默。
- **杂项（#1/#2/#3/#10）**：覆盖率注释对齐 AGENTS.md「≥ 85%」；resolveChatHttpTimeoutMs 退出公共导出面（测试深层导入，防签名调整成 breaking change）；SMOKE_TIMEOUT_MS 非法值显式告警（静默回退会把「配置未生效」误导为端点问题，实测告警生效）；maxTokens 双轨补前缀全成员锁定（gpt-4.1-mini/o1/o3-mini/o4-mini——正则误删成员在测试层红，不再落到端点 400）。

驳回 1 条：
- **#14**（白名单补 minProperties/maxProperties）：核验官方 v1beta Schema 经典字段列表不含这两键，社区 Gemini schema 转换器均将其列为不支持项剥离；Nov-2025 扩展的 default/anyOf/$ref 属 response_json_schema 通道非 functionDeclarations.parameters 路径。按评审自己的备选口径「确属不支持则维持现状并在注释记录核验结论」处理，真机有 key 后复核。

测试 239 例全绿（覆盖率 98.65%）；smoke 假 key 复验（SMOKE_TIMEOUT_MS 非法值告警生效）。

### 评审轮 13（review-p2-llm-client-13.json，2026-09-25，15 条）

采纳 13 条 / 驳回 2 条（#7 维持轮 1 裁决；#8 缺省翻转推翻 parity 终裁）。要点：

- **canonical 空文本块拦截（#6，新不变量）**：`TextBlock.text` 非空进 assertValidMessages——Anthropic 官方端点对空 text 块直接 400（"text content blocks must be non-empty"），canonical 层一处收口三适配器；01 §2.1 不变量清单同步补记。
- **isInfraError 纳入 LLMTimeoutError（#15，语义修正）**：能到达该谓词的超时只来自单请求级 timeoutMs（无梯子 deadline 的 600s 兜底——网关挂起类瞬时基建故障），Python SDK 侧 APITimeoutError ⊂ APIConnectionError 同为 infra；梯子 deadline 的强杀经 callWithBackoff 预检还原为裸 abort 不会以本类型到达。此前 errors.test 的 "timeout → false" 锚定与 http.ts "infra 可重试" 注释互为矛盾，现一致。
- **assistant 角色图块收口（#13/#14）**：anthropic assistant content 只收 text/tool_use（image 透传 400 "Input tag 'image' found…"）、gemini 多模态仅 user 角色合法（model turn inlineData 400）——两适配器对齐 openai 轮 9 已登记的静默丢弃口径。
- **format 值封闭枚举校验（#4）**：v1beta Schema 的 format 只收 enum/date-time/float/double/int32/int64——JSON Schema 常见 uri/email/uuid 等值原样透传是 400 形态，删除并上报。
- **temperature NaN 不发（#5）**：Math 钳制对 NaN 透传、JSON 序列化成 null 上送 400（Infinity 反而能钳）——非有限值直接缺省不发。
- **致盲 advisory（#9）**：未声明主卡被白名单推导为无视觉却仍带图出站时留一次 WARNING（对称于滤图告警，独立去重标志）——P0 实测的静默致盲缺省形态可观测，不挑战偏离 9 取舍。
- **实现收敛与守卫（#10/#1/#11/#12/#2/#3）**：`replaceSensitiveText` 单一实现收敛三处替换复制（请求侧/R4 回显/redactToolResults）；MockFetch hangUntilAbort 无 signal 立即报错（fail-fast）；预算作用域注释（每次 callWithBackoff 独立计账，Python parity 有意）；SMOKE_TIMEOUT_MS 用解析有效性标志判定回退（合法值恰等于缺省不再误告警，双场景实测）；setupProviderWithLogs 收敛 7 处日志装配样板；敏感值插入序补反序锚定用例（短键在前的部分替换 hazardous 半边）。

驳回 2 条：
- **#7**（折叠骨架参数化抽象 anthropic/gemini）：轮 1 #7 已裁决——骨架同构但语义分支（签名携带/结果配对/角色名）已在块形状内，抽象后净收益低于可读性损失；两适配器镜像测试矩阵锁定折叠语义，改一漏二会被测试网捕获。维持。
- **#8**（sensitiveMap 缺省占位、显式 false 退出）：敏感值议题第五次，本次要求翻转缺省——直接推翻 P5 parity 基准与轮 12 刚落的 opt-in 终裁（缺省 parity + 显式阻断）。偏离 5/10 先例是 TS 内部机制/中文损坏修复，非请求内容 parity；缺省翻转破坏评测对比的请求侧一致性。P4 SecretProvider 时统一裁决缺省姿态。

测试 247 例全绿（覆盖率 98.80%）；smoke 双场景复验（合法值 60000 无误报 / 非法值告警）。

### 评审轮 14（review-p2-llm-client-14.json，2026-09-25，12 条）

采纳 12 条（#2 采纳其文档子项，缺省翻转随其主诉求 deferred 到 P4）。要点：

- **408 → LLMTimeoutError（#7，本轮最重要）**：408 是网关/代理上游超时的常见形态，OpenAI/Anthropic Python SDK 均映射为可重试——此前落入 4xx 兜底成 LLMInvalidRequestError（非 infra 不退避 + 误触 fallback 单向切换，一次瞬时超时被放大为永久换卡）。轮 13 把 TimeoutError 纳入 infra 后此修复自然获得退避；http.test 矩阵补 408 行。
- **assistant 空 content/parts 兜底（#8/#9）**：image-only 且无 toolCalls 的 assistant（canonical 放行形态）过滤图块后产生空 content/parts 数组——anthropic 硬 400 / gemini INVALID_ARGUMENT。补 `[image omitted]` 占位降级，与 stripImageBlocks 口径一致。
- **o 系 temperature 抑制（#10）**：o1/o3/o4 只接受默认温度，卡片误配（o3 配 0.2）即每请求硬 400 且误触切换——与 maxTokensField 同源的地雷同源拆除（`^o\d` 前缀命中抑制发送；gpt-5/4.1/gpt-oss 支持 0-2 不抑制），config.temperature JSDoc 同步声明。
- **sensitiveMap 缺省风险显式标注（#2，敏感值议题第六次的落点）**：评审主诉求已是「P4 收口时翻转缺省为 secure-by-default + 至少文档标注」——与既有裁决一致。GetActionOptions.sensitiveMap JSDoc 显式声明「sensitiveMap 不覆盖全部出站文本，需阻断显式 redactToolResults:true」；缺省翻转方向登记为 P4 决策项。
- **实现收敛（#3/#11/#12）**：toolResult 敏感值检测/替换单趟合并（命中即换，未命中恒等）；`hasImageBlocks` 共享判定导出（滤图 WARNING 与致盲 advisory 复用，与 stripImageBlocks 跳过规则同处维护）；restoreSensitiveInOutput 恢复集空早退（与 restoreUrlsInOutput 对称）。
- **测试基建（#1/#4/#5/#6）**：makeHangingBodyFetch 补无 signal fail-fast 守卫（与 hangUntilAbort 口径对称）；setupClockWithLogs 收敛第 4 处内联构造；assertOk 辅助收敛 kind 收窄样板；blocked（gemini promptFeedback，非 infra 第三分支）触发 fallback 切换的行为层对称用例。

测试 252 例全绿（覆盖率 98.86%）。

### 评审轮 15（review-p2-llm-client-15.json，2026-09-25，17 条）

采纳 17 条。要点：

- **args 泄露链收口（#7，敏感值家族最隐蔽的一条）**：assistant.toolCalls[].args 不在占位范围且零观测——okResult 把占位符还原为真实值 → 调用方回灌 assistant 历史 → 下一轮 args 明文出站（比 toolResult 更隐蔽，连 WARNING 都没有）。按轮 12/14 先例对称处理：WARNING 检测 + opt-in 深层占位（`replaceSensitiveDeep` 与还原侧同款游走）；**开关由 redactToolResults 更名 redactToolPayloads**（分支未合并，更名零成本）以覆盖 args 语义。
- **type 枚举校验（#17）+ 约束键标量校验（#13）**：`type: "STRING"/"str"` 等合法字符串但非法枚举值原样透传是 400 形态——小写归一命中发射、否则删除上报；约束键 pattern（string）/minLength/maxLength/minimum/maximum/minItems/maxItems（有限数值，**修正了评审建议片段自身把 minLength/maxLength 当 string 的笔误**——官方口径 int64）病态值删除上报。
- **合成 id 实例盐（#14）**：fallback 切换在会话中途重建 provider 实例，纯自增序号会跨实例复用 id（宿主以 toolCallId 作跨回合键则冲突）——`gemini-call-${salt}-${seq}`，测试锚定改 salt 模式断言 + 跨实例唯一用例。
- **删除语义空文本兜底（#8）**：空占位符把整块文本滤成空串会打破轮 13 的非空文本不变量、适配器二次校验错误归因到调用方——降级 `[redacted]`（仅原始非空且滤后为空，不掩蔽调用方自带违例）。
- **围栏正则去 /s（#16，未登记 parity 漂移的回收）**：Python 基线 `.` 不匹配换行，我们的 /s 属无登记漂移——去掉后逐字对齐（多行围栏对象落三级解析，结果等价）。
- **工具与契约（#1/#9/#3/#15）**：fallback 类型 `Omit<ProviderConfig, "fallback">` 禁嵌套（类型收口「至多一档」不变量）；cloneWorkMessages 防御性拷贝 toolCalls（args 深层替换不再可能泄漏回调用方消息）；MASK_QUERY_RE 值容忍空白（token 含空格不残留明文）；smoke 缺 key 改 exitCode 模式（管道重定向下 stderr 不丢）。
- **杂项（#2/#4/#5/#6/#10/#11/#12）**：注释常量名修正（RETRY_AFTER_CAP_MS）；两处 `== null` 改显式双分支；http.test 内联桩复用 makeHangingBodyFetch + AbortSignal.abort；整数键重排限制注释；hasImageBlocks 直接用例；errors.test name 精确断言（派生式 + Error 后缀——评审建议的派生式本身漏后缀，已修正）。

测试 258 例全绿（覆盖率 98.68%）。

### 评审轮 16（review-p2-llm-client-16.json，2026-09-25，14 条）

采纳 14 条。要点：

- **args 检测改「先替换后比较」（#6，轮 15 #7 收口的检测域漏洞）**：旧 `JSON.stringify(args).includes(real)` 与文本替换域不一致——real 含引号/反斜杠/换行时串化转义失配（opt-in 也既不替换也无告警）；real 命中键名或 number 值时反向谎报「已占位」而明文仍出站。改为以实际发生的替换为命中证据（替换前后串化比较），检测/替换天然同域；双向用例锚定（转义 real 的 WARNING+占位 / 键名与 number 命中的不谎报）。
- **删除式空串降级补齐两处（#7/#14，对齐轮 15 #8 的 [redacted] 口径）**：redactToolPayloads 的 toolResult.text 与 R4 回显文本在删除式 sensitiveMap 下可被整体滤空——前者空 text 出站遇拒收会归因到调用方历史，后者空文本块会在适配器入口抛违例且 LLMError 先烧一次 fallback 单向切换；两处均降级 `[redacted]`。
- **temperature 钳制留证据（#4）**：钳制行为正确但静默，与「丢弃/清洗必留证据」口径不一致——temperatureEntry 增 onClamp 回调，三适配器注入 `makeOnceWarn` 实例级去重（每 provider 只警告一次，含卡片名归因）。
- **形态异常与名字失配分档（#11/#12）**：anthropic tool_use / openai tool_call 的 name 非 string 原与「非请求名」共用分支，证据被误标——拆分为「丢弃形态异常」与「忽略非请求名」两档（与 gemini 口径对齐），各自留证据。
- **openai assistant 图块占位对齐（#3）**：仅含 image 块的 assistant 过滤后 content 为空串，与 anthropic/gemini 的 `[image omitted]` 口径不一致——补齐；带 toolCalls 的同形态直接落 null（纯工具调用回合官方形态）。
- **结构与去重（#2/#8/#9/#13）**：transforms 复用 adapters/common 的 isRecord（删除逐字重复副本）；restoreInStrings 更名 rewriteStrings（方向中立，restore/replace 两方向共用，方向语义收敛在包装函数）；leaking 列表 join 前去重（同名工具多轮命中不重复刷屏）；FakeTimer.reject 死代码删除。
- **杂项（#1/#5/#10）**：smoke ok 判定注释修正（形状校验无法区分 toolCalls 与 text-JSON 兜底两条 ok 路径，注明漏判面）；client.test 三处 "agent_response" 字面量改 TOOL.name 插值（防实现退化硬编码工具名的回归）；schema-sanitize type 数组全 null/病态元素兜底补 onSchemaIssue 上报（兜底同样是约束丢失）。

测试 269 例全绿（覆盖率 98.71%）。

### 评审轮 17（review-p2-llm-client-17.json，2026-09-25，16 条）

采纳 16 条。要点：

- **协议违例不再触发 fallback 切换（#9，Python parity 修正）**：2xx 畸形响应体（网关 200 + HTML 错误页）分型为 LLMProtocolViolationError 后原会烧掉单向切换——核实 Python 侧 SDK 对该形态抛 APIResponseValidationError（非 APIError 子类），`_create_with_backoff` 与外层 except 元组均不捕获，即 Python 从不因响应解析失败换卡。trySwitchToFallback 排除该类型：不切换不退避直接上抛（canonical 校验违例换卡同样无济于事）；用例锚定 200+HTML → LLMProtocolViolationError 归因主卡、1 次请求、零切换。
- **canonical 新不变量（#8，web 核实后采纳）**：toolCall.id 非空串（请求侧 tool_use id="" 是端点 400 形态，响应侧轮 12 已同款丢弃）与 toolResult.text 非空（anthropic 把 text 直映射 tool_result 字符串 content，空串是 400 形态 "content field is empty"，社区报告证实）——宿主回灌历史在 canonical 层拦截，而非烧一次 400 后错误归因；01 §2.1 同步。
- **联合 type 枚举校验（#13，清洗闭环盲区）**：`type: ["STRING","null"]` 走数组分支直接透传首个成员，绕过轮 15 #17 的标量三档口径（归一/删除）——窄化结果复用同款枚举校验，非法值删键上报、PascalCase 归一。
- **丢弃类日志统一截断（#5/#6/#14/#15）**：四处形态异常丢弃日志的 JSON.stringify 无上限（网关畸形输出长度无界，长循环刷屏）——common.stringifyForLog 单源收口（String 包装 + 复用 http.ts ERROR_DETAIL_MAX=500；name 可能 undefined，JSON.stringify 返回非字符串不能直挂 .slice——评审自己点出的 TypeError 陷阱）。
- **契约与结构（#1/#4/#7/#10/#16）**：smoke 缺省端点/型号/超时收敛为文件顶常量（消除 6 处字面量散落，文案与回退值同源）；openai assistant content 三层嵌套三元改 if/else（清单规则）；sensitiveMap JSDoc 不覆盖清单补全 systemPrompt 与 ImageBlock.base64（含「宿主可信自持」前提）；redactToolPayloads 覆盖边界显式化（仅字符串值不含对象键名，键位敏感 P4 裁决）。
- **测试侧（#2/#3/#11/#12）**：types/transforms 两测试文件的 "agent_response" 字面量改 AGENT_TOOL.name 插值（惰性填充单一事实源）；URL_MIN_LENGTH 锚定用例从 tryParseJson 块归位 shortenUrlsInMessages 块；provider 字段断言前置 toBeInstanceOf（不抛时以 TypeError 失败而非清晰断言）。

测试 273 例全绿（覆盖率 98.72%）。

### 评审轮 18（review-p2-llm-client-18.json，2026-09-25，13 条）

采纳 13 条。要点：

- **type 兜底口径统一（#1，web 核实后统一）**：非法枚举字符串原走删键、产出无 type 的 schema——网检证实 Gemini 端点要求**每个 schema 节点显式 type**（"missing a type" 400，livekit/agents#5044、awslabs/mcp#661），删键同样是 400 形态。三档统一兜底：非字符串/全病态数组/非法枚举字符串均兜底 string；联合分支升级为**成员级校验、首个合法成员胜出**（`["str","object"]` 取 object，比盲目兜底 string 保真；非法成员跳过留独立证据）。
- **format 按 type 分域收尾校验（#8）**：全集校验之外的盲区——值在全集但 type 域外（`{type:"number",format:"date-time"}`）原样透传；循环后按官方分域表（string: enum/date-time；number: float/double；integer: int32/int64；boolean/array/object 无合法 format）收尾删除并上报；type 缺失不限定（真机核验项）。
- **maxTokens 有限性守卫（#10/#11/#12，三适配器同源雷）**：卡片值 NaN/Infinity/0 序列化 null 或原样上送是端点硬 400（temperature NaN 同款，轮 13 #5），三协议 max_tokens 必填不能走「缺省不发」——common.resolveMaxTokens 统一守卫（回退 DEFAULT_MAX_TOKENS + makeOnceWarn 一次性告警含卡片归因）。
- **canonical 补 name 空串不变量（#13）**：Anthropic 工具名受 ^[a-zA-Z0-9_-]{1,128}$ 约束（openai/gemini 同为必填非空），与轮 17 id 空串对称；toolResult.toolName 空串经既有配对一致性校验兜住；01 §2.1 同步。
- **systemPrompt 泄露可观测（#3）**：systemPrompt 不在占位范围（三适配器原样透传，已核实）且连命中 WARNING 都没有——补一次性告警（实例级去重，观测通道不含明文），与工具载荷/滤图/致盲的可观测姿态对齐。
- **陈旧窗口可观测（#4）**：跨步复用实例漏重登记/清除时 deadline 已过期、首请求即被强杀恒抛 LLMTimeoutError——合并 deadline 处发现过期打 WARNING（含过期毫秒数），把已知 footgun 从注释纪律变成运行时证据。
- **杂项（#2/#5/#6/#7/#9）**：cloneWorkMessages 的 toolCalls/args 副本隔离补对偶用例（轮 15 #9 实现零测试锁定）；rewriteStrings 注 null 原型对象重建会静默换原型；description 非字符串删除上报（白名单标量键值校验最后一块）；openai arguments `"null"` 字符串兜底 {}（网关字符串化 null args 与原生 null 同义，不再误报解析失败）；ASCII 尾随标点吞入行为补对偶锚定（防排除集日后扩到 ASCII 后与 Python 静默漂移）。

测试 284 例全绿（覆盖率 98.77%）。

### 评审轮 19（review-p2-llm-client-19.json，2026-09-25，6 条采纳 5 驳回 1）

采纳 5 条。要点：

- **空 schema 归一补注入 type（#1，轮 18 口径矛盾的收口）**：评审正确指出轮 18 #1 的「节点须显式 type」结论没有贯彻到自身的归一产物——子 schema 非对象 / items 非对象 / 约束键删空三条路径产出的 `{}` 节点同样无 type。统一收口：两处归一点直接产出 `{type:"string"}`，函数末尾对缺 type 节点（含调用方未写 type 的子 schema）补注入缺省 string 并上报；注入先于 format 分域校验（缺 type 节点的 format 按注入后的 type 收口）。不变量收敛为「清洗产物节点恒有显式 type」；02 §4.4 登记修订（真机核验项随风险 3）。
- **common.ts 纯函数单测收敛（#2）**：temperatureEntry/resolveMaxTokens/makeOnceWarn/stringifyForLog 此前只经三适配器测试间接覆盖（回退链/钳制告警/maxTokens 回退近乎逐字复制三份）——新增 test/llm/common.test.ts 一处锁定行为矩阵（含精确告警文案、协议上限表、Infinity/NaN 均不发）；适配器侧保留 anthropic 一份接线锚定（wire 落点 + 实例去重经 provider 生效），删 gemini/openai 重复副本。**顺手修正实现注释失实**：「Infinity 反而能被正确钳制」实际走 `!Number.isFinite` 不发分支。
- **测试组织（#4/#5/#6）**：client.test 四装配工厂（setup/setupWithLogs/setupRealClock/setupClockWithLogs）收敛为 setupCore 公共核心（时钟形态 × 日志采集两维正交）+ 薄委托，零调用点扰动；三段式 history 六处逐字重复收敛 historyWithToolResult 夹具。gemini name:42 分档断言补 `includes("42")` 真锚定（原断言会被同响应的 functionCall 整体非对象分支同文案喂绿，畸形误路由进名字失配档时用例失明）；openai 缺失 id 丢弃补告警锚定（与 anthropic 同名场景观测口径对齐）。

驳回 1 条：

- **#3 issues 文案逐字符断言脆弱**：驳回。逐字符锚定是既定契约——轮 9 #9 已显式裁决「关键词与引号格式是断言契约的一部分」（gemini 去重用例注释自认），这些字符串是可观测性契约本体（日志消费方/排障文档引用），放宽为关键词匹配会让措辞静默漂移；文案变更触发测试红是**有意的摩擦**（迫使有意识地更新契约），toEqual 的期望 diff 本身即可区分「行为回归」与「文案变更」，评审所称「无法区分」不成立。

测试 293 例全绿（覆盖率 98.77%；+11：common.test.ts 纯函数矩阵，净变化含删 4 条重复用例）。

### 评审轮 20（review-p2-llm-client-20.json，2026-09-25，15 条采纳 13 驳回 2）

采纳 13 条。要点：

- **缺 type 注入按结构线索推断（#1，轮 19 注入的语义修正）**：统一注 string 会产出 `{type:"string", properties:…}` 语义错误形态（properties 仅 OBJECT、items 仅 ARRAY 合法）——JSON Schema 中 `{properties}`/`{items}` 不写 type 是合法常见形态，按已有结构推断：有 properties 注 object、有 items 注 array、无线索才兜底 string；`{items:"x"}` 归一产物随之从 string 修正为 array。
- **gpt-5 系温度抑制（#11，web 核实修正轮 14 注释）**：gpt-5 全系与 o 系一样只接受默认温度 1（400 "Unsupported value: 'temperature' does not support X with this model. Only the default (1) value is supported"，社区广泛实证）——轮 14 注释「gpt-5 支持 0-2」有误；正则扩 `/^(o\d|gpt-5)/`（gpt-4.1/gpt-oss 仍支持 0-2）。
- **单向分层恢复（#9）+ 占位哨兵单源（#2/#15）**：isRecord 上提为 transforms 导出、adapters/common re-export（transforms 属 canonical 低层，恢复「adapters 依赖 core」方向）；`[image omitted]` 四处与 `[redacted]` 降级三处分别收敛为 transforms 导出常量/辅助函数（redactOrPreserve），防口径漂移。
- **sensitiveMap 病态配置可观测（#10/#14）**：整数形态键（JS 引擎重排到枚举首位，与插入序不一致）与占位符冲突（还原侧先插入者胜、后续条目静默失效——张冠李戴的数据损坏）在 getAction 入口留一次性 WARNING（transforms 纯函数无告警通道，检测上提）；还原侧注释显式声明「占位符须唯一」约束。
- **resolveMaxTokens 补整数校验（#12）**：三协议上限字段均整型，小数（宿主 parseFloat 产物）穿透是端点 400——`Number.isInteger` 收口（蕴含 isFinite）。
- **空串 systemPrompt 与 null 同等不发（#13，三协议统一）**：canonical 已拦空 TextBlock，systemPrompt === "" 仍以 system:""/空 text part 出站（anthropic/gemini 400 形态）——语义等同未填，非空才发送。
- **超时文案归因（#8）与测试补强（#3/#4/#5）**：超时消息区分约束来源（source=timeoutMs/window/timeoutMs+window），仅传 timeoutMs 的场景不再误导为窗口登记问题；fallback 切换补凭证头断言（防回归为主卡密钥外泄到 fallback 主机）；setupCore 嵌套三元改 if/else；firstText 可选链兜底。

驳回 2 条：

- **#6 预算算式指控**：驳回——评审漏看了窗口派生预算。`setCallWindow(40s)` 时 `cap = max(30s, 40s×0.75) = 30s`，budgetDeadline = 31000 < windowDeadline = 41000，生效 deadline 是预算 31000（标题自述 cap=30s 与算式 31000+30000>31000 内部一致且正确）。
- **#7 敏感值缺省翻转 secure-by-default**：第 N 次同议题（轮 13 #8 驳回、轮 14 #2 登记缺省风险 + P4 决策项、轮 15 更名 redactToolPayloads），本轮无新事实——「缺省抛错迫使二选一」仍是缺省行为变更，属 P4 SecretProvider 裁决域，维持裁决。

测试 299 例全绿（覆盖率 98.75%）。

### 评审轮 21（review-p2-llm-client-21.json，2026-09-25，15/15 采纳）

采纳 15 条。要点：

- **数组索引键谓词修正（#15，修正轮 20 #10 的假阳性面）**：引擎只把 canonical 数组索引键（非负整数 ≤ 2^32-1 的数字串）重排到枚举首位——负数与超界数字串（11 位手机号/16-19 位卡号，恰是轮 15 #10 注释与告警文案引用的典型形态）是普通字符串键恒插入序、无风险；谓词收窄 + 告警文案与 transforms 注释同步修正，补「16 位卡号零告警」反例锚定。
- **病态检测独立执行（#8，修正轮 20 自身的掩盖缺陷）**：整数键与占位符冲突两类检测原为 if/else 串行且共享标志——整数键命中时冲突检测被跳过且标志置位后不再复查（风险更高的张冠李戴损坏恰被掩盖）；改各自独立执行 + 共存用例锚定。
- **穷尽断言收口三适配器（#6/#10）**：ContentBlock 联合（types.ts 注释明示 PDF 等后置）的块转换 else 分支全部改为显式 kind 判定 + never 断言——联合扩展新成员时编译期报错而非静默产出 undefined 字段的非法 wire 块/空串。**评审建议的纯文本路径写法自身编译不过**（some(image) 反向守卫无法收窄到 never，TS2322 实证），改用 every 类型谓词守卫（语义等价且真收窄）。
- **温度抑制可观测（#11）+ 具名常量（#4）**：「配置了 temperature 却被静默忽略」补一次性 WARNING（复用钳制告警的 makeOnceWarn 实例，路径互斥）；抑制正则提升为 TEMPERATURE_UNSUPPORTED_PREFIX（与 NEW_CONTRACT_PREFIX 相邻，成员集刻意不同的差异入注释）。
- **schema-sanitize 收尾（#5/#12）**：6 处 onSchemaIssue 裸 stringify 收敛 stringifyForLog（病态 schema 值无上限，且 detail 整串进 128 条去重集挡不住单条无界）；约束键校验分域——int64 四键（minLength/maxLength/minItems/maxItems）补整数校验（小数 proto3 解析失败同为 400），minimum/maximum 维持 double 有限校验。
- **杂项**：`[error] ` 前缀常量单源（#3，openai/gemini 共用）；超时消息 deadline 绝对时间戳改相对 elapsed（#9，deps.now() 域无参照系易误读）；anthropic CARD.maxTokens 与 DEFAULT 同值无区分度改 4096（#1）；空 systemPrompt 用例收紧首条 user + 条数断言（#2）；setupLogs 支持 over 收敛两处直调（#13）；blocked 用例内联零时钟收敛 setupCore（#14）；transforms.test 空行对齐（#7）。

测试 299 例全绿（覆盖率 98.41%；断言增密、用例合并致净数持平）。

### 评审轮 22（review-p2-llm-client-22.json，2026-09-25，8/8 采纳）

采纳 8 条。要点：

- **__proto__ 属性名原型污染收口（#5）**：properties 循环的普通对象字面量容器遇 "__proto__" 属性名（宿主/用户可控的工具参数名）会命中继承的原型 setter——子 schema 静默丢失且无上报、props 原型被改写；null 原型容器收口（P1.2 parseAttrs 同款坑）。测试侧用 defineProperty 构造自有 __proto__（计算键/字符串成员访问均被 biome useLiteralKeys 误报，同 P1.2 轮 3 教训）。
- **无参工具顶层 parameters 归一 object（#7）**：上游对无参工具给 `{}` 很自然，清洗兜底成 `{type:"string"}` 后语义错误（顶层 parameters 恒为命名参数集；严格端点 400、宽容端点把工具声明成「参数是一个字符串」诱导病态 args）——gemini 调用点对清洗结果顶层 type 收口 object 并留清洗证据；嵌套节点兜底 string 不变（语义未知）。
- **截断长度统一 500（#1-#4）**：三适配器「响应不是对象」的 `.slice(0, 200)` 收敛 stringifyForLog、http.ts「响应体不是合法 JSON」同文件 200 与 ERROR_DETAIL_MAX=500 分叉消除；既有 200 阈值锁定用例同步更新。
- **杂项（#6/#8）**：测试注释「16 位卡号」修正为 19 位（字面量事实）；敏感值空对象与 undefined 的不同代码路径（空 entries 循环 / reversed 空早退）补对称锚定。

测试 301 例全绿（覆盖率 98.42%）。

### 评审轮 23（review-p2-llm-client-23.json，2026-09-25，5/5 采纳；状态 partial——部分文件组未跑完，已出意见有效，下轮全量复审覆盖）

采纳 5 条。要点：

- **baseUrl /v1 误配可观测（#1）**：OpenAI 卡 baseUrl 惯例带 /v1，跨协议复用卡片会拼出 /v1/v1/messages → 404（错误文案不指向根因）——anthropic 拼接处对 /v1 结尾做一次性告警（makeOnceWarn 实例去重），与 maxTokens/temperature 误配口径一致；用例锚定误配 URL 如实拼接 + 单次告警。
- **dropped 按引用过滤（#2）**：getAction 纵深防御的按名过滤会让「同名目标工具被重复调用」完全静默（find 只取第一条，其余同名调用既被丢弃也不进 dropped）——改 `c !== call` 引用过滤，文案改「丢弃多余工具调用」涵盖重复语义。
- **smoke toolInput 过 redact（#3）**：模型产物是文件内唯一未脱敏的输出面（模型可能回显输入片段），与 URL/headers/请求体/错误链的脱敏纪律对齐。
- **测试侧（#4/#5）**：「未配置则零告警」声明改 setupProviderWithLogs 真断言（静音 setup 无回归防护，且 toHaveLength(1) 受 makeOnceWarn 去重保护测不出「无条件告警」回归）；带图 user 消息三处逐字重复收敛 withImageMessages 夹具。

测试 302 例全绿（覆盖率 98.42%）。

### 评审轮 24（review-p2-llm-client-24.json，2026-09-25，7/7 采纳）

采纳 7 条（硬化/收敛类，无行为争议）。要点：

- **smoke header 白名单脱敏（#1）**：黑名单 + 值含 apiKey 兜底拦不住 extraHeaders 注入的网关独立 token（值与 key 无关），配合 `2>&1 | tee` 留档会持久化凭据——改 SAFE_HEADERS 白名单（content-type/anthropic-version/anthropic-dangerous-direct-browser-access），名单外一律 `<REDACTED>`（宁多脱敏不漏脱敏）。
- **fixtures.LONG_URL 派生自阈值（#2）**：110 字符是对 URL_MIN_LENGTH=100 的跨文件魔法契约，阈值上调会静默失去覆盖——导入常量派生长度（+10 余量），文档契约变结构性约束。
- **外部 TimeoutError 穿透锁定（#3）**：postJson 分型唯一依据是自身 timeoutSignal?.aborted 而非错误 name——补姊妹用例（外部 signal 为 AbortSignal.timeout、不传 timeoutMs → reason 与自身超时同形但必须原样穿透），防「按 name 重构」吞掉宿主 deadline 取消为 LLMTimeoutError（infra 可重试 + 误触 fallback 单向切换）。
- **gemini baseUrl /v1beta 守卫（#4）**：官方文档 URL 本身以 /v1beta 结尾，整段复制拼出 /v1beta/v1beta → 404——与 anthropic /v1（轮 23 #1）同族的一次性告警补齐。
- **pattern 可编译性校验（#5）**：编译失败的正则（"[" 等）上送同为 400——清洗侧 try { new RegExp } 截断并上报（编译通过只是必要条件：JS 正则是端点 RE2 超集，lookbehind 等 JS 合法形态仍可能被拒收）。
- **测试侧（#6/#7）**：expect 第二实参位的注释上移消除「消息参数写丢」歧义；setupCore 增 fetchOverride 维度，竞态/外部取消两处旁路用例不再内联重建 deps 字面量（防三态展开漂移）。

测试 305 例全绿（覆盖率 98.43%）。

### 评审轮 25（review-p2-llm-client-25.json，2026-09-25，7/7 采纳）

采纳 7 条。要点：

- **sensitiveMap 病态检测补全（#3/#6）**：新增第三类「交叉冲突」（某条目的 placeholder 恰为另一条目的 real——顺序 replaceAll 形成替换链，双向静默数据损坏）；reals 滤空串键（与工具载荷/systemPrompt 检测同口径）——空 real 条目从不参与替换，其占位符计入冲突集会误报并误消费一次性去重标志、让后续真病态永久静默。
- **空 image 块拦截（#4）**：空 base64/mimeType 的 ImageBlock 同为端点 400 形态——hasEmptyText 扩为 hasEmptyBlock，畸形截图数据在 canonical 层拦截（错误归因到调用方而非端点，不烧退避/fallback），与空 text 拦截（轮 13 #6）同动机。
- **顶层 parameters 归一剥离域外键（#7）**：强制 object 时同步 delete items/enum/format——原 type 合法的键残留是自相矛盾 schema（400 形态，与 FORMATS_BY_TYPE 分域同口径）。
- **408 分型注释修正（#2）**：旧注释声称超时分型可规避 fallback 切换——实际 trySwitchToFallback 对全部 LLMError（协议违例除外）触发，408 与 4xx 在切换轴无差异，真实差异只有可重试性；按事实改写。
- **测试/注释侧（#1/#5）**：/v1beta 告警的阴性对照补 chat 调用（不 chat 时 logs 恒空、断言恒绿，防不住「告警条件被误删」回归——轮 24 自写缺陷）；rewriteStrings 复用边界补 symbol 键/不可枚举属性静默丢失声明。

测试 308 例全绿（覆盖率 98.44%）。

### 评审轮 26（review-p2-llm-client-26.json，2026-09-25，5/5 采纳——其中 #4 建议代码有回归，实测修正后落地）

采纳 5 条。要点：

- **sensitiveMap 第 4/5 类病态检测（#1/#4）**：新增「URL tag 撞型」（占位符形如 [uN]——okResult 同序还原先 URL 后敏感，占位符被长 URL 顶替、真实值永不还原）；交叉冲突从精确相等放宽到双向子串包含（`****1111` 含 real `1111` 的替换链 / real 含占位符的占位先行破坏）。**#4 建议谓词 `real !== ph` 用值比较做归属排除，会把轮 25 #3 的跨条目精确撞值一并排除（轮 25 用例当场红）**——改为按条目键归属排除（other !== real），自包含（ph 含自身 real）才是无害形态（单趟 replaceAll 不重扫插入内容）。
- **openai baseUrl 误配守卫（#2）**：官方 curl 示例端点以 /chat/completions 结尾，整段复制拼出双重路径 → 404——补齐与 anthropic /v1（轮 23 #1）、gemini /v1beta（轮 24 #4）同族的一次性告警；阴性对照真请求采集（轮 25 #1 标准）。
- **temperature NaN/Infinity 必留证据（#3）**：非有限数值原先静默不发，与 onClamp 钳制/resolveMaxTokens 回退的观测口径不一致——NaN 场景同样经一次性告警。
- **顶层归一约束键闭环（#5）**：pattern/minLength/maxLength（STRING 域）、minItems/maxItems（ARRAY 域）、minimum/maximum（NUMBER/INTEGER 域）与 items/enum/format 一并在归一 object 时删除——残留按 FORMATS_BY_TYPE 分域同口径是 400 形态或语义失效。

测试 311 例全绿（覆盖率 98.47%）。

### 评审轮 27（review-p2-llm-client-27.json，2026-09-25，11/11 采纳）

采纳 11 条。要点：

- **http 层取消分型状态判别（#8/#9，直连 provider 路径真缺口）**：classifyFailure 与错误体读取 catch 原先只认 AbortError/TimeoutError 的 name——宿主以自定义 reason 中止（`controller.abort("user-stop")`，#186 我们明确支持透传）时被分型为 LLMConnectionError（infra 可重试 + 误触 fallback 切换）；经 LLMClient 有 callWithBackoff 预检兜底，但 provider.chat 是公共导出、直连宿主无防护——补 `init.signal?.aborted` 状态判别（与 throwIfTimedOut 同款状态优先）。
- **序列化提前到 try 外（#2）**：宿主病态 body（循环引用/BigInt）的同步 TypeError 原先落入 classifyFailure 分型为可重试网络故障，空转 5 轮退避 + 烧一次 fallback 切换——现原样穿透（client 对非 LLMError 的编程错误穿透路径既有）。
- **哨兵异常改 TypeError（#7 + #6 既有用例更新）**：并发误用原先抛 LLMInvalidRequestError（P4 分罪轴上是端点侧 4xx 语义）——本地编程错误改 TypeError，天然不进分罪/退避/fallback 轴；轮 12 #6 既有用例同步更新断言。
- **anthropic media_type 别名归一（#1）**：官方封闭枚举（jpeg/png/gif/webp），image/jpg 常见别名裸透传即 400——适配器侧归一收口。
- **结构与测试收敛（#3/#4/#5/#10/#11）**：/v1 告警补阴性对照（三协议误配守卫至此全部有回归防护）；16384 硬编码改引用 DEFAULT_MAX_TOKENS（值锁定收敛到 config.test 一处）；sensitiveMap 四类病态检测提取私有方法 warnSensitiveMapPathologies（getActionInner 已超 300 行）；resolveMaxTokens 补合法值零回调阴性对照；openai 两前缀清单的分叉成员（gpt-4.1/gpt-oss：新上限字段 + 温度照发）锁定温度维度，防清单被「统一」后静默丢温控。

测试 315 例全绿（覆盖率 98.37%）。

### 评审轮 28（review-p2-llm-client-28.json，2026-09-25，5/5 采纳）

采纳 5 条。要点：

- **image mime 别名归一单源化（#3/#5）**：轮 27 #1 只在 anthropic 收口，gemini inlineData 与 openai data-URL 两处漏网——提取 common.normalizeImageMime 三适配器共用（anthropic 字面量同步替换），防 mime 口径三处漂移；gemini/openai 各补 image/jpg wire 锚定。
- **gemini text-part 去除 continue（#4）**：官方 proto Part 内容域 oneof 互斥、端点不可达，但转换型网关可能产出 {text, functionCall} 并存 part——旧 continue 是该函数唯一无证据的丢弃路径；去除后并存 functionCall 自然由下方分支处理（纯 text part 不受影响），补并存形态用例。
- **smoke 可观测（#1/#2）**：文件头 SMOKE_* 变量清单补 SMOKE_TIMEOUT_MS（「对照」注释承诺与事实不符）；SMOKE_TIMEOUT_MS 空串归一为 unset（`VAR= node` 形态不再误报「非法值」，与 baseUrl/model 的 `||` 口径一致）。

测试 318 例全绿（覆盖率 98.38%）。

### 评审轮 29（review-p2-llm-client-29.json，2026-09-25，10/10 采纳）

采纳 10 条。要点：

- **三协议畸形内容留证据对齐（#1/#2/#8）**：anthropic type:text 但 text 非 string、gemini text 存在但非 string（undefined 是 functionCall part 正常形态不告警）、openai message.content 存在但非 string/null/undefined（null=纯工具回合 benign）——三处原先都是内联条件静默丢弃，文本丢失只见空响应无线索；三协议「丢弃留证据」口径至此闭环。
- **去重粒度修正（#4/#6，跨调用掩蔽真缺口）**：四类病态检测拆分独立去重标志（sensitiveMap 是 per-call 选项，单一总标志让首调整数键掩蔽次调占位符冲突）；systemPrompt 泄露改 WeakSet 按 map 身份去重（同一 map 跨步一次防刷屏，新 map 各自一次）——轮 18 旧用例同步改同 map 引用。
- **temperatureSuppressed 逃生门（#3）**：TEMPERATURE_UNSUPPORTED_PREFIX 前缀会误命中 o1-finetune 等自定义模型（注释已自知），误命中时温度静默抑制且无配置手段恢复——ProviderConfig 增显式覆盖字段（与 maxTokensField 同款逃生门）。
- **URL 尾界补 CJK 表意字符（#7，偏离 10 目标内的真缺口）**：旧排除集只覆盖全角标点——URL 直接紧邻表意字符（无标点无空白，如 `打开${url}然后点击`）时匹配仍吞掉后续中文直到句末，正是偏离 10 要修的失败形态；补 \p{Script=Han}/假名/谚文（u flag），03 §4 偏离 10 同步修订（代价：裸 CJK 路径 IRI 截断，取舍同前）。
- **常量单源（#5/#9/#10）**：SCHEMA_ISSUE_DEDUP_MAX 导出 + 测试派生（128/130 双硬编码消除）；ERROR_DETAIL_MAX 导入派生（common.test/http.test 共 4 处 500 硬编码消除）。

测试 324 例全绿（覆盖率 98.49%）。

### 评审轮 30（review-p2-llm-client-30.json，2026-09-25，10 条采纳 9 驳回 1——循环额度告罄轮）

采纳 9 条。要点：

- **transforms `__proto__` 原型污染收口（#9，真坑）**：rewriteStrings 重建对象 `out[k] = ...` 对 `__proto__` 键命中原型 setter——模型输出 JSON 完全可控该键名（JSON.parse 保留自有可枚举键），子树静默丢失 + 原型被改写；与 schema-sanitize 轮 22 #5 同款 defineProperty 收口，往返用例锁定。
- **三协议无证据丢弃路径清零（#3/#4/#5/#10）**：anthropic 非对象 content 项/未知 type/畸形 thinking 域、gemini 非对象 part、openai reasoning 字段非 string——「丢弃留证据」口径在三适配器响应解析内全部闭环。
- **schema 归一撞键留证据（#1）**："MaxLength" 与 "maxlength" 并存时归一后同键后写者覆盖先写者——上报冲突，约束静默丢失有线索。
- **嵌套三元提取（#6）**：轮 29 自写的 temperatureSuppressed 嵌套三元违反清单规范（轮 20 #4 同款），提取具名布尔恢复单层。
- **smoke userInfo 掩码（#7）**：`https://user:pass@host` 形态代理凭据与 GLM_API_KEY 无关，replaceAll 拦不住——补 MASK_USERINFO_RE（路径内嵌 token 残留风险已注明）。
- **extraHeaders 接线锚定（#8）**：gemini/openai 两处「最后合并可覆盖」实现是三处独立拷贝，补最小接线断言（对齐 anthropic 侧）。
- **#2 驳回**：白名单外 mime 丢弃——拿「响亮的 400（可归因不可重试）」换「静默丢图（模型失明无响应级证据）」，对截图驱动的 agent 是更差的缺省；轮 27 #1 注释已显式登记为待议决策，评审自身标注 low。

测试 330 例全绿（覆盖率 98.70%）。

### 评审轮 31（review-p2-llm-client-31.json，2026-09-25，14/14 采纳；第二轮循环额度轮 31-40 起）

采纳 14 条。要点：

- **sensitiveMap 检测三处补强（#9/#10/#14）**：URL tag 撞型去锚定（还原侧 replaceAll 匹配任意位置，"xx[u0]yy" 嵌入形态原检测静默漏报）；新增第 5 类「占位符互相包含」（"AB"/"ABc" 嵌套占位符还原侧先短者胜、外层撕裂失配——括号定界形态天然免疫误报）；去重粒度对齐 systemPrompt 泄露——改 WeakMap 按 (map, 类别) 去重（实例级类别布尔会让第二个 map 的同类别病态被首个 map 掩蔽）。
- **schema 归一撞键闭环到全分支（#3）**：轮 30 #1 只收口了标量分支——properties/items/type/nullable 写入点统一走 emit 出口（"properties" 与 "Properties" 并存原先整棵子树静默丢失）。
- **观测缺口（#5/#11）**：gemini 去重集达 128 上限时留一次性达限提示（「事件已停止上报」本身是运维线索，文案避开既有计数过滤词）；无已知内容域的对象 part（inlineData 等官方类型/图像输出模型/网关私货）按键名留证据（不 stringify 防 base64 刷屏）。
- **openai tool_call type 校验（#4）**：显式非 function 类型（custom/mcp 等新式形态）function 域恰为对象也会混入执行链——丢弃留证据；缺失 type 容忍（兼容端点省略）。
- **测试结构（#1/#2/#6/#7/#8/#12/#13）**：mock-fetch abortReason 三处单源 + null-body 状态降 null（204/205/304 显式 body 会在构造处抛 TypeError 被分型成网络层假象）；fixtures assemble 收敛装配主体；gemini/openai setupLogs 补 over 参数（三文件签名统一）；夹具 minimum 挪到数值域属性（object 节点挂 minimum 与顶层归一剥离口径自相矛盾）；温度巨型用例按行为维度拆为四条。

测试 337 例全绿（覆盖率 98.72%）。

### 评审轮 32（review-p2-llm-client-32.json，2026-09-25，12/12 采纳）

采纳 12 条。要点：

- **schema 两道硬化（#7/#12）**：递归深度上限 SCHEMA_MAX_DEPTH=64（宿主程序化构造的病态深层嵌套原先以 RangeError 栈溢出直穿——非 LLMError 无归因线索，同 http.ts 轮 27 #2 的宿主数据硬化维度），截断留证据；**嵌套节点约束键 type 分域收尾剥离**（{type:"string", items} 等矛盾组合原先透传，与顶层归一口径不一致）——CONSTRAINT_KEYS_BY_TYPE 按最终 type 删除域外键并上报，四个写在分域口径确立前的旧用例同步改造为域自洽形态。
- **顶层承载字段留证三连（#8/#9/#10/#11）**：anthropic content / openai choices+message / gemini candidates+promptFeedback「存在但非数组/非 record」原先静默归空——网关 200 畸形载荷下 client 只见空响应无线索；缺失形态不告警保零误报。
- **transforms 单源化（#1/#5）**：cloneBlocks 提取（TextBlock 拷贝契约两处逐字重复）+ args 嵌套共享前提注释；replaceSensitiveText 委托 rewriteStrings 字符串分支 + filteredSensitiveEntries 共用（「顺序替换」此前文本侧/深层侧两份平行实现，注释宣称的单一实现名不符实）。
- **边界与收窄（#2/#3/#4/#6）**：用户文本自带 [uN] 字面量与分配 tag 撞名的还原行为锚定（Python 同款固有边界）；REDACTED_PLACEHOLDER 收窄模块内（导出面宽于复用面）；病态检测 O(n²) 重跑的成本取舍显式裁决注释（有意支持 map 原地变异可观测）；toolCall 零结果两形态（悬空结尾/后跟 user）锚定。

测试 344 例全绿（覆盖率 98.76%）。

### 评审轮 33（review-p2-llm-client-33.json，2026-09-25，6/6 采纳；评审工具一次 code_search 子步骤失败——模型生成的 PCRE 正则喂给 POSIX git grep，单次检索丢失不影响整体 complete）

采纳 6 条。要点：

- **sensitiveMap 第 6/7 类病态（#3/#4，#3 是泄露方向——比既有各类更重）**：⑥ real 互相包含且短者在插入序之前——请求侧顺序替换先撕裂长 real（"sk-abc" 先吃掉 "sk-abcdef" → "[K1]def"），长条目失配后敏感值明文残留出站（方向判定 jdx < idx 精确到有害形态，短者在后无害有反例锚定）；⑦ 自条目占位符为真实值真子串（{"path/to/secret": "secret"}）——请求侧正常但还原侧把输出中天然出现的子串全部还原（toolInput 过度替换损坏）。
- **嵌套承载域留证补全（#1/#2/#6）**：gemini candidate/content/parts 三级、openai choice 元素与 message.tool_calls 域「存在但形态异常」留证据——「丢弃必留证据」口径在响应解析的顶层与嵌套全部闭环。
- **注释与文案纠偏（#5）**：「四类检测」计数式注释随清单增长失同步（现七类）改去计数；intKey 告警文案「≤10 位」与实际阈值 2^32-1 有偏差（"9999999999" 是普通插入序键）改精确表述。

测试 344 例全绿（覆盖率 98.78%，断言扩在既有用例内）。

### 评审轮 34（review-p2-llm-client-34.json，2026-09-25，10/10 采纳）

采纳 10 条。要点：

- **baseUrl 误配守卫族补全三形态（#6/#9/#10）**：gemini 补 /v1 结尾（OpenAI 形态跨协议复用）与 ：generateContent 结尾（官方完整端点整段复制）、anthropic 补 /v1/messages 结尾（官方 curl 全端点）——三协议误配守卫矩阵至此完整（openai /v1 + /chat/completions、anthropic /v1 + /v1/messages、gemini /v1beta + /v1 + :generateContent），各自独立去重实例。
- **normalizeImageMime 别名表化 + 小写归一（#4）**：image/x-png 历史别名与大小写变体（IMAGE/JPG 等宿主数据常见）原先裸透传即 400——MIME 大小写不敏感（RFC 2046），统一小写后查别名表。
- **items 空元组分档（#5）**：items:[] 语义是「数组须为空」，无首元素可窄化——与普通元组窄化共文案会让证据与实际行为不符。
- **测试与死代码清理（#1/#2/#3/#7/#8）**：FakeClock.sleep 不可达 else 分支重构（signal 存在才注册回调，与 abortReason 单源真正同款）；asUser/asAssistant 收窄辅助收敛 client/transforms 两文件 7 处 unreachable 守卫样板（失败信息携带实际 role）；stubDeps 死导出收窄模块内。

测试 348 例全绿（覆盖率 98.79%）。

### 评审轮 35（review-p2-llm-client-35.json，2026-09-25，14/14 采纳）

采纳 14 条。要点：

- **sensitiveMap 第 8 类病态（#14，泄露方向）**：⑧ 占位符**包含**自身真实值（{"sk-abc123": "[key:sk-abc123]"}）——占位后明文仍完整出站，脱敏对该条目完全失效；此前注释以「单趟 replaceAll 不重扫插入内容」论证自包含无害，该论证只覆盖替换链完整性不覆盖脱敏失效。八类检测矩阵至此对称（real×real / ph×real / ph×ph 全维度）。
- **empty 契约扩展（#11，01/03 文档同步）**：GetActionResult empty 分支携带 reason（text-exhausted / no-parseable-response）与 lastUsage——P4 step 分罪不再解析日志文本；Python None → empty 语义不变。
- **forced toolChoice 前置拦截（#13）**：forced 名不在本次 tools 中是三协议端点 400 形态——assertForcedToolChoiceInTools 收敛 common 三适配器共用，与 canonical 消息拦截同口径。
- **观测脱敏与对称（#9/#10）**：fallback 切换日志只记 name+status（err.message 来自端点响应体，可能回显敏感明文——与「观测通道不泄露明文」口径一致）；换 fallback 卡后滤图告警重获一次上报（文案按卡片名输出，去重不跨卡共享）。
- **域外键剥离单源（#7）**：stripKeysOutsideTypeDomain 导出，sanitize 收尾与 gemini 顶层归一共用——防两处域表清单「改一漏二」。
- **smoke（#1/#8）**：响应侧 resp.clone() 摘要（验收可直接裁决「真工具调用 vs text-JSON 兜底」）；注入 log 通道过 redact（baseUrl 误配告警内嵌 baseUrl 原文，SMOKE_*_BASE_URL 的 ?token= 形态会明文进 tee 留档）。
- **测试侧（#2/#3/#4/#5/#6/#12）**：新守卫补阴性对照；误配用例回归 setupLogs(over) 封装；openai toolResult 乱序直发行为锚定（与 anthropic/gemini 重排口径刻意不同）；TEST_CONNECTION 常量导出锚定。

测试 352 例全绿（覆盖率 98.80%）。

### 评审轮 36（review-p2-llm-client-36.json，2026-09-26，11/12 采纳（#10 驳回：TS2352 断言与实测 typecheck EXIT=0 不符））

采纳 11 条。要点：

- **ok 分支携带 toolCall（#6，gemini thinking 模型真契约缺口）**：ok 此前只返回 toolInput，丢弃命中调用的 id/signature——宿主经 getAction 拿不到 thoughtSignature（provider 为 private，无法伪造），回放 assistant 历史缺失 signature 即 400。toolCall 可选携带（真实调用路径；text-JSON 兜底不携带——伪造固定 id 会撞「拒绝重复 toolCall id」不变量），args 为还原后值；补 getAction→历史回放→二次请求的 signature 往返用例；03 文档同步。
- **mime 枚举收口（#2，第三次评审的终裁形态）**：别名归一后仍越界（svg/bmp/gif-in-gemini 等）从「裸透传 400」改为**降级占位 + 留证据**（与滤图 IMAGE_OMITTED_PLACEHOLDER 口径一致，请求可继续）——anthropic/gemini 各自维护封闭枚举（集合不同不共享），openai（data-URL 无封闭枚举）维持归一。
- **错误分型收口（#7/#11）**：fallback 卡片构造失败改 LLMError 基类、直接构造的非法 protocol 改 TypeError——本地配置/编程错误不再占用「端点 4xx」语义（P4 分罪轴），与轮 27 #7 并发守卫纪律对齐。
- **反向竞态 reason 还原（#12，#186 契约缝隙）**：deadline 先到点时 ladder reason 固化为缺省 AbortError，外部取消随后到达时 abort(external.reason) 不再生效——在外部取消优先路径上还原宿主 reason，补反向竞态用例。
- **其余**：LlmProtocol/LlmDeps 统一为 LLM 前缀（#1，未发布窗口）；408 解析 Retry-After 与 429 对称（#9）；错误体读取失败并入 detail（#4）；工具 name 空串前置拦截（#8，与轮 18 #13 对称）；defaultTestConnection JSDoc 归位（#3）；U1 按阈值派生（#5）。

测试 359 例全绿（覆盖率 98.79%）。

### 评审轮 37（review-p2-llm-client-37.json，2026-09-26，14/14 全采纳）

采纳 14 条。要点：

- **折叠骨架单源化（#10）**：anthropic toWireMessages 与 gemini toWireContents 的 toolResult 段收集/重排（Map 收集 + 按前置 toolCalls 顺序 + 配对过滤）逐字同构约 30 行——提取 common.collectToolResults（返回 pairs 携带配对 call，gemini 侧 functionResponse 需回挂 signature），后续单点修补不再改一漏一（本轮 #8/#9 兜底日志即双处同步实例）。
- **timeoutMs 非法值守卫（#7，temperature/maxTokens 同族雷）**：NaN/0/负值经宿主 parseFloat 可达，AbortSignal.timeout 立即到点 → 直连 provider.chat 的调用方每请求 LLMTimeoutError（infra 可重试 + 误触 fallback 切换 + 空转 5 轮退避）——非法值视为未设置 + onInvalidTimeout 一次性告警（三适配器接线）。
- **openai mime 枚举补齐（#12，轮 36 #2 同族收口）**：OPENAI_IMAGE_MIME（png/jpeg/webp/gif）越界降级占位 + 留日志（log 线程化进 userContent/toWireMessages），三协议口径一致（此前 openai 越界 mime 裸出站烧 400）。
- **stringifyForLog 串化兜底（#6）**：BigInt/循环引用（宿主程序化构造的 parameters 可达）原先在 schema 清洗的删除上报路径抛裸 TypeError——try/catch 兜底 String(value)，留证据路径自身不崩溃。
- **工具重名前置拦截（#14）**：三协议端点均校验 tools 名字唯一，assertToolContract 补 Set 大小比较（P4 registry 合并场景的现实病态）。
- **兜底跳过留证据（#8/#9）**：「toolResult 不在 assistant 之后」双协议兜底分支补日志（assertValidMessages 已拦、真实触发时漂移可观测，与全文件「丢弃必留证据」口径一致）。
- **schema 负值约束（#13）**：minLength/maxLength/minItems/maxItems 官方语义非负 int64，负值（maxLength: -1）与小数同为 400——补符号位校验（minimum/maximum 负值语义合法不收口）。
- **smoke 脚本（#1/#2/#3/#5）**：ok 分支用 result.toolCall 结构化判定 text-JSON 兜底（闭合轮 35 #1「合规兜底漏判为通过」缺口，不再依赖人工复核请求日志）；empty 打印 reason/lastUsage 区分两类故障方向；响应截断省略号口径统一（redact 后长度）；esbuild 兜底解析失败错误指向根因。
- **测试算式修正（#4/#11）**：FakeClock t0=1000，setCallWindow(40s/20s) 的 deadline 是 41000/21000——两处「窗口大小当 deadline」的笔误修正。

测试 371 例全绿（覆盖率 98.73%）。
