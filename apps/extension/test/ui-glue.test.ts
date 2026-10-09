// ui-glue 适配器单测（m5/05 §4）：PortClient 断线重连指数退避/在线态/send 竞态、
// sidepanel reducer（hello 全量重建/live event 投影去重/ack 回发序号/确认卡对
// token 的 cancelled 匹配与乐观清除）、attachment-file 分块 base64（>0x8000 路
// 径）、message-router options 分支（异步应答通道）。

import type { SwToUiMessage, UiToSwMessage } from "@tw/protocol";
import { describe, expect, it, vi } from "vitest";
import { registerMessageRouter } from "../src/runtime/message-router.js";
import { fileToBase64 } from "../src/ui-glue/attachment-file.js";
import { PortClient, type UiPort } from "../src/ui-glue/port-client.js";
import {
  ingestSidepanel,
  initialSidepanelState,
  liveEventToJournal,
} from "../src/ui-glue/sidepanel-state.js";

/** 脚本化 fake Port：构造即在线；disconnect() 触发监听器（模拟 SW 被杀） */
function fakePort(): UiPort & { disconnect(): void; sent: UiToSwMessage[] } {
  const sent: UiToSwMessage[] = [];
  const messageListeners: Array<(m: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  return {
    sent,
    disconnect() {
      for (const cb of disconnectListeners) cb();
    },
    postMessage(m) {
      sent.push(m);
    },
    onMessage: { addListener: (cb) => void messageListeners.push(cb) },
    onDisconnect: { addListener: (cb) => void disconnectListeners.push(cb) },
  };
}

describe("PortClient 重连", () => {
  it("断线 → 退避重连（注入定时器控制）→ 在线复位 attempt；send 无连接 false", async () => {
    vi.useFakeTimers();
    try {
      const ports: ReturnType<typeof fakePort>[] = [];
      const statuses: string[] = [];
      const messages: SwToUiMessage[] = [];
      const client = new PortClient({
        connect: () => {
          const p = fakePort();
          ports.push(p);
          return p;
        },
        onMessage: (m) => void messages.push(m),
        onStatus: (s) => void statuses.push(s),
      });
      client.connect();
      expect(statuses).toEqual(["connecting", "online"]);
      expect(client.online).toBe(true);
      expect(client.send({ kind: "journal-ack", seq: 1 })).toBe(true);

      ports[0].disconnect(); // SW 被杀
      expect(statuses).toEqual(["connecting", "online", "offline"]);
      expect(client.online).toBe(false);
      expect(client.send({ kind: "journal-ack", seq: 2 })).toBe(false);

      vi.advanceTimersByTime(1000); // 第 1 次退避 1s
      expect(ports).toHaveLength(2);
      expect(statuses).toEqual(["connecting", "online", "offline", "connecting", "online"]);

      ports[1].disconnect();
      vi.advanceTimersByTime(999); // 重连成功后 attempt 归零——下次退避又是 1s
      expect(ports).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(ports).toHaveLength(3);

      client.dispose();
      ports[2].disconnect(); // dispose 后不再重连
      vi.advanceTimersByTime(30_000);
      expect(ports).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("postMessage 抛出（端口竞态）→ send false 不炸", () => {
    const bad: UiPort = {
      postMessage() {
        throw new Error("Attempting to use a disconnected port object");
      },
      onMessage: { addListener: () => {} },
      onDisconnect: { addListener: () => {} },
    };
    const client = new PortClient({ connect: () => bad, onMessage: () => {} });
    client.connect();
    expect(client.send({ kind: "control", action: "stop" })).toBe(false);
  });
});

describe("sidepanel reducer", () => {
  const snap = (seq: number, runId = "r1"): never =>
    ({
      runId,
      tabId: 1,
      status: "running",
      seq,
      ackedSeq: 0,
      discardedBeforeSeq: 0,
      events: [],
      task: "t",
      startedAt: 1,
      endedAt: null,
      finalResult: null,
      isDone: false,
      isSuccessful: null,
      stepCount: 1,
      lastError: null,
      attachments: [],
    }) as never;

  it("hello 建立基线（快照事件/附件）；同 run journal-snapshot 只更新视图", () => {
    let { state } = ingestSidepanel(initialSidepanelState, {
      kind: "hello",
      runId: "r1",
      snapshot: {
        ...snap(3),
        events: [{ seq: 1, type: "step_start", step: 1, ts: 1, data: {} }],
        attachments: [{ attachmentId: "att_1", name: "a", mimeType: "m", size: 1 }],
      },
    });
    expect(state.events).toHaveLength(1);
    expect(state.attachments).toHaveLength(1);
    state = ingestSidepanel(state, { kind: "journal-snapshot", snapshot: snap(4) }).state;
    expect(state.snapshot?.seq).toBe(4);
    expect(state.events).toHaveLength(1); // live 流不清
  });

  it("hello 同 run 重连：未 ack 尾巴合入（SW 裁剪快照不销毁本地时间线）", () => {
    let state = ingestSidepanel(initialSidepanelState, {
      kind: "hello",
      runId: "r1",
      snapshot: {
        ...snap(2),
        events: [
          { seq: 1, type: "step_start", step: 1, ts: 1, data: {} },
          { seq: 2, type: "tool_call", step: 1, ts: 2, data: {} },
        ],
      },
    }).state;
    // SW 死亡重连：hello 只带 ack 剪剩的尾巴（seq 2）——本地 1..2 必须保留
    state = ingestSidepanel(state, {
      kind: "hello",
      runId: "r1",
      snapshot: { ...snap(2), events: [{ seq: 2, type: "tool_call", step: 1, ts: 2, data: {} }] },
    }).state;
    expect(state.events.map((e) => e.seq)).toEqual([1, 2]);
    // 换 run：全量重建（新 run 起始快照 events 为空）
    state = ingestSidepanel(state, { kind: "hello", runId: "r2", snapshot: snap(0, "r2") }).state;
    expect(state.events).toEqual([]);
    expect(state.snapshot?.runId).toBe("r2");
  });

  it("journal-snapshot 换 run 全量重建（begin 重置 seq——旧 run 不得吞新事件）", () => {
    let state = ingestSidepanel(initialSidepanelState, {
      kind: "hello",
      runId: "r1",
      snapshot: {
        ...snap(2),
        events: [{ seq: 2, type: "tool_call", step: 1, ts: 2, data: {} }],
      },
    }).state;
    // 新 run 起始快照（begin 后广播，runId 不同）→ 重建空时间线
    state = ingestSidepanel(state, { kind: "journal-snapshot", snapshot: snap(0, "r2") }).state;
    expect(state.events).toEqual([]);
    expect(state.snapshot?.runId).toBe("r2");
  });

  it("live event 投影 + ack 序号 + seq 去重（重连补发窗口）", () => {
    const event = { eventType: "tool_result", step: 1, success: true } as never;
    const first = ingestSidepanel(initialSidepanelState, { kind: "event", seq: 5, event });
    expect(first.ack).toBe(5);
    expect(first.state.events[0]).toMatchObject({
      seq: 5,
      type: "tool_result",
      data: { success: true },
    });
    // 同 seq（补发重叠）与更旧 seq：跳过且不 ack
    expect(ingestSidepanel(first.state, { kind: "event", seq: 5, event }).ack).toBeNull();
    expect(ingestSidepanel(first.state, { kind: "event", seq: 4, event }).ack).toBeNull();
    const next = ingestSidepanel(first.state, { kind: "event", seq: 6, event });
    expect(next.ack).toBe(6);
    expect(next.state.events).toHaveLength(2);
  });

  it("确认卡：token 匹配的 cancelled 才清；乐观清除动作", () => {
    const req = {
      capability: "CLICK",
      host: "a.example",
      actionName: "click",
      params: {},
      tabId: 1,
      elementIndex: null,
      elementBbox: null,
      elementXpath: null,
      label: "点击",
      expiresAt: 9,
    };
    let { state } = ingestSidepanel(initialSidepanelState, {
      kind: "permission-request",
      token: "tok_1",
      req,
    });
    expect(state.permission?.token).toBe("tok_1");
    state = ingestSidepanel(state, { kind: "permission-cancelled", token: "tok_other" }).state;
    expect(state.permission).not.toBeNull(); // 他 token 不误清
    state = ingestSidepanel(state, { kind: "permission-cancelled", token: "tok_1" }).state;
    expect(state.permission).toBeNull();
    state = ingestSidepanel(state, {
      kind: "submit-request",
      token: "tok_2",
      req,
      fields: [],
    }).state;
    expect(state.submit?.token).toBe("tok_2");
    state = ingestSidepanel(state, { kind: "submit-resolved" }).state;
    expect(state.submit).toBeNull();
  });

  it("liveEventToJournal：压缩投影形态（与 journal 快照同一渲染面）", () => {
    const entry = liveEventToJournal(
      9,
      {
        eventType: "anomaly",
        step: 2,
        rule: "loop",
        severity: "warning",
        description: "d",
      } as never,
      1234,
    );
    expect(entry).toEqual({
      seq: 9,
      type: "anomaly",
      ts: 1234,
      data: { step: 2, rule: "loop", severity: "warning", description: "d" },
    });
  });
});

describe("fileToBase64", () => {
  it("分块编码（>0x8000 路径不炸调用栈）+ 往返", async () => {
    const n = 0x8000 + 100;
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = i % 251;
    const file = new File([bytes], "big.bin", { type: "application/octet-stream" });
    const b64 = await fileToBase64(file);
    const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(back).toEqual(bytes);
  });
});

describe("message-router options 分支", () => {
  it("kind=options → onOptions 异步应答（true 保通道）；无 onOptions 落空", async () => {
    const listeners: Array<(m: unknown, s: unknown, r: (v: unknown) => void) => boolean> = [];
    const seen: Array<{ op: string; payload: unknown }> = [];
    registerMessageRouter(
      { addListener: (cb) => void listeners.push(cb) },
      {
        onUiMessage: () => {},
        onDiag: () => false,
        onOptions: (op, payload, sendResponse) => {
          seen.push({ op, payload });
          void Promise.resolve().then(() => sendResponse({ ok: true, via: "options" }));
          return true;
        },
      },
    );
    let response: unknown;
    const keep = listeners[0](
      { kind: "options", op: "list-grants", payload: { x: 1 } },
      null,
      (r) => {
        response = r;
      },
    );
    expect(keep).toBe(true);
    expect(seen).toEqual([{ op: "list-grants", payload: { x: 1 } }]);
    await Promise.resolve();
    expect(response).toEqual({ ok: true, via: "options" });

    // 无 onOptions 注入：消息落空（不炸、不保持通道）
    const listeners2: Array<(m: unknown, s: unknown, r: (v: unknown) => void) => boolean> = [];
    registerMessageRouter(
      { addListener: (cb) => void listeners2.push(cb) },
      {
        onUiMessage: () => {},
        onDiag: () => false,
      },
    );
    expect(listeners2[0]({ kind: "options", op: "get-settings" }, null, () => {})).toBe(false);
  });
});

describe("createMutationQueue（revoke 读-改-写串行化，评审轮 1 [12]）", () => {
  it("并发变更排队执行（无交错）；前序失败不阻塞后续", async () => {
    const { createMutationQueue } = await import("../src/runtime/mutation-queue.js");
    const enq = createMutationQueue();
    const order: string[] = [];
    const job = (name: string, ms: number, fail = false): Promise<string> =>
      enq(
        () =>
          new Promise<string>((resolve, reject) => {
            setTimeout(() => {
              order.push(name);
              if (fail) reject(new Error(`${name} failed`));
              else resolve(name);
            }, ms);
          }),
      );
    const results = await Promise.allSettled([
      job("a", 20),
      job("b", 1),
      job("boom", 1, true),
      job("c", 1),
    ]);
    expect(order).toEqual(["a", "b", "boom", "c"]); // 无交错、失败不堵队
    expect(results.map((r) => r.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
  });
});
