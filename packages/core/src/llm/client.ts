// LLMClient 行为层：getAction 状态机（解析梯子 R4/R1、URL 缩写/敏感值往返、
// 退避与预算、fallback 单向切换、滤图、承重墙）——移植自 tree_walker/llm/client.py
// 的 get_action/_create_with_backoff/_try_switch_to_fallback（03 文档，偏离清单见其 §4）。

import { createAnthropicProvider } from "./adapters/anthropic-messages.js";
import { createGeminiProvider } from "./adapters/gemini.js";
import { isAbortError } from "./adapters/http.js";
import { createOpenAICompletionsProvider } from "./adapters/openai-completions.js";
import type { ProviderConfig } from "./config.js";
import type { LlmDeps } from "./deps.js";
import {
  isInfraError,
  LLMError,
  LLMInvalidRequestError,
  LLMProtocolViolationError,
  LLMTimeoutError,
} from "./errors.js";
import type { LLMProvider } from "./provider.js";
import {
  applySensitiveInMessages,
  cloneWorkMessages,
  hasImageBlocks,
  replaceSensitiveDeep,
  replaceSensitiveText,
  restoreSensitiveInOutput,
  restoreUrlsInOutput,
  shortenUrlsInMessages,
  stripImageBlocks,
  tryParseJson,
} from "./transforms.js";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  TokenUsage,
  ToolChoice,
  ToolDefinition,
} from "./types.js";
import { assertValidMessages } from "./types.js";

// —— 常量（03 §3.1，Python 值原样；秒在用点换算毫秒） ——
/** R4 text-not-tool 重试上限（Python _TEXT_RETRY_MAX；第 3 次仍失败 → empty） */
const TEXT_RETRY_MAX = 2;
/** 基建错误退避重试上限（Python _RATE_LIMIT_RETRY_MAX；含首呼共 6 次请求） */
const INFRA_RETRY_MAX = 5;
/** 指数退避首次秒数（Python _RATE_LIMIT_BACKOFF_BASE；实际可达序列 2,4,8,16,30 共
 *  5 次睡眠——INFRA_RETRY_MAX=5 下第 4 次起封顶 30s，含首呼共 6 次请求，无第 6 次睡眠） */
const INFRA_BACKOFF_BASE_SEC = 2.0;
/** 指数退避单次上限（Python _RATE_LIMIT_BACKOFF_CAP） */
const INFRA_BACKOFF_CAP_SEC = 30.0;
/** 退避墙钟总预算缺省（Python _RATE_LIMIT_BUDGET_MAX；含请求耗时） */
const INFRA_BUDGET_DEFAULT_SEC = 90.0;
/** 窗口派生预算下限（Python set_llm_window 的 max(30.0, t*0.75)） */
const WINDOW_BUDGET_FLOOR_MS = 30_000;
/** 窗口派生预算比率（Python set_llm_window 的 t*0.75） */
const WINDOW_BUDGET_RATIO = 0.75;
/**
 * 单次 HTTP 请求缺省超时（毫秒）：仅当调用方既未传 timeoutMs 也未 setCallWindow
 * （无梯子 deadline）时兜底——挂死请求（TCP 黑洞/网关不回包）不会无限阻塞。
 * 对齐 Anthropic/OpenAI SDK 的缺省请求超时 600s：Python 侧同款上界来自 SDK，
 * 梯子总时长仍无上界（对齐 get_action，上界由 step 层提供）
 */
const CHAT_HTTP_TIMEOUT_DEFAULT_MS = 600_000;

export interface GetActionOptions {
  /**
   * 敏感值表：真实值 → 占位符。请求侧替换、响应 toolInput 还原（03 §3.3）。
   * **缺省风险显式标注（轮 14 #2，轮 17 #10 补全清单）**：工具载荷（toolResult
   * 文本与 assistant.toolCalls[].args）不在替换范围（P5 parity，见
   * applySensitiveInMessages 注释）——其中的敏感值会**明文出站**；systemPrompt 与
   * ImageBlock.base64 同样不在替换范围（仅 messages 的 TextBlock 参与，且连命中
   * WARNING 都没有——systemPrompt 视为宿主可信自持内容，注入密钥类上下文由宿主
   * 自担）。sensitiveMap 不覆盖全部出站内容；需阻断工具载荷时显式传
   * redactToolPayloads:true。P4 接 SecretProvider 时评估缺省翻转为
   * secure-by-default
   */
  sensitiveMap?: Record<string, string>;
  /**
   * 为 true 时**工具载荷**（toolResult 文本 + assistant.toolCalls[].args）同样做
   * 敏感值占位（作用于 work 副本不动调用方消息；模型回显占位符时响应侧还原自然
   * 闭合）。**覆盖边界（轮 17 #16）**：args 的深层替换只作用于字符串**值**，对象
   * 键名位置出现的敏感 real 值不替换也不告警（键位敏感属罕见形态，扩展需评估
   * restore 方向共用游走的键名改写影响，P4 收口时一并裁决）。缺省 false 维持
   * P5 parity（Python 只处理 text block）——工具载荷的敏感值会明文出站仅
   * WARNING 可观测（含 okResult 还原后的真实 args 随历史回放的泄露链路）；
   * 合规宿主可即刻阻断。P4 接 SecretProvider 时统一收口此开关与缺省姿态。
   */
  redactToolPayloads?: boolean;
  /**
   * 本次 getAction 的墙钟预算（毫秒）。梯子内全部请求与 sleep 共享。
   * 调用契约：无 timeoutMs 且未 setCallWindow 时梯子**总时长无内部上界**（对齐
   * Python get_action——上界由 step 层的外层 wait_for 提供）；P4 step 恒传。
   * 单次 HTTP 请求仍有 600s 缺省超时兜底（CHAT_HTTP_TIMEOUT_DEFAULT_MS，对齐
   * SDK 缺省），挂死请求不会无限阻塞。
   */
  timeoutMs?: number;
  /** 外部取消（step 停止）。穿透所有内部调用，不被吞（#186 教训） */
  signal?: AbortSignal;
}

export type GetActionResult =
  | { kind: "ok"; toolInput: Record<string, unknown>; usage: TokenUsage | null }
  | { kind: "empty" };

/** 可中止睡眠（AbortSignal-aware）。reject 形态为 AbortError，由上层分类 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // 先声明后赋值：onAbort 引用 timer，声明顺序不依赖调用时序（TDZ 前向引用脆弱）
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      // 透传 abort reason（宿主可能以自定义 reason 区分停止来源，#186 不变形）；
      // 无 reason 的 abort 用规范缺省形态
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 无梯子 deadline 时的单请求超时决策（导出供测试锚定）：无 deadline（调用方
 * 漏传 timeoutMs 且未 setCallWindow）→ 600s 兜底；有 deadline → undefined
 * （由 ladder signal 到点强杀，不重复设）
 */
export function resolveChatHttpTimeoutMs(deadlineAt: number | undefined): number | undefined {
  return deadlineAt === undefined ? CHAT_HTTP_TIMEOUT_DEFAULT_MS : undefined;
}

function resolveDeps(deps?: LlmDeps): Required<LlmDeps> {
  return {
    fetch: deps?.fetch ?? ((input, init) => fetch(input, init)),
    now: deps?.now ?? (() => performance.now()),
    sleep: deps?.sleep ?? defaultSleep,
    log: deps?.log ?? ((message) => console.warn(message)),
  };
}

/**
 * 协议 → 适配器工厂（2.2 anthropic / 2.3 openai / 2.4 gemini）。
 * deps 可部分省略（缺省实现与 createLLMClient 同源），与包根导出的注入口径一致。
 */
export function createProvider(config: ProviderConfig, deps: LlmDeps = {}): LLMProvider {
  const resolved = resolveDeps(deps);
  switch (config.protocol) {
    case "anthropic-messages":
      return createAnthropicProvider(config, resolved);
    case "openai-completions":
      return createOpenAICompletionsProvider(config, resolved);
    case "gemini":
      return createGeminiProvider(config, resolved);
    default:
      throw new LLMInvalidRequestError(`协议适配器未实现：${config.protocol}`, {
        provider: config.name,
      });
  }
}

/** R4 指令文案（Python client.py:503-506 逐字节，泛化 agent_response → tool.name） */
const r4Directive = (toolName: string): string =>
  `Do not explain. Call the ${toolName} tool now with your evaluation, memory, next goal, and action.`;

/** R1 指令文案（Python client.py:529-532 同上泛化） */
const r1Directive = (toolName: string): string =>
  `Your previous response contained no action. Respond now with the ${toolName} tool, including your evaluation, memory, next goal, and action.`;

/** 承重墙：不支持 forced tool_choice 的端点，systemPrompt 追加英文约束段（02 §6） */
const forcedToolConstraint = (toolName: string): string =>
  `\n\nIMPORTANT: You must respond by calling the tool "${toolName}" with your complete answer as the tool arguments. Do not reply with plain text.`;

/** 承重墙极端形态：连 tools 都不发的端点，schema 进 system，响应用 tryParseJson 兜底 */
const noToolsConstraint = (tool: ToolDefinition): string =>
  `\n\nIMPORTANT: You must respond with only a JSON object matching this schema:\n${JSON.stringify(tool.parameters, null, 2)}\nDo not reply with plain text.`;

/**
 * 使用约束：实例按**串行 agent loop** 设计，不支持并发 getAction——fallback 单向
 * 切换会变异 config/provider/usingFallback；windowDeadline/windowBudgetCapMs 是
 * 跨 getAction 的步级登记，跨步复用实例时每步 setCallWindow 重登记（或显式传
 * null 清除）。多 tab 等并发场景应每会话独立实例。
 */
export class LLMClient {
  private config: ProviderConfig;
  private provider: LLMProvider;
  private readonly fallbackConfig: ProviderConfig | null;
  private usingFallback = false;
  /** 滤图 WARNING 的实例级去重（首次真正滤到图片时告警一次） */
  private loggedImageFilter = false;
  /** 致盲 WARNING 的实例级去重（未声明主卡带图出站的首次提示） */
  private loggedBlindImageSend = false;
  /** systemPrompt 敏感命中 WARNING 的实例级去重（轮 18 #3） */
  private loggedSystemPromptLeak = false;
  /** setCallWindow 登记的步级共享 deadline（deps.now 域，毫秒） */
  private windowDeadline: number | undefined;
  private windowBudgetCapMs: number | undefined;
  /** getAction 重入哨兵（非并发约束的运行时防护） */
  private inFlight = false;
  private readonly deps: Required<LlmDeps>;

  constructor(config: ProviderConfig, deps?: LlmDeps) {
    this.config = config;
    this.deps = resolveDeps(deps);
    this.provider = createProvider(config, this.deps);
    this.fallbackConfig = config.fallback ?? null;
  }

  /**
   * P4 step 在 wait_for 起点登记的步级共享窗口（Python set_llm_window）：
   * deadline = now + timeoutMs（梯子内所有调用共享）；单次预算上限 = max(30s, 0.75×t)。
   * 传 null 清除登记——过期的 windowDeadline 若不清除，后续 getAction 会立即
   * 到点恒抛 LLMTimeoutError（静默全量失败）；跨步复用实例时每步重登记或显式清除。
   */
  setCallWindow(timeoutMs: number | null): void {
    if (timeoutMs === null) {
      this.windowDeadline = undefined;
      this.windowBudgetCapMs = undefined;
      return;
    }
    this.windowDeadline = this.deps.now() + timeoutMs;
    this.windowBudgetCapMs = Math.max(WINDOW_BUDGET_FLOOR_MS, timeoutMs * WINDOW_BUDGET_RATIO);
  }

  async getAction(
    systemPrompt: string,
    messages: ChatMessage[],
    tool: ToolDefinition,
    opts: GetActionOptions = {},
  ): Promise<GetActionResult> {
    // 重入哨兵（轮 12 #6）：把「类文档声明的非并发约束」变成显式失败——误用并发
    // 时的静默串卡（请求发到切换后的 fallback 卡）或窗口预算错乱极难排障
    if (this.inFlight) {
      throw new LLMInvalidRequestError(
        "LLMClient 不支持并发 getAction（fallback 单向切换/窗口登记为实例级状态；多会话应各持实例）",
        { provider: this.config.name },
      );
    }
    this.inFlight = true;
    try {
      return await this.getActionInner(systemPrompt, messages, tool, opts);
    } finally {
      this.inFlight = false;
    }
  }

  private async getActionInner(
    systemPrompt: string,
    messages: ChatMessage[],
    tool: ToolDefinition,
    opts: GetActionOptions,
  ): Promise<GetActionResult> {
    assertValidMessages(messages, this.config.name);

    // 0. ladder deadline = min(opts.timeoutMs 派生, 窗口 deadline)；到点 abort 在飞请求与
    // sleep，终点恒 LLMTimeoutError（03 偏离 5：结构性消除 wait_for 异常变形的 #194 死法）
    const now = this.deps.now();
    let deadlineAt: number | undefined =
      opts.timeoutMs !== undefined ? now + opts.timeoutMs : undefined;
    if (this.windowDeadline !== undefined) {
      // 陈旧窗口可观测（轮 18 #4）：跨步复用实例漏重登记/漏清除时 deadline 已过
      // 期，梯子首请求即被强杀恒抛 LLMTimeoutError——调用方无法区分「预算真耗尽」
      // 与「陈旧登记」，把已知 footgun 从注释纪律变成运行时证据
      if (this.windowDeadline <= now) {
        this.deps.log(
          `[llm] WARNING: setCallWindow 登记的 deadline 已过期 ${Math.round(now - this.windowDeadline)}ms，本轮梯子将立即超时（跨步复用实例应每步重登记或 setCallWindow(null) 清除）`,
        );
      }
      deadlineAt =
        deadlineAt === undefined ? this.windowDeadline : Math.min(deadlineAt, this.windowDeadline);
    }
    const external = opts.signal;
    const controller = new AbortController();
    let windowExpired = false;
    const onExternalAbort = () => controller.abort(external?.reason);
    if (external !== undefined) {
      if (external.aborted) {
        // 预中止路径与事件路径同款透传 reason（#186 不变形；轮 11 #7 补齐）
        controller.abort(external.reason);
      } else {
        external.addEventListener("abort", onExternalAbort, { once: true });
      }
    }
    // deadline 计时走注入 sleep（与退避预算同钟域，不旁路 deps.now）——FakeClock 下
    // 时钟不推进即不触发（退避预算的 gate 判定同域）；getAction 结束时 abort 取消
    // watcher，不留悬挂定时器
    const watchCancel = new AbortController();
    if (deadlineAt !== undefined) {
      void this.deps.sleep(Math.max(0, deadlineAt - now), watchCancel.signal).then(
        () => {
          windowExpired = true;
          controller.abort();
        },
        () => {
          // 被取消（正常收尾）——无事可做
        },
      );
    }
    // 无梯子 deadline 时给单次请求挂保守缺省超时：调用方漏传 timeoutMs 且未
    // setCallWindow 的失败模式不该是无限挂死（TCP 黑洞/网关不回包无超时无错误）。
    // 有 deadline 时由 ladder signal 负责到点强杀，不重复设
    const httpTimeoutMs = resolveChatHttpTimeoutMs(deadlineAt);

    try {
      // 1. 请求侧变换：全部落在 work 副本（03 偏离 1：不原地改调用方消息）
      const work = cloneWorkMessages(messages);
      const urlMap = shortenUrlsInMessages(work);
      const sensitive = opts.sensitiveMap;
      applySensitiveInMessages(work, sensitive);
      // systemPrompt 不在占位范围（三适配器原样透传，轮 18 #3 核实）且连命中
      // WARNING 都没有——与工具载荷/滤图/致盲的可观测姿态对齐：命中留一次性
      // WARNING（实例级去重），宿主误写密钥时至少有运行时证据；消息文本不含
      // 告警内容，观测通道自身不泄露明文
      if (
        sensitive !== undefined &&
        !this.loggedSystemPromptLeak &&
        Object.keys(sensitive).some((real) => real !== "" && systemPrompt.includes(real))
      ) {
        this.loggedSystemPromptLeak = true;
        this.deps.log(
          "[llm] WARNING: systemPrompt 含 sensitiveMap 命中值，将明文出站（systemPrompt 不在占位范围，由宿主自担）",
        );
      }
      // 工具载荷（toolResult 文本 + assistant.toolCalls[].args）默认不在占位范围
      //（P5 parity，见 applySensitiveInMessages 注释）——命中敏感 real 值时按
      // redactToolPayloads 分流：缺省明文出站但留 WARNING（暴露可观测，P4
      // SecretProvider 收口）；opt-in 则占位阻断泄露。单趟遍历：检测命中时即时
      // 替换（对未命中载荷恒等，检测/替换不分离）。args 的泄露链路：okResult 把
      // 占位符还原为真实值 → 调用方回灌 assistant 历史 → 下一轮 args 明文出站
      if (sensitive !== undefined) {
        const reals = Object.keys(sensitive).filter((real) => real !== "");
        const leaking: string[] = [];
        for (const m of work) {
          if (m.role === "toolResult") {
            if (reals.some((real) => m.text.includes(real))) {
              leaking.push(m.toolName);
              if (opts.redactToolPayloads === true) {
                const replaced = replaceSensitiveText(m.text, sensitive);
                // 删除式 sensitiveMap 把整条 toolResult 滤成空串时降级 [redacted]
                //（对齐 applySensitiveInMessages 轮 15 #8）：空 text 出站若被拒收，
                // 错误会归因到调用方历史而非 redaction 自身
                m.text = m.text !== "" && replaced === "" ? "[redacted]" : replaced;
              }
            }
            continue;
          }
          if (m.role === "assistant") {
            for (const call of m.toolCalls ?? []) {
              // 先替换后比较（轮 16 #6）：以实际发生的替换为命中证据，检测与替换
              // 同域。旧 JSON.stringify(args).includes(real) 与文本替换域不一致：
              // real 含引号/反斜杠/换行时串化转义后失配（既漏报也无告警）；命中
              // 键名或 number 值时反向谎报「已占位」而明文仍出站
              const before = JSON.stringify(call.args);
              const redacted = replaceSensitiveDeep(call.args, sensitive);
              if (JSON.stringify(redacted) !== before) {
                leaking.push(`${call.name}.args`);
                if (opts.redactToolPayloads === true) {
                  call.args = redacted;
                }
              }
            }
          }
        }
        if (leaking.length > 0) {
          // 同名工具多轮命中的去重（轮 16 #9）：WARNING 列表出现重复项只伤可读性
          const names = [...new Set(leaking)].join(", ");
          if (opts.redactToolPayloads === true) {
            this.deps.log(`[llm] 工具载荷(${names}) 敏感值已占位（redactToolPayloads）`);
          } else {
            this.deps.log(
              `[llm] WARNING: 工具载荷(${names}) 包含敏感值，将以明文出站（toolResult/args 不在占位范围，redactToolPayloads:true 可阻断；P4 接 SecretProvider 时收口）`,
            );
          }
        }
      }

      let textRetries = 0;
      let noActionRetried = false;
      for (;;) {
        // 2+3. 组装请求（承重墙在此分支）并经退避层发送
        const response = await this.callWithBackoff(() =>
          this.buildChatRequest(systemPrompt, work, tool, controller.signal, httpTimeoutMs),
        );

        // 4. 解析优先级：目标工具调用 → 文本 JSON 兜底 → R4 → R1
        const call = response.toolCalls.find((c) => c.name === tool.name);
        // 纵深防御（评审轮 8 注明）：getAction 恒发 tools=[tool]，适配器层已按
        // requestedNames 过滤+告警非请求名调用——正常路径 dropped 恒空；此处兜
        // 未来适配器不做上游过滤的形态，多调用响应只取其一时留 WARNING 证据
        const dropped = response.toolCalls.filter((c) => c.name !== tool.name);
        if (dropped.length > 0) {
          const names = dropped.map((c) => c.name).join(", ");
          this.deps.log(`[llm] getAction 丢弃非目标工具调用：${names}（目标 ${tool.name}）`);
        }
        if (call !== undefined) {
          return this.okResult(call.args, urlMap, sensitive, response.usage);
        }
        if (response.text.trim() !== "") {
          const parsed = tryParseJson(response.text);
          // Python `if parsed:` 语义：空对象 {} 视为解析失败（落 R4）
          if (parsed !== undefined && Object.keys(parsed).length > 0) {
            return this.okResult(parsed, urlMap, sensitive, response.usage);
          }
          if (textRetries >= TEXT_RETRY_MAX) {
            this.deps.log(
              `[llm] LLM returned text (not tool_use) ${textRetries + 1} times — returning empty for step-level retry ladder`,
            );
            return { kind: "empty" };
          }
          textRetries += 1;
          this.deps.log(
            `[llm] LLM returned text (not tool_use), retrying with directive prompt (${textRetries}/${TEXT_RETRY_MAX})`,
          );
          // 回显文本复用敏感值占位（Python R4 经递归 get_action 重跑
          // _filter_sensitive_in_messages，TS 循环结构需手动对齐 parity）；
          // 不重跑 URL 缩写——其 tag 计数器独立，重跑会与既有 urlMap 的 [uN]
          // 冲突导致还原错乱（保守偏离，回显中的新 URL 保持全量无正确性问题）
          const echo = replaceSensitiveText(response.text, sensitive);
          // 删除式 sensitiveMap 可把回显整体滤空：降级 [redacted]（对齐
          // applySensitiveInMessages 轮 15 #8）——空文本块在适配器入口
          // assertValidMessages 抛违例、错误归因到调用方历史，且 LLMError 会先
          // 烧一次 fallback 单向切换（轮 16 #14）
          work.push({
            role: "assistant",
            blocks: [{ kind: "text", text: echo !== "" ? echo : "[redacted]" }],
          });
          work.push({ role: "user", blocks: [{ kind: "text", text: r4Directive(tool.name) }] });
          continue;
        }
        this.deps.log(
          `[llm] LLM returned no parseable response (stopReason=${response.stopReason}, outputTokens=${response.usage?.outputTokens ?? "n/a"}, toolCalls=${response.toolCalls.length})`,
        );
        if (!noActionRetried) {
          noActionRetried = true;
          work.push({ role: "user", blocks: [{ kind: "text", text: r1Directive(tool.name) }] });
          continue;
        }
        this.deps.log("[llm] LLM still returned no parseable response after retry");
        return { kind: "empty" };
      }
    } catch (e) {
      // 外部取消优先分类：外部 abort 先发生、deadline 恰在异常 unwind 期间到点时
      // windowExpired 已翻 true，会把取消变形为 LLMTimeoutError（#186 不变形契约）。
      // 二者竞态同时触发时按外部取消处理（穿透原样上抛）
      if (isAbortError(e) && windowExpired && !external?.aborted) {
        throw new LLMTimeoutError(
          `getAction 窗口预算到期（deadline=${deadlineAt !== undefined ? Math.round(deadlineAt) : "?"}ms）`,
          { provider: this.config.name, cause: e },
        );
      }
      throw e; // 外部取消穿透，不吞、不变形（#186 教训）；其余异常原样上抛
    } finally {
      watchCancel.abort(); // 取消 deadline watcher（真实时钟下不留悬挂定时器）
      external?.removeEventListener("abort", onExternalAbort);
    }
  }

  testConnection(): Promise<{ ok: boolean; error?: string; model?: string }> {
    // 委托当前 provider（含 10s 探测兜底超时与统一的成败包装）；fallback 切换后跟随新卡
    return this.provider.testConnection();
  }

  private okResult(
    toolInput: Record<string, unknown>,
    urlMap: Map<string, string>,
    sensitive: Record<string, string> | undefined,
    usage: TokenUsage | null,
  ): GetActionResult {
    // 还原顺序与请求侧**同序**（先 URL 后敏感值）——对齐 Python get_action（:612-617），
    // 刻意不取严格互逆：若占位符恰为某已映射长 URL 的子串，同序会把 URL 内的占位符
    // 片段二次替换（URL 污染），但该碰撞极罕见且 Python 同款行为是 P5 parity 基准
    const restored = restoreSensitiveInOutput(restoreUrlsInOutput(toolInput, urlMap), sensitive);
    return { kind: "ok", toolInput: restored, usage };
  }

  /** 组装 ChatRequest；fallback 切到无视觉模型后滤图（幂等，「从此不带图」） */
  private buildChatRequest(
    systemPrompt: string,
    work: ChatMessage[],
    tool: ToolDefinition,
    signal: AbortSignal,
    httpTimeoutMs: number | undefined,
  ): ChatRequest {
    // 滤图条件（评审轮 4 修订，03 §4 偏离 9）：
    // - 当前卡（主/fallback 皆可）**显式声明** supportsVision=false → 恒滤——声明即生效，
    //   文本主卡（glm-5.1 等）显式配 false 即受静默致盲保护；
    // - 未声明 → 仅 fallback 切换后按白名单推导滤（Python _strip_image_blocks 同款）——
    //   白名单外主卡（qwen-vl/gpt-4o 等真视觉模型缺省推导 false）不被误滤
    // 致盲可观测（轮 13 #9，对称于滤图 WARNING）：未声明主卡被白名单推导为无视觉
    // 却仍带图出站——P0 实测的「静默致盲」缺省形态复活时留一次提示（独立去重
    // 标志，勿与滤图告警混用）；不挑战「未声明不滤」的偏离 9 取舍本身
    if (
      this.config.capabilities?.supportsVision === undefined &&
      !this.usingFallback &&
      !this.provider.capabilities.supportsVision &&
      !this.loggedBlindImageSend &&
      hasImageBlocks(work)
    ) {
      this.loggedBlindImageSend = true;
      this.deps.log(
        `[llm] WARNING: 正在向推导为无视觉的主卡（${this.config.name}）发送图片块——文本卡请显式声明 supportsVision:false 启用滤图，真视觉卡请声明 true`,
      );
    }
    if (
      this.config.capabilities?.supportsVision === false ||
      (this.usingFallback && !this.provider.capabilities.supportsVision)
    ) {
      // 滤图零观测会掩盖能力静默降级：图片确实被滤时留一次 WARNING（实例级去重，
      // 截图型 agent 逐步带图不逐请求刷屏）——白名单外真视觉卡误滤时宿主有迹可循
      if (!this.loggedImageFilter && hasImageBlocks(work)) {
        this.loggedImageFilter = true;
        this.deps.log(
          `[llm] WARNING: 滤图生效（${this.config.name} 判定无视觉能力）——图片块将不出站，若为真视觉卡请显式声明 supportsVision:true`,
        );
      }
      stripImageBlocks(work);
    }
    const caps = this.provider.capabilities;
    let sys = systemPrompt;
    let tools: ToolDefinition[] | null = null;
    let toolChoice: ToolChoice | undefined;
    if (caps.supportsTools) {
      tools = [tool];
      if (caps.supportsForcedTool) {
        toolChoice = { kind: "forced", name: tool.name };
      } else {
        sys += forcedToolConstraint(tool.name);
      }
    } else {
      sys += noToolsConstraint(tool);
    }
    return {
      systemPrompt: sys,
      messages: work,
      tools,
      toolChoice,
      signal,
      // 无梯子 deadline 时的单请求兜底超时（undefined = 由 ladder signal 强杀）
      timeoutMs: httpTimeoutMs,
    };
  }

  /**
   * 请求 + 基建错误退避（Python _create_with_backoff）。语义要点：
   * - fallback 切换不占退避名额（review4 #3），单向锁至多一次，可跨协议整卡切换；
   * - 非 infra（auth/4xx/5xx）也允许触发切换（Python 外层 except APIError 同语义）；
   * - retry-after（已在 http 层封顶 60s）覆盖指数值；指数 = min(30, 2×2^retries)；
   * - 墙钟预算（含请求耗时）只 gate sleep 起点：超预算立即抛**最后错误**（类型不变，
   *   Python 同款）；在飞请求的到点强杀由 getAction 的 ladder signal 负责。
   */
  private async callWithBackoff(buildReq: () => ChatRequest): Promise<ChatResponse> {
    // 预算作用域（轮 13 #11）：每次 callWithBackoff 调用（R4/R1 梯子的每一轮
    // 请求）独立计账——梯子总退避墙钟可达 预算×轮数，仅由 ladder deadline
    //（timeoutMs/setCallWindow）封顶（Python parity，梯子多轮重置为有意）
    const capMs = this.windowBudgetCapMs ?? INFRA_BUDGET_DEFAULT_SEC * 1000;
    const budgetDeadline = this.deps.now() + capMs;
    let deadline = budgetDeadline;
    if (this.windowDeadline !== undefined) {
      deadline = Math.min(deadline, this.windowDeadline);
    }
    let retries = 0;
    for (;;) {
      const req = buildReq();
      try {
        return await this.provider.chat(req);
      } catch (e) {
        // ladder/外部 signal 已中止：下层任何分型（如错误响应体读取阶段的 abort 被
        // http 层吞成状态码 LLMError——429 假象会误触发 fallback 单向切换并多发一次
        // 注定失败的请求）都还原为取消原样上抛（#186 取消穿透契约）；ladder deadline
        // 场景由 getAction 的 catch 统一转 LLMTimeoutError，类型不变
        if (req.signal?.aborted) {
          throw req.signal.reason ?? new DOMException("Aborted", "AbortError");
        }
        if (!(e instanceof LLMError)) {
          throw e; // 外部取消（AbortError）/ 编程错误原样穿透
        }
        if (this.trySwitchToFallback(e)) {
          continue; // buildReq 每轮重建：切换后取新 model/maxTokens/capabilities
        }
        if (!isInfraError(e)) {
          throw e;
        }
        if (retries >= INFRA_RETRY_MAX) {
          throw e;
        }
        const delayMs =
          e.retryAfterMs ??
          Math.min(INFRA_BACKOFF_CAP_SEC, INFRA_BACKOFF_BASE_SEC * 2 ** retries) * 1000;
        if (this.deps.now() + delayMs > deadline) {
          // 归因实际生效的约束（轮 12 #15）：deadline = min(预算, 窗口)，固定打印
          // capMs 会把窗口先到的耗尽误导成预算记账错误
          const boundByWindow =
            this.windowDeadline !== undefined && this.windowDeadline < budgetDeadline;
          this.deps.log(
            `[llm] LLM infra backoff ${boundByWindow ? "window deadline" : `budget (${Math.round(capMs / 1000)}s wall-clock incl. requests)`} exhausted after ${retries} retry(ies) — raising ${e.name}`,
          );
          throw e;
        }
        this.deps.log(
          `[llm] LLM ${e.name} (retry ${retries + 1}/${INFRA_RETRY_MAX}) — backing off ${(delayMs / 1000).toFixed(1)}s`,
        );
        retries += 1;
        await this.deps.sleep(delayMs, req.signal);
      }
    }
  }

  /** 单向切换到 fallback 整卡（可跨协议）；无 fallback / 已切换返回 false */
  private trySwitchToFallback(err: LLMError): boolean {
    if (this.usingFallback || this.fallbackConfig === null) {
      return false;
    }
    // 协议违例不触发切换（轮 17 #9，Python parity）：2xx 畸形响应体在 Python SDK
    // 抛 APIResponseValidationError（非 APIError 子类），_create_with_backoff 的
    // except (RateLimitError, APIConnectionError) 与外层 except (RateLimitError,
    // APIError) 均不捕获——瞬时网关抖动（200 + HTML 错误页）一次性烧掉单向切换、
    // 此后全部流量落到可能更弱的 fallback 卡，是 TS 侧此前未登记的偏离；canonical
    // 校验违例（调用方消息问题）换卡同样无济于事。不切换也不退避（非 infra），
    // 直接上抛与 Python 一致
    if (err instanceof LLMProtocolViolationError) {
      return false;
    }
    // 先在局部变量构造成功再统一提交——构造抛出时 this.config/provider 保持旧卡
    // 一致状态，后续复用实例的错误归因不会落到初始化已失败的 fallback 卡上
    let newProvider: LLMProvider;
    try {
      newProvider = createProvider(this.fallbackConfig, this.deps);
    } catch (switchErr) {
      // 保留根因：fallback 卡片构造失败（如反序列化来的非法 protocol）不能掩盖触发
      // 切换的原始错误——终点异常类型是 step 分罪依据，cause 挂原始 err
      throw new LLMInvalidRequestError(
        `fallback 卡片初始化失败（${this.fallbackConfig.name}）：${switchErr instanceof Error ? switchErr.message : String(switchErr)}`,
        { provider: this.fallbackConfig.name, cause: err },
      );
    }
    this.config = this.fallbackConfig;
    this.provider = newProvider;
    this.usingFallback = true;
    this.deps.log(
      `[llm] Switched to fallback LLM: ${this.config.model} (due to ${err.name}: ${err.message})`,
    );
    return true;
  }
}

/** 架构 §3.2 公共 API 的第一个函数 */
export function createLLMClient(config: ProviderConfig, deps?: LlmDeps): LLMClient {
  return new LLMClient(config, deps);
}
