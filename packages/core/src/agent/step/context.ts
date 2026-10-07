// StepPipeline 共享上下文面（Python StepPipeline mixin 类型注解区 :146-196 的
// TS 显式化——Agent 类实现本接口，五阶段模块收此类型）。信封消息（偏离 1：
// Python `_type` 内部键 → 显式 kind 字段；getAction 前剥除）。

import type { BrowserSession } from "../../browser/session.js";
import type { EventBus } from "../../events/event-bus.js";
import type { LLMClient } from "../../llm/client.js";
import type { ChatMessage, TokenUsage, ToolCall } from "../../llm/types.js";
import type { PolicyGate } from "../../policy/policy.js";
import type { Tools } from "../../tools/actions/index.js";
import type { FileSystemProvider } from "../../tools/fs.js";
import type {
  ActionLoopDetector,
  FailureStreakTracker,
  StreakNudge,
  ZeroResultNudge,
  ZeroResultStreakTracker,
} from "../loop-detector.js";
import type { MessageCompactor } from "../message-compactor.js";
import type { PlanManager } from "../plan-manager.js";
import type { AgentSettings } from "../settings.js";
import type { SkillSource } from "../skills/types.js";
import type { AgentState, ModelOutput } from "../views.js";

export type EnvelopeKind = "state" | "history" | "context" | "plain";

/** 内部信封消息（Python messages + `_type` 键） */
export interface EnvelopedMessage {
  message: ChatMessage;
  kind: EnvelopeKind;
}

export interface ThinkResult {
  output: ModelOutput;
  usage: TokenUsage | null;
  toolCall?: ToolCall;
}

/** 五阶段共享状态与依赖 */
export interface StepCtx {
  readonly task: string;
  safeTask: string;
  readonly llm: LLMClient;
  readonly browser: BrowserSession;
  readonly tools: Tools;
  readonly settings: AgentSettings;
  readonly state: AgentState;
  readonly loopDetector: ActionLoopDetector;
  readonly failureStreak: FailureStreakTracker;
  readonly zeroResultStreak: ZeroResultStreakTracker;
  pendingStreakNudge: StreakNudge | null;
  pendingZeroResultNudge: ZeroResultNudge | null;
  readonly compactor: MessageCompactor | null;
  readonly planManager: PlanManager | null;
  readonly obsBus: EventBus | null;
  readonly obsSessionId: string;
  /** 权限门（4.5 挂点消费；null = 宿主未装配，动作直通） */
  readonly policy: PolicyGate | null;
  /** 信封消息列（run 期对话） */
  messages: EnvelopedMessage[];
  systemPrompt: string;
  toolSchema: Record<string, unknown>;
  /** infra 步豁免 nSteps 递增标记（Branch 2.5 置位、runStep finally 消费复位） */
  skipStepIncrement: boolean;
  /** 动作间反检测等待·秒（Python 从 BrowserSettings 构造时快照） */
  readonly waitBetweenActionsS: number;
  /** 输出模式（Python step._output_mode，agent.py:218 从 llm 实例读取）：
   *  传给 getToolSchema 决定 standard/flash/thinking schema 形态 */
  readonly outputMode: string;
  stepStartTime: number;
  currentModelCallId: string;
  /** 站点级/任务级 skill 注入源（宿主注入；null = 禁用） */
  readonly skillSource: SkillSource | null;
  taskSkillText: string | null;
  taskSkillSlug: string | null;
  /** sensitive 归一化 {placeholder: {value, urls}} */
  readonly sensitiveDataRaw: Record<string, { value: string; urls: string[] | null }> | null;
  /** {real: placeholder} 方向（client 脱敏用） */
  readonly sensitiveMap: Record<string, string> | null;
  /** I/O 注入（测试） */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now: () => number;
  readonly log: (message: string) => void;
  /** getAction 的 sensitiveMap（构造时从 sensitive 派生；无敏感 null） */
  readonly sensitiveMapForGetAction: Record<string, string> | null;
  /** 截图落盘 FS（null = 跳过落盘只留内存引用——偏离 4） */
  readonly fs: FileSystemProvider | null;
  readonly rerunHistoryDir: string;
  /** <agent_history> 滑窗描述（Agent 侧构造——读 history + 窗口配置） */
  readonly historyMessageProvider: () => string | null;
  /** history 追加/末条读（Agent 持有 AgentHistoryList） */
  historyAppend(h: import("../views.js").AgentHistory): void;
  historyLast(): import("../views.js").AgentHistory | null;
  /** 视觉门（useVision && modelSupportsVision(llm.model) 逐步评估） */
  visionGateOpen(): boolean;
}

/** Python TimeoutError（Think 阶段 llm_timeout 到点；Branch 3 计能力失败） */
export class StepTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepTimeoutError";
  }
}
