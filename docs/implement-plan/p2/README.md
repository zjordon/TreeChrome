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
| 3 | gemini schema 子集（`$schema`/`additionalProperties` 等键不被接受） | 适配器白名单清洗（02 §5.3）；smoke 只测智谱两端点，gemini 真机验证顺延到有 key 时（2.4 验收以 mock 为准，标注待实测） |
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
