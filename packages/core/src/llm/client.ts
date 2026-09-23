// LLMClient 行为层：getAction 状态机（解析梯子 R4/R1、URL 缩写/敏感值往返、
// 退避与预算、fallback 单向切换、滤图、承重墙）——移植自 tree_walker/llm/client.py
// 的 get_action/_create_with_backoff/_try_switch_to_fallback（03 文档，偏离清单见其 §4）。

import { createAnthropicProvider } from "./adapters/anthropic-messages.js";
import { createGeminiProvider } from "./adapters/gemini.js";
import { isAbortError } from "./adapters/http.js";
import { createOpenAICompletionsProvider } from "./adapters/openai-completions.js";
import type { ProviderConfig } from "./config.js";
import type { LlmDeps } from "./deps.js";
import { isInfraError, LLMError, LLMInvalidRequestError, LLMTimeoutError } from "./errors.js";
import type { LLMProvider } from "./provider.js";
import {
  applySensitiveInMessages,
  cloneWorkMessages,
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
/** 指数退避首次秒数（Python _RATE_LIMIT_BACKOFF_BASE：2,4,8,16,30,30…） */
const INFRA_BACKOFF_BASE_SEC = 2.0;
/** 指数退避单次上限（Python _RATE_LIMIT_BACKOFF_CAP） */
const INFRA_BACKOFF_CAP_SEC = 30.0;
/** 退避墙钟总预算缺省（Python _RATE_LIMIT_BUDGET_MAX；含请求耗时） */
const INFRA_BUDGET_DEFAULT_SEC = 90.0;
/** 窗口派生预算下限（Python set_llm_window 的 max(30.0, t*0.75)） */
const WINDOW_BUDGET_FLOOR_MS = 30_000;

export interface GetActionOptions {
  /** 敏感值表：真实值 → 占位符。请求侧替换、响应 toolInput 还原（03 §3.3） */
  sensitiveMap?: Record<string, string>;
  /**
   * 本次 getAction 的墙钟预算（毫秒）。梯子内全部请求与 sleep 共享。
   * 调用契约：无 timeoutMs 且未 setCallWindow 时梯子**无内部时长上界**（对齐
   * Python get_action——上界由 step 层的外层 wait_for 提供）；P4 step 恒传。
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
      reject(new DOMException("Aborted", "AbortError"));
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

export class LLMClient {
  private config: ProviderConfig;
  private provider: LLMProvider;
  private readonly fallbackConfig: ProviderConfig | null;
  private usingFallback = false;
  /** setCallWindow 登记的步级共享 deadline（deps.now 域，毫秒） */
  private windowDeadline: number | undefined;
  private windowBudgetCapMs: number | undefined;
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
    this.windowBudgetCapMs = Math.max(WINDOW_BUDGET_FLOOR_MS, timeoutMs * 0.75);
  }

  async getAction(
    systemPrompt: string,
    messages: ChatMessage[],
    tool: ToolDefinition,
    opts: GetActionOptions = {},
  ): Promise<GetActionResult> {
    assertValidMessages(messages, this.config.name);

    // 0. ladder deadline = min(opts.timeoutMs 派生, 窗口 deadline)；到点 abort 在飞请求与
    // sleep，终点恒 LLMTimeoutError（03 偏离 5：结构性消除 wait_for 异常变形的 #194 死法）
    const now = this.deps.now();
    let deadlineAt: number | undefined =
      opts.timeoutMs !== undefined ? now + opts.timeoutMs : undefined;
    if (this.windowDeadline !== undefined) {
      deadlineAt =
        deadlineAt === undefined ? this.windowDeadline : Math.min(deadlineAt, this.windowDeadline);
    }
    const external = opts.signal;
    const controller = new AbortController();
    let windowExpired = false;
    const onExternalAbort = () => controller.abort();
    if (external !== undefined) {
      if (external.aborted) {
        controller.abort();
      } else {
        external.addEventListener("abort", onExternalAbort, { once: true });
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (deadlineAt !== undefined) {
      timer = setTimeout(
        () => {
          windowExpired = true;
          controller.abort();
        },
        Math.max(0, deadlineAt - now),
      );
    }

    try {
      // 1. 请求侧变换：全部落在 work 副本（03 偏离 1：不原地改调用方消息）
      const work = cloneWorkMessages(messages);
      const urlMap = shortenUrlsInMessages(work);
      const sensitive = opts.sensitiveMap;
      applySensitiveInMessages(work, sensitive);

      let textRetries = 0;
      let noActionRetried = false;
      for (;;) {
        // 2+3. 组装请求（承重墙在此分支）并经退避层发送
        const response = await this.callWithBackoff(() =>
          this.buildChatRequest(systemPrompt, work, tool, controller.signal),
        );

        // 4. 解析优先级：目标工具调用 → 文本 JSON 兜底 → R4 → R1
        const call = response.toolCalls.find((c) => c.name === tool.name);
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
          work.push({ role: "assistant", blocks: [{ kind: "text", text: response.text }] });
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
      if (isAbortError(e) && windowExpired) {
        throw new LLMTimeoutError(
          `getAction 窗口预算到期（deadline=${deadlineAt !== undefined ? Math.round(deadlineAt) : "?"}ms）`,
          { provider: this.config.name, cause: e },
        );
      }
      throw e; // 外部取消穿透，不吞、不变形（#186 教训）；其余异常原样上抛
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
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
    // 还原顺序与请求侧互逆：先 URL 后敏感值（Python get_action 同序）
    const restored = restoreSensitiveInOutput(restoreUrlsInOutput(toolInput, urlMap), sensitive);
    return { kind: "ok", toolInput: restored, usage };
  }

  /** 组装 ChatRequest；fallback 切到无视觉模型后滤图（幂等，「从此不带图」） */
  private buildChatRequest(
    systemPrompt: string,
    work: ChatMessage[],
    tool: ToolDefinition,
    signal: AbortSignal,
  ): ChatRequest {
    if (this.usingFallback && !this.provider.capabilities.supportsVision) {
      stripImageBlocks(work, this.config.name);
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
    return { systemPrompt: sys, messages: work, tools, toolChoice, signal };
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
    const capMs = this.windowBudgetCapMs ?? INFRA_BUDGET_DEFAULT_SEC * 1000;
    let deadline = this.deps.now() + capMs;
    if (this.windowDeadline !== undefined) {
      deadline = Math.min(deadline, this.windowDeadline);
    }
    let retries = 0;
    for (;;) {
      const req = buildReq();
      try {
        return await this.provider.chat(req);
      } catch (e) {
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
          this.deps.log(
            `[llm] LLM infra backoff budget (${Math.round(capMs / 1000)}s wall-clock incl. requests) exhausted after ${retries} retry(ies) — raising ${e.name}`,
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
    this.config = this.fallbackConfig;
    this.provider = createProvider(this.config, this.deps);
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
