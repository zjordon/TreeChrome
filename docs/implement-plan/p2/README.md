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
