// 扩展侧桥 runtime（issue #31 M1 P3）：与本地 tc-bridge 的长轮询连接。移植 qz
// mcp-bridge.ts 状态机骨架（Apache-2.0），裁剪为 Chrome 单形态：无 WebSocket——
// fetch 长轮询（25s < SW 30s 空闲窗，事件节律自持活）+ chrome.alarms 0.5min 兜底
// 唤醒（SW 被杀后自动恢复；paused 也靠它自愈——M1 无 UI 的拍板）。
// 配对：默认 enabled（零 UI）；用户在浏览器打开 tc-bridge connect 打印的 URL，
// 本 runtime 经 tabs.onUpdated 从 URL 捕获一次性 t 后走扩展 Origin 私线 pair；
// 桥重启（instanceId 变更）凭落盘 pairingToken 幂等 re-pair，无需用户再确认。
// 零 chrome 依赖——storage/alarms/tabs/fetch 全注入（host/chrome-apis 收口）。

import type {
  BridgeClientConfig,
  BridgeCommandMethod,
  BridgeCommandRequest,
  BridgeConnectionState,
} from "@tw/protocol";
import type {
  AlarmsApi,
  StorageArea,
  StorageOnChangedApi,
  TabsOnUpdatedApi,
  TabsQueryApi,
} from "../host/chrome-apis.js";

export const BRIDGE_STORAGE_KEY = "tc_bridge";
export const BRIDGE_POLL_ALARM = "tc-bridge-poll";
export const DEFAULT_BRIDGE_ENDPOINT = "http://127.0.0.1:18730";
/**
 * 轮询驻留时长：刻意取短（5s）。e2e 实证（headless 旧内核）：25s 长驻留 fetch 的
 * 在途请求不维持 SW 生命期——挂起后响应写进死连接，携带命令的批次直接丢失（命令
 * 已出队成孤儿）。5s 保证响应落在事件（alarm/上一轮处理）后的 30s 存活窗内；run
 * 一旦起跑由 chrome.debugger 事件流自持（keepalive.ts 既有主通道），不依赖轮询。
 */
export const BRIDGE_POLL_TIMEOUT_MS = 5_000;
const BRIDGE_POLL_INTERVAL_ON_BATCH = 0;
const PROBE_INTERVAL_MS = 2_000;
const MAX_BATCH = 4;
const RETRY_LIMIT = 8;
const RETRY_DELAY_MS = 3_000;
/** 捕获的 t 有效窗（桥侧 TTL 10min，留 1min 余量） */
const CAPTURED_T_TTL_MS = 9 * 60_000;
const FETCH_TIMEOUT_OVERHEAD_MS = 5_000;

export interface BridgeRuntimeDeps {
  storage: StorageArea;
  storageOnChanged?: StorageOnChangedApi;
  alarms: AlarmsApi;
  tabsOnUpdated?: TabsOnUpdatedApi;
  tabsQuery?: TabsQueryApi;
  fetch: typeof fetch;
  extensionId: string;
  newId(): string;
  now(): number;
  /** 命令分发面（P4 接 bridge-gateway；测试注入假件） */
  dispatch(request: BridgeCommandRequest, signal: AbortSignal): Promise<unknown>;
  log?(message: string): void;
}

interface CapturedT {
  t: string;
  expiresAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 落盘配置的防御收窄（坏形态回缺省——存储故障不拖垮 runtime） */
export function parseBridgeConfig(
  value: unknown,
  fallback: () => BridgeClientConfig,
): BridgeClientConfig {
  if (!isRecord(value)) return fallback();
  const base = fallback();
  const state = value.state;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : base.enabled,
    endpoint: typeof value.endpoint === "string" ? value.endpoint : base.endpoint,
    pairingToken: typeof value.pairingToken === "string" ? value.pairingToken : "",
    extensionId: typeof value.extensionId === "string" ? value.extensionId : base.extensionId,
    name: typeof value.name === "string" ? value.name : base.name,
    connectionId: typeof value.connectionId === "string" ? value.connectionId : base.connectionId,
    instanceId: typeof value.instanceId === "string" ? value.instanceId : "",
    state:
      typeof state === "string" && STATES.has(state as BridgeConnectionState)
        ? (state as BridgeConnectionState)
        : "connecting",
    lastError:
      isRecord(value.lastError) &&
      typeof value.lastError.code === "string" &&
      typeof value.lastError.message === "string"
        ? { code: value.lastError.code, message: value.lastError.message }
        : null,
    connectedAt: typeof value.connectedAt === "number" ? value.connectedAt : null,
  };
}

const STATES = new Set<string>(["disabled", "connecting", "connected", "reconnecting", "paused"]);
/** 桥侧命令动词白名单（wire 信任边界：未知动词直接丢弃不 dispatch） */
const COMMAND_METHODS = new Set<string>(["run_task", "get_snapshot", "stop_run", "cancel_request"]);

/** 从 connect URL 提取一次性 t（仅本桥 endpoint 前缀——不为他桥代配） */
export function pairingTokenFromUrl(url: string | undefined, endpoint: string): string | null {
  if (typeof url !== "string" || url === "") return null;
  try {
    const parsed = new URL(url);
    if (parsed.origin + parsed.pathname !== `${endpoint}/tc-connect`) return null;
    const t = parsed.searchParams.get("t");
    return t !== null && t !== "" ? t : null;
  } catch {
    return null;
  }
}

/**
 * chrome.storage 回读会把对象键按字母序重排（e2e 实证）——自身写盘回声的比对必须
 * 先做键序规范化，否则每次 persist 都误判外部变更触发假性热重启（revoke 杀掉在途
 * poll，连接彻底断掉）。
 */
export function canonicalConfigJson(value: unknown): string {
  if (!isRecord(value)) return JSON.stringify(value) ?? "null";
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = canonicalConfigJson(value[key]);
  }
  return JSON.stringify(sorted);
}

export class BridgeRuntime {
  private readonly deps: BridgeRuntimeDeps;
  private config!: BridgeClientConfig;
  private started = false;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flight: Promise<void> | undefined;
  private capturedT: CapturedT | null = null;
  private retryBudget = RETRY_LIMIT;
  private lastWritten = "";
  private readonly pending = new Map<string, AbortController>();

  private readonly storageListener = (
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    area: string,
  ): void => {
    if (area !== "local" || changes[BRIDGE_STORAGE_KEY] === undefined || !this.started) return;
    const next = changes[BRIDGE_STORAGE_KEY].newValue;
    // 自身写入回声忽略（键序规范化比对）；外部改 enabled/endpoint 才热重启
    if (canonicalConfigJson(next) === this.lastWritten) return;
    this.revoke();
    const generation = this.generation;
    void this.restore(generation).catch(() => {
      this.deps.log?.("[bridge] config reload failed");
    });
  };

  private readonly alarmListener = (alarm: { name: string }): void => {
    if (alarm.name === BRIDGE_POLL_ALARM) this.handleAlarm();
  };

  private readonly tabsListener = (_tabId: number, changeInfo: { url?: string }): void => {
    this.handleTabUrl(changeInfo?.url);
  };

  constructor(deps: BridgeRuntimeDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.deps.tabsOnUpdated?.addListener(this.tabsListener);
    this.deps.storageOnChanged?.addListener(this.storageListener);
    this.deps.alarms.onAlarm?.addListener(this.alarmListener);
    void this.restore(this.generation).catch(() => {
      this.deps.log?.("[bridge] initial config load failed");
    });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.revoke();
    this.deps.tabsOnUpdated?.removeListener(this.tabsListener);
    this.deps.storageOnChanged?.removeListener(this.storageListener);
    this.deps.alarms.onAlarm?.removeListener?.(this.alarmListener);
    void this.setAlarm(false);
  }

  /** alarm 兜底：SW 被杀后唤醒——paused 自愈（重置预算重试一轮），否则补一脚 kick */
  handleAlarm(): void {
    if (!this.started) return;
    if (this.config === undefined) return;
    if (!this.config.enabled) return;
    if (this.config.state === "paused") {
      this.retryBudget = RETRY_LIMIT;
      this.persist({ state: "reconnecting", lastError: this.config.lastError });
    }
    this.kick();
  }

  /** tabs.onUpdated / 冷启动扫描共用：捕获配对 URL 中的 t */
  handleTabUrl(url: string | undefined): void {
    if (!this.started) return;
    const endpoint = this.config?.endpoint ?? DEFAULT_BRIDGE_ENDPOINT;
    const t = pairingTokenFromUrl(url, endpoint);
    if (t === null) return;
    if (this.capturedT !== null && this.capturedT.t === t) return;
    this.capturedT = { t, expiresAt: this.deps.now() + CAPTURED_T_TTL_MS };
    this.deps.log?.("[bridge] pairing invitation captured from tab url");
    this.kick();
  }

  status(): BridgeClientConfig {
    return this.config === undefined
      ? parseBridgeConfig(undefined, () => this.fallbackConfig())
      : { ...this.config };
  }

  // —— 内部：生命周期 ——

  private fallbackConfig(): BridgeClientConfig {
    return {
      enabled: true,
      endpoint: DEFAULT_BRIDGE_ENDPOINT,
      pairingToken: "",
      extensionId: this.deps.extensionId,
      name: "TreeChrome",
      connectionId: this.deps.newId(),
      instanceId: "",
      state: "connecting",
      lastError: null,
      connectedAt: null,
    };
  }

  private revoke(): void {
    this.generation += 1;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    for (const controller of this.pending.values()) {
      controller.abort(new Error("bridge runtime revoked"));
    }
    this.pending.clear();
  }

  private async restore(generation: number): Promise<void> {
    const stored = await this.deps.storage.get(BRIDGE_STORAGE_KEY);
    if (!this.alive(generation)) return;
    this.config = parseBridgeConfig(stored[BRIDGE_STORAGE_KEY], () => this.fallbackConfig());
    this.lastWritten = canonicalConfigJson(this.config);
    if (stored[BRIDGE_STORAGE_KEY] === undefined) {
      await this.deps.storage.set({ [BRIDGE_STORAGE_KEY]: this.config });
    }
    await this.setAlarm(this.config.enabled);
    // 冷启动扫描：用户在 SW 睡眠期间打开的配对页仍开着——直接补捕获
    if (this.config.instanceId === "" && this.deps.tabsQuery !== undefined) {
      try {
        const tabs = await this.deps.tabsQuery.query({
          active: false,
          url: `${this.config.endpoint}/tc-connect*`,
        });
        if (!this.alive(generation)) return;
        for (const tab of tabs) this.handleTabUrl(tab.url);
      } catch {
        // tabs 不可用不致命——alarm 兜底仍在
      }
    }
    if (!this.config.enabled) return;
    if (this.config.state === "paused") this.retryBudget = RETRY_LIMIT;
    this.kick();
  }

  private alive(generation: number): boolean {
    return this.started && generation === this.generation;
  }

  private schedule(delay: number): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.kick();
    }, delay);
    this.timer.unref?.();
  }

  private kick(): void {
    if (this.flight !== undefined) return;
    const generation = this.generation;
    const work = this.attempt()
      .catch((error: unknown) => this.onAttemptError(error, generation))
      .finally(() => {
        if (this.flight === work) this.flight = undefined;
      });
    this.flight = work;
  }

  /** attempt 错误收敛：预算递减 → 重试；耗尽 → paused（alarm 唤醒自愈——M1 无 UI） */
  private onAttemptError(error: unknown, generation: number): void {
    if (!this.alive(generation) || this.config === undefined) return;
    if (!this.config.enabled) return;
    const code = (error as { code?: string }).code ?? "MCP_CONNECTION_UNAVAILABLE";
    const message = error instanceof Error ? error.message : String(error);
    this.retryBudget -= 1;
    if (this.retryBudget <= 0) {
      this.persist({ state: "paused", lastError: { code, message } });
      void this.setAlarm(true);
      return;
    }
    this.persist({ state: "reconnecting", lastError: { code, message } });
    this.schedule(RETRY_DELAY_MS);
  }

  /** 单步推进：一步只做一件事并调度下一步（状态机粒度与 qz 一致） */
  private async attempt(): Promise<void> {
    if (!this.started || this.config === undefined) return;
    const generation = this.generation;
    const config = this.config;
    if (!config.enabled) return;
    if (config.state === "paused") {
      await this.setAlarm(true); // 仍保留 alarm——M1 无 UI，paused 靠它自愈
      return;
    }
    if (config.instanceId === "") {
      await this.probeAndPair(generation);
      return;
    }
    await this.pollOnce(generation);
  }

  // —— 内部：探活与配对 ——

  private async probeAndPair(generation: number): Promise<void> {
    const config = this.config;
    const health = (await this.json(`${config.endpoint}/health`, undefined, 5_000, generation)) as {
      instanceId?: unknown;
      pendingPairing?: unknown;
    };
    if (!this.alive(generation)) return;
    if (typeof health.instanceId !== "string" || health.instanceId === "") {
      throw new Error("bridge health malformed");
    }
    const wantRePair = config.pairingToken !== "";
    const captured = this.capturedT;
    const tValid = captured !== null && captured.expiresAt > this.deps.now();
    if (!wantRePair && !(health.pendingPairing === true && tValid)) {
      // 桥在线但没有给我们的邀请——继续探（用户没跑 connect 或 t 已过期）
      this.retryBudget = RETRY_LIMIT;
      this.persist({ state: "connecting" });
      this.schedule(PROBE_INTERVAL_MS);
      return;
    }
    const body = {
      t: wantRePair ? "" : (captured as CapturedT).t,
      extensionId: config.extensionId,
      name: config.name,
      pairingToken: config.pairingToken !== "" ? config.pairingToken : this.newPairingToken(),
      connectionId: config.connectionId,
    };
    const paired = (await this.json(`${config.endpoint}/v1/tc/pair`, body, 5_000, generation)) as {
      instanceId?: unknown;
      connectionId?: unknown;
    };
    if (!this.alive(generation)) return;
    if (typeof paired.instanceId !== "string" || paired.instanceId === "") {
      throw new Error("bridge pair response malformed");
    }
    this.capturedT = null;
    this.retryBudget = RETRY_LIMIT;
    this.persist({
      pairingToken: body.pairingToken,
      instanceId: paired.instanceId,
      state: "connected",
      lastError: null,
      connectedAt: this.deps.now(),
    });
    await this.setAlarm(true);
    this.schedule(BRIDGE_POLL_INTERVAL_ON_BATCH);
  }

  // —— 内部：长轮询与分发 ——

  private async pollOnce(generation: number): Promise<void> {
    const config = this.config;
    const response = await this.rawPost(
      `${config.endpoint}/v1/tc/poll`,
      {
        connectionId: config.connectionId,
        pairingToken: config.pairingToken,
        instanceId: config.instanceId,
        pollTimeoutMs: BRIDGE_POLL_TIMEOUT_MS,
        maxBatch: MAX_BATCH,
      },
      BRIDGE_POLL_TIMEOUT_MS + FETCH_TIMEOUT_OVERHEAD_MS,
      generation,
    );
    if (!this.alive(generation)) return;
    if (response.status === 200) {
      const body = (await response.json()) as { requests?: unknown };
      this.retryBudget = RETRY_LIMIT;
      if (this.config.state !== "connected") {
        this.persist({ state: "connected", lastError: null, connectedAt: this.deps.now() });
      }
      const requests = Array.isArray(body.requests) ? body.requests : [];
      for (const raw of requests.slice(0, MAX_BATCH)) {
        this.startRequest(isRecord(raw) ? raw : {}, generation);
      }
      await this.setAlarm(true);
      this.schedule(BRIDGE_POLL_INTERVAL_ON_BATCH);
      return;
    }
    const error = (await response.json().catch(() => ({}))) as { code?: unknown };
    const code = typeof error.code === "string" ? error.code : "MCP_CONNECTION_UNAVAILABLE";
    if (code === "BRIDGE_PAIRING_REQUIRED" || code === "BRIDGE_INSTANCE_CHANGED") {
      // 桥重启/解除——回探活层（凭落盘 token re-pair 或等新邀请）
      this.persist({
        instanceId: "",
        state: "reconnecting",
        lastError: { code, message: "bridge restarted or unpaired" },
      });
      this.schedule(PROBE_INTERVAL_MS);
      return;
    }
    throw Object.assign(new Error(`bridge poll rejected: ${code}`), { code });
  }

  private startRequest(raw: Record<string, unknown>, generation: number): void {
    const id = typeof raw.id === "string" ? raw.id : "";
    const method = typeof raw.method === "string" ? raw.method : "";
    const params = isRecord(raw.params) ? raw.params : {};
    if (id === "" || method === "") return;
    if (method === "cancel_request") {
      const target = typeof params.requestId === "string" ? params.requestId : "";
      if (target !== "") this.pending.get(target)?.abort(new Error("cancelled by bridge"));
      return;
    }
    if (!COMMAND_METHODS.has(method)) return;
    if (this.pending.has(id)) return;
    const controller = new AbortController();
    this.pending.set(id, controller);
    const startedAt = this.deps.now();
    void (async () => {
      let payload: Record<string, unknown>;
      try {
        const result = await this.deps.dispatch(
          { id, method: method as BridgeCommandMethod, params, timeoutMs: 180_000 },
          controller.signal,
        );
        payload = { ok: true, result };
      } catch (error) {
        payload = {
          ok: false,
          error: {
            code: "TOOL_EXECUTION_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      } finally {
        this.pending.delete(id);
      }
      if (!this.alive(generation)) return;
      await this.json(
        `${this.config.endpoint}/v1/tc/result`,
        { requestId: id, ...payload, durationMs: this.deps.now() - startedAt },
        15_000,
        generation,
      ).catch(() => {
        this.deps.log?.(`[bridge] result post failed: ${id}`);
      });
    })();
  }

  // —— 内部：基础设施 ——

  private newPairingToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  private async setAlarm(enabled: boolean): Promise<void> {
    try {
      if (enabled && this.started && this.config?.enabled) {
        await this.deps.alarms.create(BRIDGE_POLL_ALARM, { periodInMinutes: 0.5 });
      } else {
        await this.deps.alarms.clear(BRIDGE_POLL_ALARM);
      }
    } catch {
      // alarms 不可用不致命——活跃期轮询自身维持
    }
  }

  /** 状态落盘（只在转移时调用——每次 poll 不写盘）；lastWritten 防自身回声 */
  private persist(patch: Partial<BridgeClientConfig>): void {
    this.config = { ...this.config, ...patch };
    this.lastWritten = canonicalConfigJson(this.config);
    void this.deps.storage.set({ [BRIDGE_STORAGE_KEY]: this.config }).catch(() => {
      this.deps.log?.("[bridge] config persist failed");
    });
  }

  private async rawPost(
    url: string,
    body: unknown,
    timeoutMs: number,
    generation: number,
  ): Promise<Response> {
    const response = await this.deps.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!this.alive(generation)) {
      void response.body?.cancel().catch(() => {});
      throw new Error("revoked");
    }
    return response;
  }

  private async json(
    url: string,
    body: unknown,
    timeoutMs: number,
    generation: number,
  ): Promise<unknown> {
    const method = body === undefined ? "GET" : "POST";
    const response = await this.deps.fetch(url, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!this.alive(generation)) throw new Error("revoked");
    if (!response.ok) {
      const detail = (await response
        .clone()
        .json()
        .catch(() => null)) as {
        code?: unknown;
        error?: unknown;
      } | null;
      const code =
        detail !== null && typeof detail.code === "string"
          ? detail.code
          : "MCP_CONNECTION_UNAVAILABLE";
      const message =
        detail !== null && typeof detail.error === "string"
          ? detail.error
          : "The local bridge is unavailable.";
      throw Object.assign(new Error(message), { code });
    }
    return await response.json();
  }
}
