// daemon HTTP 服务端（issue #27 M2）：127.0.0.1 node:http——GET /health 活性、
// POST /action 单命令执行（**串行队列**：单 Chrome 单 daemon，多调用方 FIFO——并发
// 切 tab 会竞态，browser-use 同款纪律）、POST /shutdown 优雅关停。空闲回收（缺省
// 15 分钟无请求 → 关停，TC_DAEMON_IDLE_SECS<=0 关闭）。IO 注入：会话工厂惰性单例、
// 时钟/daemon.json 写删可换假件（测试绑 0 号临时端口，零真 Chrome）。

import * as http from "node:http";
import {
  type DaemonEnvelope,
  type DaemonInfo,
  daemonErr,
  daemonOk,
  daemonPort,
  findVerb,
  idleSecs,
} from "./protocol.js";
import { type DaemonSession, SessionError } from "./session-holder.js";

const BODY_LIMIT_BYTES = 20 * 1024 * 1024;
const IDLE_CHECK_INTERVAL_MS = 5000;

export interface ServerOptions {
  env?: Record<string, string | undefined>;
  /** 缺省 daemonPort(env)；0 = 临时端口（测试） */
  port?: number;
  pid?: number;
  /** 会话工厂（首个请求才调用一次——惰性单例） */
  makeSession: () => DaemonSession;
  log?: (message: string) => void;
  now?: () => number;
  /** daemon.json 写/删（缺省不落盘：serve 模式在 CLI 层接） */
  writeInfo?: (info: DaemonInfo) => void;
  clearInfo?: () => void;
  /** 空闲检查周期（缺省 5s；测试注入小值加速回收用例） */
  idleCheckIntervalMs?: number;
}

export interface RunningDaemon {
  port: number;
  idleSecs: number;
  startedAt: number;
  /** 会话是否已建（首个动作请求后 true） */
  sessionStarted: () => boolean;
  /** 幂等：停 HTTP + 会话 shutdown + clearInfo */
  close: () => Promise<void>;
}

export class PortInUseError extends Error {
  constructor(port: number) {
    super(`端口 ${port} 已被占用（daemon 可能已在运行）`);
  }
}

export async function startDaemonServer(options: ServerOptions): Promise<RunningDaemon> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const wantedPort = options.port ?? daemonPort(env);
  const idleLimitSecs = idleSecs(env);
  const startedAt = now();

  let session: DaemonSession | null = null;
  const ensureSession = (): DaemonSession => {
    if (session === null) {
      session = options.makeSession();
    }
    return session;
  };

  // 活跃时刻：请求到达 + 每个任务结束时刷新；在途/排队计数门禁空闲回收（评审轮 1 [5]：
  // 长动作执行中不得回收——closeAllConnections 会掐断在途响应并杀正在执行的会话）
  let lastActivity = now();
  let runningJobs = 0;
  let closing = false;
  let closed = false;

  // 串行队列：promise 链 FIFO——并发请求排队执行，天然无重入
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    runningJobs += 1;
    const run = tail.then(job, job).finally(() => {
      runningJobs -= 1;
      lastActivity = now();
    });
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > BODY_LIMIT_BYTES) {
          reject(new Error(`请求体超过 ${BODY_LIMIT_BYTES} 字节上限`));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });

  const server = http.createServer((req, res) => {
    void (async () => {
      lastActivity = now();
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const send = (status: number, envelope: DaemonEnvelope) => {
        const body = JSON.stringify(envelope);
        res.writeHead(status, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(body),
        });
        res.end(body);
      };
      try {
        if (req.method === "GET" && url.pathname === "/health") {
          send(
            200,
            daemonOk({
              pid,
              port: actualPort,
              startedAt,
              idleSecs: Math.max(0, Math.floor((now() - lastActivity) / 1000)),
              sessionStarted: session !== null,
            }),
          );
          return;
        }
        if (req.method === "POST" && url.pathname === "/action") {
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            send(400, daemonErr("请求体不是合法 JSON", "usage"));
            return;
          }
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            typeof (parsed as { action?: unknown }).action !== "string" ||
            typeof (parsed as { params?: unknown }).params !== "object"
          ) {
            send(400, daemonErr('请求体须为 {"action":string,"params":object}', "usage"));
            return;
          }
          const { action } = parsed as { action: string };
          const params = (parsed as { params: Record<string, unknown> }).params;
          const verb = findVerb(action);
          if (verb === null) {
            send(404, daemonErr(`未知动作 "${action}"`, "usage"));
            return;
          }
          const result = await enqueue(async () => {
            const s = ensureSession();
            if (verb.special === "get_state") {
              return daemonOk(await s.getState());
            }
            if (verb.special === "tabs") {
              return daemonOk(await s.tabs());
            }
            return daemonOk(await s.runAction(action, params));
          });
          send(200, result);
          return;
        }
        if (req.method === "POST" && url.pathname === "/shutdown") {
          send(200, daemonOk({ stopped: true }));
          // 响应先落盘再关停（同一 tick 内排队，不丢回包）
          setImmediate(() => {
            void close();
          });
          return;
        }
        send(404, daemonErr(`无此路由 ${req.method} ${url.pathname}`, "usage"));
      } catch (e) {
        if (e instanceof SessionError) {
          send(200, daemonErr(e.message, e.kind));
          return;
        }
        send(200, daemonErr(e instanceof Error ? e.message : String(e), "exec"));
      }
    })();
  });

  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    closing = true;
    clearInterval(idleTimer);
    log("[daemon] 关停中（HTTP + 会话）");
    server.closeAllConnections();
    server.close();
    if (session !== null) {
      const s = session;
      session = null;
      await s.shutdown();
    }
    options.clearInfo?.();
  };

  const idleTimer = setInterval(() => {
    if (closing || idleLimitSecs <= 0 || runningJobs > 0) {
      return;
    }
    if (now() - lastActivity >= idleLimitSecs * 1000) {
      log(`[daemon] 空闲 ${idleLimitSecs}s，自动回收`);
      void close();
    }
  }, options.idleCheckIntervalMs ?? IDLE_CHECK_INTERVAL_MS);
  idleTimer.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE") {
        reject(new PortInUseError(wantedPort));
        return;
      }
      reject(e);
    });
    server.listen(wantedPort, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("daemon 监听地址异常（非 TCP）");
  }
  const actualPort = address.port;
  options.writeInfo?.({ pid, port: actualPort, startedAt });
  log(`[daemon] 监听 127.0.0.1:${actualPort}（pid=${pid}，空闲回收 ${idleLimitSecs}s）`);

  return {
    port: actualPort,
    idleSecs: idleLimitSecs,
    startedAt,
    sessionStarted: () => session !== null,
    close,
  };
}
