// policy-bridge（m5/04 §4.3）：PolicyInteraction 的侧边栏桥。requestPermission/
// confirmSubmit → journal 置 awaiting-* + 立即 flush → Port 广播确认卡（token）→
// 挂起 Promise；UI resolve（token 匹配）→ 放行。竞态护栏：同 token 二次 resolve
// 忽略。fail-closed 边界纪律：UI 无连接（sidepanel 关闭/未开）→ 立即 deny——
// 无人确认=拒绝；端口全断 → 未决请求全部 deny。PolicyGate 自带 300s prompt 超时
// 兜底（core 既有）——桥层不重复计时。

import type { PermissionRequest, PermissionVerdict, SubmitFieldSummary } from "@tw/core";
import { CAPABILITY_LABEL, DEFAULT_PROMPT_TIMEOUT_MS } from "@tw/core";
import type { PermissionCardPayload, SubmitField, SwToUiMessage } from "@tw/protocol";
import type { RunJournal } from "./journal.js";

export type Broadcast = (message: SwToUiMessage) => void;
export type HasPorts = () => boolean;
export type NewToken = () => string;

interface PendingPermission {
  resolve: (verdict: PermissionVerdict) => void;
}
interface PendingSubmit {
  resolve: (approved: boolean) => void;
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

  constructor(options: {
    journal: RunJournal;
    broadcast: Broadcast;
    hasPorts: HasPorts;
    runTabId: number;
    newToken?: NewToken;
  }) {
    this.journal = options.journal;
    this.broadcast = options.broadcast;
    this.hasPorts = options.hasPorts;
    this.runTabId = options.runTabId;
    this.newToken = options.newToken ?? defaultToken;
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
    this.broadcast({ kind: "permission-request", token, req: toCardPayload(req, this.runTabId) });
    return new Promise<PermissionVerdict>((resolve) => {
      this.pendingPermissions.set(token, { resolve });
    });
  }

  async confirmSubmit(req: PermissionRequest, summary: SubmitFieldSummary[]): Promise<boolean> {
    if (!this.hasPorts()) {
      return false; // fail-closed 同款
    }
    const token = this.newToken();
    this.journal.setStatus("awaiting-submit");
    this.broadcast({
      kind: "submit-request",
      token,
      req: toCardPayload(req, this.runTabId),
      fields: summary as SubmitField[],
    });
    return new Promise<boolean>((resolve) => {
      this.pendingSubmits.set(token, { resolve });
    });
  }

  /** UI permission-resolve（token 匹配；二次 resolve 忽略） */
  resolvePermission(token: string, verdict: PermissionVerdict): void {
    const pending = this.pendingPermissions.get(token);
    if (pending === undefined) return;
    this.pendingPermissions.delete(token);
    this.backToRunning();
    pending.resolve(verdict);
  }

  /** UI submit-resolve */
  resolveSubmit(token: string, approved: boolean): void {
    const pending = this.pendingSubmits.get(token);
    if (pending === undefined) return;
    this.pendingSubmits.delete(token);
    this.backToRunning();
    pending.resolve(approved);
  }

  /** 端口全断：未决请求全部 deny（确认卡再也不会被答——fail-closed） */
  onAllPortsDisconnected(): void {
    for (const [token, pending] of this.pendingPermissions) {
      this.pendingPermissions.delete(token);
      pending.resolve("deny");
    }
    for (const [token, pending] of this.pendingSubmits) {
      this.pendingSubmits.delete(token);
      pending.resolve(false);
    }
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
