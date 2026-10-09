// port-server（m5/04 §4.2 → m5/05 §2 宽限窗）：runtime.onConnect 监听 +
// @tw/protocol 信封路由。多 sidepanel 副本同连 → 广播；断连不中断 run。
// 全断收口（→ bridge deny 未决确认）延迟 RECONNECT_GRACE_MS：面板关闭→重开是
// 「awaiting-* 期间竖卡重弹」的主路径（评审轮 1 [11]：立即收口则重开时
// pendingCards 已空、补发链路只剩多副本语义）；宽限窗内重连成功即撤销待收口，
// 超窗才 fail-closed——只推迟收口时点，无人确认=拒绝的边界纪律不变。
// sidepanel（重）连 → hello（runId/snapshot——无活 run 时 null）+ 挂起卡补发。
// 薄委托面：UI 消息校验后整条交 onUiMessage（run-manager 分发）。

import type { RunJournalSnapshot, SwToUiMessage, UiToSwMessage } from "@tw/protocol";
import { UI_TO_SW_KINDS } from "@tw/protocol";
import type { OnConnectApi, RuntimePort } from "../host/chrome-apis.js";

/** 全断→deny 的宽限窗（≥ PortClient 首轮退避 1s + SW 冷启动重连余量） */
export const RECONNECT_GRACE_MS = 2000;

export function isUiToSwMessage(v: unknown): v is UiToSwMessage {
  if (typeof v !== "object" || v === null) return false;
  const kind = (v as { kind?: unknown }).kind;
  return typeof kind === "string" && (UI_TO_SW_KINDS as readonly string[]).includes(kind);
}

export interface PortServerDeps {
  /** 连接时 hello 载荷（无活 run → null/null） */
  hello: () => { runId: string | null; snapshot: RunJournalSnapshot | null };
  /** UI → SW 消息分发（run-manager 实现） */
  onUiMessage: (message: UiToSwMessage) => void;
  /** 全部端口断连（policy-bridge 未决请求收口） */
  onAllPortsDisconnected: () => void;
  /** 未决确认卡（sidepanel 重连补发——m5/05 §2：awaiting-* 期间重开面板竖卡重弹） */
  pendingCards?: () => SwToUiMessage[];
}

export class PortServer {
  private readonly ports = new Set<RuntimePort>();
  private readonly deps: PortServerDeps;
  private teardownTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onMessage = (message: unknown): void => {
    if (isUiToSwMessage(message)) this.deps.onUiMessage(message);
  };

  constructor(onConnect: OnConnectApi, deps: PortServerDeps) {
    this.deps = deps;
    onConnect.addListener((port) => this.accept(port));
  }

  private accept(port: RuntimePort): void {
    this.ports.add(port);
    // 宽限窗内重连：撤销待收口（补发链路恢复可达）
    if (this.teardownTimer !== null) {
      clearTimeout(this.teardownTimer);
      this.teardownTimer = null;
    }
    port.onMessage.addListener(this.onMessage);
    port.onDisconnect.addListener(() => {
      this.ports.delete(port);
      if (this.ports.size === 0 && this.teardownTimer === null) {
        this.teardownTimer = setTimeout(() => {
          this.teardownTimer = null;
          this.deps.onAllPortsDisconnected();
        }, RECONNECT_GRACE_MS);
      }
    });
    const { runId, snapshot } = this.deps.hello();
    this.post(port, { kind: "hello", runId, snapshot });
    // 挂起确认卡补发（原样重放——expiresAt 保持首次请求墙上钟，倒计时真实）
    for (const card of this.deps.pendingCards?.() ?? []) this.post(port, card);
  }

  /** 广播（journal 事件流/确认卡/attachments——发给全部连接副本） */
  broadcast(message: SwToUiMessage): void {
    for (const port of this.ports) this.post(port, message);
  }

  get hasPorts(): boolean {
    return this.ports.size > 0;
  }

  private post(port: RuntimePort, message: unknown): void {
    try {
      port.postMessage(message);
    } catch {
      // 端口刚断（postMessage 竞态）——onDisconnect 随后清出集合
    }
  }
}
