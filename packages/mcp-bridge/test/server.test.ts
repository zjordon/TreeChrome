// 安全门禁四件套 + /health + P1 私线全链（HTTP 面）：真起 127.0.0.1 随机端口
// （node-host daemon.test 同款先例）；Host 伪造用 node:http 直发（fetch 规范禁改
// Host 头）；配对/队列状态机细测在 state.test（本文件只测 HTTP 编排层）。
import { request as httpRequest, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BridgePairingStore,
  type BridgeServer,
  BridgeState,
  isExtensionBridgeOrigin,
  listeningPort,
  type PairingRecord,
  startBridge,
} from "../src/index.js";

const EXT_ORIGIN = `chrome-extension://${"a".repeat(32)}`;

function memoryStore(): { store: BridgePairingStore; read: () => PairingRecord | null } {
  let record: PairingRecord | null = null;
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

function makeState(instanceId = "inst-1"): BridgeState {
  const mem = memoryStore();
  let tokenSeq = 0;
  let idSeq = 0;
  return new BridgeState({
    instanceId,
    now: () => 1_000_000,
    randomId: () => `id-${++idSeq}`,
    randomToken: () => `t${++tokenSeq}`,
    pairingStore: mem.store,
  });
}

function rawStatus(options: { port: number; hostHeader: string; path: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: options.port,
        path: options.path,
        headers: { Host: options.hostHeader },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("startBridge 门禁（P0）", () => {
  let bridge: BridgeServer;

  beforeAll(async () => {
    bridge = await startBridge({ port: 0, state: makeState(), instanceId: "inst-1" });
  });
  afterAll(async () => {
    await bridge.close();
  });

  it("非回环绑定直接拒绝", async () => {
    await expect(startBridge({ host: "0.0.0.0", port: 0, state: makeState() })).rejects.toThrow(
      /loopback/,
    );
  });

  it("健康检查：无 Origin 可达，携带服务身份与状态", async () => {
    const res = await fetch(`${bridge.endpoint}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      service: "tc-bridge",
      protocolVersion: 1,
      instanceId: "inst-1",
      pendingPairing: false,
      status: { paired: false },
    });
  });

  it("Host 头非白名单 → 421（DNS rebinding 门）", async () => {
    const status = await rawStatus({
      port: bridge.port,
      hostHeader: "evil.example:443",
      path: "/health",
    });
    expect(status).toBe(421);
  });

  it("/mcp 带任意 Origin → 403（网页开不了 MCP 会话，扩展也不例外）", async () => {
    const res = await fetch(`${bridge.endpoint}/mcp`, { headers: { origin: EXT_ORIGIN } });
    expect(res.status).toBe(403);
  });

  it("网页 Origin 打 /v1/* 与 /health → 403", async () => {
    const res = await fetch(`${bridge.endpoint}/v1/tc/poll`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    const health = await fetch(`${bridge.endpoint}/health`, {
      headers: { origin: "https://evil.example" },
    });
    expect(health.status).toBe(403);
  });

  it("扩展 Origin 预检 → 204 + CORS 回声", async () => {
    const res = await fetch(`${bridge.endpoint}/v1/tc/poll`, {
      method: "OPTIONS",
      headers: { origin: EXT_ORIGIN },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(EXT_ORIGIN);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("POST 非 JSON content-type → 415", async () => {
    const res = await fetch(`${bridge.endpoint}/v1/tc/poll`, {
      method: "POST",
      headers: { origin: EXT_ORIGIN, "content-type": "text/plain" },
      body: "x",
    });
    expect(res.status).toBe(415);
  });

  it("未知私线路由 → 404；GET 打 POST 路由同样 404；未初始化 /mcp → 400", async () => {
    const res = await fetch(`${bridge.endpoint}/v1/tc/nope`, {
      method: "POST",
      headers: { origin: EXT_ORIGIN, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    const wrongMethod = await fetch(`${bridge.endpoint}/v1/tc/poll`, {
      headers: { origin: EXT_ORIGIN },
    });
    expect(wrongMethod.status).toBe(404);
    const mcp = await fetch(`${bridge.endpoint}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(400);
  });

  it("处理器抛错 → 500 收口（不悬挂连接）", async () => {
    const broken = await startBridge({
      port: 0,
      state: {
        ...makeState(),
        status: () => {
          throw new Error("boom");
        },
      } as unknown as BridgeState,
      instanceId: "inst-broken",
    });
    try {
      const res = await fetch(`${broken.endpoint}/health`);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toContain("boom");
    } finally {
      await broken.close();
    }
  });

  it("listeningPort：非 TCP 监听地址拒绝", () => {
    expect(() => listeningPort({ address: () => null } as unknown as Server)).toThrow(
      /listen failed/,
    );
    expect(() => listeningPort({ address: () => "unix:/x" } as unknown as Server)).toThrow(
      /listen failed/,
    );
  });
});

describe("私线全链（P1：admin → connect 页 → pair → poll → result → disconnect）", () => {
  let bridge: BridgeServer;
  let invitationT = "";

  beforeAll(async () => {
    bridge = await startBridge({ port: 0, state: makeState(), instanceId: "inst-1" });
  });
  afterAll(async () => {
    await bridge.close();
  });

  it("POST /admin/pairing：无 Origin 签发邀请；带 Origin 拒绝", async () => {
    const denied = await fetch(`${bridge.endpoint}/admin/pairing`, {
      method: "POST",
      headers: { origin: EXT_ORIGIN, "content-type": "application/json" },
      body: "{}",
    });
    expect(denied.status).toBe(403);

    const res = await fetch(`${bridge.endpoint}/admin/pairing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; t: string; url: string };
    expect(body.ok).toBe(true);
    expect(body.url).toContain(`/tc-connect?t=${body.t}`);
    invitationT = body.t;
  });

  it("GET /tc-connect：HTML + CSP 收口", async () => {
    const res = await fetch(`${bridge.endpoint}/tc-connect?t=${invitationT}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(await res.text()).toContain("TreeChrome");
  });

  it("GET /tc-connect/state：同源（无 Origin）可读，跨源 403", async () => {
    // 同源 GET 浏览器不发 Origin（undici 同款——fetch 不带 origin 头）
    const ok = await fetch(`${bridge.endpoint}/tc-connect/state?t=${invitationT}`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { paired: boolean; expiresAt: number | null };
    expect(body.paired).toBe(false);
    expect(body.expiresAt).toBeGreaterThan(0);

    const foreign = await fetch(`${bridge.endpoint}/tc-connect/state?t=${invitationT}`, {
      headers: { origin: "https://evil.example" },
    });
    expect(foreign.status).toBe(403);
    const extension = await fetch(`${bridge.endpoint}/tc-connect/state?t=${invitationT}`, {
      headers: { origin: EXT_ORIGIN },
    });
    expect(extension.status).toBe(403);
  });

  it("POST /v1/tc/pair：凭邀请配对成功；缺字段 400", async () => {
    const malformed = await fetch(`${bridge.endpoint}/v1/tc/pair`, {
      method: "POST",
      headers: { origin: EXT_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ extensionId: "ext-1" }),
    });
    expect(malformed.status).toBe(400);

    const res = await fetch(`${bridge.endpoint}/v1/tc/pair`, {
      method: "POST",
      headers: { origin: EXT_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        t: invitationT,
        extensionId: "ext-1",
        name: "TreeChrome",
        pairingToken: "ptoken",
        connectionId: "c-1",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; instanceId: string; connectionId: string };
    expect(body).toEqual({ ok: true, instanceId: "inst-1", connectionId: "c-1" });
  });

  it("POST /v1/tc/poll：已配对空手而归（长轮询 1s 截止）；错 token 409", async () => {
    const res = await fetch(`${bridge.endpoint}/v1/tc/poll`, {
      method: "POST",
      headers: { origin: EXT_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        connectionId: "c-1",
        pairingToken: "ptoken",
        instanceId: "inst-1",
        pollTimeoutMs: 1_000,
        maxBatch: 4,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requests: unknown[] };
    expect(body.requests).toEqual([]);

    const wrong = await fetch(`${bridge.endpoint}/v1/tc/poll`, {
      method: "POST",
      headers: { origin: EXT_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        connectionId: "c-1",
        pairingToken: "other",
        instanceId: "inst-1",
        pollTimeoutMs: 1_000,
        maxBatch: 4,
      }),
    });
    expect(wrong.status).toBe(409);
    const wrongBody = (await wrong.json()) as { code: string };
    expect(wrongBody.code).toBe("BRIDGE_PAIRING_REQUIRED");
  });

  it("POST /v1/tc/result：未知 requestId → ok:false", async () => {
    const res = await fetch(`${bridge.endpoint}/v1/tc/result`, {
      method: "POST",
      headers: { origin: EXT_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ requestId: "nope", ok: true, result: null, durationMs: 1 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("/health 反映配对态", async () => {
    const res = await fetch(`${bridge.endpoint}/health`);
    const body = (await res.json()) as { status: { paired: boolean } };
    expect(body.status.paired).toBe(true);
  });

  it("POST /v1/tc/disconnect：解除后 poll 409；错 token 409", async () => {
    const res = await fetch(`${bridge.endpoint}/v1/tc/disconnect`, {
      method: "POST",
      headers: { origin: EXT_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ pairingToken: "ptoken" }),
    });
    expect(res.status).toBe(200);

    const wrong = await fetch(`${bridge.endpoint}/v1/tc/disconnect`, {
      method: "POST",
      headers: { origin: EXT_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ pairingToken: "nope" }),
    });
    expect(wrong.status).toBe(409);

    const poll = await fetch(`${bridge.endpoint}/v1/tc/poll`, {
      method: "POST",
      headers: { origin: EXT_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        connectionId: "c-1",
        pairingToken: "ptoken",
        instanceId: "inst-1",
        pollTimeoutMs: 1_000,
        maxBatch: 4,
      }),
    });
    expect(poll.status).toBe(409);
  });
});

describe("请求体防御（P1）", () => {
  let bridge: BridgeServer;

  beforeAll(async () => {
    bridge = await startBridge({
      port: 0,
      state: makeState(),
      instanceId: "inst-cap",
      maxBodyBytes: 16,
    });
  });
  afterAll(async () => {
    await bridge.close();
  });

  it("超限请求体 → 413", async () => {
    const res = await fetch(`${bridge.endpoint}/v1/tc/poll`, {
      method: "POST",
      headers: { origin: EXT_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ filler: "x".repeat(64) }),
    });
    expect(res.status).toBe(413);
  });

  it("坏 JSON → 400", async () => {
    const res = await fetch(`${bridge.endpoint}/v1/tc/poll`, {
      method: "POST",
      headers: { origin: EXT_ORIGIN, "content-type": "application/json" },
      body: "{bad",
    });
    expect(res.status).toBe(400);
  });
});

describe("poll 断连收口（P1）", () => {
  let bridge: BridgeServer;

  beforeAll(async () => {
    bridge = await startBridge({
      port: 0,
      state: makeState("inst-abort"),
      instanceId: "inst-abort",
    });
    const invite = await fetch(`${bridge.endpoint}/admin/pairing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const { t } = (await invite.json()) as { t: string };
    const pair = await fetch(`${bridge.endpoint}/v1/tc/pair`, {
      method: "POST",
      headers: { origin: EXT_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        t,
        extensionId: "ext-1",
        name: "TreeChrome",
        pairingToken: "ptoken",
        connectionId: "c-1",
      }),
    });
    expect(pair.status).toBe(200);
  });
  afterAll(async () => {
    await bridge.close();
  });

  it("客户端中断长轮询后，服务端收口不炸、后续请求正常", async () => {
    const controller = new AbortController();
    const pending = fetch(`${bridge.endpoint}/v1/tc/poll`, {
      method: "POST",
      headers: { origin: EXT_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        connectionId: "c-1",
        pairingToken: "ptoken",
        instanceId: "inst-abort",
        pollTimeoutMs: 30_000,
        maxBatch: 4,
      }),
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await expect(pending).rejects.toThrow();
    const health = await fetch(`${bridge.endpoint}/health`);
    expect(health.status).toBe(200);
  });
});

describe("MCP 面（P2：Streamable HTTP 全链）", () => {
  let bridge: BridgeServer;
  let sessionId = "";
  let rpcId = 0;

  beforeAll(async () => {
    bridge = await startBridge({
      port: 0,
      state: makeState("inst-mcp"),
      instanceId: "inst-mcp",
      version: "test-9.9.9",
    });
    // 私线配对（后续 tools/call 需要扩展侧领取）
    const invite = await fetch(`${bridge.endpoint}/admin/pairing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const { t } = (await invite.json()) as { t: string };
    const pair = await fetch(`${bridge.endpoint}/v1/tc/pair`, {
      method: "POST",
      headers: { origin: EXT_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        t,
        extensionId: "ext-1",
        name: "TreeChrome",
        pairingToken: "ptoken",
        connectionId: "c-1",
      }),
    });
    expect(pair.status).toBe(200);
  });
  afterAll(async () => {
    await bridge.close();
  });

  function rpc(
    method: string,
    params: Record<string, unknown>,
    withSession = true,
  ): Promise<Response> {
    return fetch(`${bridge.endpoint}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(withSession && sessionId !== "" ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
  }

  async function readRpc(res: Response): Promise<Record<string, unknown>> {
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      const text = await res.text();
      for (const line of text.split("\n")) {
        if (line.startsWith("data:")) return JSON.parse(line.slice(5)) as Record<string, unknown>;
      }
      throw new Error("SSE 无 data 行");
    }
    return (await res.json()) as Record<string, unknown>;
  }

  it("initialize → 会话建立；未带会话的请求 → 400；未知会话 → 404", async () => {
    const bare = await rpc("tools/list", {}, false);
    expect(bare.status).toBe(400);

    const unknown = await fetch(`${bridge.endpoint}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "no-such-session",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }),
    });
    expect(unknown.status).toBe(404);

    const init = await fetch(`${bridge.endpoint}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0" },
        },
      }),
    });
    expect(init.status).toBe(200);
    sessionId = init.headers.get("mcp-session-id") ?? "";
    expect(sessionId).not.toBe("");
    const body = await readRpc(init);
    const result = body.result as { serverInfo: { name: string; version: string } };
    expect(result.serverInfo).toEqual({ name: "tc-bridge", version: "test-9.9.9" });

    // initialized 通知（SDK 要求建立后、请求前送达）
    const ready = await fetch(`${bridge.endpoint}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(ready.status).toBe(202);
  });

  it("tools/list → 21 工具（M1 5 件 + M2 直驱 16 件）", async () => {
    const res = await rpc("tools/list", {});
    expect(res.status).toBe(200);
    const body = await readRpc(res);
    const tools = (body.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "tc_bridge_status",
      "run_task",
      "get_snapshot",
      "watch_task",
      "stop_run",
      "get_state",
      "navigate",
      "click",
      "input_text",
      "select_dropdown",
      "scroll",
      "find_text",
      "read_grid",
      "evaluate",
      "screenshot",
      "upload_file",
      "go_back",
      "tabs",
      "switch_tab",
      "close_tab",
      "session_stop",
    ]);
  });

  it("tools/call 直驱全链：get_state 记 epoch → click 自动附带（#32 会话簿记）", async () => {
    const pollAndComplete = async (
      result: unknown,
      check: (params: Record<string, unknown>) => void,
    ): Promise<void> => {
      const poll = await fetch(`${bridge.endpoint}/v1/tc/poll`, {
        method: "POST",
        headers: { origin: EXT_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({
          connectionId: "c-1",
          pairingToken: "ptoken",
          instanceId: "inst-mcp",
          pollTimeoutMs: 1_000,
          maxBatch: 4,
        }),
      });
      const { requests } = (await poll.json()) as {
        requests: Array<{ id: string; method: string; params: Record<string, unknown> }>;
      };
      expect(requests[0]?.method).toBe("drive");
      check(requests[0].params);
      const post = await fetch(`${bridge.endpoint}/v1/tc/result`, {
        method: "POST",
        headers: { origin: EXT_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ requestId: requests[0].id, ok: true, result, durationMs: 2 }),
      });
      expect(post.status).toBe(200);
    };

    const call1 = rpc("tools/call", { name: "get_state", arguments: {} });
    await pollAndComplete(
      { ok: true, data: { elementTreeText: "[0] button" }, epoch: 11 },
      (params) => expect(params).toEqual({ verb: "get_state", args: {} }),
    );
    const res1 = await call1;
    const body1 = await readRpc(res1);
    const result1 = body1.result as { content: Array<{ text: string }> };
    expect(JSON.parse(result1.content[0].text)).toEqual({ elementTreeText: "[0] button" });

    const call2 = rpc("tools/call", { name: "click", arguments: { index: 5 } });
    await pollAndComplete({ ok: true, data: { isDone: false }, epoch: 11 }, (params) =>
      expect(params).toEqual({ verb: "click", args: { index: 5 }, epoch: 11 }),
    );
    const res2 = await call2;
    const body2 = await readRpc(res2);
    const result2 = body2.result as { content: Array<{ text: string }> };
    expect(JSON.parse(result2.content[0].text)).toEqual({ isDone: false });
  });

  it("tools/call run_task：MCP → 队列 → 扩展 poll → result 回投 → MCP 应答", async () => {
    const call = rpc("tools/call", {
      name: "run_task",
      arguments: { task: "到 example.com 查标题" },
    });
    // 假扩展：poll 立即领到 run_task → result 回投
    const poll = await fetch(`${bridge.endpoint}/v1/tc/poll`, {
      method: "POST",
      headers: { origin: EXT_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        connectionId: "c-1",
        pairingToken: "ptoken",
        instanceId: "inst-mcp",
        pollTimeoutMs: 1_000,
        maxBatch: 4,
      }),
    });
    const { requests } = (await poll.json()) as { requests: Array<{ id: string; method: string }> };
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("run_task");
    const post = await fetch(`${bridge.endpoint}/v1/tc/result`, {
      method: "POST",
      headers: { origin: EXT_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: requests[0].id,
        ok: true,
        result: { accepted: true, runId: "r-1" },
        durationMs: 2,
      }),
    });
    expect(post.status).toBe(200);

    const res = await call;
    expect(res.status).toBe(200);
    const body = await readRpc(res);
    const result = body.result as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0].text)).toEqual({ accepted: true, runId: "r-1" });
  });

  it("MCP 客户端断连 → cancel_request 转发扩展（断连转 cancelled 链路）", async () => {
    const controller = new AbortController();
    const call = fetch(`${bridge.endpoint}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name: "run_task", arguments: { task: "会被中断" } },
      }),
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    // SSE 流式响应头先到（fetch 已 resolve）——abort 只掐流不断 promise；两种形态都收
    const res = await call.catch(() => null);
    if (res !== null) {
      try {
        await res.text();
      } catch {
        // 掐流后的 body 读取异常是预期
      }
    }
    // 服务端 close 事件可能晚于客户端 abort——给 cancelled 注入链一个时序窗
    await new Promise((resolve) => setTimeout(resolve, 200));
    const poll = await fetch(`${bridge.endpoint}/v1/tc/poll`, {
      method: "POST",
      headers: { origin: EXT_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        connectionId: "c-1",
        pairingToken: "ptoken",
        instanceId: "inst-mcp",
        pollTimeoutMs: 1_000,
        maxBatch: 4,
      }),
    });
    const { requests } = (await poll.json()) as { requests: Array<{ method: string }> };
    expect(requests.map((r) => r.method)).toContain("cancel_request");
  });

  it("DELETE 会话 → 该 id 后续请求 404", async () => {
    const del = await fetch(`${bridge.endpoint}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId },
    });
    expect([200, 202, 204]).toContain(del.status);
    const after = await rpc("tools/list", {});
    expect(after.status).toBe(404);
    sessionId = "";
  });
});

describe("isExtensionBridgeOrigin", () => {
  it("只接受打包扩展 ID 形态（32 位 a-p）", () => {
    expect(isExtensionBridgeOrigin(EXT_ORIGIN)).toBe(true);
    expect(isExtensionBridgeOrigin(`chrome-extension://${"a".repeat(31)}`)).toBe(false);
    expect(isExtensionBridgeOrigin(`chrome-extension://${"z".repeat(32)}`)).toBe(false);
    expect(isExtensionBridgeOrigin("moz-extension://00000000-0000-0000-0000-000000000000")).toBe(
      false,
    );
    expect(isExtensionBridgeOrigin("https://example.com")).toBe(false);
    expect(isExtensionBridgeOrigin("")).toBe(false);
  });
});
