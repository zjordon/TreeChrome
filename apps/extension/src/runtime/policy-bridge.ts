// policy-bridge（m5/04 §4.3）：PolicyInteraction 的侧边栏桥。requestPermission/
// confirmSubmit → journal 置 awaiting-* + 立即 flush → Port 广播确认卡（token）→
// 挂起 Promise；UI resolve（token 匹配）→ 放行。竞态护栏：同 token 二次 resolve
// 忽略。fail-closed 边界纪律：UI 无连接（sidepanel 关闭/未开）→ 立即 deny——
// 无人确认=拒绝；端口全断/run 停止 → 未决请求全部 deny。
// 超时收口（评审轮 1 [5]）：core PolicyGate 的 race 超时只放弃 interaction
// promise 不 settle——桥层在 gate 超时 + grace 后自兜底：删条目 + backToRunning +
// 广播 permission-cancelled + resolve deny，迟到 resolve 落入空表护栏。

import type { PermissionRequest, PermissionVerdict, SubmitFieldSummary } from "@tw/core";
import { CAPABILITY_LABEL, DEFAULT_PROMPT_TIMEOUT_MS } from "@tw/core";
import type {
  PermissionCardPayload,
  SubmitField,
  SwPermissionRequestMessage,
  SwSubmitRequestMessage,
  SwToUiMessage,
} from "@tw/protocol";
import type { RunJournal } from "./journal.js";

export type Broadcast = (message: SwToUiMessage) => void;
export type HasPorts = () => boolean;
export type NewToken = () => string;

/** 桥层过期相对 gate 超时的余量（gate race 先 settle，桥随后清场） */
const DEFAULT_EXPIRY_GRACE_MS = 1000;

interface PendingPermission {
  resolve: (verdict: PermissionVerdict) => void;
  cancelExpiry: () => void;
  /** 原始广播消息（重连补发用——expiresAt 是首次请求的墙上钟，重建会漂移） */
  message: SwPermissionRequestMessage;
}
interface PendingSubmit {
  resolve: (approved: boolean) => void;
  cancelExpiry: () => void;
  message: SwSubmitRequestMessage;
}

/** core PermissionRequest → UI 卡 payload（tabId 换扩展原生 number——绑 run 的
 *  tab；core 的 targetId 字符串不进 UI 面） */
export function toCardPayload(req: PermissionRequest, runTabId: number): PermissionCardPayload {
  return {
    capability: req.capability,
    host: req.host,
    actionName: req.actionName,
    params: req.params,
    tabId: runTabId,
    elementIndex: req.elementIndex,
    elementBbox: req.elementBbox,
    elementXpath: req.elementXpath,
    label: CAPABILITY_LABEL[req.capability],
    expiresAt: Date.now() + DEFAULT_PROMPT_TIMEOUT_MS,
  };
}

export class SidepanelPolicyBridge {
  private readonly journal: RunJournal;
  private readonly broadcast: Broadcast;
  private readonly hasPorts: HasPorts;
  private readonly newToken: NewToken;
  private readonly runTabId: number;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly pendingSubmits = new Map<string, PendingSubmit>();

  private readonly promptTimeoutMs: number;
  private readonly expiryGraceMs: number;

  constructor(options: {
    journal: RunJournal;
    broadcast: Broadcast;
    hasPorts: HasPorts;
    runTabId: number;
    newToken?: NewToken;
    /** 桥层过期计时（gate 同源超时 + grace；测试注入短值） */
    promptTimeoutMs?: number;
    expiryGraceMs?: number;
  }) {
    this.journal = options.journal;
    this.broadcast = options.broadcast;
    this.hasPorts = options.hasPorts;
    this.runTabId = options.runTabId;
    this.newToken = options.newToken ?? defaultToken;
    this.promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    this.expiryGraceMs = options.expiryGraceMs ?? DEFAULT_EXPIRY_GRACE_MS;
  }

  /** PolicyInteraction 面（PolicyGate 构造注入） */
  readonly interaction = {
    requestPermission: (req: PermissionRequest): Promise<PermissionVerdict> =>
      this.requestPermission(req),
    confirmSubmit: (req: PermissionRequest, summary: SubmitFieldSummary[]): Promise<boolean> =>
      this.confirmSubmit(req, summary),
  };

  async requestPermission(req: PermissionRequest): Promise<PermissionVerdict> {
    if (!this.hasPorts()) {
      return "deny"; // fail-closed：无人确认=拒绝
    }
    const token = this.newToken();
    this.journal.setStatus("awaiting-permission");
    const message: SwPermissionRequestMessage = {
      kind: "permission-request",
      token,
      req: toCardPayload(req, this.runTabId),
    };
    this.broadcast(message);
    return new Promise<PermissionVerdict>((resolve) => {
      const cancelExpiry = this.armPermissionExpiry(token, resolve);
      this.pendingPermissions.set(token, { resolve, cancelExpiry, message });
    });
  }

  async confirmSubmit(req: PermissionRequest, summary: SubmitFieldSummary[]): Promise<boolean> {
    if (!this.hasPorts()) {
      return false; // fail-closed 同款
    }
    const token = this.newToken();
    this.journal.setStatus("awaiting-submit");
    const message: SwSubmitRequestMessage = {
      kind: "submit-request",
      token,
      req: toCardPayload(req, this.runTabId),
      fields: summary as SubmitField[],
    };
    this.broadcast(message);
    return new Promise<boolean>((resolve) => {
      const cancelExpiry = this.armSubmitExpiry(token, resolve);
      this.pendingSubmits.set(token, { resolve, cancelExpiry, message });
    });
  }

  /** 未决确认卡原始消息（sidepanel 重连补发——port-server accept 消费） */
  pendingCards(): SwToUiMessage[] {
    return [
      ...[...this.pendingPermissions.values()].map((p) => p.message),
      ...[...this.pendingSubmits.values()].map((p) => p.message),
    ];
  }

  /** 桥层过期（gate 超时 + grace 后）：条目仍在 → 删条目 + backToRunning +
   *  permission-cancelled 广播 + deny——core race 超时不 settle interaction，
   *  桥不兜底则 journal 永停 awaiting-* 且迟到 resolve 命中残留条目 */
  private armPermissionExpiry(
    token: string,
    resolve: (verdict: PermissionVerdict) => void,
  ): () => void {
    const timer = setTimeout(() => {
      if (!this.pendingPermissions.has(token)) return;
      this.pendingPermissions.delete(token);
      this.backToRunning();
      this.broadcast({ kind: "permission-cancelled", token });
      resolve("deny");
    }, this.promptTimeoutMs + this.expiryGraceMs);
    return () => clearTimeout(timer);
  }

  private armSubmitExpiry(token: string, resolve: (approved: boolean) => void): () => void {
    const timer = setTimeout(() => {
      if (!this.pendingSubmits.has(token)) return;
      this.pendingSubmits.delete(token);
      this.backToRunning();
      resolve(false);
    }, this.promptTimeoutMs + this.expiryGraceMs);
    return () => clearTimeout(timer);
  }

  /** UI permission-resolve（token 匹配；二次 resolve 忽略） */
  resolvePermission(token: string, verdict: PermissionVerdict): void {
    const pending = this.pendingPermissions.get(token);
    if (pending === undefined) return;
    this.pendingPermissions.delete(token);
    pending.cancelExpiry();
    this.backToRunning();
    pending.resolve(verdict);
  }

  /** UI submit-resolve */
  resolveSubmit(token: string, approved: boolean): void {
    const pending = this.pendingSubmits.get(token);
    if (pending === undefined) return;
    this.pendingSubmits.delete(token);
    pending.cancelExpiry();
    this.backToRunning();
    pending.resolve(approved);
  }

  /** 端口全断：未决请求全部 deny（确认卡再也不会被答——fail-closed） */
  onAllPortsDisconnected(): void {
    this.cancelAll();
  }

  /** run 停止/中断/结束收口：未决确认全部 deny + 状态复位（run-manager 消费——
   *  agent.stop() 只置标志位，挂在 pending Promise 上的 run 要等这里才解除） */
  cancelAll(): void {
    for (const [token, pending] of this.pendingPermissions) {
      this.pendingPermissions.delete(token);
      pending.cancelExpiry();
      pending.resolve("deny");
    }
    for (const [token, pending] of this.pendingSubmits) {
      this.pendingSubmits.delete(token);
      pending.cancelExpiry();
      pending.resolve(false);
    }
    this.backToRunning();
  }

  private backToRunning(): void {
    if (
      this.journal.status === "awaiting-permission" ||
      this.journal.status === "awaiting-submit"
    ) {
      this.journal.setStatus("running");
    }
  }
}

function defaultToken(): string {
  return `tok_${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16)}`;
}
