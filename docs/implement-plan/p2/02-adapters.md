# 02 · 三协议适配器 wire 规格

> 对应工作项 2.2（anthropic）/ 2.3（openai）/ 2.4（gemini）。**官方文档会漂移，本仓 wire fixtures + smoke 实测才是权威**；本文冻结的是映射规则与断言口径。
>
> 三协议共同点先说清：全部 `POST` + JSON 请求体 + JSON 响应（P2 无流式）；全部支持图片 base64 与函数调用；全部"强制指定工具"有原生机制（但兼容端点支持参差，见 §6 承重墙）。

## 1. 共享 http 层（`adapters/http.ts`）

所有适配器共用一个 `postJson()`，职责收敛：

1. **URL/headers/body 组装**由各适配器完成，http 层只做发送；
2. **超时与取消**：`AbortSignal.any([req.signal, req.timeoutMs && AbortSignal.timeout(timeoutMs)])`（挂起兼容性：Node 20.3+/Chrome 116+ 有 `any`；无则手写监听合并——实现时验证目标环境，脚手架项 2.0 一并定）；
3. **状态→错误类**：按 01 §5 矩阵构造（429/401/403/4xx/5xx）；body 尽量解析出各协议的 `error.message`（形状见各节），解析失败用原文前 500 字符（webbrain 同款截断）；
4. **Retry-After**：仅秒数标量（`Number(raw)` 可解析且 >0），封顶 60s（Python `_RETRY_AFTER_CAP`）；HTTP-date 形态不解析，回落指数退避——与 Python `_infra_backoff_delay` 容错口径一致；
5. **网络层失败**：`fetch` 抛 `TypeError` → `LLMConnectionError`（cause 保留）；AbortError → `LLMTimeoutError`（signal 外部取消时上抛 `LLMError`，01 §5 尾段）。

## 2. anthropic-messages（工作项 2.2 · parity 主通道）

### 2.1 端点与头

- URL：`${baseUrl}/v1/messages`；默认 `https://api.anthropic.com`；智谱兼容端点 `https://open.bigmodel.cn/api/anthropic`。
- 头：`content-type: application/json`、`x-api-key: <apiKey>`、`anthropic-version: 2023-06-01`、**`anthropic-dangerous-direct-browser-access: true`（恒发）**——扩展宿主从 SW 直连时，Anthropic 对浏览器源做 CORS 拦截，该头是官方逃生门（webbrain 同款；对智谱等兼容端点多发无害）。`extraHeaders` 最后合并（可覆盖）。

### 2.2 请求体构造（canonical → wire）

```jsonc
{
  "model": "<model>",
  "max_tokens": 16384,            // 必填字段；anthropic 无缺省
  "system": "<systemPrompt>",     // 仅非 null 时发；字符串形态（不用 blocks 数组）
  "messages": [ /* 见映射表 */ ],
  "tools": [ { "name": "...", "description": "...", "input_schema": { ... } } ],
  "tool_choice": { "type": "tool", "name": "agent_response" }  // forced；auto = {"type":"auto"} 或缺省
}
```

| canonical | wire | 备注 |
|---|---|---|
| `systemPrompt` | `system`（string） | |
| `user.blocks` | content 数组：text → `{"type":"text","text"}`；image → `{"type":"image","source":{"type":"base64","media_type":mimeType,"data":base64}}` | |
| `assistant.blocks` | text 块同上；**纯工具调用回合（blocks 空）发空数组 content** | |
| `assistant.toolCalls` | 追加 `{"type":"tool_use","id","name","input":args}` | input 是对象（anthropic 原生就是对象，无字符串化） |
| `toolResult` | `{"type":"tool_result","tool_use_id":toolCallId,"content":text,"is_error":isError?}` 装进 **user** 消息 | `is_error` 仅 true 时发 |

**地雷 1（400）——连续 toolResult 合并**：一个 assistant 回合的多个 tool_use 的 tool_result 必须装在**同一条** user 消息里；逐条各发一条 user 消息会被 API 以 400 拒绝（webbrain `anthropic.js` `_convertMessages` 已踩）。适配器把"连续 toolResult 段"折叠为一条 user 消息（多条 tool_result 块并置）。canonical 允许 toolResult 序列乱序到达，折叠时**按前置 assistant.toolCalls 的顺序重排**。

**地雷 2——首消息必须 user**：canonical 不变量已在 01 §2.1 拦截，适配器直接信任。

**地雷 3——图片与 vision 声明**：`supportsVision=false` 的模型收到 image 块，智谱端点**静默致盲不报错**（client.py `_strip_image_blocks` 注释）。适配器不防御（canonical 带 image 是调用方决策——client.ts 的 fallback 滤图才管），但 `testConnection` 若带图会暴露。

### 2.3 响应解析（wire → canonical）

```jsonc
{
  "content": [
    { "type": "text", "text": "..." },
    { "type": "thinking", "thinking": "...", "signature": "..." },  // GLM/Claude 思考块——跳过
    { "type": "tool_use", "id": "toolu_...", "name": "agent_response", "input": { ... } }
  ],
  "stop_reason": "tool_use",        // tool_use | end_turn | stop_sequence | max_tokens | refusal
  "usage": { "input_tokens": 1, "output_tokens": 2,
             "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 }
}
```

- `text`：全部 `text` 块拼接；`reasoningText`：全部 `thinking` 块的 `thinking` 字段拼接（观测用）。
- `toolCalls`：`tool_use` 块直映（`input` 已是对象）；**忽略 name 不匹配的 tool_use**（Python 只认 `agent_response`——泛化为"忽略非请求工具名的调用"，03 §2 消费侧同规则）。
- `stopReason`：`tool_use→tool_call`，`end_turn|stop_sequence→stop`，`max_tokens→length`，其余→`other`。
- `usage`：`input_tokens/output_tokens` 直映；cache 字段有则带（01 §3 可选字段）。
- 错误体：`{"type":"error","error":{"type":"invalid_request_error","message":"..."}}`——`error.message` 进异常消息。

## 3. openai-completions（工作项 2.3）

### 3.1 端点与头

- URL：`${baseUrl}/chat/completions`；OpenAI 官方 `https://api.openai.com/v1`；智谱 `https://open.bigmodel.cn/api/paas/v4`；DeepSeek/Kimi/Qwen/Groq/OpenRouter/vLLM/Ollama 各自 baseUrl（卡片配置）。
- 头：`authorization: Bearer <apiKey>`、`content-type: application/json`。

### 3.2 请求体构造

```jsonc
{
  "model": "<model>",
  "messages": [ /* system + 映射表 */ ],
  "max_tokens": 16384,             // 或 "max_completion_tokens"，见地雷 1
  "tools": [ { "type": "function",
               "function": { "name": "...", "description": "...", "parameters": { ... } } } ],
  "tool_choice": { "type": "function", "function": { "name": "agent_response" } }  // forced
}
```

| canonical | wire | 备注 |
|---|---|---|
| `systemPrompt` | 首条 `{"role":"system","content":<string>}` | |
| `user.blocks` | 纯文本 → `content` 直接字符串；含图 → 数组 `{"type":"text","text"}` + `{"type":"image_url","image_url":{"url":"data:<mime>;base64,<data>"}}` | 纯文本走字符串形态最大化兼容 |
| `assistant.blocks` | `{"role":"assistant","content":<text 或 null>}` | 纯工具调用回合 content 置 null（官方形态） |
| `assistant.toolCalls` | `tool_calls: [{"id","type":"function","function":{"name","arguments": JSON.stringify(args)}}]` | **args 字符串化是 openai 独有**，反向解析见 3.3 |
| `toolResult` | `{"role":"tool","tool_call_id":toolCallId,"content":text}` | 每条独立消息（与 anthropic 相反，不合并）；`isError` 无原生字段——true 时在 text 前缀 `[error] `（约定，写死在适配器并注释） |

**地雷 1——输出上限字段双轨**：`gpt-5` / `gpt-4.1` / `o1` / `o3` / `o4` 系拒收 `max_tokens` 要 `max_completion_tokens`；其余（含全部兼容端点）用 `max_tokens`。规则：`ProviderConfig.maxTokensField` 声明优先；未声明按模型名前缀正则 `/^(gpt-5|gpt-4\.1|o1|o3|o4)/` 自动选新契约（借 webbrain `_isNewOpenAIContract`）。
**地雷 2——temperature 400**：新契约模型只接受默认温度。TS 侧 `temperature` 缺省不发（Python 同款），配置了才发——新旧契约都不炸。
**地雷 3——不认识的字段**：兼容端点对未知字段报错的不少。请求体保持最小集：不发自建房间的 `stream_options`/`parallel_tool_calls`/`user` 等。

### 3.3 响应解析

```jsonc
{
  "choices": [ { "message": { "role": "assistant", "content": "..." | null,
                              "tool_calls": [ { "id": "call_...", "type": "function",
                                "function": { "name": "agent_response",
                                              "arguments": "{...JSON 字符串...}" } } ],
                              "reasoning_content": "..." },   // GLM/DeepSeek 思考，可选
                "finish_reason": "tool_calls" } ],            // stop | length | content_filter
  "usage": { "prompt_tokens": 1, "completion_tokens": 2,
             "prompt_tokens_details": { "cached_tokens": 0 } }  // details 可选
}
```

- **arguments guard-parse**：`arguments` 是 JSON 字符串且可能被 `length` 截断。解析成功 → `args` 对象；**解析失败 → 丢弃该 toolCall 并降 warning**（消费侧自然落入文本兜底/空响应梯子；不带病 args 进 canonical）。个别端点返回对象形态——`typeof` 判别后直收。
- `stopReason`：`tool_calls→tool_call`，`stop→stop`，`length→length`，`content_filter→other`（并抛 `LLMBlockedError`？**否**——filter 时 choices 通常仍有文本，按 `other` + 正常返回，让梯子处理；`LLMBlockedError` 只用于 gemini 全局拦截形态）。
- `usage`：`prompt_tokens→inputTokens`、`completion_tokens→outputTokens`、`prompt_tokens_details.cached_tokens→cacheReadTokens`（有则带）。
- `reasoning_content`（或 `reasoning`）→ `reasoningText`。
- 错误体：`{"error":{"message":"...","type":"...","code":"..."}}`——`error.message` 进异常。

## 4. gemini（工作项 2.4 · 无内部参考，风险最高）

### 4.1 端点与头

- URL：`${baseUrl}/v1beta/models/${model}:generateContent`；默认 `https://generativelanguage.googleapis.com`。
- 头：`x-goog-api-key: <apiKey>`（**key 走头不走 URL query**——避免 key 进日志/Referer；query `?key=` 同样合法，不用）、`content-type: application/json`。

### 4.2 请求体构造

```jsonc
{
  "systemInstruction": { "parts": [ { "text": "<systemPrompt>" } ] },
  "contents": [ /* 仅 user/model 两种角色，见映射表 */ ],
  "tools": [ { "functionDeclarations": [ { "name": "...", "description": "...",
                "parameters": { /* OpenAPI 子集，见 4.4 */ } } ] } ],
  "toolConfig": { "functionCallingConfig": { "mode": "ANY",
                 "allowedFunctionNames": [ "agent_response" ] } },   // forced；auto = mode:"AUTO" 或不发 toolConfig
  "generationConfig": { "maxOutputTokens": 16384 }
}
```

| canonical | wire | 备注 |
|---|---|---|
| `systemPrompt` | `systemInstruction`（仅非 null 发） | contents 里**没有** system 角色 |
| `user.blocks` | `{role:"user",parts:[...]}`：text → `{"text"}`；image → `{"inlineData":{"mimeType","data":base64}}` | |
| `assistant.blocks` | `{role:"model",parts:[{"text"}]}` | 角色名是 **model** 不是 assistant |
| `assistant.toolCalls` | 同一 model turn 追加 `{"functionCall":{"name","args"}}` | args 原生对象 |
| `toolResult` | `{role:"user",parts:[{"functionResponse":{"name":toolName,"response":{"result":text}}}]}` | **按 name 关联（无 id 语义）**——canonical 双携带的原因；`response` 包装为 `{"result": text}` 是官方推荐形状；`isError` 无原生字段，true 时 text 前缀 `[error] `（与 openai 同约定） |

**地雷 1**：contents 角色只有 `user`/`model`；连续 toolResult 折叠为一条 user turn（多 functionResponse part 并置，同 anthropic 逻辑）。
**地雷 2**：`maxOutputTokens` 进 `generationConfig`（不与 openai/anthropic 的顶层字段混淆）。
**地雷 3**：temperature 进 `generationConfig.temperature`，缺省不发。

### 4.3 响应解析

```jsonc
{
  "candidates": [ { "content": { "role": "model", "parts": [
                      { "text": "..." },
                      { "functionCall": { "name": "agent_response", "args": { ... } } },
                      { "text": "...", "thought": true }   // 思考片段，可选
                    ] },
                    "finishReason": "STOP" } ],             // STOP | MAX_TOKENS | SAFETY | RECITATION | ...
  "usageMetadata": { "promptTokenCount": 1, "candidatesTokenCount": 2 },
  "promptFeedback": { "blockReason": "SAFETY" }             // 全局拦截时 candidates 缺失
}
```

- `promptFeedback.blockReason` 存在 → 抛 `LLMBlockedError`（gemini 拦截时无候选内容，梯子无从处理）。
- `text`：`thought` 非 true 的 text part 拼接；`reasoningText`：`thought===true` 的拼接。
- `toolCalls`：`functionCall` part 直映（无 id——**合成 `id = \`gemini-call-${序号}\``**，保证 canonical 不变量；同回合多 functionCall 即并行调用）。
- `stopReason`：有 functionCall part → `tool_call`（finishReason 仍为 STOP，**从 parts 推导优先**）；否则 `STOP→stop`、`MAX_TOKENS→length`、其余→`other`。
- `usage`：`promptTokenCount→inputTokens`、`candidatesTokenCount→outputTokens`。
- 错误体：`{"error":{"code":429,"message":"...","status":"RESOURCE_EXHAUSTED"}}`——`error.message` 进异常。

### 4.4 schema sanitize（`schema-sanitize.ts`）

`functionDeclarations.parameters` 只收 **OpenAPI Schema 子集**（`type`/`format`/`description`/`nullable`/`items`/`properties`/`required`/`enum` 及 `type` 的大小写变体），JSON Schema 的 `$schema`/`$id`/`additionalProperties`/`examples` 等键会被拒或忽略。适配器对 `parameters` 做**递归白名单清洗**（清洗事件经回调上报），原始 schema 不动（其余两协议透传）。白名单首版如上，2.4 的 mock 用例锁定行为，真机差异等有 key 实测后修订（README 风险 3）。
**评审轮 10 修订**：按官方 v1beta Schema 文档把约束键 `minimum`/`maximum`/`pattern`/`minLength`/`maxLength`/`minItems`/`maxItems` 补入白名单（多词键按官方 camelCase 发射）——删除会让数值/长度约束静默丢失、模型生成越界参数；同时收口 `required` 非 string[]、items 元组/非对象、布尔子 schema 的值形态（归一或删除并上报）。
**评审轮 18/19 修订**：端点要求**每个 schema 节点显式 `type`**（社区实证 "missing a type" 400：livekit/agents#5044、awslabs/mcp#661）——type 的病态值（非字符串/全病态数组/非法枚举字符串）统一兜底 `string` 不删键；联合数组按成员级枚举校验取首个合法成员；`format` 按 type 分域收尾校验（string: enum/date-time、number: float/double、integer: int32/int64，其余 type 无合法 format）；清洗产物与调用方未写 type 的子 schema 统一补注入缺省 `type:"string"`（归一空 schema 不再产出无 type 节点）。真机有 key 后复核（README 风险 3）。

## 5. 强制工具映射总表（架构 §3.4 落地）

| | openai-completions | anthropic-messages | gemini |
|---|---|---|---|
| 工具定义 | `tools[].function.{name,description,parameters}` | `tools[].{name,description,input_schema}` | `tools[].functionDeclarations[].{name,description,parameters(清洗)}` |
| forced | `tool_choice:{type:"function",function:{name}}` | `tool_choice:{type:"tool",name}` | `toolConfig.functionCallingConfig:{mode:"ANY",allowedFunctionNames:[name]}` |
| auto | `tool_choice:"auto"` 或不发 | 不发 | `mode:"AUTO"` 或不发 |
| 工具调用（出） | `choices[0].message.tool_calls[].function.{name,arguments(JSON 串)}` | `content[].tool_use.{id,name,input}` | `candidates[0].content.parts[].functionCall.{name,args}` |
| 工具结果（入） | `role:"tool"` 独立消息 ×N | 合并进**一条** user 消息的 tool_result 块 | 合并进**一条** user turn 的 functionResponse part |
| 调用标识 | `id`（tool_call_id 配对） | `id`（tool_use_id 配对） | 无 id，按 `name`（canonical 双携带） |
| 输出上限 | `max_tokens` / `max_completion_tokens`（地雷双轨） | `max_tokens`（必填） | `generationConfig.maxOutputTokens` |
| usage | `prompt_tokens`/`completion_tokens`(+details.cached) | `input_tokens`/`output_tokens`(+cache×2) | `usageMetadata.promptTokenCount`/`candidatesTokenCount` |

## 6. 承重墙：不支持 forced tool_choice 的端点

`capabilities.supportsForcedTool === false` 时（vLLM 旧版 / 部分自建网关；卡片显式声明）：

1. tools 照发（若 `supportsTools`），`tool_choice` **不发**；
2. systemPrompt 追加约束段（英文，与 TreeWalker 重试文案同语种）：

```
IMPORTANT: You must respond by calling the tool "${toolName}" with your complete
answer as the tool arguments. Do not reply with plain text.
```

3. 响应文本经 `tryParseJson` 兜底（03 §3.4）——**该路径与"模型偏不听话返回纯文本"共用同一条兜底**，这正是把它做进 client 行为层而非适配器的原因：一个机制覆盖两类失效。
