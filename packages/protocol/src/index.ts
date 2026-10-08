// 事件协议类型包（架构 §8，m5/01 §1.1）：core 事件类型 re-export（单一事实源在
// @tw/core）+ SW↔UI 消息信封（Port 长连接双向 + sendMessage 单发共用）。纯类型零
// 运行时（kind 常量表除外——路由器校验与 exhaustive 测试的锚）。console-ui 只依赖
// 本包不依赖 core；宿主转发（SW Port 广播 / M6 SSE 桥）消费同一信封。

// —— core 事件类型 re-export（type-only）——
// —— core 权限/配置类型的 UI 消费面 re-export（type-only）——
export type {
  AnomalyEvent,
  ElementBbox,
  EventBase,
  GatedCapability,
  Grant,
  ModelCallEvent,
  ModelResultEvent,
  PermissionVerdict,
  ProviderConfig,
  SessionEndEvent,
  SkillActiveEvent,
  StepEndEvent,
  StepStartEvent,
  ToolCallEvent,
  ToolResultEvent,
  TwEvent,
  TwEventType,
} from "@tw/core";

import type { ElementBbox, GatedCapability, ProviderConfig, TwEvent, TwEventType } from "@tw/core";

/**
 * 消息信封 kind 常量表（本包唯一运行时面）。判别联合以字面量 kind 收口，常量表供
 * 路由器（段 D port-server/message-router）做未知 kind 防御与测试 exhaustive 断言。
 */
export const SW_TO_UI_KINDS = [
  "hello",
  "journal-snapshot",
  "event",
  "permission-request",
  "permission-cancelled",
  "submit-request",
  "attachments",
] as const;

export const UI_TO_SW_KINDS = [
  "journal-ack",
  "permission-resolve",
  "submit-resolve",
  "control",
  "attachment-add",
  "attachment-remove",
  "settings-changed",
  "diag",
] as const;

export type SwToUiKind = (typeof SW_TO_UI_KINDS)[number];
export type UiToSwKind = (typeof UI_TO_SW_KINDS)[number];

// —— 共享 payload ——

/** 附件注册表条目（任务文本引用 attachment:<id> 的 UI 投影） */
export interface AttachmentInfo {
  attachmentId: string;
  name: string;
  mimeType: string;
  size: number;
}

/** submit 预确认的字段摘要行（core SubmitProbe 产出；password 值已在 probe 侧打码） */
export interface SubmitField {
  name: string;
  value: string;
}

/**
 * 权限确认卡 payload：core PermissionRequest 的 UI 投影（tabId 从 core 的 string|null
 * 换扩展原生 number——SW 粘合层转换）；label 为 capability 中文动作名（宿主用 core
 * CAPABILITY_LABEL 填充——运行时常量不进本类型包）；expiresAt 是确认卡兜底超时
 * （core PolicyGate promptTimeoutMs 的墙上钟换算，UI 倒计时条用）。
 */
export interface PermissionCardPayload {
  capability: GatedCapability;
  host: string;
  actionName: string;
  params: Record<string, unknown>;
  tabId: number | null;
  elementIndex: number | null;
  elementBbox: ElementBbox | null;
  elementXpath: string | null;
  label: string;
  expiresAt: number;
}

// —— run journal ——

/** run 终态/挂起态全集（m5/04 §4.1；awaiting-* 期间 Agent 挂在确认卡上不烧步数） */
export type RunStatus =
  | "running"
  | "awaiting-permission"
  | "awaiting-submit"
  | "done"
  | "error"
  | "interrupted";

/** journal 事件条目：core TwEvent 的 seq 编号 + 压缩投影（data 形态随 type 变化，
 * 消费侧按 type 收窄——压缩规则在 SW journal 层，类型面保持 unknown） */
export interface JournalEvent {
  seq: number;
  type: TwEventType;
  ts: number;
  data: unknown;
}

/**
 * run journal 快照（chrome.storage `tc_runUi:<tabId>` 的落盘形态 + Port 全量补发的
 * 载荷）。seq 单调；ackedSeq 之前的 events 已被 UI 确认可释放；discardedBeforeSeq
 * 只记事件环真实淘汰（webbrain 后期修正语义——ack 不算丢失）。
 */
export interface RunJournalSnapshot {
  runId: string;
  tabId: number;
  status: RunStatus;
  seq: number;
  ackedSeq: number;
  discardedBeforeSeq: number;
  events: JournalEvent[];
  task: string;
  startedAt: number;
  endedAt: number | null;
  finalResult: string | null;
  isDone: boolean;
  isSuccessful: boolean | null;
  stepCount: number;
  lastError: string | null;
  attachments: AttachmentInfo[];
}

/** provider 卡片的存储/表单形态（单一事实源 = core ProviderConfig；扩展 chrome.storage
 * 与 options 表单直存此形——字段漂移由别名收口，不另立 Dto） */
export type ProviderCardDto = ProviderConfig;

// —— SW → UI 消息（Port 广播 + hello/journal-snapshot 全量补发）——

export interface SwHelloMessage {
  kind: "hello";
  /** SW 重启后无活 run 时 null（UI 呈现空闲态或 interrupted 恢复） */
  runId: string | null;
  snapshot: RunJournalSnapshot | null;
}

export interface SwJournalSnapshotMessage {
  kind: "journal-snapshot";
  snapshot: RunJournalSnapshot;
}

export interface SwEventMessage {
  kind: "event";
  seq: number;
  event: TwEvent;
}

export interface SwPermissionRequestMessage {
  kind: "permission-request";
  token: string;
  req: PermissionCardPayload;
}

export interface SwPermissionCancelledMessage {
  kind: "permission-cancelled";
  token: string;
}

export interface SwSubmitRequestMessage {
  kind: "submit-request";
  token: string;
  req: PermissionCardPayload;
  fields: SubmitField[];
}

export interface SwAttachmentsMessage {
  kind: "attachments";
  items: AttachmentInfo[];
}

export type SwToUiMessage =
  | SwHelloMessage
  | SwJournalSnapshotMessage
  | SwEventMessage
  | SwPermissionRequestMessage
  | SwPermissionCancelledMessage
  | SwSubmitRequestMessage
  | SwAttachmentsMessage;

// —— UI → SW 消息（Port 发送 + options 页 sendMessage 单发共用）——

export interface UiJournalAckMessage {
  kind: "journal-ack";
  seq: number;
}

export interface UiPermissionResolveMessage {
  kind: "permission-resolve";
  token: string;
  verdict: "allow-once" | "allow-always" | "deny";
}

export interface UiSubmitResolveMessage {
  kind: "submit-resolve";
  token: string;
  approved: boolean;
}

export interface UiControlMessage {
  kind: "control";
  action: "start" | "stop" | "pause" | "resume";
  /** action=start 时必填；其余 action 忽略 */
  task?: string;
}

export interface UiAttachmentAddMessage {
  kind: "attachment-add";
  name: string;
  mimeType: string;
  /** 附件字节（file.arrayBuffer() → base64；上限校验在 SW 注册表） */
  base64: string;
}

export interface UiAttachmentRemoveMessage {
  kind: "attachment-remove";
  attachmentId: string;
}

export interface UiSettingsChangedMessage {
  kind: "settings-changed";
}

export interface UiDiagMessage {
  kind: "diag";
  command: "echo" | "smoke:attach";
  payload?: unknown;
}

export type UiToSwMessage =
  | UiJournalAckMessage
  | UiPermissionResolveMessage
  | UiSubmitResolveMessage
  | UiControlMessage
  | UiAttachmentAddMessage
  | UiAttachmentRemoveMessage
  | UiSettingsChangedMessage
  | UiDiagMessage;
