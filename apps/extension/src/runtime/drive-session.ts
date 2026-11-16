// 扩展侧直驱会话持有（issue #32 M2 P1）：node-host daemon session-holder 的 SW
// 同构体。与 daemon 的三点差异：① transport 为 chrome.debugger 工厂（首动词挑
// 活动可驱动 tab 绑定；switch_tab/close_tab/navigate(new_tab) 的 Target.* 拦截
// 重锚在 cdp-chrome transport 内完成——会话不重建）；② SW 会死——会话在位期间
// keepalive hold 保活（run 与 hold 任一在位即保活，keepalive.ts 既有语义），
// 空闲 15min 回收；③ epoch 单调计数持久化（tc_driveEpoch）——每次会话创建 +1，
// 跨 SW 死亡单调，保证桥侧 lastObservedEpoch 必失配 → EPOCH_STALE（决策点 ①）。
// 零 chrome 依赖全注入（tabsQuery/makeCore/keepalive/storage）。

import type { BrowserSession, CdpTransport, Tools } from "@tw/core";
import type { StorageArea, TabsQueryApi } from "../host/chrome-apis.js";
import type { KeepaliveController } from "../host/keepalive.js";
import { pickActiveDrivableTab } from "./tab-pick.js";

export const DRIVE_EPOCH_KEY = "tc_driveEpoch";
export const DEFAULT_DRIVE_IDLE_MS = 15 * 60_000;

/** 会话核心（装配由 makeCore 注入——background 接真件，测试换假件） */
export interface DriveCore {
  browser: BrowserSession;
  tools: Tools;
}

export interface DriveSessionDeps {
  tabsQuery: TabsQueryApi;
  /** 绑定 tab 构造 transport 工厂（真实现 = host/debugger-api） */
  makeTransportFactory: (tabId: number) => () => Promise<CdpTransport>;
  /** BrowserSession+Tools 装配（真件注入 OPFS fs 等；transportFactory 直通 core） */
  makeCore: (
    transportFactory: () => Promise<CdpTransport>,
    log: (message: string) => void,
  ) => DriveCore;
  keepalive: KeepaliveController;
  storage: StorageArea;
  now(): number;
  log?(message: string): void;
  /** 空闲回收窗（缺省 15min；<=0 关闭——测试注小值） */
  idleMs?: number;
}

export class DriveSession {
  private readonly deps: DriveSessionDeps;
  private core: DriveCore | null = null;
  private held = false;
  private epochLoaded = false;
  private epochValue = 0;
  private lastActivity = 0;
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  private creating: Promise<DriveCore> | null = null;

  constructor(deps: DriveSessionDeps) {
    this.deps = deps;
  }

  /** 会话在位（附着中——桥侧 drive 可用） */
  get active(): boolean {
    return this.core !== null;
  }

  /** 当前代次（0 = 尚未创建过会话；每次创建单调 +1 且持久化） */
  get epoch(): number {
    return this.epochValue;
  }

  /** 最后一次动词活动时间戳（网关每动词 touch——空闲回收依据） */
  get lastActivityAt(): number {
    return this.lastActivity;
  }

  /**
   * 惰性启动（并发安全）：挑活动可驱动 tab → makeCore → start → hold →
   * epoch+1 持久化 → 空闲计时。死会话（连接断）先收口再重建（代次照加）。
   */
  async ensure(): Promise<DriveCore> {
    if (this.core?.browser.isConnected) {
      this.touch();
      return this.core;
    }
    if (this.creating !== null) return await this.creating;
    if (this.core !== null) await this.stop();
    const attempt = this.create();
    this.creating = attempt;
    try {
      return await attempt;
    } finally {
      this.creating = null;
    }
  }

  /** 动词活动标记——空闲计时重置（网关每动词调用） */
  touch(): void {
    this.lastActivity = this.deps.now();
  }

  /** 幂等回收：stop 会话 + release hold + 清计时（epoch 不变——下次创建才 +1） */
  async stop(): Promise<void> {
    if (this.idleTimer !== undefined) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
    const core = this.core;
    this.core = null;
    if (core !== null) {
      try {
        await core.browser.stop();
      } catch {
        // 清理路径不抛
      }
    }
    this.releaseHold();
  }

  // ── 内部 ─────────────────────────────────────────────────────────────

  private async create(): Promise<DriveCore> {
    const pick = await pickActiveDrivableTab(this.deps.tabsQuery);
    if (pick.tabId === undefined) {
      throw Object.assign(
        new Error(
          pick.sawRestricted
            ? "当前活动标签页是浏览器内部页面（chrome:// 等）无法被驱动"
            : "找不到活动标签页",
        ),
        { code: pick.sawRestricted ? "RESTRICTED_TAB" : "NO_ACTIVE_TAB" },
      );
    }
    if (!this.epochLoaded) {
      const stored = await this.deps.storage.get(DRIVE_EPOCH_KEY);
      const raw = stored[DRIVE_EPOCH_KEY];
      if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
        this.epochValue = raw;
      }
      this.epochLoaded = true;
    }
    const log = (message: string): void => {
      this.deps.log?.(message);
    };
    const core = this.deps.makeCore(this.deps.makeTransportFactory(pick.tabId), log);
    try {
      await core.browser.start();
    } catch (error) {
      try {
        await core.browser.stop();
      } catch {
        // 清理路径不抛
      }
      throw Object.assign(
        new Error(`直驱会话启动失败：${error instanceof Error ? error.message : String(error)}`),
        { code: "SESSION_START_FAILED" },
      );
    }
    this.epochValue += 1;
    // 持久化失败不阻塞会话（下次冷启 epoch 回退风险由「创建即写」的次序兜底——
    // 极端场景失配方向仍是失配，不产生假匹配）
    void this.deps.storage.set({ [DRIVE_EPOCH_KEY]: this.epochValue }).catch(() => {});
    this.core = core;
    if (!this.held) {
      this.deps.keepalive.hold();
      this.held = true;
    }
    this.touch();
    this.startIdleWatch();
    log(`[drive] session ready (tab ${pick.tabId}, epoch ${this.epochValue})`);
    return core;
  }

  private releaseHold(): void {
    if (!this.held) return;
    this.held = false;
    this.deps.keepalive.release();
  }

  private startIdleWatch(): void {
    if (this.idleTimer !== undefined) return;
    const idleMs = this.deps.idleMs ?? DEFAULT_DRIVE_IDLE_MS;
    if (idleMs <= 0) return;
    // 检查粒度：≤60s 且 ≤idle/2（小值注入时秒级可测）
    const tick = Math.min(60_000, Math.max(1, Math.ceil(idleMs / 2)));
    this.idleTimer = setInterval(() => {
      if (this.core === null) return;
      if (this.deps.now() - this.lastActivity >= idleMs) {
        this.deps.log?.(`[drive] idle ${idleMs}ms — recycle session`);
        void this.stop();
      }
    }, tick);
    this.idleTimer.unref?.();
  }
}
