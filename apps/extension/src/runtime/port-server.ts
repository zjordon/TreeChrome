// port-server（m5/04 §4.2）：runtime.onConnect 监听 + @tw/protocol 信封路由。
// 多 sidepanel 副本同连 → 广播；断连不中断 run（全断才回调——policy-bridge 收口
// 未决确认）。sidepanel（重）连 → hello（runId/snapshot——无活 run 时 null）。
// 薄委托面：UI 消息校验后整条交 onUiMessage（run-manager 分发 journal.ack /
// bridge.resolve / control / attachments）——端口集合与生命周期解耦。

import type { RunJournalSnapshot, SwToUiMessage, UiToSwMessage } from "@tw/protocol";
import { UI_TO_SW_KINDS } from "@tw/protocol";
import type { OnConnectApi, RuntimePort } from "../host/chrome-apis.js";

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
}

export class PortServer {
  private readonly ports = new Set<RuntimePort>();
  private readonly deps: PortServerDeps;
  private readonly onMessage = (message: unknown): void => {
    if (isUiToSwMessage(message)) this.deps.onUiMessage(message);
  };

  constructor(onConnect: OnConnectApi, deps: PortServerDeps) {
    this.deps = deps;
    onConnect.addListener((port) => this.accept(port));
  }

  private accept(port: RuntimePort): void {
    this.ports.add(port);
    port.onMessage.addListener(this.onMessage);
    port.onDisconnect.addListener(() => {
      this.ports.delete(port);
      if (this.ports.size === 0) this.deps.onAllPortsDisconnected();
    });
    const { runId, snapshot } = this.deps.hello();
    this.post(port, { kind: "hello", runId, snapshot });
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
