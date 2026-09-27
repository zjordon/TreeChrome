// transport 单测（docs/implement-plan/p3/03 §2 矩阵，01 §3 十条语义逐条锚定）。
// 全部走 FakeWebSocket 假件，无真网络。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CdpCommandError, CdpConnectionClosedError, CdpTimeoutError } from "../src/errors.js";
import { CdpWsClient } from "../src/transport.js";
import {
  createCapturingSocket,
  createFakeSocket,
  type FakeSocketHandle,
} from "./fake-websocket.js";

async function connect(handle: FakeSocketHandle, logs?: string[]): Promise<CdpWsClient> {
  return CdpWsClient.connect({
    wsUrl: "ws://fake.test/devtools/browser/uuid",
    socketFactory: handle.factory,
    logger: logs === undefined ? undefined : (m) => logs.push(m),
  });
}

describe("信封（01 §3 语义 1）", () => {
  it("首条命令：id=1、params 缺省 {}、无 sessionId 键", async () => {
    const handle = createFakeSocket();
    const client = await connect(handle);
    handle.socket.respond("A.b", {});
    await client.send("A.b");
    expect(JSON.parse(handle.socket.sentFrames[0] ?? "")).toEqual({
      id: 1,
      method: "A.b",
      params: {},
    });
    await client.stop();
  });

  it("params 透传不改动；sessionId 真值才携带（null 不发该键）", async () => {
    const handle = createFakeSocket();
    const client = await connect(handle);
    handle.socket.respond("A.b", {});
    handle.socket.respond("A.c", {});
    await client.send("A.b", { depth: -1, pierce: true }, "sess-1");
    await client.send("A.c", { x: 1 }, null);
    const frames = handle.socket.sentFrames.map((f) => JSON.parse(f));
    expect(frames[0]).toEqual({
      id: 1,
      method: "A.b",
      params: { depth: -1, pierce: true },
      sessionId: "sess-1",
    });
    expect(frames[1]).toEqual({ id: 2, method: "A.c", params: { x: 1 } });
    await client.stop();
  });

  it("id 严格递增", async () => {
    const handle = createFakeSocket();
    const client = await connect(handle);
    handle.socket.respond("A.a", {});
    handle.socket.respond("A.b", {});
    handle.socket.respond("A.c", {});
    await client.send("A.a");
    await client.send("A.b");
    await client.send("A.c");
    const ids = handle.socket.sentFrames.map((f) => JSON.parse(f).id);
    expect(ids).toEqual([1, 2, 3]);
    await client.stop();
  });

  it("wsUrl 透传给 socketFactory", async () => {
    const handle = createCapturingSocket();
    await connect(handle);
    expect(handle.capturedUrl()).toBe("ws://fake.test/devtools/browser/uuid");
  });
});

describe("路由（01 §3 语义 2/3/10）", () => {
  it("result 解析（泛型透传）", async () => {
    const handle = createFakeSocket();
    const client = await connect(handle);
    handle.socket.respond("Target.getTargets", { targetInfos: [] });
    const result = await client.send<{ targetInfos: unknown[] }>("Target.getTargets");
    expect(result.targetInfos).toEqual([]);
    await client.stop();
  });

  it("error → CdpCommandError（code/method/rawMessage）", async () => {
    const handle = createFakeSocket();
    const client = await connect(handle);
    handle.socket.fail("DOM.getDocument", -32000, "Node not found");
    const err = await client.send("DOM.getDocument").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CdpCommandError);
    const cErr = err as CdpCommandError;
    expect(cErr.code).toBe(-32000);
    expect(cErr.method).toBe("DOM.getDocument");
    expect(cErr.rawMessage).toBe("Node not found");
    expect(cErr.message).toContain("DOM.getDocument");
    await client.stop();
  });

  it("error 非对象形态（字符串）→ code=0、message 字符串化", async () => {
    const handle = createFakeSocket();
    const client = await connect(handle);
    handle.socket.sentFrames.length = 0;
    const promise = client.send("X.y");
    // 直接灌非对象 error 的响应（绕过 respond 规则）
    const id = JSON.parse(handle.socket.sentFrames[0] ?? "").id;
    handle.socket.emitRaw(JSON.stringify({ id, error: "boom" }));
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CdpCommandError);
    expect((err as CdpCommandError).code).toBe(0);
    expect((err as CdpCommandError).rawMessage).toBe('"boom"');
    await client.stop();
  });

  it("迟到/重复响应：警告且不崩", async () => {
    const logs: string[] = [];
    const handle = createFakeSocket();
    const client = await connect(handle, logs);
    handle.socket.respond("A.b", { ok: 1 });
    await client.send("A.b");
    handle.socket.emitRaw(JSON.stringify({ id: 1, result: { late: true } }));
    expect(logs.some((m) => m.includes("迟到/重复响应 id=1"))).toBe(true);
    await client.stop();
  });

  it("并发 3 命令交叉响应各自归位（语义 10）", async () => {
    const handle = createFakeSocket();
    const client = await connect(handle);
    const p1 = client.send<{ v: string }>("A.one");
    const p2 = client.send<{ v: string }>("A.two");
    const p3 = client.send<{ v: string }>("A.three");
    // 手工交叉回包：id=3 → id=1 → id=2
    handle.socket.emitRaw(JSON.stringify({ id: 3, result: { v: "three" } }));
    handle.socket.emitRaw(JSON.stringify({ id: 1, result: { v: "one" } }));
    handle.socket.emitRaw(JSON.stringify({ id: 2, result: { v: "two" } }));
    await expect(p1).resolves.toEqual({ v: "one" });
    await expect(p2).resolves.toEqual({ v: "two" });
    await expect(p3).resolves.toEqual({ v: "three" });
    await client.stop();
  });
});

describe("生命周期", () => {
  it("握手失败 reject，文案含 rediscover 引导", async () => {
    const handle = createFakeSocket();
    handle.socket.failHandshake = true;
    const err = await connect(handle).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CdpConnectionClosedError);
    expect((err as Error).message).toContain("discoverWebSocketUrl");
    expect((err as Error).message).toContain("close code=1006");
  });

  it("stop 后 send 拒绝", async () => {
    const handle = createFakeSocket();
    const client = await connect(handle);
    await client.stop();
    const err = await client.send("A.b").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CdpConnectionClosedError);
    expect((err as Error).message).toContain("已关闭");
  });

  it("stop 时 in-flight reject；stop 幂等", async () => {
    const handle = createFakeSocket();
    const client = await connect(handle);
    const pending = client.send("A.hang");
    const errPromise = pending.catch((e: unknown) => e);
    await client.stop();
    await client.stop(); // 幂等：不抛
    const err = await errPromise;
    expect(err).toBeInstanceOf(CdpConnectionClosedError);
    expect((err as Error).message).toContain("正在停止");
  });

  it("服务端 close 后 send 拒绝", async () => {
    const handle = createFakeSocket();
    const client = await connect(handle);
    handle.socket.serverClose();
    const err = await client.send("A.b").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CdpConnectionClosedError);
    await client.stop();
  });

  it("socket.send 同步抛（InvalidState）→ CdpConnectionClosedError 且 pending 清理", async () => {
    const logs: string[] = [];
    const handle = createFakeSocket();
    const client = await connect(handle, logs);
    handle.socket.throwOnSend = true;
    const err = await client.send("A.b").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CdpConnectionClosedError);
    expect((err as Error).message).toContain("发送失败");
    // pending 已清理：迟到响应落警告而非 resolve
    handle.socket.throwOnSend = false;
    handle.socket.emitRaw(JSON.stringify({ id: 1, result: {} }));
    expect(logs.some((m) => m.includes("迟到/重复响应 id=1"))).toBe(true);
    await client.stop();
  });
});

describe("泵（01 §3 语义 5/6/8/9）", () => {
  it("serverClose → pending 全 reject + onClosed 触发（code 透传）", async () => {
    const handle = createFakeSocket();
    const client = await connect(handle);
    const errPromise = client.send("A.hang").catch((e: unknown) => e);
    const closedEvents: Array<{ code: number }> = [];
    client.onClosed((event) => closedEvents.push(event));
    handle.socket.serverClose(1001, "going away");
    const err = await errPromise;
    expect(err).toBeInstanceOf(CdpConnectionClosedError);
    expect((err as Error).message).toContain("连接已关闭");
    expect(closedEvents).toEqual([{ code: 1001, reason: "going away", wasClean: true }]);
    await client.stop();
  });

  it("坏帧（非 JSON）：log 跳过，后续帧照常路由", async () => {
    const logs: string[] = [];
    const handle = createFakeSocket();
    const client = await connect(handle, logs);
    handle.socket.respond("A.b", { ok: 1 });
    handle.socket.emitRaw("{not json");
    const result = await client.send("A.b");
    expect(result).toEqual({ ok: 1 });
    expect(logs.some((m) => m.includes("帧解析失败"))).toBe(true);
    await client.stop();
  });

  it("非 text 帧（data 非 string）跳过", async () => {
    const logs: string[] = [];
    const handle = createFakeSocket();
    const client = await connect(handle, logs);
    handle.socket.emitNonText(42);
    expect(logs.some((m) => m.includes("非 text 帧"))).toBe(true);
    await client.stop();
  });

  it("未预期形态（非对象帧 / 既无 id 也无 method）警告", async () => {
    const logs: string[] = [];
    const handle = createFakeSocket();
    const client = await connect(handle, logs);
    handle.socket.emitRaw(JSON.stringify([1, 2, 3]));
    handle.socket.emitRaw(JSON.stringify({ foo: "bar" }));
    expect(logs.some((m) => m.includes("非对象帧"))).toBe(true);
    expect(logs.some((m) => m.includes("既无 id 也无 method"))).toBe(true);
    await client.stop();
  });

  it("onClosed 监听器异常隔离", async () => {
    const logs: string[] = [];
    const handle = createFakeSocket();
    const client = await connect(handle, logs);
    let second = false;
    client.onClosed(() => {
      throw new Error("listener boom");
    });
    client.onClosed(() => {
      second = true;
    });
    handle.socket.serverClose();
    expect(second).toBe(true);
    expect(logs.some((m) => m.includes("onClosed 监听器异常"))).toBe(true);
    await client.stop();
  });
});

describe("事件订阅（01 §3 语义 4/9，§5.2 列表语义）", () => {
  it("多监听器都收到 (params, sessionId)；params 缺省归一 {}", async () => {
    const handle = createFakeSocket();
    const client = await connect(handle);
    const seen: Array<[unknown, string | undefined]> = [];
    client.on("Page.frameAttached", (params, sessionId) => seen.push([params, sessionId]));
    client.on("Page.frameAttached", (params, sessionId) => seen.push([params, sessionId]));
    handle.socket.emit("Page.frameAttached", { frameId: "f1" }, "sess-1");
    handle.socket.emit("Page.frameAttached");
    expect(seen).toEqual([
      [{ frameId: "f1" }, "sess-1"],
      [{ frameId: "f1" }, "sess-1"],
      [{}, undefined],
      [{}, undefined],
    ]);
    await client.stop();
  });

  it("无监听器静默（不告警不崩）", async () => {
    const logs: string[] = [];
    const handle = createFakeSocket();
    const client = await connect(handle, logs);
    handle.socket.emit("Network.requestWillBeSent", {});
    expect(logs).toEqual([]);
    await client.stop();
  });

  it("监听器异常不影响其他监听器与泵", async () => {
    const logs: string[] = [];
    const handle = createFakeSocket();
    const client = await connect(handle, logs);
    let second = false;
    client.on("Page.loadEventFired", () => {
      throw new Error("boom");
    });
    client.on("Page.loadEventFired", () => {
      second = true;
    });
    handle.socket.emit("Page.loadEventFired");
    expect(second).toBe(true);
    expect(logs.some((m) => m.includes("监听器异常"))).toBe(true);
    // 泵仍活：命令照常
    handle.socket.respond("A.b", { alive: true });
    await expect(client.send("A.b")).resolves.toEqual({ alive: true });
    await client.stop();
  });

  it("disposer 生效（移除后不再收到，再注册不复活旧句柄）", async () => {
    const handle = createFakeSocket();
    const client = await connect(handle);
    let calls = 0;
    const dispose = client.on("X.y", () => {
      calls += 1;
    });
    handle.socket.emit("X.y");
    dispose();
    handle.socket.emit("X.y");
    expect(calls).toBe(1);
    await client.stop();
  });

  it("onClosed disposer 生效", async () => {
    const handle = createFakeSocket();
    const client = await connect(handle);
    let calls = 0;
    const dispose = client.onClosed(() => {
      calls += 1;
    });
    dispose();
    handle.socket.serverClose();
    expect(calls).toBe(0);
    await client.stop();
  });
});

describe("超时（01 §5.1 opt-in）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function connectWithTimeout(handle: FakeSocketHandle, timeoutMs: number, logs: string[]) {
    return CdpWsClient.connect({
      wsUrl: "ws://fake.test",
      socketFactory: handle.factory,
      timeoutMs,
      logger: (m) => logs.push(m),
    });
  }

  it("timeoutMs 到点 reject CdpTimeoutError；迟到响应落警告", async () => {
    const logs: string[] = [];
    const handle = createFakeSocket();
    const client = await connectWithTimeout(handle, 100, logs);
    const promise = client.send("A.hang");
    const errPromise = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    const err = await errPromise;
    expect(err).toBeInstanceOf(CdpTimeoutError);
    expect((err as Error).message).toContain("A.hang");
    // 迟到响应：不 resolve 已放弃的调用，落迟到警告
    handle.socket.emitRaw(JSON.stringify({ id: 1, result: {} }));
    expect(logs.some((m) => m.includes("迟到/重复响应 id=1"))).toBe(true);
    await client.stop();
  });

  it("响应先到：清除定时器不超时", async () => {
    const logs: string[] = [];
    const handle = createFakeSocket();
    const client = await connectWithTimeout(handle, 100, logs);
    handle.socket.respond("A.b", { ok: 1 });
    await expect(client.send("A.b")).resolves.toEqual({ ok: 1 });
    await vi.advanceTimersByTimeAsync(500);
    expect(logs).toEqual([]);
    await client.stop();
  });

  it("缺省无超时：不推进时钟也能完成", async () => {
    const handle = createFakeSocket();
    const client = await connect(handle);
    handle.socket.respond("A.b", { ok: 1 });
    await expect(client.send("A.b")).resolves.toEqual({ ok: 1 });
    await client.stop();
  });
});
