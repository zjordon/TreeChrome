# 04 · 测试策略

> 纪律先行（AGENTS.md）：**测试不发真网络请求**——fetch/sleep/now 全注入；唯一真网入口是 2.5 的 smoke 脚本（手动跑，不入 CI）。覆盖率 ≥85% 由提交门强制。移植代码期望值锚定 Python 实跑（AGENTS.md 铁律）——本层锚定对象是 `client.py` 的纯函数与常量行为，方法见 §4。

## 1. 测试文件布局

```
test/llm/
  mock-fetch.ts        # §2 注入夹具
  fixtures/*.json      # §3 wire fixtures
  types.test.ts        # canonical 不变量 + assertValidMessages
  config.test.ts       # modelSupportsVision 白名单（Python 锚定）+ resolveCapabilities
  errors.test.ts       # isInfraError 谓词矩阵
  anthropic.test.ts    # 适配器（§5 矩阵 A 列）
  openai.test.ts       # 适配器（矩阵 O 列）
  gemini.test.ts       # 适配器（矩阵 G 列）+ schema-sanitize
  client.test.ts       # 行为层（§6）
  transforms.test.ts   # Python 锚定（§4）
```

## 2. 注入夹具（`mock-fetch.ts`）

```ts
/** 按"第 N 次匹配 (method,url)"或谓词返回预设 Response；记录全部调用 */
class MockFetch {
  calls: { url: string; init: RequestInit }[];
  queue(responses: MockResponseSpec[]);      // 顺序消费；耗尽即失败
  expect(urlPattern: RegExp, respond: MockResponseSpec); // 模式匹配
  lastBody(): unknown;                        // JSON.parse(最近一次 init.body)
}
type MockResponseSpec =
  | { status: number; headers?: Record<string, string>; body?: unknown }
  | { networkError: Error }                   // fetch 抛 TypeError 路径
  | { abortAfterMs: number };                 // 配合假时钟测超时
}

/** 假时钟：now() 手动推进；sleep 登记为可推进的定时器 */
class FakeClock {
  now(): number;
  async advance(ms: number): Promise<void>;   // 触发到期的 sleep resolve / abort
}
```

要点：

- Response 用真实 `Response` 构造（status/headers/body 走真解析路径，别 mock Response 类本身）；
- `abortAfterMs` 与 FakeClock 联动验证：deadline 在飞请求 → `LLMTimeoutError`（03 偏离 5 的行为锁）；
- `AbortSignal.any` 兼容性若手写合并，这里顺带覆盖合并逻辑（合并错 = 取消失效，最隐蔽）。

## 3. wire fixtures

`test/llm/fixtures/` 按协议分文件（`anthropic-cases.json` / `openai-cases.json` / `gemini-cases.json`），每 case 三元组：

```jsonc
{
  "name": "text_plus_tool_use",
  "request": { /* canonical ChatRequest */ },
  "expectedWire": { /* 期望发出的 HTTP body（对象级 deep-equal，非字符串对拍） */ },
  "wireResponse": { /* 喂给 MockFetch 的响应体 */ },
  "expectedCanonical": { /* 期望 ChatResponse */ }
}
```

样本来源（手搓，权威顺序）：官方 API 文档示例 → 智谱端点 smoke 实测样本回填修订。每协议最少覆盖 8 个 case：纯文本 / 文本+工具调用 / 纯工具调用（content 空）/ 带图 user / 多 toolResult（anthropic/gemini 验证合并）/ usage 全字段 / 错误体各一（429 带 Retry-After、401）/ 停止原因边界（length 截断）。

**对象级断言而非字节级**：wire 层是 JSON.stringify 的确定性序列化，deep-equal 等价且 diff 可读；`expectedWire` 缺省字段（temperature 不发等）用"键不存在"断言——这正是地雷回归点（`expect(body).not.toHaveProperty("temperature")`）。

## 4. Python 锚定（transforms + 常量行为）

锚定工具：evals venv（AGENTS.md 验收命令同款），TreeWalker 以 editable 安装：

```bash
D:/dev/git/z_jordon/evals/webarena/.venv/Scripts/python.exe -c \
  "from tree_walker.llm.client import _try_parse_json; print(repr(_try_parse_json(<输入>)))"
```

| 锚定对象 | 方法 | 烤入位置 |
|---|---|---|
| `tryParseJson` | 固定输入集实跑：裸 JSON / ```` ```json 围栏 / 围栏含嵌套花括号 / 前后杂文本的首尾大括号 / 垃圾文本 / 空串——输出（含 None）逐条记录 | `transforms.test.ts`（输入-期望对照表） |
| URL 缩写 | `LLMClient(api_key="x")` 实例跑 `_shorten_urls_in_messages`：短 URL 不动 / 长 URL→`[u0]` / 同 URL 复用 tag / 多长 URL 顺序分配 `[u0][u1][u2]` / 消息间共享 tag——记录 url_map 与改写后文本 | 同上（tag 分配顺序是契约） |
| 敏感值替换 | `_filter_sensitive_in_messages` + `_restore_sensitive_in_output`：单键往返 / 键值有包含关系的双键（顺序敏感） | 同上 |
| 退避 delay | `_infra_backoff_delay(attempt, err)`：attempt 0..5 的指数序列（2,4,8,16,30,30）+ retry-after 覆盖（<60 生效，>60 封顶 60，0/负值回落指数，非标量容错） | `client.test.ts` 退避组 |
| R4/R1 文案 | client.py:503-506 / :529-532 原文照抄（泛化点：`agent_response` → `tool.name`，见 03 §3.6） | `client.test.ts` 梯子组（断言追加消息的 text 逐字符） |
| 视觉白名单 | `model_supports_vision` 边界集：`claude-3-5-sonnet` / `glm-4v` / `glm-4.5v` / `glm-5.3-flash` 真 / `glm-5.1` / `glm-4` / 空 / 大写形态 | `config.test.ts` |
| 常量 | 03 §3.1 表逐值（值本身即锚定，无需实跑） | `client.test.ts` |

生成期望值的命令与实跑输出存 `transforms.test.ts` 头部注释（同 dom-snapshot `models.test.ts` 惯例），保证可复算。

## 5. 适配器覆盖矩阵（§3 fixtures 之外的分支专项）

| 用例 | anthropic | openai | gemini |
|---|---|---|---|
| 请求：system 独立字段/首条消息 | ✓ | ✓ | ✓（systemInstruction） |
| 请求：forced tool_choice 三映射 | ✓ | ✓ | ✓（mode=ANY+allowed） |
| 请求：图片块映射 | base64 source | data-URL image_url | inlineData |
| 请求：多 toolResult | **合并一条 user**（400 地雷） | 独立 tool 消息 ×N | **合并一条 user turn** |
| 请求：isError | is_error:true | `[error] ` 前缀 | `[error] ` 前缀 |
| 请求：temperature 缺省不发 | ✓ | ✓（新契约 400 地雷） | ✓ |
| 请求：maxTokens 字段 | 顶层 max_tokens | max_tokens / max_completion_tokens（前缀正则+配置覆盖） | generationConfig.maxOutputTokens |
| 响应：thinking/reasoning 块跳过并捕获 | thinking | reasoning_content | thought:true |
| 响应：args 解析 | 原生对象 | **guard-parse 失败丢弃**（截断样本） | 原生对象；合成 id |
| 响应：usage 全字段/缺字段 | ✓ | ✓（cached_tokens 可选） | ✓ |
| 响应：stopReason 归一表 | ✓ | ✓ | ✓（functionCall 优先推导） |
| 错误：状态→类型矩阵（429/401/403/400/500）+ error.message 提取 + Retry-After | ✓ | ✓ | ✓（含 blockReason→LLMBlockedError） |
| gemini schema sanitize | — | — | 白名单递归清洗专项（$schema/additionalProperties 删除、enum/items 保留） |

## 6. 行为层覆盖（`client.test.ts`）

按 03 §2 状态机逐边覆盖：

**解析优先级**：工具调用命中（含"忽略其它名字的调用"）→ 文本 JSON 命中 → 文本不可解析入 R4 → 空响应入 R1。

**梯子**：
- R4：第 1 次文本 → 追加指令 → 第 2 次工具调用成功（断言追加消息文案逐字符 + 原文本回灌）；连续 3 次文本 → `empty`；
- R1：空 → 追加指令一次 → 成功 / 仍空 → `empty`；
- R1 与 R4 独立计数（R4 耗尽后 R1 不再触发）。

**退避**：
- 429 ×5 → 第 6 次成功；429 恒败 → 抛 `LLMRateLimitError`（类型不变）；
- Retry-After 头覆盖指数（0/负/超大/非标量回落——Python 容错口径锚定）；
- 墙钟预算：FakeClock 推进到 `now()+delay > deadline` → 立即抛最后错误；
- 非infra（401）不退避直接走 fallback 判定。

**fallback**：
- 429 触发切换：不占退避名额（切换后仍有完整 6 次请求额度）；请求体 model/maxTokens 刷新（断言第 2 次请求的 wire body）；
- 401 触发切换（APIError 路径）；已切换后二次 429 不再切（单向锁）；
- 无 fallback 配置时 429 → 纯退避；
- **跨协议切换**（主 anthropic + fallback openai）——full card 组合的独有测试点；
- 滤图：fallback 无视觉 + work 含图 → 后续请求 wire body 无图块；主模型不受影响。

**窗口**：`setCallWindow` 登记后，两次 getAction 共享 deadline（第一次耗掉大半，第二次预算取小）；`opts.timeoutMs` 与窗口同时存在取小。

**取消**：外部 signal abort → 立即抛、不重试、sleep 中止（在飞 fetch abort 路径用 `abortAfterMs` 联动）。

**往返**：URL 缩写→toolInput 还原（嵌套对象/数组）；敏感值往返；两者叠加；`kind:"empty"` 路径不还原（无产物）。

**承重墙**（02 §6）：`supportsForcedTool:false` → 请求无 tool_choice + systemPrompt 含约束段；纯文本响应经 tryParseJson 命中；`supportsTools:false` → 请求无 tools + schema 进约束段。

## 7. smoke（`tools/llm-smoke.mjs`，工作项 2.5）

- 宿主侧脚本（`tools/` 不受核心包边界约束，可读 `process.env`）：`GLM_API_KEY` 必填；
- 目标：智谱 OpenAI 端点（`https://open.bigmodel.cn/api/paas/v4`，model 如 `glm-4.7`——以账号可用模型为准）+ 智谱 Anthropic 端点（`https://open.bigmodel.cn/api/anthropic`，`glm-5.1`）各发一次**最小 `agent_response` 强制调用**（两三步消息 + 假 schema），打印：请求体摘要（key 脱敏）/ 响应 toolInput / usage / 耗时；
- 产物贴回 `README.md` §7（端点行为与官方文档的偏差 → 修订 fixtures 时提交信息注明）；
- gemini 不在本次 smoke（无 key；2.4 验收以 mock 为准，README 风险 3 已标注顺延）。

## 8. 验收命令

```bash
pnpm install && pnpm typecheck && pnpm test          # 日常全绿
node scripts/gate.mjs pre-commit                      # 提交门（含覆盖率 ≥85%）
node packages/core/tools/llm-smoke.mjs                # 2.5 手动真机（需 GLM_API_KEY）
```
