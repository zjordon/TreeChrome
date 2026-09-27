// Tools 编排器：注册表持有 + execute 分发（查名 → _flatten_params → handler →
// 异常包 ActionResult{error}）。移植自 TreeWalker tools/actions.py 的 Tools 类
// @640d52a（:723-830）。batch1 注册 10 动作（_registerAll 对无 handler 的动作跳过，
// P4b 增补 batch2 handler 后注册面自动扩维）。

import { ActionResult } from "../../agent/views.js";
import type { BrowserStateSummary } from "../../browser/views.js";
import { ACTION_DEFINITIONS, makeStructuredDoneParams, type ParamModel } from "../models.js";
import { ActionRegistry } from "../registry.js";
import type { ToolsOptions } from "../settings.js";
import { DEFAULT_TRUNCATION_SETTINGS } from "../settings.js";
import type { ActionHandler, ToolsBrowser } from "../types.js";
import { createClickHandler } from "./click.js";
import type { ToolsContext } from "./context.js";
import { createDoneHandler } from "./done.js";
import { createExtractHandler } from "./extract.js";
import { createGoBackHandler } from "./go-back.js";
import { createInputTextHandler } from "./input-text.js";
import { createNavigateHandler } from "./navigate.js";
import { createScrollHandler, createSendKeysHandler, createWaitHandler } from "./scroll.js";
import { createSwitchTabHandler } from "./switch-tab.js";

/** batch1 十动作 handler 工厂（P4b：batch2 族在此扩维） */
const HANDLER_FACTORIES: Record<string, (ctx: ToolsContext) => ActionHandler> = {
  navigate: createNavigateHandler,
  click: createClickHandler,
  input_text: createInputTextHandler,
  scroll: createScrollHandler,
  extract: createExtractHandler,
  wait: createWaitHandler,
  go_back: createGoBackHandler,
  switch_tab: createSwitchTabHandler,
  send_keys: createSendKeysHandler,
  done: createDoneHandler,
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class Tools {
  readonly registry: ActionRegistry;
  /** handler 闭包共享上下文；extractClient/extractionSchema 由 4.4 agent 接线后可变 */
  readonly ctx: ToolsContext;

  constructor(options: ToolsOptions = {}) {
    const truncation = { ...DEFAULT_TRUNCATION_SETTINGS, ...options.truncation };
    this.ctx = {
      truncation,
      allowedUploadPaths: options.allowedUploadPaths ?? null,
      allowedWritePaths: options.allowedWritePaths ?? null,
      allowedReadPaths: options.allowedReadPaths ?? null,
      displayFilesInDoneText: options.displayFilesInDoneText ?? false,
      outputModel: options.outputModel ?? null,
      pageSettleEnabled: options.pageSettleEnabled ?? true,
      pageSettleTimeoutS: options.pageSettleTimeoutS ?? 10.0,
      pageSettlePollS: options.pageSettlePollS ?? 0.5,
      pageSettleStablePolls: options.pageSettleStablePolls ?? 4,
      fs: options.fs ?? null,
      sleep: options.sleep ?? defaultSleep,
      log: options.log ?? ((message) => console.info(message)),
      extractClient: null,
      extractionSchema: null,
      cachedBrowserState: null,
    };
    // 变体 B：outputModel 须在 _registerAll 前就位（registry 据此隐藏字段、注册变体参数模型）
    this.registry = new ActionRegistry(this.ctx.outputModel);
    this.registerAll();
  }

  /** 执行单个动作（:771-793）：未知名 → error；参数拆 LLM 嵌套包裹；异常包 error */
  async execute(
    actionName: string,
    params: Record<string, unknown>,
    browser: ToolsBrowser,
    browserState: BrowserStateSummary | null = null,
  ): Promise<ActionResult> {
    const registered = this.registry.actions.get(actionName);
    if (registered === undefined) {
      return new ActionResult({ error: `Unknown action: ${actionName}` });
    }

    const flat = this.flattenParams(params, actionName);

    this.ctx.cachedBrowserState = browserState;
    try {
      const result = await registered.handler(flat, browser);
      return this.normalize(result);
    } catch (e) {
      this.ctx.log(`Action ${actionName} failed: ${e instanceof Error ? e.message : String(e)}`);
      return new ActionResult({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.ctx.cachedBrowserState = null;
    }
  }

  /**
   * 拆 LLM 嵌套包裹 {"click": {"index": 5}} → {"index": 5}（:3269-3289）。
   * 不拆「单嵌套 dict 恰为动作真字段」的形态（变体 B done 的 data）。
   */
  flattenParams(params: Record<string, unknown>, actionName: string): Record<string, unknown> {
    if (!params || Object.keys(params).length === 0) return params;
    const direct = params[actionName];
    if (direct !== undefined && isRecord(direct)) {
      return direct;
    }
    // 单一嵌套 dict 值（常见 LLM 形态）
    const dictVals = Object.entries(params).filter((e): e is [string, Record<string, unknown>] =>
      isRecord(e[1]),
    );
    if (dictVals.length === 1 && Object.keys(params).length === 1) {
      const [onlyKey, onlyVal] = dictVals[0];
      const model = this.registry.actions.get(actionName)?.params;
      const fieldNames = new Set((model?.fields ?? []).map((f) => f.name));
      if (!fieldNames.has(onlyKey)) {
        return onlyVal;
      }
    }
    return params;
  }

  /** 页模式过滤（:832-840）：只影响可见性，不拦截执行 */
  applyPageFilters(filters: Record<string, string[]>): void {
    for (const [name, patterns] of Object.entries(filters)) {
      const action = this.registry.actions.get(name);
      if (action !== undefined) {
        action.pagePatterns = patterns;
      }
    }
  }

  /** ActionResult | string | null 归一（:3291-3297） */
  private normalize(result: ActionResult | string | null): ActionResult {
    if (result instanceof ActionResult) return result;
    if (typeof result === "string") return new ActionResult({ extractedContent: result });
    return new ActionResult();
  }

  /** 注册全部有 handler 的动作（:816-830）；done 变体 B 参数模型在此替换 */
  private registerAll(): void {
    for (const [name, def] of Object.entries(ACTION_DEFINITIONS)) {
      const factory = HANDLER_FACTORIES[name];
      if (factory === undefined) continue; // 无 handler（batch2）——跳过注册
      let params: ParamModel = def.params;
      if (name === "done" && this.ctx.outputModel !== null) {
        params = makeStructuredDoneParams(this.ctx.outputModel);
      }
      this.registry.register({
        name,
        description: def.description,
        params,
        handler: factory(this.ctx),
        terminatesSequence: def.terminatesSequence,
      });
    }
  }
}
