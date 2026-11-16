// 桥 HTTP 服务端（issue #31 M1）：仅回环绑定，安全门禁链定死——Host 白名单（防
// DNS rebinding）最前，Origin 门禁次之（/mcp 拒一切 Origin；其余仅放行扩展 Origin；
// /admin 面反向要求无 Origin；/tc-connect/state 仅同源），路由分发最后。P1 接线：
// /health、/tc-connect、/admin/pairing、/v1/tc/* 私线（pair/poll/result/disconnect）；
// P2 接线 /mcp（MCP Streamable HTTP，会话管理 + 断连转 cancelled + idle 回收）。
// 移植自 qz-browser-agent services/mcp-bridge/src/server.mjs（Apache-2.0），裁剪为
// 单扩展形态。

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Server as McpServerInstance } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, isJSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import type { BridgeCommandResult, BridgePairRequest, BridgePollRequest } from "@tw/protocol";
import { CONNECT_PAGE, CONNECT_PAGE_CSP } from "./connect-page.js";
import { type BridgeState, BridgeStateError } from "./state.js";
import { createMcpServer } from "./tools.js";

export const BRIDGE_SERVICE = "tc-bridge";
export const BRIDGE_PROTOCOL_VERSION = 1;
export const DEFAULT_BRIDGE_PORT = 18730;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** MCP 会话空闲回收（最后一个响应结束后无新请求即回收） */
const MCP_SESSION_IDLE_MS = 30 * 60_000;

/** /mcp 会话（Streamable HTTP：mcp-session-id 头携带的身份） */
interface McpSession {
  mcp: McpServerInstance;
  transport: StreamableHTTPServerTransport;
  activeResponses: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  closed: boolean;
  /** 会话级直驱 epoch 簿记（#32 决策点 ①：drive 响应信封更新，locator 动词附带） */
  lastEpoch: number | null;
}

/** Chrome 扩展 Origin 白名单形态：chrome-extension:// + 32 位 a-p（打包 ID 字符集） */
export function isExtensionBridgeOrigin(origin: string): boolean {
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

export interface BridgeServerOptions {
  /** 缺省 127.0.0.1；仅允许回环（非回环直接抛——防误配暴露到局域网） */
  host?: string;
  /** 缺省 18730（TC_BRIDGE_PORT 由 cli 层解析注入）；0 = 随机端口（测试用） */
  port?: number;
  instanceId?: string;
  state: BridgeState;
  /** MCP serverInfo.version（cli 层透传包版本） */
  version?: string;
  /** MCP 会话空闲回收窗口（测试注小值） */
  mcpSessionIdleMs?: number;
  /** 请求体上限（缺省 32MiB；测试注小值盖 413 分支） */
  maxBodyBytes?: number;
}

export interface BridgeServer {
  endpoint: string;
  port: number;
  instanceId: string;
  state: BridgeState;
  close(): Promise<void>;
}

const EXTENSION_CORS_HEADERS = {
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
} as const;

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

/** 从 server.address() 取 TCP 端口（unix socket / 未监听形态直接抛——桥只走 TCP） */
export function listeningPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("bridge listen failed");
  }
  return address.port;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** isInitializeRequest 的窄前守（undefined body 直接 false——避免 SDK 断言面） */
const isJSONRPCRequestSafe = (value: unknown): boolean => isRecord(value);

async function readJson(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) {
      throw new BridgeStateError("BODY_TOO_LARGE", `Request body exceeds ${maxBytes} bytes.`, 413);
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isRecord(body)) throw new Error("not an object");
    return body;
  } catch {
    throw new BridgeStateError("BAD_REQUEST", "JSON object required.", 400);
  }
}

function expectString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value === "") {
    throw new BridgeStateError("BAD_REQUEST", `Field ${key} must be a non-empty string.`, 400);
  }
  return value;
}

function parsePairRequest(body: Record<string, unknown>): BridgePairRequest {
  return {
    // 首次配对必填（pair() 校验）；re-pair（桥重启后凭原令牌恢复）可为空
    t: typeof body.t === "string" ? body.t : "",
    extensionId: expectString(body, "extensionId"),
    name: typeof body.name === "string" ? body.name : "",
    pairingToken: expectString(body, "pairingToken"),
    connectionId: expectString(body, "connectionId"),
  };
}

function parsePollRequest(body: Record<string, unknown>): BridgePollRequest {
  return {
    connectionId: expectString(body, "connectionId"),
    pairingToken: expectString(body, "pairingToken"),
    instanceId: expectString(body, "instanceId"),
    pollTimeoutMs: typeof body.pollTimeoutMs === "number" ? body.pollTimeoutMs : 0,
    maxBatch: typeof body.maxBatch === "number" ? body.maxBatch : 4,
  };
}

function parseCommandResult(body: Record<string, unknown>): BridgeCommandResult {
  const requestId = expectString(body, "requestId");
  const durationMs = typeof body.durationMs === "number" ? body.durationMs : 0;
  if (body.ok === true) {
    return { requestId, ok: true, result: body.result ?? null, durationMs };
  }
  const error = isRecord(body.error) ? body.error : {};
  return {
    requestId,
    ok: false,
    durationMs,
    error: {
      code: typeof error.code === "string" ? error.code : "TOOL_EXECUTION_FAILED",
      message: typeof error.message === "string" ? error.message : "Unknown error.",
    },
  };
}

export async function startBridge(options: BridgeServerOptions): Promise<BridgeServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("tc-bridge must bind to loopback");
  }
  const port = options.port ?? DEFAULT_BRIDGE_PORT;
  const instanceId = options.instanceId ?? randomUUID();
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const mcpSessionIdleMs = options.mcpSessionIdleMs ?? MCP_SESSION_IDLE_MS;
  const state = options.state;
  let actualPort = port;

  // —— /mcp 会话簿（qz 同款：initialize 建会话，idle 回收，断连转 cancelled）——
  const mcpSessions = new Map<string, McpSession>();
  const mcpResponses = new Set<Promise<void>>();
  let closing = false;

  const forgetSession = (session: McpSession): void => {
    if (session.idleTimer !== undefined) clearTimeout(session.idleTimer);
    session.closed = true;
    const id = session.transport.sessionId;
    if (id !== undefined && mcpSessions.get(id) === session) mcpSessions.delete(id);
  };
  const scheduleSessionCleanup = (session: McpSession): void => {
    if (session.idleTimer !== undefined) clearTimeout(session.idleTimer);
    if (closing || session.closed || session.activeResponses > 0) return;
    session.idleTimer = setTimeout(() => {
      forgetSession(session);
      void session.mcp.close().catch(() => {});
    }, mcpSessionIdleMs);
    session.idleTimer.unref?.();
  };
  const trackSessionResponse = (
    session: McpSession,
    request: IncomingMessage,
    response: ServerResponse,
    body: Record<string, unknown> | undefined,
  ): void => {
    if (session.idleTimer !== undefined) {
      clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }
    session.activeResponses += 1;
    const finish = (): void => {
      response.off("finish", finish);
      response.off("close", disconnected);
      session.activeResponses -= 1;
      scheduleSessionCleanup(session);
    };
    const disconnected = (): void => {
      if (!response.writableFinished && request.method === "POST" && isJSONRPCRequest(body)) {
        // 响应连接已断：把标准 cancelled 注入 transport（如同客户端发来）——SDK 会
        // 中止在途工具调用的 AbortSignal，桥再把 cancel_request 转发给扩展撤销副作用
        session.transport.onmessage?.({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: {
            requestId: body?.id as string | number,
            reason: "MCP response connection closed",
          },
        });
      }
      finish();
    };
    response.once("finish", finish);
    response.once("close", disconnected);
  };

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (error instanceof BridgeStateError) {
        if (!response.destroyed && !response.headersSent) {
          sendJson(response, error.status, { ok: false, code: error.code, error: error.message });
          return;
        }
      }
      if (!response.destroyed && !response.headersSent) {
        sendJson(response, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        response.end();
      }
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // 门 1：Host 头白名单。请求只能在 listen 完成后到达，actualPort 届时已定。
    const hostHeader = String(request.headers.host ?? "").toLowerCase();
    if (hostHeader !== `127.0.0.1:${actualPort}` && hostHeader !== `localhost:${actualPort}`) {
      return sendJson(response, 421, { ok: false, error: "invalid bridge host" });
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const origin = String(request.headers.origin ?? "");
    // 门 2：Origin 门禁——/mcp 拒一切 Origin；其余路径只放行扩展 Origin
    // （网页连 /health 也拿不到，与 qz 同口径：探测面不给网页）
    if (origin !== "" && (path === "/mcp" || !isExtensionBridgeOrigin(origin))) {
      return sendJson(response, 403, { ok: false, error: "invalid bridge origin" });
    }
    const cors =
      origin === ""
        ? {}
        : { "access-control-allow-origin": origin, vary: "Origin", ...EXTENSION_CORS_HEADERS };
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "cache-control": "no-store", ...cors });
      response.end();
      return;
    }
    if (request.method === "GET" && path === "/health") {
      const status = state.status();
      return sendJson(
        response,
        200,
        {
          ok: true,
          service: BRIDGE_SERVICE,
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          instanceId,
          pendingPairing: status.pendingPairing,
          status,
        },
        cors,
      );
    }
    if (request.method === "GET" && path === "/tc-connect") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": CONNECT_PAGE_CSP,
        "x-content-type-options": "nosniff",
      });
      response.end(CONNECT_PAGE);
      return;
    }
    if (request.method === "GET" && path === "/tc-connect/state") {
      // 门 2.5：配对进度面只给同源（connect 页轮询）。同源 GET 浏览器不发 Origin，
      // 放行空 Origin；携带 Origin 时必须等于本桥 origin（跨源页面 403）。只读无
      // 秘密（t 不回显），非浏览器客户端本就能访问——无增益攻击面。
      const sameOrigin = [`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`];
      if (origin !== "" && !sameOrigin.includes(origin)) {
        return sendJson(response, 403, { ok: false, error: "same-origin only" });
      }
      return sendJson(response, 200, state.pairingStatus(url.searchParams.get("t") ?? ""));
    }
    // 门 3：POST 一律要求 JSON content-type（读体前置）
    let body: Record<string, unknown> | undefined;
    if (request.method === "POST") {
      const contentType = String(request.headers["content-type"] ?? "")
        .split(";")[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== "application/json") {
        return sendJson(response, 415, { ok: false, error: "JSON content-type required" }, cors);
      }
      body = await readJson(request, maxBodyBytes);
    }

    if (request.method === "POST" && path === "/admin/pairing") {
      // CLI 管理面：携带任何 Origin 一律拒绝（浏览器页面不可自造配对邀请）
      if (origin !== "") {
        return sendJson(response, 403, { ok: false, error: "origin not allowed on admin" });
      }
      const invitation = state.beginPairing();
      return sendJson(response, 200, {
        ok: true,
        t: invitation.t,
        expiresAt: invitation.expiresAt,
        url: `http://127.0.0.1:${actualPort}/tc-connect?t=${encodeURIComponent(invitation.t)}`,
      });
    }

    if (path.startsWith("/v1/tc/") && request.method === "POST" && body !== undefined) {
      const route = path.slice("/v1/tc/".length);
      if (route === "pair") {
        const paired = await state.pair(parsePairRequest(body));
        return sendJson(response, 200, paired, cors);
      }
      if (route === "poll") {
        const controller = new AbortController();
        response.once("close", () => {
          if (!response.writableEnded) controller.abort(new Error("poll disconnected"));
        });
        const polled = await state.poll(parsePollRequest(body), controller.signal);
        if (!response.destroyed) return sendJson(response, 200, polled, cors);
        return;
      }
      if (route === "result") {
        return sendJson(response, 200, { ok: state.complete(parseCommandResult(body)) }, cors);
      }
      if (route === "disconnect") {
        await state.disconnect(expectString(body, "pairingToken"));
        return sendJson(response, 200, { ok: true }, cors);
      }
    }

    if (path === "/mcp") {
      if (closing) return sendJson(response, 503, { error: "The local bridge is stopping" });
      const sessionIdHeader = request.headers["mcp-session-id"];
      let session =
        typeof sessionIdHeader === "string" ? mcpSessions.get(sessionIdHeader) : undefined;
      if (
        session === undefined &&
        sessionIdHeader === undefined &&
        request.method === "POST" &&
        isJSONRPCRequestSafe(body) &&
        isInitializeRequest(body)
      ) {
        const createdShell = (): McpSession => ({
          mcp: undefined as unknown as McpServerInstance,
          transport: undefined as unknown as StreamableHTTPServerTransport,
          activeResponses: 0,
          idleTimer: undefined,
          closed: false,
          lastEpoch: null,
        });
        const created = createdShell();
        const mcp = createMcpServer({
          state,
          version: options.version ?? "0.0.0",
          driveEpoch: () => created.lastEpoch ?? undefined,
          onDriveEpoch: (epoch) => {
            created.lastEpoch = epoch;
          },
        });
        created.mcp = mcp;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            if (mcpSessions.get(id) !== created) mcpSessions.set(id, created);
          },
          onsessionclosed: () => forgetSession(created),
        });
        created.transport = transport;
        await mcp.connect(transport);
        mcp.onclose = () => forgetSession(created);
        session = created;
      }
      if (session === undefined) {
        return sendJson(response, sessionIdHeader !== undefined ? 404 : 400, {
          jsonrpc: "2.0",
          id: body?.id ?? null,
          error: {
            code: -32000,
            message: sessionIdHeader !== undefined ? "Unknown MCP session" : "Initialize MCP first",
          },
        });
      }
      if (response.destroyed) {
        scheduleSessionCleanup(session);
        return;
      }
      // 在途响应登记（关停时给 1s 出口）+ 断连转 cancelled
      if (request.method === "POST") {
        let complete: () => void = () => {};
        const finished = new Promise<void>((resolve) => {
          complete = resolve;
        });
        const cleanup = (): void => {
          response.off("finish", cleanup);
          response.off("close", cleanup);
          mcpResponses.delete(finished);
          complete();
        };
        mcpResponses.add(finished);
        response.once("finish", cleanup);
        response.once("close", cleanup);
      }
      trackSessionResponse(session, request, response, body);
      await session.transport.handleRequest(request, response, body);
      return;
    }

    return sendJson(response, 404, { ok: false, error: "not found" }, cors);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  actualPort = listeningPort(server);

  const close = async (): Promise<void> => {
    closing = true;
    // 给在途 MCP 响应 1s 出口（cancelled 结果先于关流送达），再收会话与监听
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...mcpResponses]),
      new Promise<void>((resolve) => {
        giveUp = setTimeout(resolve, 1_000);
        giveUp.unref?.();
      }),
    ]);
    if (giveUp !== undefined) clearTimeout(giveUp);
    await Promise.allSettled(
      [...mcpSessions.values()].map((session) => {
        forgetSession(session);
        return session.mcp.close();
      }),
    );
    mcpSessions.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  };

  return {
    endpoint: `http://${host}:${actualPort}`,
    port: actualPort,
    instanceId,
    state,
    close,
  };
}
