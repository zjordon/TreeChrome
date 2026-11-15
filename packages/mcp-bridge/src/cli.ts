// tc-bridge CLI（issue #31 M1 P1）：serve / connect / status 三命令。退出码对齐 tc
// 惯例——环境问题（桥未起/端口不可达/参数错）exit 2。全注入（env/fetch/log/err），
// serve 供 e2e 复用；bin 薄壳只做版本注入与兜底。

import { getRandomValues, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type BridgeServer, DEFAULT_BRIDGE_PORT, startBridge } from "./server.js";
import { type BridgePairingStore, BridgeState, type PairingRecord } from "./state.js";

export function resolveBridgePort(env: Record<string, string | undefined>): number {
  const raw = Number.parseInt(env.TC_BRIDGE_PORT ?? "", 10);
  if (Number.isInteger(raw) && raw >= 1 && raw <= 65535) return raw;
  return DEFAULT_BRIDGE_PORT;
}

/** 扩展侧同款生成器：32 字节随机 → base64url（两侧令牌形态一致，互校不猜） */
export function newPairingToken(): string {
  const bytes = new Uint8Array(32);
  getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/** 配对落盘：~/.tc/bridge/pairing.json（与 tc daemon 的 ~/.tc/ 同根不同目录） */
export class FsPairingStore implements BridgePairingStore {
  constructor(private readonly path: string) {}

  async load(): Promise<PairingRecord | null> {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (
        typeof raw !== "object" ||
        raw === null ||
        typeof (raw as PairingRecord).pairingToken !== "string" ||
        typeof (raw as PairingRecord).extensionId !== "string" ||
        typeof (raw as PairingRecord).name !== "string"
      ) {
        return null;
      }
      return raw as PairingRecord;
    } catch {
      return null;
    }
  }

  async save(record: PairingRecord): Promise<void> {
    // 同步小文件写入（配对是低频一次性操作，原子性无要求）
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(record), "utf8");
  }

  async remove(): Promise<void> {
    try {
      unlinkSync(this.path);
    } catch {
      // 未落盘/已删——幂等
    }
  }
}

export function defaultPairingPath(): string {
  return join(homedir(), ".tc", "bridge", "pairing.json");
}

export interface ServeBridgeOptions {
  port?: number;
  pairingPath?: string;
  instanceId?: string;
  /** MCP serverInfo.version（bin 透传包版本） */
  version?: string;
}

/** serve 命令主体（e2e 复用）：装配状态机 + 起服务，返回后常驻由调用方决定 */
export async function serveBridge(options: ServeBridgeOptions = {}): Promise<BridgeServer> {
  // instanceId 单源：state（poll 校验）与 server（/health 呈现）必须是同一进程身份
  const instanceId = options.instanceId ?? randomUUID();
  const state = new BridgeState({
    instanceId,
    now: () => Date.now(),
    randomId: () => randomUUID(),
    randomToken: newPairingToken,
    pairingStore: new FsPairingStore(options.pairingPath ?? defaultPairingPath()),
  });
  await state.init();
  return await startBridge({ port: options.port, state, instanceId, version: options.version });
}

export interface BridgeCliDeps {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** serve 注入缝（单测替换；缺省真起） */
  serve?: (options: ServeBridgeOptions) => Promise<BridgeServer>;
  /** 包版本（bin 注入；透传 MCP serverInfo） */
  version?: string;
  log?(message: string): void;
  err?(message: string): void;
}

const USAGE = "usage: tc-bridge <serve|connect|status> [--port <n>] [--pairing-path <p>]";

export async function runBridgeCli(argv: string[], deps: BridgeCliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetch ?? fetch;
  const log = deps.log ?? ((m: string) => console.log(m));
  const err = deps.err ?? ((m: string) => console.error(m));
  const command = argv[0];
  const portFlag = argv.indexOf("--port");
  const port =
    portFlag >= 0 ? Number.parseInt(argv[portFlag + 1] ?? "", 10) : resolveBridgePort(env);
  const pairingPathFlag = argv.indexOf("--pairing-path");
  const pairingPath =
    pairingPathFlag >= 0 && typeof argv[pairingPathFlag + 1] === "string"
      ? argv[pairingPathFlag + 1]
      : undefined;

  if (command !== "serve" && command !== "connect" && command !== "status") {
    err(USAGE);
    return 2;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    err(`invalid port: ${argv[portFlag + 1] ?? ""}`);
    return 2;
  }
  const endpoint = `http://127.0.0.1:${port}`;

  if (command === "serve") {
    const serve = deps.serve ?? serveBridge;
    const server = await serve({ port, version: deps.version, pairingPath });
    log(
      `tc-bridge listening on ${server.endpoint} (pairing: ${pairingPath ?? defaultPairingPath()})`,
    );
    // 常驻：listening server 持有事件循环；Ctrl-C 由 Node 缺省终止（队列不持久化，
    // 在途 MCP 调用由其调用方超时语义兜底——M1 有意为之）
    return await new Promise<never>(() => {});
  }

  if (command === "connect") {
    let res: Response;
    try {
      res = await doFetch(`${endpoint}/admin/pairing`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    } catch {
      err(`bridge unavailable — is 'tc-bridge serve' running on ${endpoint}?`);
      return 2;
    }
    if (!res.ok) {
      err(`bridge unavailable (${res.status}) — is 'tc-bridge serve' running?`);
      return 2;
    }
    const body = (await res.json()) as { url?: string; expiresAt?: number };
    log(`在装有 TreeChrome 扩展的浏览器中打开：`);
    log(body.url ?? "(no url)");
    return 0;
  }

  // status
  let res: Response;
  try {
    res = await doFetch(`${endpoint}/health`);
  } catch {
    err(`bridge unavailable — is 'tc-bridge serve' running on ${endpoint}?`);
    return 2;
  }
  if (!res.ok) {
    err(`bridge unavailable (${res.status}) — is 'tc-bridge serve' running?`);
    return 2;
  }
  const body = (await res.json()) as Record<string, unknown>;
  log(JSON.stringify(body, null, 2));
  return 0;
}
