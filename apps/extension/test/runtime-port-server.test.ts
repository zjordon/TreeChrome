// port-server + message-router 单测（m5/04 §4.2/§1）：连接 hello（快照/null）/
// broadcast 多副本 / UI 消息路由分发 / 断连全断回调 / 非信封消息忽略 /
// sendMessage 单发 diag（echo + 异步）/settings-changed 分发。

import type { UiToSwMessage } from "@tw/protocol";
import { describe, expect, it } from "vitest";
import type { OnConnectApi, RuntimePort } from "../src/host/chrome-apis.js";
import { registerMessageRouter } from "../src/runtime/message-router.js";
import { PortServer } from "../src/runtime/port-server.js";

function fakePort(): RuntimePort & {
  inbox: unknown[];
  messageListeners: Array<(m: unknown) => void>;
  disconnectListeners: Array<(p: RuntimePort) => void>;
  emit(message: unknown): void;
  disconnect(): void;
} {
  const messageListeners: Array<(m: unknown) => void> = [];
  const disconnectListeners: Array<(p: RuntimePort) => void> = [];
  const inbox: unknown[] = [];
  const port: RuntimePort & {
    inbox: unknown[];
    messageListeners: Array<(m: unknown) => void>;
    disconnectListeners: Array<(p: RuntimePort) => void>;
    emit(message: unknown): void;
    disconnect(): void;
  } = {
    inbox,
    messageListeners,
    disconnectListeners,
    postMessage: (m) => inbox.push(m),
    onMessage: {
      addListener: (cb) => messageListeners.push(cb),
      removeListener: (cb) => {
        const i = messageListeners.indexOf(cb);
        if (i >= 0) messageListeners.splice(i, 1);
      },
    },
    onDisconnect: {
      addListener: (cb) => disconnectListeners.push(cb),
      removeListener: (cb) => {
        const i = disconnectListeners.indexOf(cb);
        if (i >= 0) disconnectListeners.splice(i, 1);
      },
    },
    emit: (message) => {
      for (const cb of [...messageListeners]) cb(message);
    },
    disconnect: () => {
      for (const cb of [...disconnectListeners]) cb(port);
    },
  };
  return port;
}

function fakeOnConnect() {
  const listeners: Array<(port: RuntimePort) => void> = [];
  const api: OnConnectApi = {
    addListener: (cb) => listeners.push(cb),
  };
  return {
    api,
    connect: (port: RuntimePort) => {
      for (const cb of listeners) cb(port);
    },
  };
}

function makeServer() {
  const onConnect = fakeOnConnect();
  const received: UiToSwMessage[] = [];
  const disconnected: number[] = [];
  const server = new PortServer(onConnect.api, {
    hello: () => ({ runId: "run_1", snapshot: { runId: "run_1" } as never }),
    onUiMessage: (m) => received.push(m),
    onAllPortsDisconnected: () => disconnected.push(1),
  });
  return { onConnect, received, disconnected, server };
}

describe("PortServer", () => {
  it("连接 → hello（runId + snapshot）；多副本 broadcast；断连全断回调一次", () => {
    const { onConnect, received, disconnected, server } = makeServer();
    const p1 = fakePort();
    onConnect.connect(p1);
    expect(p1.inbox[0]).toMatchObject({ kind: "hello", runId: "run_1" });
    expect(server.hasPorts).toBe(true);

    const p2 = fakePort();
    onConnect.connect(p2);
    server.broadcast({ kind: "attachments", items: [] });
    expect(p1.inbox[1]).toEqual({ kind: "attachments", items: [] });
    expect(p2.inbox[1]).toEqual({ kind: "attachments", items: [] });

    p1.disconnect();
    expect(server.hasPorts).toBe(true);
    expect(disconnected).toEqual([]);
    p2.disconnect();
    expect(server.hasPorts).toBe(false);
    expect(disconnected).toHaveLength(1);
    void received;
  });

  it("UI 消息路由：信封消息分发（薄委托——diag 也转发，run-manager 侧忽略）、非信封忽略", () => {
    const { onConnect, received } = makeServer();
    const port = fakePort();
    onConnect.connect(port);
    port.emit({ kind: "journal-ack", seq: 5 });
    port.emit({ kind: "control", action: "stop" });
    port.emit({ kind: "bogus" });
    port.emit("junk");
    port.emit({ kind: "diag", command: "echo" });
    expect(received).toEqual([
      { kind: "journal-ack", seq: 5 },
      { kind: "control", action: "stop" },
      { kind: "diag", command: "echo" },
    ]);
  });

  it("postMessage 竞态抛错不外溢（刚断端口）", () => {
    const { onConnect } = makeServer();
    const port = fakePort();
    Object.assign(port, {
      postMessage: () => {
        throw new Error("Attempting to use a disconnected port");
      },
    });
    expect(() => onConnect.connect(port)).not.toThrow();
  });
});

describe("registerMessageRouter", () => {
  function fakeOnMessage() {
    const listeners: Array<(m: unknown, s: unknown, r: (v: unknown) => void) => boolean> = [];
    return {
      api: {
        addListener: (cb: (m: unknown, s: unknown, r: (v: unknown) => void) => boolean) =>
          void listeners.push(cb),
      },
      dispatch: (m: unknown) => {
        let responded: unknown;
        let async = false;
        for (const cb of listeners) {
          const keepOpen = cb(m, {}, (v) => {
            responded = v;
          });
          async = async || keepOpen;
        }
        return { responded, async };
      },
    };
  }

  it("diag echo 同步应答；未知 diag 不应答；信封消息分发无应答", () => {
    const bus = fakeOnMessage();
    const uiMessages: UiToSwMessage[] = [];
    registerMessageRouter(bus.api, {
      onUiMessage: (m) => uiMessages.push(m),
      onDiag: (command, payload, sendResponse) => {
        if (command === "echo") {
          sendResponse({ ok: true, command: "echo", payload: payload ?? null });
          return false;
        }
        return false;
      },
    });
    const echo = bus.dispatch({ kind: "diag", command: "echo", payload: "p" });
    expect(echo.responded).toEqual({ ok: true, command: "echo", payload: "p" });
    expect(echo.async).toBe(false);
    expect(bus.dispatch({ kind: "diag", command: "smoke:attach" }).responded).toBeUndefined();
    const settings = bus.dispatch({ kind: "settings-changed" });
    expect(settings.responded).toBeUndefined();
    expect(uiMessages).toEqual([{ kind: "settings-changed" }]);
    expect(bus.dispatch("junk").responded).toBeUndefined();
  });
});
