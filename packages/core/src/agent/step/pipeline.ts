// _step 编排器（step.py:216-297）+ 消息管理小件（_strip_type 等价的信封剥除）+
// 错误处理四分支 _handleStepError（:1872-1970，含 #194 Branch 2.5 infra 分罪）。

import type { BrowserStateSummary } from "../../browser/views.js";
import { stepStartEvent } from "../../events/events.js";
import { isInfraError } from "../../llm/errors.js";
import { cloneWorkMessages, stripImageBlocks } from "../../llm/transforms.js";
import type { ChatMessage } from "../../llm/types.js";
import {
  formatStepError,
  INFRA_BACKOFF_BASE_S,
  INFRA_BACKOFF_CAP_S,
  InterruptedError,
  isConnectionError,
  LLM_PARSE_ERROR_MARKERS,
} from "../constants.js";
import type { ModelOutput } from "../views.js";
import { ActionResult } from "../views.js";
import { executeActions } from "./act.js";
import type { EnvelopedMessage, StepCtx } from "./context.js";
import { finalizeStep } from "./finalize.js";
import { postProcess } from "./post.js";
import { prepareContext } from "./sense.js";
import { getNextAction } from "./think.js";

/** 信封剥除（getAction 前的边界——偏离 1：kind 显式字段随壳剥离） */
export function stripEnvelope(messages: EnvelopedMessage[]): ChatMessage[] {
  return messages.map((m) => m.message);
}

/** 真实定时器句柄（settle 后必须 cancel——步级/动作/门禁三处超时共用；不用注入
 * sleep：测试的 fake sleep 立即 resolve 会把「计时」退化为「立即到点」） */
export interface RealTimer {
  promise: Promise<void>;
  cancel(): void;
}

export function realTimer(ms: number, onFire: () => void): RealTimer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(
      () => {
        onFire();
        resolve();
      },
      Math.max(0, ms),
    );
  });
  return {
    promise,
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/** Python copy_messages_without_images：拷贝去图（降级重试用；不污染原消息） */
export function copyMessagesWithoutImages(messages: ChatMessage[]): ChatMessage[] {
  const copy = cloneWorkMessages(messages);
  stripImageBlocks(copy);
  return copy;
}

export function addContextMessage(ctx: StepCtx, content: string, kind?: "plain"): void {
  if (!ctx.settings.enableMessageTyping) {
    ctx.messages.push({
      kind: kind ?? "plain",
      message: { role: "user", blocks: [{ kind: "text", text: content }] },
    });
    return;
  }
  ctx.messages.push({
    kind: "context",
    message: { role: "user", blocks: [{ kind: "text", text: content }] },
  });
}

/** 单步执行（Sense-Think-Act 循环）；返回是否 done */
export async function runStep(ctx: StepCtx): Promise<boolean> {
  ctx.stepStartTime = ctx.now();
  if (ctx.obsBus !== null) {
    ctx.obsBus.emit(stepStartEvent(ctx.state.nSteps, ctx.obsSessionId));
  }
  let browserState: BrowserStateSummary | null = null;
  let modelOutput: ModelOutput | null = null;
  let results: ActionResult[] = [];

  try {
    const [state, _stateMessage] = await prepareContext(ctx);
    browserState = state;
    if (ctx.compactor !== null) {
      await ctx.compactor.maybeCompact(ctx.messages, ctx.state.nSteps);
    }
    if (ctx.state.stopped || ctx.state.paused) {
      return false;
    }

    // 清上步 state 注入（prepareContext 读旧值之后、LLM 调用之前——超时/异常不留脏数据）
    ctx.state.lastModelOutput = null;
    ctx.state.lastResult = null;

    const think = await getNextAction(ctx);
    if (think === null) {
      // P0-1：LLM 期间用户停止 → 输出丢弃；finalize 的 model_output 守卫跳过历史写入
      return false;
    }
    modelOutput = think.output;
    // review2 #5：止损 nudge 档位此刻才提交（peek 只暂存；LLM 调用失败时下步重发）
    ackPendingStreakNudge(ctx);
    results = await executeActions(ctx, modelOutput, browserState);
    postProcess(ctx, results, modelOutput);

    if (results.some((r) => r.isDone)) {
      return true;
    }
    if (ctx.state.consecutiveFailures >= ctx.settings.maxFailures) {
      return true;
    }
  } catch (e) {
    try {
      await handleStepError(ctx, e);
    } catch (he) {
      // review3 #4：错误处理器自身故障降级为日志——不得从 except 逃出杀死 run
      ctx.log(
        `step error handler itself failed: ${he instanceof Error ? he.message : String(he)} ` +
          `(original error: ${e instanceof Error ? e.message : String(e)})`,
      );
    }
    return false;
  } finally {
    // finally 边界（issue #173）：finalize 含历史追加与事件发射，整体兜住——
    // 历史/obs 降级也强过任务死亡；降级计数只增不清零（run() 达阈值升级终止）。
    try {
      await finalizeStep(ctx, browserState, modelOutput, results);
    } catch (e) {
      ctx.log(
        `_finalize failed — history/obs degraded for this step: ${e instanceof Error ? e.message : String(e)}`,
      );
      ctx.state.finalizeDegradedSteps += 1;
    }
    // n_steps 递增单一所有点（吞异常不得跳过——否则 run 循环退化为无界 livelock）；
    // #194 唯一豁免：infra 失败步不烧步数预算（防 livelock 的界由 run 顶部预算接管）
    if (!ctx.skipStepIncrement) {
      ctx.state.nSteps += 1;
    }
    ctx.skipStepIncrement = false;
  }

  return false;
}

/** 止损 nudge 提交侧（peek 暂存的配对写侧——LLM 响应确实取得后调用） */
export function ackPendingStreakNudge(ctx: StepCtx): void {
  if (ctx.pendingStreakNudge !== null) {
    ctx.failureStreak.ackNudge(ctx.pendingStreakNudge.name, ctx.pendingStreakNudge.streak);
    ctx.pendingStreakNudge = null;
  }
  if (ctx.pendingZeroResultNudge !== null) {
    ctx.zeroResultStreak.ackNudge(ctx.pendingZeroResultNudge.key);
    ctx.pendingZeroResultNudge = null;
  }
}

/** 异常分罪四分支（:1872-1970） */
export async function handleStepError(ctx: StepCtx, error: unknown): Promise<void> {
  // Branch 1：用户中断——不计失败
  if (error instanceof InterruptedError) {
    const msg = error.message
      ? `Agent interrupted mid-step - ${error.message}`
      : "Agent interrupted mid-step";
    ctx.log(msg);
    return;
  }

  // Branch 2.5：LLM 基建失败（#194）——先于浏览器 reconnect；与能力失败分罪
  if (isInfraError(error)) {
    ctx.state.infraFailures += 1;
    const isFinal = ctx.state.infraFailures >= ctx.settings.maxInfraFailures;
    if (isFinal) {
      ctx.log(
        `Infra failure budget (${ctx.state.infraFailures}/${ctx.settings.maxInfraFailures}) exhausted — run will stop`,
      );
    } else {
      const delay = Math.min(
        INFRA_BACKOFF_CAP_S,
        INFRA_BACKOFF_BASE_S * 2 ** (ctx.state.infraFailures - 1),
      );
      ctx.log(
        `Infra failure (${ctx.state.infraFailures}/${ctx.settings.maxInfraFailures}): ` +
          `${error instanceof Error ? error.constructor.name : String(error)} — backing off ${Math.round(delay)}s ` +
          "(step budget not consumed)",
      );
      await ctx.sleep(delay * 1000);
    }
    ctx.skipStepIncrement = true;
    // truthful 回显（下一步模型读到它不会误以为自己做错过动作）
    ctx.state.lastResult = [
      new ActionResult({
        error:
          `LLM API ${error instanceof Error ? error.constructor.name : String(error)} ` +
          "(infrastructure, not an action result); " +
          "backoff applied, no action executed this step",
      }),
    ];
    return;
  }

  // #194 review4 #2：非 infra 失败到达即解除基建嫌疑（否则被隔开的限流窗口叠加判死）
  if (ctx.state.infraFailures > 0) {
    ctx.state.infraFailures = 0;
  }

  // Branch 2：连接类错误——循环 reconnect（固定 1s 间隔），耗尽 stopped
  if (isConnectionError(error)) {
    ctx.log(
      `Connection error, attempting reconnect: ${error instanceof Error ? error.message : String(error)}`,
    );
    for (let i = 0; i < ctx.settings.reconnectTimeout; i++) {
      if (await ctx.browser.reconnect()) {
        ctx.log("Reconnection succeeded, continuing");
        ctx.state.lastResult = [
          new ActionResult({
            error: `Connection lost and recovered: ${error instanceof Error ? error.message : String(error)}`,
          }),
        ];
        return;
      }
      await ctx.sleep(1000);
    }
    ctx.log(`Reconnection failed after ${ctx.settings.reconnectTimeout}s, stopping agent`);
    ctx.state.stopped = true;
    return;
  }

  // Branch 3：其余错误——计连败 + 解析类错误附模型名诊断
  const errorMsg = formatStepError(error);
  ctx.state.consecutiveFailures += 1;
  const _isFinal = ctx.state.consecutiveFailures >= ctx.settings.maxFailures;
  if (LLM_PARSE_ERROR_MARKERS.some((marker) => errorMsg.includes(marker))) {
    ctx.log(`Model ${ctx.llm.model} failed to produce valid output`);
  }
  ctx.log(
    `Step ${ctx.state.nSteps} failed (${ctx.state.consecutiveFailures}/${ctx.settings.maxFailures}): ${errorMsg}`,
  );
  ctx.state.lastResult = [new ActionResult({ error: errorMsg })];
}
