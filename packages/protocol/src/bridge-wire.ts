// 桥↔扩展私线 wire 类型（issue #31 M1）：@tw/mcp-bridge（Node 桥）与
// apps/extension 的 SW bridge-runtime 共享的信封形状。纯类型零运行时（两侧各自
// 防御收窄——扩展既有惯例）；命名与语义对齐 qz /v1/qingzhou/* 私线（Apache-2.0）。

/** 扩展侧连接状态机（chrome.storage.local 键 tc_bridge 的 state 字段） */
export type BridgeConnectionState =
  | "disabled"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "paused";

/** 私线错误信封（桥↔扩展共用形态；code 见各响应/结果处的字面量约定） */
export interface BridgeWireError {
  code: string;
  message: string;
}

/** 扩展侧连接配置（chrome.storage.local 键 tc_bridge 的完整形状） */
export interface BridgeClientConfig {
  enabled: boolean;
  endpoint: string;
  /** 扩展生成、pair 时上报的配对令牌（base64url 32 字节）——仅存扩展与桥本地 */
  pairingToken: string;
  extensionId: string;
  name: string;
  /** SW 会话身份：每次冷启动新生成——桥侧据此次活动租约归属 */
  connectionId: string;
  /** 桥进程身份：变更 = 桥重启，扩展需 re-pair（token 幂等复用） */
  instanceId: string;
  state: BridgeConnectionState;
  lastError: BridgeWireError | null;
  connectedAt: number | null;
}

/** GET /health 响应（桥状态 + 配对邀请位） */
export interface BridgeHealthResponse {
  ok: true;
  service: "tc-bridge";
  protocolVersion: 1;
  instanceId: string;
  /** tc-bridge connect 发起且已被浏览器内点击确认的一次性配对邀请 */
  pendingPairing: boolean;
  status: Record<string, unknown>;
}

/** POST /v1/tc/pair 请求 */
export interface BridgePairRequest {
  /** connect URL 携带的一次性令牌（t 参数）——桥校验其已被用户在浏览器内确认 */
  t: string;
  extensionId: string;
  name: string;
  pairingToken: string;
  connectionId: string;
}

export interface BridgePairResponse {
  ok: true;
  instanceId: string;
  connectionId: string;
}

/** 桥→扩展的命令信封（poll 领取；M1 任务级三件 + 取消传播） */
export interface BridgeCommandRequest {
  id: string;
  method: BridgeCommandMethod;
  params: Record<string, unknown>;
  timeoutMs: number;
}

export type BridgeCommandMethod = "run_task" | "get_snapshot" | "stop_run" | "cancel_request";

/** POST /v1/tc/poll 请求体 */
export interface BridgePollRequest {
  connectionId: string;
  pairingToken: string;
  instanceId: string;
  pollTimeoutMs: number;
  maxBatch: number;
}

/** POST /v1/tc/poll 响应体（requests 为空 = 长轮询超时空手而归） */
export interface BridgePollResponse {
  requests: BridgeCommandRequest[];
  instanceId: string;
  connectionId: string;
}

/** 扩展→桥的结果回投（POST /v1/tc/result） */
export type BridgeCommandResult =
  | { requestId: string; ok: true; result: unknown; durationMs: number }
  | { requestId: string; ok: false; error: BridgeWireError; durationMs: number };

/** run_task 受理回执 */
export interface BridgeRunTaskResult {
  accepted: true;
  runId: string;
}

/** get_snapshot / watch_task 终态快照（camelCase，对齐 tc run 单 JSON 口径） */
export interface BridgeRunSnapshot {
  runId: string | null;
  status: string;
  isDone: boolean;
  isSuccessful: boolean | null;
  finalResult: string | null;
  stopReason: string | null;
  nSteps: number;
  errors: string[];
  lastUrl: string | null;
  /** 时间线尾部摘要（最近 N 条事件的紧凑投影） */
  timeline: Array<{ seq: number; type: string; summary: string }>;
}
