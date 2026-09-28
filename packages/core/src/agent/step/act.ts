// Stage 3 Act：_execute_actions（:1357-1597）——严格串行 + 五守卫（done 中段截断/
// is_done·error 截断/terminatesSequence/URL·target 漂移）+ per-action 超时与异常
// 分诊（InterruptedError·连接类 re-raise）+ actionability 等待 + streak 记录 +
// ToolCall/ToolResult 事件 + 权限门逐动作过门（4.5，架构 §5.3——denied 走 error
// 通道不计 consecutiveFailures）。

import type { BrowserStateSummary, EnhancedDOMTreeNode } from "../../browser/views.js";
import { toolCallEvent, toolResultEvent } from "../../events/events.js";
import { hostForAction, resolveCapability } from "../../policy/capability.js";
import { actionsOf, isRecord, nameOf, paramsOf } from "../action-shape.js";
import { ACTIONABILITY_ACTIONS, isFileInput, waitForActionability } from "../actionability.js";
import { InterruptedError } from "../constants.js";
import type { ModelOutput } from "../views.js";
import { ActionResult } from "../views.js";
import type { StepCtx } from "./context.js";
import { realTimer } from "./pipeline.js";
import { redactParamsForLog, sensitiveMapForLog } from "./think.js";

export async function executeActions(
  ctx: StepCtx,
  modelOutput: ModelOutput,
  browserState: BrowserStateSummary,
): Promise<ActionResult[]> {
  if (ctx.state.stopped || ctx.state.paused) {
    return [new ActionResult({ error: "Agent stopped or paused" })];
  }

  const actions = actionsOf(modelOutput);
  const total = actions.length;
  const results: ActionResult[] = [];

  for (const [i, action] of actions.entries()) {
    const actionName = String(nameOf(action) ?? "");
    const actionParams = paramsOf(action) as Record<string, unknown>;

    // Guard #1：done 只允许单动作——中段出现即截断（后续动作静默跳过）
    if (i > 0 && actionName === "done") {
      break;
    }

    // 反检测节奏：链式动作间等待（首个跳过）
    if (i > 0 && ctx.waitBetweenActionsS > 0) {
      await ctx.sleep(ctx.waitBetweenActionsS * 1000);
    }

    // P0-1：per-action stop/pause 检查（raise 直达 handleStepError Branch 1；
    // partial results 随 raise 丢弃——用户主动停=不要剩余结果）
    if (ctx.state.stopped || ctx.state.paused) {
      throw new InterruptedError();
    }

    // 决策日志脱敏（params 已还原真值——先脱敏再打印）
    const safeParams = redactParamsForLog(actionName, actionParams, sensitiveMapForLog(ctx));
    ctx.log(`  [${i + 1}/${total}] ${actionName}: ${JSON.stringify(safeParams)}`);

    const toolStart = ctx.now();
    // 元素几何（ToolCallEvent 与权限门确认卡共用；无 index/拿不到 node → null 字段）
    const geometry = actionElementGeometry(actionParams, browserState);
    let toolCallId = "";
    if (ctx.obsBus !== null) {
      toolCallId = Math.random().toString(16).slice(2, 10);
      ctx.obsBus.emit(
        toolCallEvent(ctx.state.nSteps, ctx.obsSessionId, {
          modelCallId: ctx.currentModelCallId,
          toolCallId,
          actionName: String(actionName ?? ""),
          params: actionParams,
          actionIndex: i,
          totalActions: total,
          elementIndex: geometry.elementIndex,
          elementBbox: geometry.elementBbox,
          elementXpath: geometry.elementXpath,
        }),
      );
    }

    // Guard #5 预采样：首动作用步起 URL（省一次 CDP），其后读新值
    let preActionUrl: string;
    if (i === 0) {
      preActionUrl = browserState.url;
    } else {
      try {
        preActionUrl = await ctx.browser.getCurrentUrl();
      } catch {
        preActionUrl = browserState.url;
      }
    }
    const preTargetId = ctx.browser.currentTargetId;

    // 权限门（4.5，架构 §5.3）：ToolCallEvent 之后、actionability 之前，逐动作。
    // 拒绝回流走 error 通道（Guard#2/#3 截断序列），不计 consecutiveFailures。
    let deniedResult: ActionResult | null = null;
    if (ctx.policy !== null) {
      const capability = resolveCapability(actionName, actionParams);
      if (capability !== "none") {
        const host = hostForAction(actionName, actionParams, preActionUrl);
        const outcome = await ctx.policy.check({
          capability,
          host,
          actionName,
          params: actionParams,
          tabId: preTargetId,
          elementIndex: geometry.elementIndex,
          elementBbox: geometry.elementBbox,
          elementXpath: geometry.elementXpath,
        });
        if (!outcome.allowed) {
          deniedResult = new ActionResult({
            success: false,
            denied: true,
            error: outcome.reason,
          });
          ctx.log(`  [${i + 1}/${total}] ${actionName}: policy denied — ${outcome.reason}`);
        }
      }
    }

    let result: ActionResult;
    if (deniedResult !== null) {
      result = deniedResult;
    } else {
      // P0 探索 actionability：白名单动作等元素就绪（降级不抛——超时/漂移照常执行）
      if (ctx.settings.explorationActionabilityCheck && ACTIONABILITY_ACTIONS.has(actionName)) {
        const idx = actionParams.index;
        const sm = browserState.domState ? browserState.domState.selectorMap : null;
        const node = sm && typeof idx === "number" ? (sm.get(idx) ?? null) : null;
        if (node !== null && !isFileInput(node) && typeof idx === "number") {
          const [newState] = await waitForActionability(ctx.browser, browserState, idx, {
            timeout: ctx.settings.explorationActionabilityTimeout,
            poll: ctx.settings.explorationActionabilityPoll,
            receivesEvents: ctx.settings.explorationActionabilityReceivesEvents,
            runtimeOcclusion: ctx.settings.explorationActionabilityRuntimeOcclusion,
            stable: ctx.settings.explorationActionabilityStable,
            stableInterval: ctx.settings.explorationActionabilityStableInterval,
            stableTolerance: ctx.settings.explorationActionabilityStableTolerance,
            sleep: ctx.sleep,
            now: ctx.now,
          });
          browserState.domState = newState.domState;
        }
      }

      // 单动作超时；InterruptedError/连接类 re-raise，其余包 error 停序列
      try {
        result = await withActionTimeout(
          ctx,
          ctx.tools.execute(actionName, actionParams, ctx.browser, browserState),
        );
      } catch (e) {
        if (e instanceof InterruptedError) throw e;
        if (isConnectionErrorLike(e)) throw e;
        ctx.log(
          `Action '${actionName}' raised ${e instanceof Error ? e.constructor.name : String(e)}: ${e instanceof Error ? e.message : String(e)}`,
        );
        result = new ActionResult({
          error: `${e instanceof Error ? e.constructor.name : String(e)}: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    results.push(result);

    if (deniedResult === null) {
      // #186 现象①：失败感知连败（多动作步内失败也计；成功即清零；done 豁免）——
      // 权限拒绝不在此列（04 §2：denied 不计 consecutiveFailures）
      ctx.failureStreak.record(actionName, result.error !== null);
      // #186-c2 形态②：零结果降级（query_total 旁路；展平前查注册表与 execute 同源）
      const known = ctx.tools.registry.actions.has(actionName);
      ctx.zeroResultStreak.record(
        actionName,
        known ? ctx.tools.flattenParams(actionParams, actionName) : actionParams,
        result,
      );
    }

    if (ctx.obsBus !== null && toolCallId !== "") {
      ctx.obsBus.emit(
        toolResultEvent(ctx.state.nSteps, ctx.obsSessionId, {
          toolCallId,
          success: result.success,
          error: result.error,
          durationSeconds: (ctx.now() - toolStart) / 1000,
          actionIndex: i,
          totalActions: total,
        }),
      );
    }

    // Guard #2/#3：is_done 或 error 终止序列（LLM 下一步看到失败/完成）
    if (result.isDone || result.error !== null || i === total - 1) {
      break;
    }

    // Guard #4：静态 terminatesSequence 标记（navigate/search/switch_tab/go_back/evaluate）
    const registered = ctx.tools.registry.actions.get(actionName);
    if (registered?.terminatesSequence) {
      break;
    }

    // Guard #5：运行时漂移（URL/target 变化 → 后续动作操作过期 DOM）
    let postUrl: string;
    try {
      postUrl = await ctx.browser.getCurrentUrl();
    } catch {
      postUrl = preActionUrl;
    }
    const postTargetId = ctx.browser.currentTargetId;
    if (postUrl !== preActionUrl || postTargetId !== preTargetId) {
      ctx.log(
        `Page drifted after '${actionName}' (url: ${preActionUrl}→${postUrl}, ` +
          `tab: ${preTargetId}→${postTargetId}) — skipping ${total - i - 1}/${total} remaining`,
      );
      break;
    }
  }

  return results;
}

function isConnectionErrorLike(e: unknown): boolean {
  if (e instanceof Error && e.name === "ConnectionError") return true;
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    msg.includes("websocket connection closed") ||
    msg.includes("connection closed") ||
    msg.includes("connection reset") ||
    msg.includes("connection refused") ||
    msg.includes("browser has been closed") ||
    msg.includes("browser closed") ||
    msg.includes("no browser")
  );
}

/** asyncio.wait_for(action, actionTimeout) 等价：真实定时器到点返回超时 error 结果
 * （挂起动作的孤儿结果不消费——Python wait_for 取消协程；TS 以注释登记语义差） */
async function withActionTimeout(ctx: StepCtx, p: Promise<ActionResult>): Promise<ActionResult> {
  let timedOut = false;
  const timer = realTimer(ctx.settings.actionTimeout * 1000, () => {
    timedOut = true;
  });
  try {
    return await Promise.race([
      p,
      timer.promise.then(() =>
        timedOut
          ? new ActionResult({ error: `Action timed out after ${ctx.settings.actionTimeout}s` })
          : new ActionResult(),
      ),
    ]);
  } finally {
    timer.cancel();
  }
}

/** ToolCallEvent 元素几何（归一化 bbox + xpath；无 index/拿不到 node → null 字段） */
function actionElementGeometry(
  actionParams: Record<string, unknown>,
  browserState: BrowserStateSummary,
): {
  elementIndex: number | null;
  elementBbox: import("../../events/events.js").ElementBbox | null;
  elementXpath: string | null;
} {
  const idx = actionParams.index;
  if (typeof idx !== "number") {
    return { elementIndex: null, elementBbox: null, elementXpath: null };
  }
  const sm = browserState.domState ? browserState.domState.selectorMap : null;
  const node = sm ? (sm.get(idx) ?? null) : null;
  if (node === null) {
    return { elementIndex: idx, elementBbox: null, elementXpath: null };
  }
  const bounds = node.snapshotNode?.bounds ?? null;
  // 视口归一化需 getViewportSize——obs 增强面，P4 事件先带原始 bbox 坐标
  const bbox =
    bounds !== null
      ? { left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }
      : null;
  return { elementIndex: idx, elementBbox: bbox, elementXpath: node.xpath || null };
}

export type { EnhancedDOMTreeNode };
export { isRecord };
