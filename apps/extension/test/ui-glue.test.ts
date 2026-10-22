// ui-glue 适配器单测（m5/05 §4；issue #2 C 档改传输编排）：PortClient 断线重连
// 指数退避/在线态/send 竞态、sidepanel reducer（hello 全量重建/live event 投影
// 去重/ack 回发序号/确认卡对 token 的 cancelled 匹配与乐观清除/附件预算与拒绝
// 明细）、attachment-upload 分块传输（begin→begun→chunk→commit 全路径与失败面）、
// message-router options 分支（异步应答通道）。

import type { AttachmentRejection, SwToUiMessage, UiToSwMessage } from "@tw/protocol";
import { describe, expect, it, vi } from "vitest";
import { registerMessageRouter } from "../src/runtime/message-router.js";
import {
  type BegunSignal,
  type UploadFile,
  uploadAttachment,
} from "../src/ui-glue/attachment-upload.js";
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

  it("attachments 广播吸收预算投影；attachment-rejected 入列；本地拒绝同位展示；begun 无状态变化", () => {
    let { state } = ingestSidepanel(initialSidepanelState, {
      kind: "attachments",
      items: [{ attachmentId: "att_1", name: "a", mimeType: "m", size: 4 }],
      budget: { usedBytes: 4, pendingBytes: 0, maxBytes: 10, maxTotalBytes: 20 },
    });
    expect(state.attachmentBudget).toEqual({
      usedBytes: 4,
      pendingBytes: 0,
      maxBytes: 10,
      maxTotalBytes: 20,
    });
    state = ingestSidepanel(state, { kind: "attachment-begun", transferId: "t0" }).state;
    expect(state.attachments).toHaveLength(1); // begun 只供传输编排消费
    state = ingestSidepanel(state, {
      kind: "attachment-rejected",
      rejection: {
        transferId: "t1",
        name: "big.mp4",
        mimeType: "video/mp4",
        size: 11,
        reason: "too-large",
        limit: 10,
      },
    }).state;
    state = ingestSidepanel(state, {
      kind: "attachment-rejected-local",
      rejection: { name: "bad.txt", mimeType: "text/plain", size: 0, reason: "invalid", limit: 0 },
    }).state;
    expect(state.attachmentRejections.map((r) => r.name)).toEqual(["big.mp4", "bad.txt"]);
  });

  it("拒绝明细：上限 5 挤掉最早；× 逐条清；起跑整表清", () => {
    let st = initialSidepanelState;
    for (let i = 0; i < 7; i++) {
      st = ingestSidepanel(st, {
        kind: "attachment-rejected",
        rejection: { name: `f${i}`, mimeType: "m", size: 1, reason: "too-large", limit: 2 },
      }).state;
    }
    expect(st.attachmentRejections.map((r) => r.name)).toEqual(["f2", "f3", "f4", "f5", "f6"]);
    st = ingestSidepanel(st, { kind: "attachment-rejection-dismissed", index: 1 }).state;
    expect(st.attachmentRejections.map((r) => r.name)).toEqual(["f2", "f4", "f5", "f6"]);
    st = ingestSidepanel(st, { kind: "attachment-rejections-cleared" }).state;
    expect(st.attachmentRejections).toEqual([]);
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

describe("uploadAttachment（分块二进制传输编排）", () => {
  /** 假文件：字节串按块切片回放；可注入 slice 抛错 */
  const fakeFile = (bytes: Uint8Array, opts: { failAt?: number } = {}): UploadFile => ({
    name: "a.bin",
    mimeType: "application/octet-stream",
    size: bytes.length,
    slice: async (off, end) => {
      if (opts.failAt !== undefined && off >= opts.failAt) throw new Error("read failed");
      return bytes.slice(off, end).slice().buffer as ArrayBuffer;
    },
  });

  const harness = (begunSignal: BegunSignal, failSend?: (m: UiToSwMessage) => boolean) => {
    const sent: UiToSwMessage[] = [];
    const progress: Array<{ transferId: string; sent: number }> = [];
    const rejections: AttachmentRejection[] = [];
    return {
      sent,
      rejections,
      deps: {
        send: (m: UiToSwMessage) => {
          sent.push(m);
          return failSend?.(m) ?? true;
        },
        waitForBegun: vi.fn(async () => begunSignal),
        onProgress: (transferId: string, s: number) => void progress.push({ transferId, sent: s }),
        onLocalRejection: (r: AttachmentRejection) => void rejections.push(r),
        generateTransferId: () => "t1",
        chunkBytes: 4,
        begunTimeoutMs: 50,
      },
      progress,
    };
  };

  it("成功路径：begin → begun → 多块顺序 chunk（跨块边界）→ commit + 进度递增", async () => {
    const bytes = new Uint8Array(10);
    for (let i = 0; i < 10; i++) bytes[i] = i;
    const h = harness("begun");
    await uploadAttachment(fakeFile(bytes), h.deps);
    expect(h.sent.map((m) => m.kind)).toEqual([
      "attachment-begin",
      "attachment-chunk",
      "attachment-chunk",
      "attachment-chunk",
      "attachment-commit",
    ]);
    const chunks = h.sent.filter((m) => m.kind === "attachment-chunk");
    expect(chunks.map((c) => (c as { offset: number }).offset)).toEqual([0, 4, 8]);
    const tail = atob((chunks[2] as { data: string }).data); // 尾块（2 字节，内容 8/9）
    expect(tail.length).toBe(2);
    expect(tail.charCodeAt(0)).toBe(8);
    expect(h.progress.map((p) => p.sent)).toEqual([4, 8, 10]);
    expect(h.rejections).toEqual([]);
  });

  it("begin 被拒（SW 已广播拒绝）：不发 chunk、不本地重复拒绝", async () => {
    const h = harness("rejected");
    await uploadAttachment(fakeFile(new Uint8Array(8)), h.deps);
    expect(h.sent.map((m) => m.kind)).toEqual(["attachment-begin"]);
    expect(h.rejections).toEqual([]);
  });

  it("begun 超时：本地 lost 拒绝 + abort 兜底", async () => {
    const h = harness("timeout");
    await uploadAttachment(fakeFile(new Uint8Array(8)), h.deps);
    expect(h.sent.map((m) => m.kind)).toEqual(["attachment-begin", "attachment-abort"]);
    expect(h.rejections).toEqual([
      {
        transferId: "t1",
        name: "a.bin",
        mimeType: "application/octet-stream",
        size: 8,
        reason: "lost",
        limit: 0,
      },
    ]);
  });

  it("读文件失败（slice 抛错）：本地 lost 拒绝 + abort，不静默", async () => {
    const h = harness("begun");
    await uploadAttachment(fakeFile(new Uint8Array(10), { failAt: 4 }), h.deps);
    expect(h.sent.map((m) => m.kind)).toEqual([
      "attachment-begin",
      "attachment-chunk",
      "attachment-abort",
    ]);
    expect(h.rejections).toHaveLength(1);
    expect(h.rejections[0]).toMatchObject({ name: "a.bin", reason: "lost" });
  });

  it("断连收口（send 返 false 不抛）：begin/chunk/commit 各阶段本地 lost + abort 尝试", async () => {
    // begin 阶段断连：SW 未收 begin——立即本地拒绝，不进 waitForBegun 等待
    const hb = harness("begun", () => false);
    await uploadAttachment(fakeFile(new Uint8Array(8)), hb.deps);
    expect(hb.deps.waitForBegun).not.toHaveBeenCalled();
    expect(hb.sent.map((m) => m.kind)).toEqual(["attachment-begin"]);
    expect(hb.rejections).toHaveLength(1);
    // chunk 阶段断连（首块失败）：本地 lost + abort 尽力发
    const hc = harness("begun", (m) => m.kind !== "attachment-chunk");
    await uploadAttachment(fakeFile(new Uint8Array(8)), hc.deps);
    expect(hc.sent.map((m) => m.kind)).toEqual([
      "attachment-begin",
      "attachment-chunk",
      "attachment-abort",
    ]);
    expect(hc.rejections).toHaveLength(1);
    // commit 阶段断连：本地 lost + abort 尽力发（SW 侧 pending 由 60s 超时兜底）
    const hm = harness("begun", (m) => m.kind !== "attachment-commit");
    await uploadAttachment(fakeFile(new Uint8Array(8)), hm.deps);
    expect(hm.sent.map((m) => m.kind)).toEqual([
      "attachment-begin",
      "attachment-chunk",
      "attachment-chunk",
      "attachment-commit",
      "attachment-abort",
    ]);
    expect(hm.rejections).toHaveLength(1);
  });

  it("空 MIME 规范化：File.type 为空串（.md/.log/无扩展名）→ begin 带缺省 MIME 不被 registry 判 invalid", async () => {
    const h = harness("rejected");
    const file = { ...fakeFile(new Uint8Array(8)), mimeType: "" };
    await uploadAttachment(file, h.deps);
    const begin = h.sent[0] as { kind: string; mimeType: string };
    expect(begin.kind).toBe("attachment-begin");
    expect(begin.mimeType).toBe("application/octet-stream");
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

describe("hello 空载荷保留终态视图（段 F 验收：SW 休眠重连不清空）", () => {
  const snapAt = (seq: number, runId = "r1"): never =>
    ({
      runId,
      tabId: 1,
      status: "done",
      seq,
      ackedSeq: 0,
      discardedBeforeSeq: 0,
      events: [],
      task: "t",
      startedAt: 1,
      endedAt: 9,
      finalResult: "完成",
      isDone: true,
      isSuccessful: true,
      stepCount: 1,
      lastError: null,
      attachments: [],
    }) as never;

  it("run 终态后 SW 被杀重连（hello null）——事件/快照/附件全保留", () => {
    let state = ingestSidepanel(initialSidepanelState, {
      kind: "hello",
      runId: "r1",
      snapshot: {
        ...snapAt(2),
        events: [{ seq: 1, type: "session_end", step: 1, ts: 1, data: { summary: "完成" } }],
        attachments: [],
      },
    }).state;
    const before = state;
    state = ingestSidepanel(state, { kind: "hello", runId: null, snapshot: null }).state;
    expect(state).toEqual(before); // 一字不改
    // 新 run 起跑：起始快照（换 runId）才是重置点
    state = ingestSidepanel(state, { kind: "journal-snapshot", snapshot: snapAt(0, "r2") }).state;
    expect(state.events).toEqual([]);
    expect(state.snapshot?.runId).toBe("r2");
  });
});
