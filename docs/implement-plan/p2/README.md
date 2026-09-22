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

（实施时追加：各工作项完成日期、分支/提交、验收证据、smoke 产物摘要。）
