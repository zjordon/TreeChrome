// Stage 5 Finalize：_finalize（:1691-1757）——stateSummary（仅 done 步带 domExcerpt）/
// 截图落盘（FS 未注入跳过——screenshotPath=null，偏离 4）/AgentHistory 追加
//（interactedElement 等长按位投影）/StepEndEvent。

import type { BrowserStateSummary } from "../../browser/views.js";
import { stepEndEvent } from "../../events/events.js";
import { actionsOf, isRecord, paramsOf } from "../action-shape.js";
import { type ActionResult, AgentHistory, type ModelOutput, StepMetadata } from "../views.js";
import type { StepCtx } from "./context.js";

export async function finalizeStep(
  ctx: StepCtx,
  browserState: BrowserStateSummary | null,
  modelOutput: ModelOutput | null,
  results: ActionResult[],
): Promise<void> {
  if (modelOutput !== null) {
    let stateSummary: Record<string, unknown> | null = null;
    if (browserState !== null) {
      stateSummary = {
        url: browserState.url,
        title: browserState.title,
        duration: (ctx.now() - ctx.stepStartTime) / 1000,
      };
      // 仅 done 步带 DOM 摘要——Judge 交叉验证的独立页面证据；其余步保持轻量
      if (results.some((r) => r.isDone)) {
        const domState = browserState.domState;
        stateSummary.domExcerpt = (domState ? domState.elementTreeText : "").slice(
          0,
          ctx.settings.truncation.domExcerptMaxChars,
        );
      }
    }
    const screenshotPath =
      browserState !== null && browserState.screenshot !== null
        ? await saveStepScreenshot(ctx, browserState.screenshot)
        : null;
    ctx.historyAppend(
      new AgentHistory({
        stepNumber: ctx.state.nSteps,
        modelOutput,
        result: results,
        stateSummary,
        interactedElement: safeProjectInteractedElements(ctx, modelOutput, browserState, results),
        metadata: buildStepMetadata(ctx, ctx.now()),
        screenshotPath,
      }),
    );
  }

  if (ctx.obsBus !== null) {
    ctx.obsBus.emit(
      stepEndEvent(ctx.state.nSteps, ctx.obsSessionId, {
        durationSeconds: (ctx.now() - ctx.stepStartTime) / 1000,
        isDone: results.length > 0 ? results.some((r) => r.isDone) : false,
        consecutiveFailures: ctx.state.consecutiveFailures,
      }),
    );
  }
}

/** 当步截图落盘（<dir>/screenshots/step_NNN.png）；失败只 warning 返回 null */
async function saveStepScreenshot(ctx: StepCtx, png: Uint8Array): Promise<string | null> {
  if (ctx.fs === null) {
    return null; // FS 未注入：跳过落盘只留内存引用（偏离 4 登记降级）
  }
  try {
    const dir = `${ctx.rerunHistoryDir}/screenshots`;
    await ctx.fs.ensureDir(dir);
    const target = `${dir}/step_${String(ctx.state.nSteps).padStart(3, "0")}.png`;
    await ctx.fs.writeBytes(target, png);
    return target;
  } catch (e) {
    ctx.log(`step screenshot save failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** 单步计时（stepInterval = 上一步耗时；首步 null） */
function buildStepMetadata(ctx: StepCtx, stepEndTime: number): StepMetadata {
  const prev = ctx.historyLast();
  const stepInterval =
    prev !== null && prev.metadata !== null ? prev.metadata.durationSeconds : null;
  return new StepMetadata({
    stepStartTime: ctx.stepStartTime,
    stepEndTime,
    stepNumber: ctx.state.nSteps,
    stepInterval,
  });
}

/** 每动作交互元素投影（与 actions 等长按位；无 index 的动作 null；uploadClue 覆盖） */
export function projectInteractedElements(
  modelOutput: ModelOutput,
  browserState: BrowserStateSummary | null,
  results: ActionResult[] | null = null,
): Array<Record<string, unknown> | null> | null {
  if (browserState === null || browserState.domState === null) return null;
  const selectorMap = browserState.domState.selectorMap;
  if (selectorMap.size === 0) return null;

  const actions = actionsOf(modelOutput);
  const projected: Array<Record<string, unknown> | null> = [];
  for (const [i, action] of actions.entries()) {
    // upload_file：agent 采集的语义线索优先（#151——batch2 动作，P4b 生效）
    if (
      results !== null &&
      i < results.length &&
      isRecord(action) &&
      action.name === "upload_file"
    ) {
      const clue = results[i].metadata?.upload_clue;
      if (isRecord(clue)) {
        projected.push({ _semantic_clue: true, kind: "file_upload", ...clue });
        continue;
      }
    }
    const params = paramsOf(action) as Record<string, unknown>;
    let index = params.index;
    if (index === undefined || index === null) {
      index = params.element_id; // element_id 是 index 的别名
    }
    const node =
      index !== undefined && index !== null && typeof index === "number"
        ? (selectorMap.get(index) ?? null)
        : null;
    if (node !== null) {
      projected.push(interactedElementDict(node));
    } else {
      projected.push(null);
    }
  }
  return projected;
}

/** DOMInteractedElement.load_from_enhanced_dom_tree(node).to_dict() 等价 */
function interactedElementDict(
  node: import("../../browser/views.js").EnhancedDOMTreeNode,
): Record<string, unknown> {
  const axName = node.axNode?.name ? node.axNode.name : null;
  const bounds = node.snapshotNode?.bounds ?? null;
  return {
    node_id: node.nodeId,
    backend_node_id: node.backendNodeId,
    frame_id: node.frameId,
    node_type: node.nodeType,
    node_value: node.nodeValue,
    node_name: node.nodeName,
    attributes: node.attributes,
    x_path: node.xpath,
    element_hash: node.elementHash.toString(), // bigint → 字符串（序列化域；Python int 由轨迹层转换）
    stable_hash: node.computeStableHash().toString(),
    bounds:
      bounds !== null
        ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
        : null,
    ax_name: axName,
  };
}

/** 投影只是历史元数据——失败降级 None，绝不让元数据 bug 杀死任务（issue #173） */
function safeProjectInteractedElements(
  ctx: StepCtx,
  modelOutput: ModelOutput,
  browserState: BrowserStateSummary | null,
  results: ActionResult[],
): Array<Record<string, unknown> | null> | null {
  try {
    return projectInteractedElements(modelOutput, browserState, results);
  } catch (e) {
    ctx.log(
      `interacted-element projection failed — history metadata degraded to None: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}
