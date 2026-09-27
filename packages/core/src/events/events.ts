// 观测事件类型：9 类事件的 discriminated union（判别值保 Python event_type 原字符串，
// 字段 camelCase）。移植自 TreeWalker observability/events.py（@640d52a）。
// 已知偏离：timestamp 用 JS toISOString()（毫秒 Z 后缀）而非 Python isoformat 的
// 微秒 +00:00——时间戳无跨语言字节可比性，UI/SSE 消费方按 ISO 通用解析。

export interface EventBase {
  eventType: string;
  timestamp: string;
  step: number;
  sessionId: string;
}

export interface StepStartEvent extends EventBase {
  eventType: "step_start";
}

export interface ModelCallEvent extends EventBase {
  eventType: "model_call";
  modelCallId: string;
  messageCount: number;
}

export interface ModelResultEvent extends EventBase {
  eventType: "model_result";
  modelCallId: string;
  actionName: string;
  thinking?: string | null;
  nextGoal?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/** 目标元素几何（归一化百分比 [0,1]，相对视口）；无 index/拿不到节点/视口 → null */
export interface ElementBbox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ToolCallEvent extends EventBase {
  eventType: "tool_call";
  modelCallId: string;
  toolCallId: string;
  actionName: string;
  params?: Record<string, unknown>;
  actionIndex?: number;
  totalActions?: number;
  elementIndex?: number | null;
  elementBbox?: ElementBbox | null;
  elementXpath?: string | null;
}

export interface ToolResultEvent extends EventBase {
  eventType: "tool_result";
  toolCallId: string;
  success: boolean | null;
  error?: string | null;
  durationSeconds?: number;
  actionIndex?: number;
  totalActions?: number;
}

export interface StepEndEvent extends EventBase {
  eventType: "step_end";
  durationSeconds: number;
  isDone: boolean;
  consecutiveFailures: number;
}

export interface AnomalyEvent extends EventBase {
  eventType: "anomaly";
  rule: string;
  severity: "low" | "medium" | "high";
  description: string;
}

export interface SessionEndEvent extends EventBase {
  eventType: "session_end";
  totalSteps: number;
  totalDurationSeconds: number;
  summary: string;
  evaluation?: Record<string, unknown> | null;
}

/** 本步活动的 skill：host/命中/字数（站点级与任务级分开标，taskSlug 非空表示只有任务卡命中） */
export interface SkillActiveEvent extends EventBase {
  eventType: "skill_active";
  host?: string | null;
  skillLoaded?: boolean;
  charCount?: number;
  taskSlug?: string;
  taskSkillChars?: number;
}

export type TwEvent =
  | StepStartEvent
  | ModelCallEvent
  | ModelResultEvent
  | ToolCallEvent
  | ToolResultEvent
  | StepEndEvent
  | AnomalyEvent
  | SessionEndEvent
  | SkillActiveEvent;

export type TwEventType = TwEvent["eventType"];

function baseFields(step: number, sessionId: string): Omit<EventBase, "eventType"> {
  return { timestamp: new Date().toISOString(), step, sessionId };
}

export function stepStartEvent(step: number, sessionId: string): StepStartEvent {
  return { eventType: "step_start", ...baseFields(step, sessionId) };
}

export function modelCallEvent(
  step: number,
  sessionId: string,
  fields: { modelCallId: string; messageCount: number },
): ModelCallEvent {
  return { eventType: "model_call", ...baseFields(step, sessionId), ...fields };
}

export function modelResultEvent(
  step: number,
  sessionId: string,
  fields: {
    modelCallId: string;
    actionName: string;
    thinking?: string | null;
    nextGoal?: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
  },
): ModelResultEvent {
  return { eventType: "model_result", ...baseFields(step, sessionId), ...fields };
}

export function toolCallEvent(
  step: number,
  sessionId: string,
  fields: {
    modelCallId: string;
    toolCallId: string;
    actionName: string;
    params?: Record<string, unknown>;
    actionIndex?: number;
    totalActions?: number;
    elementIndex?: number | null;
    elementBbox?: ElementBbox | null;
    elementXpath?: string | null;
  },
): ToolCallEvent {
  return { eventType: "tool_call", ...baseFields(step, sessionId), ...fields };
}

export function toolResultEvent(
  step: number,
  sessionId: string,
  fields: {
    toolCallId: string;
    success: boolean | null;
    error?: string | null;
    durationSeconds?: number;
    actionIndex?: number;
    totalActions?: number;
  },
): ToolResultEvent {
  return { eventType: "tool_result", ...baseFields(step, sessionId), ...fields };
}

export function stepEndEvent(
  step: number,
  sessionId: string,
  fields: { durationSeconds: number; isDone: boolean; consecutiveFailures: number },
): StepEndEvent {
  return { eventType: "step_end", ...baseFields(step, sessionId), ...fields };
}

export function anomalyEvent(
  step: number,
  sessionId: string,
  fields: { rule: string; severity: "low" | "medium" | "high"; description: string },
): AnomalyEvent {
  return { eventType: "anomaly", ...baseFields(step, sessionId), ...fields };
}

export function sessionEndEvent(
  step: number,
  sessionId: string,
  fields: {
    totalSteps: number;
    totalDurationSeconds: number;
    summary: string;
    evaluation?: Record<string, unknown> | null;
  },
): SessionEndEvent {
  return { eventType: "session_end", ...baseFields(step, sessionId), ...fields };
}

export function skillActiveEvent(
  step: number,
  sessionId: string,
  fields: {
    host?: string | null;
    skillLoaded?: boolean;
    charCount?: number;
    taskSlug?: string;
    taskSkillChars?: number;
  },
): SkillActiveEvent {
  return { eventType: "skill_active", ...baseFields(step, sessionId), ...fields };
}
