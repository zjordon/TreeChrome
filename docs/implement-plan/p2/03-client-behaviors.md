# 03 · LLMClient 行为层（client.py 移植语义）

> 对应工作项 2.2 的行为层半区。Python 参考：`TreeWalker/src/tree_walker/llm/client.py`（812 行，2026-09-23 快照）。**移植保真为默认，偏离必须入 §4 清单并给理由**——本层是 P5 评测 parity 的一部分，语义漂移会直接进 SR 差距。

## 1. 结构与公共面

```ts
export interface GetActionOptions {
  /** 敏感值表：真实值 → 占位符。请求侧替换、响应 toolInput 还原（§3.3） */
  sensitiveMap?: Record<string, string>;
  /** 本次 getAction 的墙钟预算（毫秒）。梯子内全部请求与 sleep 共享 */
  timeoutMs?: number;
  /** 外部取消（step 停止）。穿透所有内部调用，不被吞 */
  signal?: AbortSignal;
}

export type GetActionResult =
  | { kind: "ok"; toolInput: Record<string, unknown>; usage: TokenUsage | null }
  | { kind: "empty" };

export class LLMClient {
  constructor(config: ProviderConfig, deps?: LlmDeps);
  /** agent 决策调用：强制 tool（默认 forced:name=tool.name）+ 全套行为 */
  getAction(
    systemPrompt: string,
    messages: ChatMessage[],
    tool: ToolDefinition,
    opts?: GetActionOptions,
  ): Promise<GetActionResult>;
  testConnection(): Promise<{ ok: boolean; error?: string; model?: string }>;
  /** P4 step 在 wait_for 起点登记的步级共享窗口（Python set_llm_window）；
   *  null 清除登记（评审轮 1 增补——过期窗口不清除会让后续 getAction 恒超时） */
  setCallWindow(timeoutMs: number | null): void;
}

export function createLLMClient(config: ProviderConfig, deps?: LlmDeps): LLMClient;
```

`toolInput` = `agent_response` 工具的完整输入对象（含 `evaluation_previous_goal` / `memory` / `next_goal` / `action`）——字段抽取与 `normalize_actions_list` 归一化属 P4（依赖未稳定的 action_shape），P2 整体透传。

## 2. getAction 主流程（状态机）

```
getAction(systemPrompt, messages, tool, opts)
 ├─ 0. 前置
 │    assertValidMessages(messages)（01 §2.1 不变量）
 │    deadline = opts.timeoutMs ? now()+timeoutMs : undefined
 │    deadline ≤ setCallWindow 登记的窗口（两者都有时取小）
 ├─ 1. 请求侧变换（transforms，函数式——不改动调用方消息，§4 偏离 1）
 │    work = 深拷贝 messages（仅复制会被改写的对象，blocks 共享不可变块）
 │    urlMap     = shortenUrls(work)          // §3.2
 │    sensitive  = applySensitive(work, opts.sensitiveMap)  // §3.3
 ├─ 2. 组装 ChatRequest
 │    tools=[tool]，toolChoice = capabilities.supportsForcedTool
 │      ? {kind:"forced", name:tool.name} : undefined（且追加约束段，02 §6）
 │    capabilities.supportsTools=false 时不带 tools（纯 prompt 模式，schema 进约束段）
 ├─ 3. 发送：provider.chat(req) 经 _callWithBackoff（§3.5 退避）
 ├─ 4. 解析（§3.4 优先级）
 │    a. toolCalls 中 name===tool.name 的第一个 → toolInput = args
 │    b. text 非空 → tryParseJson(text) 成功 → toolInput = parsed
 │    c. text 非空且解析失败 → R4 梯子（§3.6）
 │    d. text 空且无工具调用 → R1 梯子（§3.6）
 ├─ 5. 响应侧还原（仅 ok 路径）
 │    toolInput = restoreSensitive(restoreUrls(toolInput, urlMap), sensitive)
 │    return { kind:"ok", toolInput, usage }
 └─ 6. 梯子耗尽 → return { kind:"empty" }（§4 偏离 3：honest-done 合成移 P4）
```

usage 透传：`ChatResponse.usage` 原样返回；Python 在 R1 合成 done 的场景也带 usage——TS `kind:"empty"` 不带（无可解析产物，usage 观测走 client 内部日志，P4 的 ModelResultEvent 在 ok 路径取用）。

## 3. 行为块逐项设计

### 3.1 常量（`client.ts`，Python 值原样移植）

| 常量 | 值 | Python 对应 |
|---|---|---|
| `URL_MIN_LENGTH` | 100 | `_URL_MIN_LENGTH` |
| `TEXT_RETRY_MAX` | 2 | `_TEXT_RETRY_MAX`（R4） |
| `INFRA_RETRY_MAX` | 5 | `_RATE_LIMIT_RETRY_MAX`（含首呼共 6 次请求） |
| `INFRA_BACKOFF_BASE_SEC` | 2.0 | `_RATE_LIMIT_BACKOFF_BASE`（2,4,8,16,30） |
| `INFRA_BACKOFF_CAP_SEC` | 30.0 | `_RATE_LIMIT_BACKOFF_CAP` |
| `RETRY_AFTER_CAP_SEC` | 60.0 | `_RETRY_AFTER_CAP` |
| `INFRA_BUDGET_DEFAULT_SEC` | 90.0 | `_RATE_LIMIT_BUDGET_MAX` |
| 窗口派生预算 | `max(30s, 0.75×timeoutMs)` | `set_llm_window` 的 `max(30.0, t*0.75)` |

### 3.2 URL 缩写（`transforms.ts`）

移植 `_shorten_urls_in_messages`：正则 `/https?:\/\/\S+/g`，长度 ≥100 的 URL 换 `[uN]`，同 URL 同 tag，N 从 0 递增（**分配顺序 = 首次出现顺序**，锚定测试锁这个顺序）；返回 `Map<string,string>`（tag→原 URL）。响应侧 `restoreUrls(obj, map)` 递归还原字符串字段（对象/数组/嵌套全走）。区别：Python 在 Anthropic block 形态上操作，TS 在 canonical blocks 上操作——语义等价（只碰 TextBlock.text，ImageBlock 天然无 URL）。

### 3.3 敏感值占位/还原

移植 `_filter_sensitive_in_messages` / `_restore_sensitive_in_output`：请求侧 TextBlock 文本内 `real→placeholder`（**多键按对象插入序**替换，与 Python dict 序等价——键有包含关系时顺序影响结果，锚定测试覆盖）；响应侧 toolInput 递归 `placeholder→real`。Python 从实例属性 `self._sensitive_map` 取表（agent 层注入的隐藏状态）——TS 改为 `opts.sensitiveMap` 显式传参（§4 偏离 2）。

### 3.4 解析优先级与 `tryParseJson`

移植 `_try_parse_json`（三级：直接 `JSON.parse`（trim 后以 `{` 开头才试）→ ```` ```(json)?\s*(\{.*?\})\s*``` ```` 围栏 → 首个 `{`…末个 `}` 子串）。全部失败返回 undefined。期望值锚定 Python 实跑（04 §4）。

工具调用选择：`toolCalls.find(c => c.name === tool.name)`（Python：遍历 content 找 `type==="tool_use" && name==="agent_response"` 的第一个——泛化为"请求的工具名"，其余名字的调用忽略）。

### 3.5 退避与 fallback（`_create_with_backoff` + `_try_switch_to_fallback` 移植）

```
_callWithBackoff(buildReq):
  cap    = 窗口派生预算 ?? INFRA_BUDGET_DEFAULT_SEC
  deadline = min(now()+cap, callWindowDeadline)     // Python：两者都有取小
  retries = 0
  loop:
    try: return provider.chat(buildReq())           // buildReq() 每轮重建：
                                                    //   fallback 切换后取新 model/maxTokens
    catch e:
      非 infra（auth/4xx/5xx）→ trySwitchToFallback(e) ? continue（不占名额）: throw
      infra（429/连接）→
        trySwitchToFallback(e) ? continue           // 单向锁，至多一次，不占名额
        retries >= INFRA_RETRY_MAX → throw
        delay = retryAfterMs ?? min(CAP, BASE×2^retries)
        now()+delay > deadline → throw（预算耗尽，终点异常类型不变）
        await sleep(delay, deadlineSignal)          // 可中止；signal 触发即抛
```

对齐 Python 语义的三个关键细节：

1. **fallback 切换不占退避名额**（`_create_with_backoff` review4 #3：显式计数器，switch 的 continue 不递增）；
2. **切换后刷新请求参数**（review4 修的 bug：create_kwargs 已绑定主模型名——切换后必须重建请求，否则把主模型名发给 fallback 端点）；TS 侧 `buildReq()` 每轮重建天然满足；
3. **非 infra 的 APIError 也允许触发 fallback 切换**（Python 外层 `except (RateLimitError, APIError)` → `_try_switch_to_fallback` → 递归重试）：即 401/402/5xx 先切 fallback 再说，无 fallback 或已切换才抛。

**fallback 切换的连带动作**（`_try_switch_to_fallback` + 阶段二边界）：

- 切换 = provider 实例整体替换（fallback 是完整卡片，**可跨协议**）；`model`/`maxTokens`/`capabilities` 跟随；
- **滤图**：切换后 `capabilities.supportsVision === false` 且 work 消息含 ImageBlock → 从 work **移除**全部图片块（Python `_strip_image_blocks` 原地语义 → TS 对 work 副本操作，等效"从此以后都不带图"）；块移空的消息按 canonical 不变量处理（user 消息恒有 text 在前，理论不空——与 Python 注释同款假设，违例抛 `LLMProtocolViolationError` 暴露）；
- 单向锁：`_usingFallback` 置位后永远不再切（Python 同款）。

**timeout 的实现差异（有意改进，§4 偏离 5）**：Python 的墙钟预算只 gate sleep 起点，在飞请求靠外层 `asyncio.wait_for` 强杀——异常被变形为 TimeoutError 是 #194 的死因之一。TS 侧把 deadline 做成 AbortSignal 贯穿 fetch 与 sleep：到点中止在飞请求，抛 `LLMTimeoutError`（类型恒定，不变形）。

### 3.6 重试梯子（R4 / R1）

**R4 text-not-tool**（`_TEXT_RETRY_MAX=2`）：文本非空、JSON 解析失败 → work 追加两条消息后重发：

```
assistant: <原文本>                    // blocks:[{kind:"text", text}]
user:      "Do not explain. Call the agent_response tool now with your
            evaluation, memory, next goal, and action."
```

文案逐字节照抄 Python（含 `agent_response` 字面名——**泛化时替换为 `tool.name`**，同款句式；这是 prompt 契约，锚定测试锁文案）。计数耗尽（第 3 次仍失败）→ `{kind:"empty"}`。

**R1 空响应**（含 thinking-only）：文本空且无工具调用 → 追加一条重试一次：

```
user: "Your previous response contained no action. Respond now with the
       agent_response tool, including your evaluation, memory, next goal,
       and action."
```

（同样泛化 `tool.name`。）仍空 → `{kind:"empty"}`。Python 在此处内联合成 honest-done（`honest_done_action()`）——**移到 P4**（§4 偏离 3）。

两个梯子的 `_no_action_retry_used` / `_text_retry_count` 防递归标志 → TS 译为循环内的显式计数器（同语义，不递归）。

**观测日志**（对齐 Python R2 的 WARNING 证据链）：空响应时 warn 一行含 `stopReason`/`usage.outputTokens`/`toolCalls.length`——P2 用 console.warn（EventBus 的 model_result 事件属 P4，接通后改走事件）。退避每轮 warn（类型/第几次/退避秒数）、fallback 切换 warn（目标 model + 诱因）。

## 4. 有意偏离清单（评审重点）

| # | 偏离 | Python 行为 | TS 行为 | 理由 |
|---|---|---|---|---|
| 1 | **不改调用方消息** | `_shorten_urls` / `_filter_sensitive` / `_strip_image_blocks` 原地改 dict（#197 类共享可变结构 bug 温床；为此另造了 `copy_messages_without_images` 补丁） | 入口浅拷贝出 work，全部变换落在副本 | JS 侧共享引用更隐蔽；函数式一次做对，免去"原地/拷贝"两套 API |
| 2 | **sensitiveMap 显式传参** | 实例隐藏属性 `self._sensitive_map`（agent 层 set） | `GetActionOptions.sensitiveMap` | AGENTS.md：配置是显式传入的类型化对象；隐藏状态与 SecretProvider 注入（架构 §4）在 P4 汇合时同样走显式参数 |
| 3 | **honest-done 合成移出** | R1 耗尽时 client 内合成 `honest_done_action()` done | 返回 `{kind:"empty"}`，合成归 P4 | `action_shape` 属 P4 且上游未稳定；P2 不引未冻结依赖。P4 移植 step 时按 client.py:539-557 在 step 侧合成，行为等价 |
| 4 | **结果判别联合** | 返回 dict（`{}` 哨兵 = falsy） | `{kind:"ok"\|"empty"}` | TS 无 falsy-dict 惯例；判别键让 P4 无法误读 |
| 5 | **deadline=AbortSignal** | 预算只 gate sleep；在飞请求靠外层 `wait_for` 强杀（异常变形 #194 死因） | signal 贯穿 fetch+sleep，终点恒 `LLMTimeoutError` | 结构性消除异常变形；Python 侧靠注释维持的不变量在 TS 是类型保证 |
| 6 | **openai args guard-parse** | （anthropic 原生无此问题） | 字符串解析失败的 toolCall 丢弃+warn，落文本兜底 | webbrain 已踩：截断 args 的 JSON.parse 抛错会永久毒化后续请求 |
| 7 | **temperature 缺省不发** | 不发（create kwargs 无 temperature） | 同（webbrain 的 0.7 默认不采纳） | 非偏离，写明防"顺手补默认值" |
| 8 | **单文件非递归实现** | 梯子靠递归 get_action | 循环 + 计数器 | 语义同（防递归标志即计数器），可读性/栈深更优 |
| 9 | **滤图条件**（评审轮 2 登记、轮 4 修订） | `_strip_image_blocks` 仅在 fallback 切到无视觉模型时执行（主卡隐含恒为 claude 视觉模型） | 当前卡**显式声明** `capabilities.supportsVision=false` → 恒滤（声明即生效，文本主卡显式配 false 即受保护）；**未声明** → 仅 fallback 切换后按白名单推导滤 | 未声明时改纯能力驱动有反向风险：白名单外真视觉模型（qwen-vl/gpt-4o）缺省推导 false，恒滤图会把图从视觉模型上静默剥掉。声明/未声明分流后两个目标兼得 |
| 10 | **URL 缩写尾界**（评审轮 8 登记） | `https?://\S+` 尾界贪婪到空白，中文书写 URL 后紧跟全角标点（无空白）会把后续中文吞进「URL」整体换 tag | 尾界排除常见全角标点/引号/括号（，。；：、！？“”‘’（）「」『』【】《》）；ASCII 标点保持同款吞入 | 中文语境（本项目宿主的常态）下 \S+ 是静默数据损坏：请求侧删中文、还原侧产出带中文尾巴的损坏 URL。与视觉白名单 `(?![a-z0-9])`（types.ts）同类的登记式收紧，英文/空格锚定用例不受影响 |

## 5. 不移植项（Python 有、P2 明确不要）

| 项 | Python 位置 | 去向 |
|---|---|---|
| `extract()` / `structured_call()` | client.py:635-780 | P4 薄封装（消费方 extract 动作与 skill matcher 都在 P4） |
| `asyncio.to_thread` 包装 | client.py:621-633 | fetch 原生异步，无需 |
| `_HonestDone` dict 子类带外标记 | client.py:321-329 注释 | P4（随 honest-done 一起） |
| `output_mode`（standard/flash/thinking） | config.py:285 | P4 settings（不影响 wire） |
| 消息管理（`_trim_messages` 等） | step.py | P4 |
