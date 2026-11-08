// daemon 故障诊断（issue #27 M2，`tc daemon --doctor`）：三类故障定位 + 可行动建议——
// ① daemon（daemon.json/pid 活性//health）② Chrome（CDP /json/version 探测）③ 端口
//（被非 daemon 进程占用 vs 空闲）。探测面全注入（离线单测）。

import * as net from "node:net";
import { type ClientDeps, type FetchLike, probeHealth } from "./client.js";
import { type DaemonInfo, daemonPort } from "./protocol.js";

export interface DoctorFinding {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  hint: string | null;
}

export interface DoctorResult {
  findings: DoctorFinding[];
  summary: "healthy" | "degraded" | "down";
}

export interface DoctorDeps extends ClientDeps {
  /** 读 ~/.tc/daemon/daemon.json（缺省 null = 不读盘，serve 面外诊断够用） */
  readInfo?: () => DaemonInfo | null;
  pidAlive?: (pid: number) => boolean;
  /** TCP 连通探测：refused = 端口空闲；connected = 有进程在听 */
  netProbe?: (port: number) => Promise<"refused" | "connected" | "error">;
  /** CDP /json/version 探测（缺省走 fetch） */
  probeCdp?: (url: string) => Promise<boolean>;
  cdpHost?: string;
  cdpPort?: number;
}

const defaultPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const defaultNetProbe = (port: number): Promise<"refused" | "connected" | "error"> =>
  new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (result: "refused" | "connected" | "error") => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish("connected"));
    socket.once("error", (e: NodeJS.ErrnoException) =>
      finish(e.code === "ECONNREFUSED" ? "refused" : "error"),
    );
    socket.setTimeout(1500, () => finish("error"));
  });

const defaultProbeCdp =
  (fetchImpl: FetchLike) =>
  async (url: string): Promise<boolean> => {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  };

export async function diagnoseDaemon(deps: DoctorDeps = {}): Promise<DoctorResult> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch.bind(globalThis) as FetchLike);
  const port = daemonPort(env);
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const netProbe = deps.netProbe ?? defaultNetProbe;
  const probeCdp = deps.probeCdp ?? defaultProbeCdp(fetchImpl);
  const findings: DoctorFinding[] = [];

  // ① daemon：daemon.json + pid 活性 + /health
  const info = deps.readInfo?.() ?? null;
  const health = await probeHealth(fetchImpl, port);
  if (health !== null) {
    const pidInInfo = info !== null && pidAlive(info.pid);
    findings.push({
      name: "daemon",
      status: "ok",
      detail: `运行中（127.0.0.1:${port}，pid=${String(health.pid ?? "?")}）`,
      hint: null,
    });
    if (info !== null && !pidInInfo) {
      findings.push({
        name: "daemon.json",
        status: "warn",
        detail: `daemon.json 记录 pid=${info.pid} 已退出但文件残留`,
        hint: "无害残留；daemon 正常关停时会自动清理，可手删 ~/.tc/daemon/daemon.json",
      });
    }
  } else {
    const stalePid = info !== null && pidAlive(info.pid);
    findings.push({
      name: "daemon",
      status: stalePid ? "fail" : "warn",
      detail:
        info === null
          ? "未运行（无 daemon.json）"
          : stalePid
            ? `daemon.json 记录 pid=${info.pid} 活着但 /health 无响应——僵死`
            : "未运行（daemon.json 记录的 pid 已退出）",
      hint: stalePid
        ? `结束僵死进程后重试：taskkill /PID ${info?.pid} /F（或 kill ${info?.pid}）；任一动作命令也会自动重拉`
        : "无需处理——下一次动作命令会自动拉起 daemon",
    });
  }

  // ② Chrome：CDP /json/version（显式 CDP_WS_URL 时提示自管语义）
  const explicit = env.CDP_WS_URL;
  const host = deps.cdpHost ?? env.CDP_HOST ?? "127.0.0.1";
  const cdpPort = deps.cdpPort ?? (env.CDP_PORT !== undefined ? Number(env.CDP_PORT) : 9222);
  if (explicit !== undefined && explicit !== "") {
    findings.push({
      name: "chrome",
      status: "ok",
      detail: `显式 CDP_WS_URL 已设（${explicit}）——调用方自管连接，doctor 不探测`,
      hint: null,
    });
  } else {
    const up = await probeCdp(`http://${host}:${cdpPort}/json/version`);
    findings.push({
      name: "chrome",
      status: up ? "ok" : "warn",
      detail: up
        ? `CDP 可达（${host}:${cdpPort}）`
        : `CDP 不可达（${host}:${cdpPort}）——daemon 将自动拉起临时 Chrome（需本机装有 Chrome 或设 CHROME_PATH）`,
      hint: up
        ? null
        : "装 Chrome / 设 CHROME_PATH；或自起调试 Chrome：chrome --remote-debugging-port=9222",
    });
  }

  // ③ 端口：daemon 不在听时才有信息量（被谁占了）
  if (health === null) {
    const net = await netProbe(port);
    findings.push({
      name: "port",
      status: net === "connected" ? "fail" : net === "refused" ? "ok" : "warn",
      detail:
        net === "connected"
          ? `端口 ${port} 被其他进程占用（非 tc daemon——/health 无响应）`
          : net === "refused"
            ? `端口 ${port} 空闲`
            : `端口 ${port} 探测超时`,
      hint:
        net === "connected"
          ? `换端口：设 TC_DAEMON_PORT=<其它端口> 后重试（netstat -ano | findstr :${port} 定位占用者）`
          : null,
    });
  }

  const hasFail = findings.some((f) => f.status === "fail");
  const allOk = findings.every((f) => f.status === "ok");
  return {
    findings,
    summary: hasFail ? "down" : allOk ? "healthy" : "degraded",
  };
}
