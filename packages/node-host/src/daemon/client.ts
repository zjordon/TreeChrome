// daemon HTTP 客户端与自起生命周期（issue #27 M2）：CLI 侧单命令调用——POST /action；
// 不可达（ECONNREFUSED）时自动拉起 daemon（detached+unref 自 spawn 同一入口脚本
// `daemon --serve`，沿 #26 auto-chrome 纪律）等 /health 就绪后重试一次。fetch/spawn/
// 时钟全注入（离线单测）。v1 无鉴权：绑定恒 127.0.0.1，暴露面与本机 CDP 9222 同级
//（#27 拍板，登记偏离并写入文档）。

import { spawn } from "node:child_process";
import { type DaemonEnvelope, daemonErr } from "./protocol.js";

const HEALTH_TIMEOUT_MS = 1500;
const STARTUP_TIMEOUT_MS = 20_000;
const STARTUP_POLL_MS = 250;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ClientDeps {
  fetchImpl?: FetchLike;
  /** 自 spawn daemon（缺省 node <entry> daemon --serve，注入 entryScript 可换） */
  spawnSelf?: (port: number) => { pid: number };
  /** daemon 入口脚本（缺省 process.argv[1]——dev 形态 bin/tc.mjs / dist 形态 tc.mjs） */
  entryScript?: string;
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 等待 /health 就绪的总预算（缺省 20s；测试注入小值） */
  startupTimeoutMs?: number;
}

const defaultSpawnSelf =
  (entryScript: string | undefined, env: Record<string, string | undefined>) =>
  (port: number): { pid: number } => {
    const child = spawn(
      process.execPath,
      [entryScript ?? process.argv[1] ?? "", "daemon", "--serve"],
      {
        detached: true,
        stdio: "ignore",
        env: { ...env, TC_DAEMON_PORT: String(port) },
      },
    );
    // 沿 #26 auto-chrome 纪律：吞异步 error（无监听 'error' 会崩 CLI）+ unref 防挂起
    child.on("error", () => {});
    child.unref();
    return { pid: child.pid ?? -1 };
  };

/** GET /health：活着返回数据对象；不可达/坏响应返回 null（探测即失败，不抛） */
export async function probeHealth(
  fetchImpl: FetchLike,
  port: number,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return null;
    }
    const parsed = (await res.json()) as unknown;
    const envelope = parsed as { ok?: unknown; data?: unknown };
    if (envelope.ok !== true || typeof envelope.data !== "object" || envelope.data === null) {
      return null;
    }
    return envelope.data as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 确保 daemon 在跑：活着直接 true；否则自 spawn 并轮询 /health 直到就绪/超时 */
export async function ensureDaemonRunning(port: number, deps: ClientDeps = {}): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch.bind(globalThis) as FetchLike);
  const env = deps.env ?? process.env;
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const spawnSelf = deps.spawnSelf ?? defaultSpawnSelf(deps.entryScript, env);
  const timeoutMs = deps.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;

  if ((await probeHealth(fetchImpl, port)) !== null) {
    return true;
  }
  const spawned = spawnSelf(port);
  if (spawned.pid <= 0) {
    return false;
  }
  log(`[tc] daemon 不在运行，已拉起 pid=${spawned.pid}（端口 ${port}）`);
  const deadline = now() + timeoutMs;
  for (;;) {
    if ((await probeHealth(fetchImpl, port)) !== null) {
      return true;
    }
    if (now() >= deadline) {
      return false;
    }
    await sleep(STARTUP_POLL_MS);
  }
}

/** POST /shutdown；不可达视为「本就没在跑」 */
export async function stopDaemon(
  port: number,
  deps: ClientDeps = {},
): Promise<{ stopped: boolean; wasRunning: boolean }> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch.bind(globalThis) as FetchLike);
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return { stopped: res.ok, wasRunning: true };
  } catch {
    return { stopped: false, wasRunning: false };
  }
}

/**
 * 单命令调用：POST /action；网络层失败后先探活——daemon 不在（ECONNREFUSED）才自动
 * 拉起并重试一次；daemon 仍存活（600s 超时/连接中断）则不盲重发（动作可能已在服务端
 * 执行或仍在 FIFO 队列，非幂等动作重发会被重复执行——评审轮 1 [4]），把重试决策交还
 * 调用方。拉起后仍不可达 / 存活但请求失败 → env 类错误信封（CLI exit 2）。
 */
export async function requestDaemon(
  port: number,
  action: string,
  params: Record<string, unknown>,
  deps: ClientDeps = {},
): Promise<DaemonEnvelope> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch.bind(globalThis) as FetchLike);
  const post = async (): Promise<DaemonEnvelope> => {
    const res = await fetchImpl(`http://127.0.0.1:${port}/action`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ action, params }),
      signal: AbortSignal.timeout(600_000),
    });
    return (await res.json()) as DaemonEnvelope;
  };
  try {
    return await post();
  } catch (e) {
    // 存活探测：daemon 活着说明失败是超时/中断而非未启动——动作可能已执行或仍在队列
    if ((await probeHealth(fetchImpl, port)) !== null) {
      return daemonErr(
        `daemon 请求失败（127.0.0.1:${port}）——daemon 仍存活，动作可能已在服务端执行或仍在队列，请勿盲目重试：${
          e instanceof Error ? e.message : String(e)
        }`,
        "env",
      );
    }
  }
  const running = await ensureDaemonRunning(port, deps);
  if (!running) {
    return daemonErr(
      `daemon 不可达且自动拉起失败（127.0.0.1:${port}）——查 ~/.tc/daemon/daemon.log 或跑 tc daemon --doctor`,
      "env",
    );
  }
  try {
    return await post();
  } catch (e) {
    return daemonErr(`daemon 请求失败：${e instanceof Error ? e.message : String(e)}`, "env");
  }
}
