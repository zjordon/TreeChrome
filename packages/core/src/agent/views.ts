// agent 数据模型层：ActionResult / AgentState / AgentHistory / AgentHistoryList。
// 移植自 TreeWalker agent/views.py（@640d52a），出界项（p4/03 §10）：rerun/编辑器族
// （ManualVariableBinding/DetectedVariable/RerunSummaryAction/BatchRowResult/mutation
// API/save-load 文件持久化）不移植。字段名 camelCase；序列化给评测的 JSON 键在 4.4
// 的轨迹转换层保 snake_case。render() 是 LLM 可见渲染（进 [Previous Action Results]
// 段）——Python f-string 布尔字面量（True/False/None）与截断标记逐字节保真。

import { isRecord, type ModelOutput, normalizeModelOutput } from "./action-shape.js";

export type { ModelOutput } from "./action-shape.js";

/** Python f"{success}" 的字面量渲染（prompt 保真） */
function pyBool(value: boolean | null): string {
  if (value === true) return "True";
  if (value === false) return "False";
  return "None";
}

export interface ActionResultInit {
  isDone?: boolean;
  success?: boolean | null;
  error?: string | null;
  extractedContent?: string | null;
  longTermMemory?: string | null;
  /** Judge 复核回写（4.4） */
  judgement?: unknown;
  /** 通用结构化副字段（如 evaluate 的 images）；render() 不渲染 */
  metadata?: Record<string, unknown> | null;
  /** done 附件路径列表；render() 不渲染（附件清单走 extractedContent） */
  attachments?: string[] | null;
}

export class ActionResult {
  static readonly DISPLAY_MAX_CHARS = 500;

  readonly isDone: boolean;
  readonly success: boolean | null;
  readonly error: string | null;
  readonly extractedContent: string | null;
  readonly longTermMemory: string | null;
  judgement: unknown;
  readonly metadata: Record<string, unknown> | null;
  readonly attachments: string[] | null;

  constructor(init: ActionResultInit = {}) {
    this.isDone = init.isDone ?? false;
    this.success = init.success ?? null;
    this.error = init.error ?? null;
    this.extractedContent = init.extractedContent ?? null;
    this.longTermMemory = init.longTermMemory ?? null;
    this.judgement = init.judgement ?? null;
    this.metadata = init.metadata ?? null;
    this.attachments = init.attachments ?? null;
    if (this.success === true && this.isDone !== true) {
      throw new Error(
        "success=True can only be set when is_done=True. " +
          "For regular actions that succeed, leave success as None.",
      );
    }
  }

  /** Python __str__：有界渲染（display_max_chars=500），静默截断追加显式标记（issue #185 现象③） */
  render(): string {
    const parts: string[] = [];
    if (this.error) parts.push(`ERROR: ${this.error}`);
    if (this.extractedContent) {
      const visible = this.extractedContent.slice(0, ActionResult.DISPLAY_MAX_CHARS);
      const marker =
        this.extractedContent.length > ActionResult.DISPLAY_MAX_CHARS
          ? ` [...display truncated: showing ${ActionResult.DISPLAY_MAX_CHARS} of ` +
            `${this.extractedContent.length} chars — re-read with a smaller window]`
          : "";
      parts.push(`EXTRACTED: ${visible}${marker}`);
    }
    if (this.isDone) parts.push(`DONE (success=${pyBool(this.success)})`);
    if (parts.length === 0) parts.push("OK");
    return parts.join(" | ");
  }
}

export interface PlanItem {
  text: string;
  status: string;
}

export function planItem(text: string, status = "pending"): PlanItem {
  return { text, status };
}

export interface DownloadInfo {
  filename: string;
  url: string;
  path?: string | null;
}

/** agent 运行态（step/run 各阶段共变的可变状态，挂在单一实例上） */
export class AgentState {
  nSteps = 0;
  consecutiveFailures = 0;
  lastResult: ActionResult[] | null = null;
  lastModelOutput: ModelOutput | null = null;
  stopped = false;
  paused = false;
  downloadedFiles: DownloadInfo[] = [];
  plan: PlanItem[] | null = null;
  currentPlanItemIndex = 0;
  planGenerationStep = 0;
  /** _finalize 降级计数（PR #174 review4 #4）：finally 兜底吞异常的次数，run 连续达阈值升级终止 */
  finalizeDegradedSteps = 0;
  /** done 门禁累计触发（issue #186 现象②）：每 run 封顶，防「每步重发带标记的 done」循环 */
  doneGateUses = 0;
  /** LLM 基建失败连续计数（issue #194）：与 consecutiveFailures 分罪——不烧步数、不进能力止损 */
  infraFailures = 0;
}

/** 单步计时信息（重放步间延迟用；userPauseSeconds 为 recorder 路径专用，P4 恒 null） */
export class StepMetadata {
  readonly stepStartTime: number;
  readonly stepEndTime: number;
  readonly stepNumber: number;
  readonly stepInterval: number | null;
  readonly userPauseSeconds: number | null;

  constructor(init: {
    stepStartTime: number;
    stepEndTime: number;
    stepNumber: number;
    stepInterval?: number | null;
    userPauseSeconds?: number | null;
  }) {
    this.stepStartTime = init.stepStartTime;
    this.stepEndTime = init.stepEndTime;
    this.stepNumber = init.stepNumber;
    this.stepInterval = init.stepInterval ?? null;
    this.userPauseSeconds = init.userPauseSeconds ?? null;
  }

  get durationSeconds(): number {
    return this.stepEndTime - this.stepStartTime;
  }
}

export interface AgentHistoryInit {
  stepNumber: number;
  modelOutput: ModelOutput;
  result: Array<ActionResult | ActionResultInit>;
  /** url/title/duration（done 步另带 domExcerpt）——序列化键 snake_case 在 4.4 转换层处理 */
  stateSummary?: Record<string, unknown> | null;
  /** 每动作交互元素投影，与 modelOutput.actions 等长按位对应；无 index 的动作为 null */
  interactedElement?: Array<Record<string, unknown> | null> | null;
  metadata?: StepMetadata | null;
  screenshotPath?: string | null;
}

/**
 * 畸形动作归一化的构造收口（issue #173 review7 #2/#3，history 上下文）：不合成可执行
 * 动作，只做无害化；**拷贝归一化**——绝不就地改写调用方传入的 dict（构造随后校验
 * 失败时不得腐蚀失败构造器从未拥有的输入；与 state.lastModelOutput 共享同一对象）。
 */
function copyModelOutputForHistory(mo: ModelOutput): ModelOutput {
  const moCopy: ModelOutput = { ...mo };
  const actions = moCopy.actions;
  if (Array.isArray(actions)) {
    moCopy.actions = actions.map((a) => (isRecord(a) ? { ...a } : a));
  }
  const act = moCopy.action;
  if (isRecord(act)) moCopy.action = { ...act };
  return moCopy;
}

export class AgentHistory {
  readonly stepNumber: number;
  readonly modelOutput: ModelOutput;
  readonly result: ActionResult[];
  readonly stateSummary: Record<string, unknown> | null;
  readonly interactedElement: Array<Record<string, unknown> | null> | null;
  readonly metadata: StepMetadata | null;
  readonly screenshotPath: string | null;

  constructor(init: AgentHistoryInit) {
    this.stepNumber = init.stepNumber;
    const moCopy = copyModelOutputForHistory(init.modelOutput);
    normalizeModelOutput(moCopy, { context: "history" });
    this.modelOutput = moCopy;
    this.result = init.result.map((r) => (r instanceof ActionResult ? r : new ActionResult(r)));
    this.stateSummary = init.stateSummary ?? null;
    this.interactedElement = init.interactedElement ?? null;
    this.metadata = init.metadata ?? null;
    this.screenshotPath = init.screenshotPath ?? null;
  }
}

/** 仅这些「用户填值类」动作的参数需要敏感数据脱敏（动作名 → 待脱敏的参数字段） */
export const SENSITIVE_ACTION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  input_text: ["text"],
  search: ["query"],
  extract: ["query"],
};

/**
 * 把 value 中出现的真实秘密替换成 <secret>key</secret> 占位符。按值长度从长到短
 * 排序，避免短秘密先匹配造成泄露（password 先吃掉 password123 的前缀）。
 */
export function redactSensitiveString(
  value: string,
  sensitiveValues: Record<string, string>,
): string {
  if (!value) return value;
  const entries = Object.entries(sensitiveValues).sort(
    (a, b) => (b[1] ?? "").length - (a[1] ?? "").length,
  );
  for (const [key, secret] of entries) {
    if (secret) value = value.split(secret).join(`<secret>${key}</secret>`);
  }
  return value;
}

export interface AgentHistoryListInit {
  history?: AgentHistory[];
  /** 存盘时写入，load 侧宽松校验（防 action 注册表漂移导致旧历史读不回）；文件持久化 M6 */
  actionRegistryVersion?: string | null;
  finalizeDegradedSteps?: number;
}

/** run() 的返回值（runner 契约消费面：isDone/isSuccessful/finalResult/history） */
export class AgentHistoryList {
  readonly history: AgentHistory[];
  actionRegistryVersion: string | null;
  /** run() 收尾落计数：调用方可区分「正常完成」与「history 残缺的完成」；0 = 无降级 */
  finalizeDegradedSteps: number;

  constructor(init: AgentHistoryListInit = {}) {
    this.history = init.history ?? [];
    this.actionRegistryVersion = init.actionRegistryVersion ?? null;
    this.finalizeDegradedSteps = init.finalizeDegradedSteps ?? 0;
  }

  finalResult(): string | null {
    for (let i = this.history.length - 1; i >= 0; i--) {
      for (const r of this.history[i].result) {
        if (r.isDone && r.extractedContent) return r.extractedContent;
      }
    }
    return null;
  }

  isDone(): boolean {
    if (this.history.length === 0) return false;
    return this.history[this.history.length - 1].result.some((r) => r.isDone);
  }

  isSuccessful(): boolean {
    if (this.history.length === 0) return false;
    return this.history[this.history.length - 1].result.some((r) => r.isDone && r.success);
  }
}
