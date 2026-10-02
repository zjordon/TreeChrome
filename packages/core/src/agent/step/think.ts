// Stage 2 Think：_get_next_action（:796-929）+ 双梯（#197 外梯形状澄清 2 次/
// 内梯参数校验 3 次共用预算，第二次起去图）+ done 完整性门禁（#186 现象②）+
// 动作数硬截断。超时结构：步级 llmTimeout 以 AbortSignal 包住**整个梯子**
//（Python asyncio.wait_for(_get_action_with_retry(...))）；门禁内层按剩余额度
// 自带小超时，步级到点穿透（取消语义不吞——review4 #1）。

import { modelCallEvent, modelResultEvent } from "../../events/events.js";
import type { ChatMessage, TokenUsage, ToolDefinition } from "../../llm/types.js";
import { validateParams } from "../../tools/models.js";
import {
  describeActionEntry,
  isHonestFailureAction,
  isRecord,
  nameOf,
  normalizeModelOutput,
  paramsOf,
} from "../action-shape.js";
import {
  DONE_GATE_MAX_PER_RUN,
  DONE_GATE_RETRY_TIMEOUT_S,
  describeResponseAction,
  fallbackDoneOutput,
  INVALID_ACTION_MAX_RETRIES,
  invalidActionFeedback,
  PARAM_VALIDATION_MAX_RETRIES,
  scanUncertaintyKeywords,
  scanUncertaintyMarkers,
} from "../constants.js";
import type { ModelOutput } from "../views.js";
import { redactSensitiveString, SENSITIVE_ACTION_FIELDS } from "../views.js";
import { type StepCtx, StepTimeoutError, type ThinkResult } from "./context.js";
import { copyMessagesWithoutImages, realTimer, stripEnvelope } from "./pipeline.js";

function toolDef(ctx: StepCtx): ToolDefinition {
  const schema = ctx.toolSchema as { name?: string; description?: string; input_schema?: unknown };
  return {
    name: String(schema.name ?? "agent_response"),
    description: String(schema.description ?? ""),
    parameters: (schema.input_schema ?? {}) as Record<string, unknown>,
  };
}

/** 步级超时（Python asyncio.TimeoutError 文案）；到点先于任何 catch 穿透 */
class GateTimeoutError extends Error {}

/**
 * 梯子输出的「响应 + 用量」对（Python response dict 自带 usage 键的等价形态）：
 * 每次重试整体覆盖（最终那次调用的用量——Python 每轮覆盖 response 的同语义）；
 * fallback done 是合成产物无用量（null，Python fallback dict 无 usage 键同款）。
 */
interface LlmOutput {
  output: ModelOutput;
  usage: TokenUsage | null;
}

async function callLlm(
  ctx: StepCtx,
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<LlmOutput> {
  const result = await ctx.llm.getAction(ctx.systemPrompt, messages, toolDef(ctx), {
    signal,
    sensitiveMap: ctx.sensitiveMapForGetAction ?? undefined,
  });
  const raw = result.kind === "ok" ? (result.toolInput as unknown) : {};
  return {
    output: normalizeLLMResponse(ctx, raw),
    // empty 形态的用量在 lastUsage（若梯子全程 empty，事件显示 ?+? 与 Python
    // usage None 同款）；ok 直取
    usage: result.kind === "ok" ? result.usage : (result.lastUsage ?? null),
  };
}

export async function getNextAction(ctx: StepCtx): Promise<ThinkResult | null> {
  const trimmed = trimMessages(ctx);

  let modelCallId = "";
  if (ctx.obsBus !== null) {
    modelCallId = randomId();
    ctx.obsBus.emit(
      modelCallEvent(ctx.state.nSteps, ctx.obsSessionId, {
        modelCallId,
        messageCount: trimmed.length,
      }),
    );
  }

  // #194 review3：wait_for 起点登记步级退避窗口（梯子内所有 L2 退避共享 deadline）
  ctx.llm.setCallWindow(ctx.settings.llmTimeout * 1000);
  const controller = new AbortController();
  const timer = realTimer(ctx.settings.llmTimeout * 1000, () =>
    controller.abort(new StepTimeoutError("step-timer")),
  );
  let output: ModelOutput;
  let usage: TokenUsage | null;
  try {
    ({ output, usage } = await getActionWithRetry(ctx, trimmed, controller.signal));
  } catch (e) {
    if (controller.signal.aborted) {
      throw new StepTimeoutError(
        `LLM call timed out after ${ctx.settings.llmTimeout}s. Keep your output concise.`,
      );
    }
    throw e;
  } finally {
    timer.cancel();
  }

  // P0-1 post-LLM stop 检查 #1：丢弃输出（无事件发射/历史追加）短路
  if (ctx.state.stopped || ctx.state.paused) {
    return null;
  }

  // 动作数硬截断（schema maxItems 只是「告知」，此处是运行时兜底）
  output = truncateActions(ctx, output);

  // P0-1 post-LLM stop 检查 #2（提交消息前）——返回响应交由 Act 阶段 stop 守卫拦执行
  const assistantContent =
    `[${typeof output.evaluation_previous_goal === "string" ? output.evaluation_previous_goal : ""}] ` +
    `Goal: ${typeof output.next_goal === "string" ? output.next_goal : ""} | ` +
    `Action: ${nameOf(output.action) ?? "unknown"}`;
  if (ctx.state.stopped || ctx.state.paused) {
    return { output, usage };
  }
  ctx.messages.push({
    kind: "plain",
    message: { role: "assistant", blocks: [{ kind: "text", text: assistantContent }] },
  });

  if (ctx.obsBus !== null) {
    ctx.obsBus.emit(
      modelResultEvent(ctx.state.nSteps, ctx.obsSessionId, {
        modelCallId,
        actionName: String(nameOf(output.action) ?? ""),
        nextGoal: typeof output.next_goal === "string" ? output.next_goal : "",
        // P6 后续 I2 等价接线（Python step.py:864-876）：最终那次调用的用量
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
      }),
    );
  }

  // 决策日志脱敏（params 已被 client 还原为真值——只影响日志，执行用真值）
  const actionName = String(nameOf(output.action) ?? "unknown");
  const actionParams = paramsOf(output.action) as Record<string, unknown>;
  const safeParams = redactParamsForLog(actionName, actionParams, sensitiveMapForLog(ctx));
  ctx.log(`  ↳ decision: ${actionName} ${JSON.stringify(safeParams)}`);

  ctx.currentModelCallId = modelCallId;
  return { output, usage };
}

function randomId(): string {
  return Math.random().toString(16).slice(2, 10);
}

/** {placeholder: real} 方向（Agent 维护的是反向 {real: placeholder}，惰性反转） */
export function sensitiveMapForLog(ctx: StepCtx): Record<string, string> | null {
  const raw = ctx.sensitiveMap;
  if (raw === null || Object.keys(raw).length === 0) return null;
  return Object.fromEntries(Object.entries(raw).map(([real, placeholder]) => [placeholder, real]));
}

export function normalizeLLMResponse(ctx: StepCtx, response: unknown): ModelOutput {
  if (!isRecord(response)) return response as ModelOutput;
  const knownNames = new Set(ctx.tools.registry.actions.keys());
  return normalizeModelOutput(response as ModelOutput, { context: "live", knownNames });
}

export function truncateActions(ctx: StepCtx, response: ModelOutput): ModelOutput {
  const actions = response.actions;
  if (!Array.isArray(actions) || actions.length <= ctx.settings.maxActionsPerStep) {
    return response;
  }
  const kept = actions.slice(0, ctx.settings.maxActionsPerStep);
  const dropped = actions.slice(ctx.settings.maxActionsPerStep);
  const droppedNames = dropped
    .filter((a) => isRecord(a))
    .map((a) => String((a as Record<string, unknown>).name ?? "?"));
  ctx.log(
    `Step ${ctx.state.nSteps}: LLM emitted ${actions.length} actions ` +
      `(max ${ctx.settings.maxActionsPerStep}) — truncated, dropped: ${droppedNames.join(", ")}`,
  );
  return { ...response, actions: kept, action: kept[0] ?? response.action ?? {} };
}

/** 形状判定（不做类型收窄——ModelOutput 的否定分支需可达） */
function isValidAction(response: unknown): boolean {
  if (!isRecord(response)) return false;
  const action = response.action;
  if (!isRecord(action)) return false;
  const name = action.name;
  return typeof name === "string" && name !== "";
}

/** 外梯：首调 → 形状定向澄清 2 次（第二次去图）→ fallback done */
export async function getActionWithRetry(
  ctx: StepCtx,
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<LlmOutput> {
  let wrapped = await callLlm(ctx, messages, signal);
  if (isValidAction(wrapped.output)) {
    return gateUncertainSuccessDone(
      ctx,
      await validateParamsOrRetry(ctx, wrapped, messages, signal),
      messages,
      signal,
    );
  }
  for (let attempt = 0; attempt < INVALID_ACTION_MAX_RETRIES; attempt++) {
    // #197：第二次澄清降级去图（拷贝——原地滤图经共享引用泄漏回原消息）
    const degrade = attempt >= 1;
    const base = degrade ? copyMessagesWithoutImages(messages) : messages;
    ctx.log(
      `LLM returned empty action (${describeResponseAction(wrapped.output)}), ` +
        `retrying with clarification (${attempt + 1}/${INVALID_ACTION_MAX_RETRIES})` +
        (degrade ? " — text-only (screenshot dropped)" : ""),
    );
    const retryMessages: ChatMessage[] = [
      ...base,
      { role: "user", blocks: [{ kind: "text", text: invalidActionFeedback(wrapped.output) }] },
    ];
    wrapped = await callLlm(ctx, retryMessages, signal);
    if (isValidAction(wrapped.output)) {
      return gateUncertainSuccessDone(
        ctx,
        await validateParamsOrRetry(ctx, wrapped, messages, signal),
        messages,
        signal,
      );
    }
  }
  ctx.log(
    `LLM still returned empty action after ${INVALID_ACTION_MAX_RETRIES} retries, using fallback done`,
  );
  return { output: fallbackDoneOutput(), usage: null };
}

/** done(success=True) 携带未消解不确定标记 → 一次验证重试（每 run 封顶） */
export async function gateUncertainSuccessDone(
  ctx: StepCtx,
  wrapped: LlmOutput,
  messages: ChatMessage[],
  stepSignal: AbortSignal,
): Promise<LlmOutput> {
  const response = wrapped.output;
  const action = isRecord(response.action) ? response.action : null;
  if (action === null || nameOf(action) !== "done") return wrapped;
  if (isHonestFailureAction(action)) return wrapped;
  const params = paramsOf(action);
  // review2 #2：镜像 pydantic lax 强转语义再判定（"success": "true" 字符串）
  let rawSuccess: unknown = params.success !== undefined ? params.success : true;
  if (typeof rawSuccess === "string") {
    rawSuccess = ["true", "t", "yes", "y", "on", "1"].includes(rawSuccess.trim().toLowerCase());
  }
  if (!rawSuccess) return wrapped;
  if (!ctx.settings.doneUncertaintyGate) return wrapped;
  if (ctx.state.doneGateUses >= DONE_GATE_MAX_PER_RUN) return wrapped;
  // review4 #3：text 只扫关键词；词尾 ? 仅对自评字段（evaluation/memory）生效
  const evalText =
    typeof response.evaluation_previous_goal === "string" ? response.evaluation_previous_goal : "";
  const memText = typeof response.memory === "string" ? response.memory : "";
  const textParam = typeof params.text === "string" ? params.text : "";
  // Python `or`（空列表 falsy）语义：自评无命中才扫 text 关键词——JS [] 恒真，
  // `||` 会让右侧永不执行（done.text 的 not sure 等关键词漏检）
  const markerHits = scanUncertaintyMarkers(evalText, memText);
  const hits = markerHits.length > 0 ? markerHits : scanUncertaintyKeywords(textParam);
  if (hits.length === 0) return wrapped;
  ctx.state.doneGateUses += 1;
  ctx.log(
    `done(success=True) with unresolved uncertainty markers ${hits.join(", ")} — ` +
      `verification retry (${ctx.state.doneGateUses}/${DONE_GATE_MAX_PER_RUN})`,
  );
  const feedback =
    "Your own evaluation/memory contains unresolved uncertainty " +
    `(matched: ${hits.map((h) => `'${h}'`).join(", ")}). You are about to ` +
    "call done(success=true) on incomplete data. Either (a) verify the " +
    "missing pieces with tools first, or (b) call done(success=false) " +
    "describing exactly what was accomplished and what remains " +
    "unverified. Do NOT restate done(success=true) while the same " +
    "markers remain unresolved.";
  const retryMessages: ChatMessage[] = [
    ...messages,
    { role: "user", blocks: [{ kind: "text", text: feedback }] },
  ];
  let retried: LlmOutput;
  try {
    // review5 #1：内层按剩余额度取小（绝对 60s 会让外层先到期，合法 done 变失败步）
    const elapsed = (ctx.now() - ctx.stepStartTime) / 1000;
    const retryTimeoutS = Math.max(
      0,
      Math.min(DONE_GATE_RETRY_TIMEOUT_S, ctx.settings.llmTimeout - elapsed),
    );
    const gateCtl = new AbortController();
    const gateTimer = realTimer(retryTimeoutS * 1000, () =>
      gateCtl.abort(new GateTimeoutError("gate")),
    );
    const combined = AbortSignal.any ? AbortSignal.any([stepSignal, gateCtl.signal]) : stepSignal;
    try {
      retried = await callLlm(ctx, retryMessages, combined);
    } finally {
      gateTimer.cancel();
    }
  } catch (e) {
    if (stepSignal.aborted) {
      // 步级到点穿透（取消语义不吞——review4 #1）
      throw new StepTimeoutError(
        `LLM call timed out after ${ctx.settings.llmTimeout}s. Keep your output concise.`,
      );
    }
    // 门禁自身小超时/调用异常：预算回滚放行原响应（软干预不得把合法 done 变失败步）
    ctx.state.doneGateUses -= 1;
    ctx.log(
      `done-gate verification retry failed (${e instanceof Error ? e.constructor.name : String(e)}) — passing through original response (budget rolled back)`,
    );
    return wrapped;
  }
  if (!isValidAction(retried.output)) return wrapped;
  if (validateActionParams(ctx, retried.output) !== null) return wrapped;
  return retried;
}

/** 内梯：参数校验 3 次（无效动作与参数错共用预算；形状澄清第二次起去图） */
export async function validateParamsOrRetry(
  ctx: StepCtx,
  wrapped: LlmOutput,
  originalMessages: ChatMessage[],
  signal: AbortSignal,
): Promise<LlmOutput> {
  let response = wrapped.output;
  let usage = wrapped.usage;
  let paramError = validateActionParams(ctx, response);
  if (paramError === null) return wrapped;

  let invalidActionSeen = 0;
  for (let attempt = 0; attempt < PARAM_VALIDATION_MAX_RETRIES; attempt++) {
    let feedback: string;
    let base: ChatMessage[];
    if (isValidAction(response)) {
      ctx.log(
        `Invalid params for '${String(nameOf(response.action ?? {}))}': ${paramError} — ` +
          `retrying (${attempt + 1}/${PARAM_VALIDATION_MAX_RETRIES})`,
      );
      feedback =
        `Your action parameters are invalid: ${paramError}. ` +
        "Please fix the parameters and respond again with a valid action.";
      base = originalMessages; // 参数反馈恒不去图（修 index/url 需要页面视觉）
    } else {
      // P0-B：重试退化成无名字动作——外梯同款澄清（共用预算）
      invalidActionSeen += 1;
      const degrade = invalidActionSeen >= 2;
      ctx.log(
        `LLM returned invalid action during param validation retry ` +
          `(${describeActionEntry(isRecord(response) ? response.action : undefined)}) — ` +
          `clarifying (${attempt + 1}/${PARAM_VALIDATION_MAX_RETRIES})` +
          (degrade ? " — text-only (screenshot dropped)" : ""),
      );
      feedback = invalidActionFeedback(response);
      base = degrade ? copyMessagesWithoutImages(originalMessages) : originalMessages;
    }
    const retryMessages: ChatMessage[] = [
      ...base,
      { role: "user", blocks: [{ kind: "text", text: feedback }] },
    ];
    const retried = await callLlm(ctx, retryMessages, signal);
    response = retried.output;
    usage = retried.usage;

    if (isValidAction(response)) {
      paramError = validateActionParams(ctx, response);
      if (paramError === null) return { output: response, usage };
    }
  }

  if (!isValidAction(response)) {
    ctx.log(
      `LLM still returned invalid action after ${PARAM_VALIDATION_MAX_RETRIES} ` +
        "param-validation retries — fallback done",
    );
    return { output: fallbackDoneOutput(), usage: null };
  }
  ctx.log(
    `Params still invalid after ${PARAM_VALIDATION_MAX_RETRIES} retries: ${paramError} — proceeding anyway`,
  );
  return { output: response, usage };
}

/** registry paramModel + _flattenParams 同源校验；返回 null=有效或错误串 */
export function validateActionParams(ctx: StepCtx, response: ModelOutput): string | null {
  const action = isRecord(response.action) ? response.action : {};
  // review6 #3：诚实失败 done 跳过校验立即执行（variant B 会拒绝其 text 参数）
  if (isHonestFailureAction(action)) return null;
  const name = String(nameOf(action) ?? "");
  const params = paramsOf(action);

  const registered = ctx.tools.registry.actions.get(name);
  if (registered === undefined) {
    // review3 #3：未注册名也进澄清-重试梯
    return `Unknown action '${name}'`;
  }
  const flat = ctx.tools.flattenParams(params as Record<string, unknown>, name);
  const result = validateParams(registered.params, flat);
  if (result.ok) return null;
  return result.errors.join("; ");
}

/** 消息裁剪（默认尾部 20；compactor 启用放宽 3×安全上限）+ 信封剥除 */
export function trimMessages(ctx: StepCtx): ChatMessage[] {
  const maxMessages = 20;
  let out: StepCtx["messages"];
  if (ctx.compactor !== null) {
    out =
      ctx.messages.length > maxMessages * 3
        ? ctx.messages.slice(-(maxMessages * 3))
        : [...ctx.messages];
  } else if (ctx.messages.length <= maxMessages) {
    out = [...ctx.messages];
  } else {
    out = ctx.messages.slice(-maxMessages);
  }
  return stripEnvelope(out);
}

/** 决策日志脱敏（只脱敏敏感字段，动作仍用真值执行） */
export function redactParamsForLog(
  actionName: string,
  params: Record<string, unknown>,
  sensitiveMap: Record<string, string> | null,
): Record<string, unknown> {
  if (sensitiveMap === null || Object.keys(sensitiveMap).length === 0) {
    return { ...params };
  }
  const fields = SENSITIVE_ACTION_FIELDS[actionName];
  if (!fields) return { ...params };
  const redacted = { ...params };
  for (const f of fields) {
    if (typeof redacted[f] === "string") {
      redacted[f] = redactSensitiveString(redacted[f] as string, sensitiveMap);
    }
  }
  return redacted;
}
