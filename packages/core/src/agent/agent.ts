// Agent 主编排（agent.py :55-705 的 P4 面）：run 外层循环（三预算破环 + 任务级
// skill 匹配一次 + judge + finalize 降级升级）/ stop·pause·resume 公共 API /
// sensitive 归一化与 [Available Secrets] / <agent_history> 滑窗 / 消息裁剪 /
// 任务 URL 提取。偏离 2：SIGINT/stdin 交互不移植（宿主职责）；偏离 3：rerun 族。

import type { BrowserSession } from "../browser/session.js";
import type { EventBus } from "../events/event-bus.js";
import type { LLMClient } from "../llm/client.js";
import { Tools } from "../tools/actions/index.js";
import type { FileSystemProvider } from "../tools/fs.js";
import { actionsOf, nameOf, paramsOf } from "./action-shape.js";
import { JudgeEvaluator } from "./judge.js";
import {
  ActionLoopDetector,
  FailureStreakTracker,
  ZeroResultStreakTracker,
} from "./loop-detector.js";
import { MessageCompactor } from "./message-compactor.js";
import { PlanManager } from "./plan-manager.js";
import { buildSystemPrompt } from "./prompts/system-prompt.js";
import { pyReprDeep } from "./py-repr.js";
import {
  type AgentSettings,
  DEFAULT_MESSAGE_COMPACTION_SETTINGS,
  resolveAgentSettings,
  type SensitiveDataSpec,
} from "./settings.js";
import { buildTaskSkillText, matchTaskSkill } from "./skills/task-matcher.js";
import type { StepCtx } from "./step/context.js";
import { runStep } from "./step/pipeline.js";
import { visionGateOpen } from "./step/sense.js";
import { extractHostWithPort } from "./url-utils.js";
import { type ActionResult, type AgentHistory, AgentHistoryList, AgentState } from "./views.js";

export interface AgentOptions {
  task: string;
  llm: LLMClient;
  browser: BrowserSession;
  /** 缺省自建（AgentSettings 全量接线） */
  tools?: Tools | null;
  settings?: AgentSettings | null;
  /** 敏感数据（{占位符: 真值|{value,urls}}）；settings.sensitiveData 的直传优先 */
  sensitiveData?: Record<string, SensitiveDataSpec> | null;
  /** 宿主 skill 注入源（null = 禁用站点级/任务级注入） */
  skillSource?: StepCtx["skillSource"] | null;
  /** 观测事件总线（null = 关观测——偏离 5：订阅装配在宿主） */
  eventBus?: EventBus | null;
  /** I/O 注入（测试） */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
  /** 截图落盘 FS（null = 跳过） */
  fs?: FileSystemProvider | null;
  /** 重放历史根目录（截图落盘子目录基准；默认 rerun-history） */
  rerunHistoryDir?: string;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });

export class Agent implements StepCtx {
  readonly task: string;
  safeTask: string;
  readonly llm: LLMClient;
  readonly browser: BrowserSession;
  readonly tools: Tools;
  readonly settings: AgentSettings;
  readonly state = new AgentState();
  readonly history = new AgentHistoryList();
  readonly loopDetector = new ActionLoopDetector();
  readonly failureStreak = new FailureStreakTracker();
  readonly zeroResultStreak = new ZeroResultStreakTracker();
  pendingStreakNudge: ReturnType<FailureStreakTracker["peekNudge"]> = null;
  pendingZeroResultNudge: ReturnType<ZeroResultStreakTracker["peekNudge"]> = null;
  readonly compactor: MessageCompactor | null;
  readonly planManager: PlanManager | null;
  readonly obsBus: EventBus | null;
  readonly obsSessionId: string;
  messages: StepCtx["messages"] = [];
  systemPrompt: string;
  toolSchema: Record<string, unknown>;
  skipStepIncrement = false;
  stepStartTime = 0;
  currentModelCallId = "";
  readonly skillSource: StepCtx["skillSource"];
  taskSkillText: string | null = null;
  taskSkillSlug: string | null = null;
  readonly sensitiveDataRaw: Record<string, { value: string; urls: string[] | null }> | null;
  readonly sensitiveMap: Record<string, string> | null;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now: () => number;
  readonly log: (message: string) => void;
  readonly fs: FileSystemProvider | null;
  readonly rerunHistoryDir: string;
  readonly waitBetweenActionsS: number;
  private readonly judge: JudgeEvaluator | null;
  private resumeGate: Promise<void> = Promise.resolve();
  private resumeRelease: (() => void) | null = null;
  readonly historyMessageProvider: () => string | null;

  constructor(options: AgentOptions) {
    this.task = options.task;
    this.llm = options.llm;
    this.browser = options.browser;
    this.settings = resolveAgentSettings(options.settings ?? null);
    const s = this.settings;
    // sensitive 归一化（旧全局字符串 / 新 {value,urls} 双格式兼容）
    const rawSensitive = options.sensitiveData ?? s.sensitiveData;
    this.sensitiveDataRaw = Agent.normalizeSensitiveData(rawSensitive);
    if (this.sensitiveDataRaw !== null) {
      this.sensitiveMap = Object.fromEntries(
        Object.entries(this.sensitiveDataRaw)
          .filter(([, spec]) => spec.value !== "")
          .map(([placeholder, spec]) => [spec.value, placeholder]),
      );
      this.safeTask = this.task;
      for (const [real, placeholder] of Object.entries(this.sensitiveMap)) {
        this.safeTask = this.safeTask.split(real).join(placeholder);
      }
    } else {
      this.sensitiveMap = null;
      this.safeTask = this.task;
    }
    // P2 LLMClient 无 setter——getAction 每调用显式传 sensitiveMap（Python 写
    // llm._sensitive_map 的等价消费面；09 §9 接线形态差异登记）
    this.sensitiveMapForGetAction = this.sensitiveMap;

    this.tools =
      options.tools ??
      new Tools({
        truncation: s.truncation,
        allowedUploadPaths: s.allowedUploadPaths,
        allowedWritePaths: s.allowedWritePaths,
        allowedReadPaths: s.allowedReadPaths,
        displayFilesInDoneText: s.displayFilesInDoneText,
        outputModel: s.outputModel,
        pageSettleEnabled: s.explorationPageSettle,
        pageSettleTimeoutS: s.explorationPageSettleTimeout,
        pageSettlePollS: s.explorationPageSettlePoll,
        pageSettleStablePolls: s.explorationPageSettleStablePolls,
        fs: options.fs ?? null,
        log: options.log ?? ((m) => console.info(m)),
      });
    if (s.actionPageFilters !== null) {
      this.tools.applyPageFilters(s.actionPageFilters);
    }
    // extract 工具接线（专用 LLM 缺省复用主 llm——P2 面即 LLMClient 实例）
    this.tools.ctx.extractClient = this.llm;
    this.tools.ctx.extractionSchema = s.extractionSchema;

    this.compactor = s.messageCompaction?.enabled
      ? new MessageCompactor(
          { ...DEFAULT_MESSAGE_COMPACTION_SETTINGS, ...s.messageCompaction },
          this.llm,
        )
      : null;
    this.planManager = s.enablePlanning ? new PlanManager() : null;
    this.obsBus = options.eventBus ?? null;
    this.obsSessionId = Math.random().toString(16).slice(2, 10);
    this.skillSource = options.skillSource ?? null;
    this.sleep = (options.sleep as (ms: number) => Promise<void>) ?? defaultSleep;
    this.now = options.now ?? (() => Date.now() / 1000);
    this.log = options.log ?? ((m) => console.info(m));
    this.fs = options.fs ?? null;
    this.rerunHistoryDir = options.rerunHistoryDir ?? "rerun-history";
    this.waitBetweenActionsS = 0; // Python 读 BrowserSettings.waitBetweenActions——宿主经 browser 设置传入
    this.judge = s.judge.enabled ? new JudgeEvaluator(this.llm, s.judge) : null;
    this.historyMessageProvider = () => this.buildAgentHistoryDescription();

    this.systemPrompt = buildSystemPrompt(
      this.tools.registry.getActionDescriptionsText(),
      this.safeTask,
      s.enableDecisionAttribution,
      s.maxActionsPerStep,
    );
    this.toolSchema = this.tools.registry.getToolSchema({
      enablePlanning: s.enablePlanning,
      maxActions: s.maxActionsPerStep,
    }) as unknown as Record<string, unknown>;
  }

  /** getAction 的 sensitiveMap 消费面（构造时从 sensitiveMap 派生；无敏感为 null） */
  readonly sensitiveMapForGetAction: Record<string, string> | null;

  // ── 公共 API ───────────────────────────────────────────────────────

  async run(keepAlive = false): Promise<AgentHistoryList> {
    await this.browser.start({
      trackDownloads: this.settings.trackDownloads,
      enableRecentEvents: this.settings.enableRecentEvents,
    });

    const initialUrl = extractUrl(this.task);
    if (initialUrl !== null) {
      try {
        await this.browser.navigate(initialUrl);
      } catch (e) {
        this.log(
          `Failed to navigate to initial URL: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    try {
      // 任务级 skill 匹配一次（初始导航后——导航前 host 不可信；全异常=不注入）
      if (this.settings.enableTaskSkillInjection && this.skillSource !== null) {
        try {
          await this.matchTaskSkill(initialUrl);
        } catch (e) {
          this.log(
            `task-skill: match failed (${e instanceof Error ? e.message : String(e)}) — no injection`,
          );
        }
      }

      while (this.state.nSteps <= this.settings.maxSteps) {
        if (this.state.stopped) {
          break;
        }
        if (this.state.consecutiveFailures >= this.settings.maxFailures) {
          this.log(`Max consecutive failures (${this.settings.maxFailures}) reached`);
          break;
        }
        // #194：基建预算检查——infra 步不递增 n_steps，防 livelock 的界由此接管
        if (this.state.infraFailures >= this.settings.maxInfraFailures) {
          this.log(
            `Max infra failures (${this.settings.maxInfraFailures}) reached — API unreachable, stopping`,
          );
          break;
        }
        // paused 等待 resume（宿主调用 resume() 放行）
        if (this.state.paused) {
          await this.resumeGate;
          if (this.state.stopped) break;
        }

        const done = await runStep(this);
        // review5 #3：升级检查在 done-break 之前，升级分支先跑 judge
        if (this.state.finalizeDegradedSteps >= 3) {
          this.log(
            `_finalize degraded on ${this.state.finalizeDegradedSteps} steps — aborting run ` +
              "(history is incomplete; see prior error logs)",
          );
          if (done && this.judge !== null) {
            await this.runJudge();
          }
          break;
        }
        if (done) {
          if (this.judge !== null) {
            await this.runJudge();
          }
          break;
        }
      }
    } finally {
      // 降级信息落到返回的 history（调用方可区分「正常完成」与「残缺完成」）
      this.history.finalizeDegradedSteps = this.state.finalizeDegradedSteps;
      if (this.obsBus !== null) {
        this.obsBus.close();
      }
      if (!keepAlive) {
        await this.browser.stop();
      }
    }

    return this.history;
  }

  stop(): void {
    this.state.stopped = true;
    this.resumeRelease?.();
  }

  pause(): void {
    this.state.paused = true;
    this.resumeGate = new Promise((resolve) => {
      this.resumeRelease = resolve;
    });
  }

  resume(): void {
    this.state.paused = false;
    this.resumeRelease?.();
    this.resumeRelease = null;
  }

  // ── StepCtx 实现（history 桥） ──────────────────────────────────────

  historyAppend(h: AgentHistory): void {
    this.history.history.push(h);
  }

  historyLast(): AgentHistory | null {
    return this.history.history.length > 0
      ? this.history.history[this.history.history.length - 1]
      : null;
  }

  visionGateOpen(): boolean {
    return visionGateOpen(this);
  }

  // ── 内部件 ─────────────────────────────────────────────────────────

  private async runJudge(): Promise<void> {
    if (this.judge === null || !this.history.isDone()) return;
    const finalResult = this.history.finalResult();
    const judgement = await this.judge.judge(this.safeTask, this.history, finalResult);
    if (judgement !== null && this.history.history.length > 0) {
      const lastStep = this.history.history[this.history.history.length - 1];
      for (const r of lastStep.result) {
        if (r.isDone) {
          r.judgement = judgement;
        }
      }
    }
  }

  /** 任务级 skill 匹配（每任务一次；host 优先导航目标 URL 消竞态） */
  private async matchTaskSkill(preferredUrl: string | null): Promise<void> {
    if (this.skillSource === null || this.safeTask.trim() === "") return;
    const url = preferredUrl ?? (await this.browser.getCurrentUrl());
    const hostKey = extractHostWithPort(url);
    if (hostKey === null) return;
    const catalog = await this.skillSource.taskCatalog(hostKey);
    if (catalog.length === 0) return;
    const match = await matchTaskSkill(this.safeTask, catalog, this.llm);
    if (match.slug === null) return;
    const card = catalog.find((c) => c.slug === match.slug);
    if (card === undefined) return;
    this.taskSkillSlug = match.slug;
    const cardText = await this.skillSource.taskCardText(card);
    this.taskSkillText = buildTaskSkillText(match.slug, cardText, {
      matchKind: match.matchKind,
      taskKind: match.taskKind,
    });
  }

  /** 归一化 sensitive_data（旧全局字符串 / 新 {value,urls}——跳过无 value 项） */
  static normalizeSensitiveData(
    raw: Record<string, SensitiveDataSpec> | null | undefined,
  ): Record<string, { value: string; urls: string[] | null }> | null {
    if (raw === null || raw === undefined) return null;
    const normalized: Record<string, { value: string; urls: string[] | null }> = {};
    for (const [placeholder, spec] of Object.entries(raw)) {
      let value: string;
      let urls: string[] | null;
      if (typeof spec === "object" && spec !== null) {
        value = String(spec.value ?? "");
        urls = spec.urls ?? null;
      } else {
        value = String(spec);
        urls = null;
      }
      if (value === "") continue;
      normalized[placeholder] = { value, urls };
    }
    return Object.keys(normalized).length > 0 ? normalized : null;
  }

  /** compactor 启用时窗口降到 5（避免双重占用 token） */
  private effectiveMaxHistoryItems(): number {
    return this.compactor !== null
      ? Math.min(this.settings.maxHistoryItems, 5)
      : this.settings.maxHistoryItems;
  }

  /** <agent_history> 滑窗（首条 + 省略行 + 最近 N 条；格式字节锚定 agent.json） */
  buildAgentHistoryDescription(): string | null {
    const items = this.history.history;
    if (items.length === 0) return null;
    const maxItems = this.effectiveMaxHistoryItems();
    if (maxItems <= 0) return null;

    let shown: AgentHistory[];
    let omitted: number;
    if (items.length <= maxItems) {
      shown = items;
      omitted = 0;
    } else if (maxItems === 1) {
      shown = items.slice(0, 1);
      omitted = items.length - 1;
    } else {
      shown = [items[0], ...items.slice(-(maxItems - 1))];
      omitted = items.length - maxItems;
    }

    const lines: string[] = ["<agent_history>"];
    if (omitted > 0) {
      lines.push(`  [... ${omitted} previous steps omitted ...]`);
    }
    for (const h of shown) {
      const mo = h.modelOutput ?? {};
      const goal = typeof mo.next_goal === "string" ? mo.next_goal : "";
      const eval_ =
        typeof mo.evaluation_previous_goal === "string" ? mo.evaluation_previous_goal : "";
      const memory = typeof mo.memory === "string" ? mo.memory : "";
      const actions = actionsOf(mo);
      const actionParts = actions
        .filter((a) => typeof a === "object" && a !== null)
        .map((a) => `${nameOf(a) ?? "?"}(${pyReprDeep(paramsOf(a))})`);
      const actionStr = actionParts.length > 0 ? actionParts.join(", ").slice(0, 150) : "?";
      // P1c 修订：只保留结果状态（✓/✗/done），情境性软警告不进滑窗（累积放大误导）
      const resultStr = summarizeStepResult(h.result);
      lines.push(`  Step ${h.stepNumber}: [${eval_}] Goal: ${goal} | ${actionStr} -> ${resultStr}`);
      if (memory) {
        lines.push(`    Memory: ${memory}`);
      }
    }
    lines.push("</agent_history>");
    return lines.join("\n");
  }
}

/** 单步结果状态摘要（✗ 首 error 前 80 字 / ✓ done / ✓ / 空） */
export function summarizeStepResult(results: ActionResult[]): string {
  if (results.length === 0) return "";
  for (const r of results) {
    if (r.error !== null) {
      return `✗ ${r.error.slice(0, 80)}`;
    }
  }
  if (results.some((r) => r.isDone)) return "✓ done";
  return "✓";
}

/** 从任务文本提取 URL（初始导航；agent.py:700-705 正则） */
export function extractUrl(task: string): string | null {
  const m = task.match(/https?:\/\/[^\s<>"']+/);
  return m !== null ? m[0] : null;
}
