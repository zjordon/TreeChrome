// 桥状态机（issue #31 M1 P1）：配对（一次性邀请 t + 令牌双向核验 + 落盘免再确认）、
// 单扩展租约（先到先得，后者 BRIDGE_CLIENT_IN_USE）、命令队列（长轮询领取 + 结果
// 回投 + 超时/中断）。移植 qz-browser-agent BridgeState 语义（Apache-2.0），裁剪为
// 单扩展形态：无多浏览器注册表、无 rename、无 Firefox 唤醒面。全注入（now/random/
// 持久化）——单测零真定时器依赖由 fake timers 承担。

import type {
  BridgeCommandMethod,
  BridgeCommandRequest,
  BridgeCommandResult,
  BridgePairRequest,
  BridgePairResponse,
  BridgePollRequest,
  BridgePollResponse,
} from "@tw/protocol";

export const DEFAULT_COMMAND_TIMEOUT_MS = 180_000;
export const DEFAULT_POLL_TIMEOUT_MS = 25_000;
const MIN_POLL_TIMEOUT_MS = 1_000;
const MAX_POLL_TIMEOUT_MS = 50_000;
/** 配对邀请有效期（tc-bridge connect 打印 URL 后用户有 10 分钟打开它） */
export const PAIRING_TTL_MS = 10 * 60_000;
/** 最近一次 poll 在此窗口内视为「已连接」 */
const CONNECTED_GRACE_MS = 45_000;

/** 私线流错误：code 供扩展状态机分流；status 为 HTTP 映射（缺省 409） */
export class BridgeStateError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface PairingRecord {
  pairingToken: string;
  extensionId: string;
  name: string;
}

/** 配对落盘面（桥重启免再确认；~/.tc/bridge/pairing.json 的注入抽象） */
export interface BridgePairingStore {
  load(): Promise<PairingRecord | null>;
  save(record: PairingRecord): Promise<void>;
  remove(): Promise<void>;
}

export interface BridgeStatus {
  paired: boolean;
  connected: boolean;
  pendingPairing: boolean;
  queueDepth: number;
  inflight: number;
  lastPollAt: number | null;
}

export interface BridgeStateDeps {
  instanceId: string;
  now(): number;
  randomId(): string;
  randomToken(): string;
  pairingStore: BridgePairingStore;
  log?(message: string): void;
}

interface PendingInvitation {
  t: string;
  expiresAt: number;
}

interface PairedClient {
  pairingToken: string;
  extensionId: string;
  name: string;
  connectionId: string;
}

interface InflightCommand {
  request: BridgeCommandRequest;
  resolve: (value: unknown) => void;
  reject: (error: BridgeStateError) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PollWaiter {
  maxBatch: number;
  deliver: (requests: BridgeCommandRequest[]) => void;
  abort: () => void;
}

export function clampPollTimeoutMs(value: number): number {
  return Math.max(MIN_POLL_TIMEOUT_MS, Math.min(MAX_POLL_TIMEOUT_MS, value));
}

export class BridgeState {
  private invitation: PendingInvitation | null = null;
  private pairedState: PairedClient | null = null;
  private readonly queue: BridgeCommandRequest[] = [];
  private readonly inflight = new Map<string, InflightCommand>();
  private readonly waiters = new Set<PollWaiter>();
  private lastPollAt: number | null = null;
  private readonly deps: BridgeStateDeps;

  constructor(deps: BridgeStateDeps) {
    this.deps = deps;
  }

  /** 加载落盘配对（serve 启动时调用一次；桥重启后扩展凭原 token 直接 re-pair） */
  async init(): Promise<void> {
    const record = await this.deps.pairingStore.load();
    if (record === null) return;
    this.pairedState = { ...record, connectionId: "" };
    this.deps.log?.(`[bridge] pairing restored: ${record.extensionId}`);
  }

  get paired(): boolean {
    return this.pairedState !== null;
  }

  /** 发起一次性配对邀请（CLI /admin/pairing → 打印 URL） */
  beginPairing(): { t: string; expiresAt: number } {
    const t = this.deps.randomToken();
    this.invitation = { t, expiresAt: this.deps.now() + PAIRING_TTL_MS };
    return { t, expiresAt: this.invitation.expiresAt };
  }

  /** connect 页轮询的配对进度（同源限定端点消费） */
  pairingStatus(t: string): { ok: true; paired: boolean; expiresAt: number | null } {
    if (this.pairedState !== null) return { ok: true, paired: true, expiresAt: null };
    const invitation = this.invitation;
    const valid =
      invitation !== null && invitation.t === t && invitation.expiresAt >= this.deps.now();
    return {
      ok: true,
      paired: false,
      expiresAt: valid && invitation !== null ? invitation.expiresAt : null,
    };
  }

  async pair(request: BridgePairRequest): Promise<BridgePairResponse> {
    const current = this.pairedState;
    // re-pair：桥重启后扩展凭原 token 直接恢复（token 持有即证明，无需用户再确认）
    const rePair = current !== null && current.pairingToken === request.pairingToken;
    if (!rePair) {
      const invitation = this.invitation;
      if (
        invitation === null ||
        invitation.t !== request.t ||
        invitation.expiresAt < this.deps.now()
      ) {
        throw new BridgeStateError(
          "BRIDGE_PAIRING_REQUIRED",
          "No valid pairing invitation. Run tc-bridge connect and open the printed URL in this browser.",
        );
      }
      if (current !== null) {
        throw new BridgeStateError(
          "BRIDGE_CLIENT_IN_USE",
          "Another extension is already paired. Disconnect it first.",
        );
      }
      this.invitation = null;
    }
    this.pairedState = {
      pairingToken: request.pairingToken,
      extensionId: request.extensionId,
      name: request.name,
      connectionId: request.connectionId,
    };
    await this.deps.pairingStore.save({
      pairingToken: request.pairingToken,
      extensionId: request.extensionId,
      name: request.name,
    });
    this.deps.log?.(`[bridge] paired: ${request.extensionId}`);
    return { ok: true, instanceId: this.deps.instanceId, connectionId: request.connectionId };
  }

  async disconnect(pairingToken: string): Promise<void> {
    const current = this.pairedState;
    if (current === null || current.pairingToken !== pairingToken) {
      throw new BridgeStateError("BRIDGE_PAIRING_REQUIRED", "Not paired with this token.");
    }
    this.pairedState = null;
    this.lastPollAt = null;
    await this.deps.pairingStore.remove();
    this.deps.log?.("[bridge] disconnected");
  }

  /** MCP 调用入队：扩展领走执行、回投结果后 settle；超时/中断拒绝 */
  enqueue(
    method: BridgeCommandMethod,
    params: Record<string, unknown>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (options.signal?.aborted) {
      return Promise.reject(new BridgeStateError("INTERRUPTED", "The operation was cancelled."));
    }
    return new Promise((resolve, reject) => {
      const id = this.deps.randomId();
      const request: BridgeCommandRequest = { id, method, params, timeoutMs };
      const drop = (error: BridgeStateError): void => {
        this.removeFromQueue(id);
        const entry = this.inflight.get(id);
        if (entry === undefined) return;
        this.inflight.delete(id);
        clearTimeout(entry.timer);
        reject(error);
      };
      const timer = setTimeout(() => {
        drop(new BridgeStateError("BRIDGE_REQUEST_TIMEOUT", "The browser operation timed out."));
      }, timeoutMs);
      timer.unref?.();
      this.inflight.set(id, { request, resolve, reject, timer });
      this.queue.push(request);
      this.wakeWaiters();
      options.signal?.addEventListener(
        "abort",
        () => {
          // 立刻失权并通知扩展撤销在途副作用（qz cancel_request 同款：只撤这一条）
          drop(new BridgeStateError("INTERRUPTED", "The browser operation was interrupted."));
          this.pushControl("cancel_request", { requestId: id });
        },
        { once: true },
      );
    });
  }

  /** 扩展长轮询：立即领批或挂起等待（pollTimeoutMs 截止空手而归；断连即让位） */
  async poll(request: BridgePollRequest, signal: AbortSignal): Promise<BridgePollResponse> {
    const current = this.requirePaired(request);
    this.lastPollAt = this.deps.now();
    current.connectionId = request.connectionId;
    const timeoutMs = clampPollTimeoutMs(request.pollTimeoutMs || DEFAULT_POLL_TIMEOUT_MS);
    const maxBatch = Math.max(1, Math.min(8, request.maxBatch || 4));
    const immediate = this.takeBatch(maxBatch);
    if (immediate.length > 0) return this.pollResponse(immediate);

    return await new Promise<BridgePollResponse>((resolve) => {
      const waiter: PollWaiter = {
        maxBatch,
        deliver: (requests) => {
          cleanup();
          resolve(this.pollResponse(requests));
        },
        abort: () => {
          cleanup();
          resolve(this.pollResponse([]));
        },
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", waiter.abort);
        this.waiters.delete(waiter);
      };
      const timer = setTimeout(() => waiter.abort(), timeoutMs);
      timer.unref?.();
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.add(waiter);
    });
  }

  /** 扩展结果回投；未知/已结算 requestId 返回 false */
  complete(result: BridgeCommandResult): boolean {
    const entry = this.inflight.get(result.requestId);
    if (entry === undefined) return false;
    this.inflight.delete(result.requestId);
    clearTimeout(entry.timer);
    if (result.ok) {
      entry.resolve(result.result);
    } else {
      entry.reject(new BridgeStateError(result.error.code, result.error.message));
    }
    return true;
  }

  status(): BridgeStatus {
    const now = this.deps.now();
    const invitation = this.invitation;
    return {
      paired: this.pairedState !== null,
      connected:
        this.pairedState !== null &&
        this.lastPollAt !== null &&
        now - this.lastPollAt < CONNECTED_GRACE_MS,
      pendingPairing: invitation !== null && invitation.expiresAt >= now,
      queueDepth: this.queue.length,
      inflight: this.inflight.size,
      lastPollAt: this.lastPollAt,
    };
  }

  /** poll 鉴权并返回已配对记录（token + instanceId 双核验） */
  private requirePaired(request: BridgePollRequest): PairedClient {
    const current = this.pairedState;
    if (current === null || request.pairingToken !== current.pairingToken) {
      throw new BridgeStateError(
        "BRIDGE_PAIRING_REQUIRED",
        "Not paired. Run tc-bridge connect and open the printed URL in this browser.",
      );
    }
    if (request.instanceId !== this.deps.instanceId) {
      throw new BridgeStateError(
        "BRIDGE_INSTANCE_CHANGED",
        "The bridge restarted. Re-pairing with the stored token.",
      );
    }
    return current;
  }

  /** 控制命令（cancel_request）直接入队唤醒轮询——不进 inflight（无结果预期） */
  private pushControl(method: BridgeCommandMethod, params: Record<string, unknown>): void {
    this.queue.push({ id: this.deps.randomId(), method, params, timeoutMs: 15_000 });
    this.wakeWaiters();
  }

  private takeBatch(maxBatch: number): BridgeCommandRequest[] {
    return this.queue.splice(0, maxBatch);
  }

  private wakeWaiters(): void {
    for (const waiter of this.waiters) {
      if (this.queue.length === 0) return;
      waiter.deliver(this.takeBatch(waiter.maxBatch));
    }
  }

  private removeFromQueue(id: string): void {
    const index = this.queue.findIndex((request) => request.id === id);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private pollResponse(requests: BridgeCommandRequest[]): BridgePollResponse {
    return {
      requests,
      instanceId: this.deps.instanceId,
      connectionId: this.pairedState?.connectionId ?? "",
    };
  }
}
