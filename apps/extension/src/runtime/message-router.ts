// message-router（m5/04 §1 → m5/05 段 E 扩 options 面）：runtime.sendMessage 单发
// 路由（options 页无 Port——options 请求-应答单发；diag 命令沿用段 B 形态）。
// Port 信封消息不走此通道（port-server 面）；返回 true = 异步应答通道保持打开。

import type { OptionsOp } from "@tw/protocol";
import { isUiToSwMessage } from "./port-server.js";

export interface MessageRouterDeps {
  /** UI 消息统一分发（run-manager.handleUiMessage——Port 与单发同源） */
  onUiMessage: (message: import("@tw/protocol").UiToSwMessage) => void;
  /** diag 命令处理（段 B 冒烟通道；同步/异步应答由处理方决定） */
  onDiag: (command: string, payload: unknown, sendResponse: (response: unknown) => void) => boolean;
  /** options 请求-应答（段 E：get-settings/save-settings/grants/skills/test-card） */
  onOptions?: (
    op: OptionsOp,
    payload: unknown,
    sendResponse: (response: unknown) => void,
  ) => boolean;
}

export function registerMessageRouter(
  onMessage: {
    addListener(
      callback: (message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean,
    ): void;
  },
  deps: MessageRouterDeps,
): void {
  onMessage.addListener((message, _sender, sendResponse) => {
    const asEnv = message as { kind?: unknown; command?: unknown; op?: unknown };
    if (asEnv !== null && typeof asEnv === "object" && asEnv.kind === "diag") {
      const command = typeof asEnv.command === "string" ? asEnv.command : "";
      return deps.onDiag(command, (message as { payload?: unknown }).payload, sendResponse);
    }
    if (
      asEnv !== null &&
      typeof asEnv === "object" &&
      asEnv.kind === "options" &&
      deps.onOptions !== undefined
    ) {
      const op = typeof asEnv.op === "string" ? (asEnv.op as OptionsOp) : ("" as OptionsOp);
      return deps.onOptions(op, (message as { payload?: unknown }).payload, sendResponse);
    }
    if (isUiToSwMessage(message)) {
      deps.onUiMessage(message);
      return false; // 单发 UI 消息无需应答
    }
    return false;
  });
}
