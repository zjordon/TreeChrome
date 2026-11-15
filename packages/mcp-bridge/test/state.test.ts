// BridgeState 单测（issue #31 M1 P1）：配对状态机 + 队列/租约全链。fake timers 承担
// 定时器语义（命令超时/长轮询截止），now/random/持久化全注入。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BridgePairingStore,
  BridgeState,
  clampPollTimeoutMs,
  PAIRING_TTL_MS,
  type PairingRecord,
} from "../src/index.js";

function memoryStore(seed: PairingRecord | null = null): {
  store: BridgePairingStore;
  read: () => PairingRecord | null;
} {
  let record: PairingRecord | null = seed;
  return {
    store: {
      load: async () => record,
      save: async (r) => {
        record = r;
      },
      remove: async () => {
        record = null;
      },
    },
    read: () => record,
  };
}

function makeState(seed: PairingRecord | null = null): {
  state: BridgeState;
  saved: () => PairingRecord | null;
  advance: (ms: number) => void;
} {
  const mem = memoryStore(seed);
  let now = 1_000_000;
  let idSeq = 0;
  let tokenSeq = 0;
  const state = new BridgeState({
    instanceId: "inst-1",
    now: () => now,
    randomId: () => `id-${++idSeq}`,
    randomToken: () => `tok-${++tokenSeq}`,
    pairingStore: mem.store,
  });
  return { state, saved: mem.read, advance: (ms) => (now += ms) };
}

const auth = (
  over: Partial<Parameters<BridgeState["poll"]>[0]> = {},
): {
  connectionId: string;
  pairingToken: string;
  instanceId: string;
  pollTimeoutMs: number;
  maxBatch: number;
} => ({
  connectionId: "c-1",
  pairingToken: "ptoken",
  instanceId: "inst-1",
  pollTimeoutMs: 1_000,
  maxBatch: 4,
  ...over,
});

async function pairFresh(state: BridgeState, token = "ptoken"): Promise<void> {
  const invitation = state.beginPairing();
  await state.pair({
    t: invitation.t,
    extensionId: "ext-1",
    name: "TreeChrome",
    pairingToken: token,
    connectionId: "c-1",
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("配对", () => {
  it("未配对 poll 拒绝（BRIDGE_PAIRING_REQUIRED）", async () => {
    const { state } = makeState();
    await expect(state.poll(auth(), new AbortController().signal)).rejects.toMatchObject({
      code: "BRIDGE_PAIRING_REQUIRED",
    });
  });

  it("邀请 → pair 成功 → 落盘；poll 凭据可用", async () => {
    const { state, saved } = makeState();
    await pairFresh(state);
    expect(state.paired).toBe(true);
    expect(saved()).toEqual({
      pairingToken: "ptoken",
      extensionId: "ext-1",
      name: "TreeChrome",
    });
    const polled = state.poll(auth(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await polled).instanceId).toBe("inst-1");
  });

  it("邀请过期 → 拒绝；重发新邀请可再配", async () => {
    const { state, advance } = makeState();
    const invitation = state.beginPairing();
    advance(PAIRING_TTL_MS + 1);
    await expect(
      state.pair({
        t: invitation.t,
        extensionId: "ext-1",
        name: "",
        pairingToken: "ptoken",
        connectionId: "c-1",
      }),
    ).rejects.toMatchObject({ code: "BRIDGE_PAIRING_REQUIRED" });
    await pairFresh(state);
    expect(state.paired).toBe(true);
  });

  it("已有别家配对时凭有效邀请再配 → BRIDGE_CLIENT_IN_USE", async () => {
    const { state } = makeState({
      pairingToken: "ptoken-a",
      extensionId: "ext-a",
      name: "A",
    });
    await state.init();
    const invitation = state.beginPairing();
    await expect(
      state.pair({
        t: invitation.t,
        extensionId: "ext-b",
        name: "B",
        pairingToken: "ptoken-b",
        connectionId: "c-b",
      }),
    ).rejects.toMatchObject({ code: "BRIDGE_CLIENT_IN_USE" });
  });

  it("re-pair：落盘 token 直接恢复，无需邀请与用户确认", async () => {
    const { state } = makeState({
      pairingToken: "ptoken",
      extensionId: "ext-1",
      name: "TreeChrome",
    });
    await state.init();
    expect(state.paired).toBe(true);
    const result = await state.pair({
      t: "",
      extensionId: "ext-1",
      name: "TreeChrome",
      pairingToken: "ptoken",
      connectionId: "c-2",
    });
    expect(result).toEqual({ ok: true, instanceId: "inst-1", connectionId: "c-2" });
  });

  it("桥重启（instanceId 变更）→ poll 拒 BRIDGE_INSTANCE_CHANGED", async () => {
    const { state } = makeState();
    await pairFresh(state);
    await expect(
      state.poll(auth({ instanceId: "inst-2" }), new AbortController().signal),
    ).rejects.toMatchObject({ code: "BRIDGE_INSTANCE_CHANGED" });
  });

  it("disconnect：解除并清盘，之后 poll 拒绝", async () => {
    const { state, saved } = makeState();
    await pairFresh(state);
    await state.disconnect("ptoken");
    expect(state.paired).toBe(false);
    expect(saved()).toBeNull();
    await expect(state.poll(auth(), new AbortController().signal)).rejects.toMatchObject({
      code: "BRIDGE_PAIRING_REQUIRED",
    });
  });

  it("挂起中的长轮询在 disconnect 后空手而归（connectionId 空）", async () => {
    const { state } = makeState();
    await pairFresh(state);
    const polled = state.poll(auth(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    await state.disconnect("ptoken");
    await vi.advanceTimersByTimeAsync(1_000);
    const response = await polled;
    expect(response.requests).toEqual([]);
    expect(response.connectionId).toBe("");
  });

  it("pairingStatus：邀请有效/失效/被消费三态——仅消费本轮邀请的 t 报 paired", async () => {
    const { state, advance } = makeState();
    const invitation = state.beginPairing();
    expect(state.pairingStatus(invitation.t)).toEqual({
      ok: true,
      paired: false,
      expiresAt: 1_000_000 + PAIRING_TTL_MS,
    });
    expect(state.pairingStatus("wrong").expiresAt).toBeNull();
    advance(PAIRING_TTL_MS + 1);
    expect(state.pairingStatus(invitation.t).expiresAt).toBeNull();
    const consumed = state.beginPairing();
    await state.pair({
      t: consumed.t,
      extensionId: "ext-1",
      name: "TreeChrome",
      pairingToken: "ptoken",
      connectionId: "c-1",
    });
    expect(state.pairingStatus(consumed.t)).toEqual({ ok: true, paired: true, expiresAt: null });
    // 别的 t（含曾有效的旧邀请）不冒领——已配对但非本轮邀请
    expect(state.pairingStatus("whatever")).toEqual({ ok: true, paired: false, expiresAt: null });
  });

  it("别家已占用：邀请未被消费 → connect 页不冒领（持续 paired:false 到失效）", async () => {
    const { state } = makeState({
      pairingToken: "ptoken-a",
      extensionId: "ext-a",
      name: "A",
    });
    await state.init();
    const invitation = state.beginPairing();
    await expect(
      state.pair({
        t: invitation.t,
        extensionId: "ext-b",
        name: "B",
        pairingToken: "ptoken-b",
        connectionId: "c-b",
      }),
    ).rejects.toMatchObject({ code: "BRIDGE_CLIENT_IN_USE" });
    expect(state.pairingStatus(invitation.t)).toEqual({
      ok: true,
      paired: false,
      expiresAt: invitation.expiresAt,
    });
  });

  it("re-pair 消费同 t 的在途邀请：桥重启后重开 connect 页能显示完成", async () => {
    const { state } = makeState({
      pairingToken: "ptoken",
      extensionId: "ext-1",
      name: "TreeChrome",
    });
    await state.init();
    const invitation = state.beginPairing();
    await state.pair({
      t: invitation.t,
      extensionId: "ext-1",
      name: "TreeChrome",
      pairingToken: "ptoken",
      connectionId: "c-2",
    });
    expect(state.pairingStatus(invitation.t).paired).toBe(true);
  });
});

describe("队列与租约", () => {
  it("enqueue → poll 领取 → complete 回投 → promise resolve", async () => {
    const { state } = makeState();
    await pairFresh(state);
    const pending = state.enqueue("run_task", { task: "查价" }, { timeoutMs: 5_000 });
    const { requests } = await state.poll(auth(), new AbortController().signal);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ id: "id-1", method: "run_task", params: { task: "查价" } });
    expect(
      state.complete({ requestId: "id-1", ok: true, result: { accepted: true }, durationMs: 3 }),
    ).toBe(true);
    await expect(pending).resolves.toEqual({ accepted: true });
  });

  it("长轮询空手：pollTimeoutMs 截止返回空批", async () => {
    const { state } = makeState();
    await pairFresh(state);
    const polled = state.poll(auth(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await polled).requests).toEqual([]);
  });

  it("enqueue 唤醒挂起中的长轮询（无需等到超时）", async () => {
    const { state } = makeState();
    await pairFresh(state);
    const polled = state.poll(auth(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    void state.enqueue("get_snapshot", {}, { timeoutMs: 5_000 });
    const { requests } = await polled;
    expect(requests.map((r) => r.method)).toEqual(["get_snapshot"]);
  });

  it("命令超时：排队未被领取也一样拒绝并清位", async () => {
    const { state } = makeState();
    await pairFresh(state);
    const pending = state.enqueue("run_task", {}, { timeoutMs: 5_000 });
    // 断言先行：fake timers 推进时 reject 先于 handler 附加会误报未处理拒绝
    const rejection = expect(pending).rejects.toMatchObject({ code: "BRIDGE_REQUEST_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(state.status().queueDepth).toBe(0);
    expect(state.status().inflight).toBe(0);
  });

  it("complete 未知/已结算 requestId → false", async () => {
    const { state } = makeState();
    await pairFresh(state);
    expect(state.complete({ requestId: "nope", ok: true, result: null, durationMs: 1 })).toBe(
      false,
    );
    const pending = state.enqueue("get_snapshot", {}, { timeoutMs: 5_000 });
    const { requests } = await state.poll(auth(), new AbortController().signal);
    const rejection = expect(pending).rejects.toMatchObject({ code: "RUN_IN_PROGRESS" });
    expect(
      state.complete({
        requestId: requests[0].id,
        ok: false,
        error: { code: "RUN_IN_PROGRESS", message: "busy" },
        durationMs: 2,
      }),
    ).toBe(true);
    await rejection;
    expect(
      state.complete({ requestId: requests[0].id, ok: true, result: null, durationMs: 2 }),
    ).toBe(false);
  });

  it("中断：signal abort → 立即 INTERRUPTED + cancel_request 入队通知扩展", async () => {
    const { state } = makeState();
    await pairFresh(state);
    const controller = new AbortController();
    const pending = state.enqueue("run_task", {}, { timeoutMs: 60_000, signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ code: "INTERRUPTED" });
    controller.abort();
    await rejection;
    const { requests } = await state.poll(auth(), new AbortController().signal);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "cancel_request",
      params: { requestId: "id-1" },
    });
  });

  it("status：配对/连接/队列字段全链", async () => {
    const { state } = makeState();
    expect(state.status()).toEqual({
      paired: false,
      connected: false,
      pendingPairing: false,
      queueDepth: 0,
      inflight: 0,
      lastPollAt: null,
    });
    state.beginPairing();
    expect(state.status().pendingPairing).toBe(true);
    await pairFresh(state);
    expect(state.status().connected).toBe(false);
    const polled = state.poll(auth(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1_000);
    await polled;
    expect(state.status()).toMatchObject({ paired: true, connected: true, lastPollAt: 1_000_000 });
  });
});

describe("clampPollTimeoutMs", () => {
  it("下限 1s、上限 50s", () => {
    expect(clampPollTimeoutMs(0)).toBe(1_000);
    expect(clampPollTimeoutMs(999)).toBe(1_000);
    expect(clampPollTimeoutMs(25_000)).toBe(25_000);
    expect(clampPollTimeoutMs(99_999)).toBe(50_000);
  });
});
