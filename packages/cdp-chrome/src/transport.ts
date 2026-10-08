// ChromeDebuggerTransport：core CdpTransport 的 chrome.debugger 实现（m5/02 细案，
// 探针定案 2026-10-08——两轮真机探针事实见本文件各拦截点注释）。方案 S：握手与
// tabs 命令在 transport 层拦截合成，per-session 命令经 Debuggee {tabId} 路由到
// 附着会话。webbrain cdp-client.js 为机制参照（设计取用，代码重写）。

import type { CdpTransport } from "@tw/core";
import type { CdpEventListener } from "./root-session.js";
import { isRootSessionId, ROOT_SESSION_ID } from "./root-session.js";
import type { Debuggee, DebuggerApi, TargetInfoDto } from "./types.js";

/** chrome.tabs 的最小注入面（debugger API 覆盖不了的动作；adapter 实现走 chrome.tabs） */
export interface TabsApi {
  /** 激活 tab（switchTab 的 Target.activateTarget 拦截目标） */
  activate(tabId: number): Promise<void>;
  /** 关 tab（Target.closeTarget 拦截目标） */
  remove(tabId: number): Promise<void>;
}

export interface ChromeDebuggerTransportOptions {
  api: DebuggerApi;
  tabs: TabsApi;
  /** 附着的 tab（transport 的会话锚点；switchTab 重映射时更新） */
  tabId: number;
  log?: (message: string) => void;
  /** 用户手点「取消调试」/tab 关闭/策略剥离回调（SW run 中止决策用） */
  onDetached?: (reason: string) => void;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class ChromeDebuggerTransport implements CdpTransport {
  private readonly api: DebuggerApi;
  private readonly tabs: TabsApi;
  private readonly log: (message: string) => void;
  private readonly onDetached?: (reason: string) => void;
  private currentTabId: number;
  private detached = false;
  private detachReason: string | null = null;
  private readonly listeners = new Map<string, Set<CdpEventListener>>();
  private readonly globalEventHandler = (
    source: Debuggee,
    method: string,
    params: unknown,
  ): void => {
    // 全局单播源 → 按 method 多播；source.sessionId 透传（根事件无 sessionId——探针实证）。
    // 事件源过滤（评审轮 1 [6]）：仅当前锚定 tab 的事件入多播——switch 重叠窗与旧 tab
    // detach 失败残留的事件（根形态与他 tab 不可区分）不得污染 recentEvents/networkIdle/
    // fileChooser 状态；出站命令同经 currentTabId 路由，过滤不丢合法事件
    if (source.tabId !== undefined && source.tabId !== this.currentTabId) return;
    for (const listener of this.listeners.get(method) ?? []) {
      listener(params, typeof source.sessionId === "string" ? source.sessionId : undefined);
    }
  };
  private readonly globalDetachHandler = (source: Debuggee, reason?: string): void => {
    // 关闭当前锚定 tab 的预期 target_closed（评审轮 1 [5]）：interceptCloseTarget 登记
    // 抑制——core closeTab 随后 getTargets+switchTab 重锚，markDetached 会击穿整个会话
    if (this.suppressDetachForTab !== null && source.tabId === this.suppressDetachForTab) {
      this.suppressDetachForTab = null;
      return;
    }
    if (source.tabId !== this.currentTabId) return;
    this.markDetached(typeof reason === "string" ? reason : "unknown");
  };
  /** 在途 send 的 reject 柄（detach 时全量拒绝——core 错误分罪按文本匹配，原文透传） */
  private readonly pendingRejections = new Set<(e: Error) => void>();
  private targetInfosCache: TargetInfoDto[] | null = null;
  /** 预期内的 target_close（interceptCloseTarget 关当前 tab）——抑制其 onDetach */
  private suppressDetachForTab: number | null = null;

  constructor(options: ChromeDebuggerTransportOptions) {
    this.api = options.api;
    this.tabs = options.tabs;
    this.log = options.log ?? (() => {});
    this.onDetached = options.onDetached;
    this.currentTabId = options.tabId;
    this.api.onEvent.addListener(this.globalEventHandler);
    this.api.onDetach.addListener(this.globalDetachHandler);
  }

  get tabId(): number {
    return this.currentTabId;
  }

  async send<T>(method: string, params?: object, sessionId?: string): Promise<T> {
    if (this.detached) {
      throw new Error(
        `Debugger detached${this.detachReason !== null ? `: ${this.detachReason}` : ""} — ${method} dropped`,
      );
    }
    // —— Target.* 浏览器级命令（core 一律无 sessionId 发送，tabs.ts 事实）——
    if (isRootSessionId(sessionId)) {
      switch (method) {
        case "Target.getTargets":
          return (await this.syntheticGetTargets()) as T;
        case "Target.attachToTarget":
          return (await this.interceptAttachToTarget(params)) as T;
        case "Target.activateTarget":
          return (await this.interceptActivateTarget(params)) as T;
        case "Target.closeTarget":
          return (await this.interceptCloseTarget(params)) as T;
        // Target.setAutoAttach 透传（评审轮 1 [2] 探针修正后实证：autoAttach 可用——
        // Worker 子会话事件（source.sessionId）与子会话命令路由（Debuggee {tabId,
        // sessionId}）双通；被拒的只有显式 attachToTarget（握手拦截方案 S 不变）
        default:
          break;
      }
    }
    const result = (await this.sendRaw<T>(method, params, sessionId)) as T;
    // createTarget 透传新建 tab（评审轮 1 [4]）：快照立即失效——core createTab→switchTab
    // 紧跟的 activateTarget/attachToTarget 必须重新解析 targetId→tabId，陈旧缓存必抛
    // "not found"（navigate(new_tab) 100% 失败链）
    if (method === "Target.createTarget") this.targetInfosCache = null;
    return result;
  }

  on(method: string, listener: CdpEventListener): () => void {
    let set = this.listeners.get(method);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  async stop(): Promise<void> {
    const alreadyDetached = this.detached;
    this.teardownListeners();
    this.suppressDetachForTab = null;
    this.markDetached("stopped");
    if (alreadyDetached) return; // 幂等：重复 stop 零 API 调用（onDetach 先到同此路径）
    try {
      await this.api.detach({ tabId: this.currentTabId });
    } catch {
      // 已脱离（onDetach 先到）时 Chrome 会拒——静默
    }
  }

  // ── 内部 ─────────────────────────────────────────────────────────────

  private async sendRaw<T>(method: string, params?: object, sessionId?: string): Promise<T> {
    const debuggee: Debuggee = { tabId: this.currentTabId };
    if (!isRootSessionId(sessionId)) debuggee.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.pendingRejections.add(reject);
      this.api
        .sendCommand(debuggee, method, params ?? {})
        .then(
          (result) => resolve(result as T),
          (e: unknown) => reject(e instanceof Error ? e : new Error(errText(e))),
        )
        .finally(() => this.pendingRejections.delete(reject));
    });
  }

  /** TargetInfo 快照（合成 getTargets 与 targetId↔tabId 解析共用；探针：条目键为 id） */
  private async targetInfos(): Promise<TargetInfoDto[]> {
    const all = await this.api.getTargets();
    this.targetInfosCache = all;
    return all;
  }

  /**
   * Target.getTargets 合成（协议命令被拒 "Not allowed"——探针 P1）：page 条目映射
   * {targetId: entry.id, url, title, attached}，**附着 tab 置首**（core connectSession
   * 取首个 page target——必须命中附着 tab 而非任意标签）。
   */
  private async syntheticGetTargets(): Promise<{ targetInfos: Array<Record<string, unknown>> }> {
    const all = await this.targetInfos();
    const pages = all.filter((t) => t.type === "page");
    pages.sort((a, b) => {
      const own = (e: TargetInfoDto): number => (e.tabId === this.currentTabId ? 0 : 1);
      const d = own(a) - own(b);
      return d !== 0 ? d : (a.tabId ?? 0) - (b.tabId ?? 0);
    });
    return {
      targetInfos: pages.map((t) => ({
        targetId: t.id,
        type: "page",
        url: typeof t.url === "string" ? t.url : "",
        title: typeof t.title === "string" ? t.title : "",
        attached: t.tabId === this.currentTabId,
      })),
    };
  }

  private async tabIdForTarget(targetId: string): Promise<number | null> {
    const all = this.targetInfosCache ?? (await this.targetInfos());
    const hit = all.find((t) => t.id === targetId && t.type === "page");
    return typeof hit?.tabId === "number" ? hit.tabId : null;
  }

  private async ownTargetId(): Promise<string | null> {
    const all = this.targetInfosCache ?? (await this.targetInfos());
    const hit = all.find((t) => t.type === "page" && t.tabId === this.currentTabId);
    return typeof hit?.id === "string" ? hit.id : null;
  }

  /**
   * Target.attachToTarget 拦截（协议命令被拒 "Not allowed"——探针 q2）：
   * - 目标即当前附着 tab（connectSession 握手）→ 返回合成根会话标记；
   * - 其它 tab（switchTab 路径）→ 先 attach 新（失败则原附着不动，天然回滚）再
   *   detach 旧，更新锚点。chrome.debugger 允许同扩展多 tab 并发附着——先新后旧
   *   无空窗。
   */
  private async interceptAttachToTarget(params?: object): Promise<{ sessionId: string }> {
    const targetId =
      typeof (params as { targetId?: unknown } | undefined)?.targetId === "string"
        ? (params as { targetId: string }).targetId
        : "";
    if (targetId === "") throw new Error("attachToTarget: missing targetId");
    const ownId = await this.ownTargetId();
    if (targetId === ownId) return { sessionId: ROOT_SESSION_ID };
    const newTabId = await this.tabIdForTarget(targetId);
    if (newTabId === null) throw new Error(`Target ${targetId} not found (page targets only)`);
    await this.api.attach({ tabId: newTabId }, "1.3");
    const oldTabId = this.currentTabId;
    this.currentTabId = newTabId;
    this.targetInfosCache = null; // 附着关系已变，快照失效
    if (oldTabId !== newTabId) {
      try {
        await this.api.detach({ tabId: oldTabId });
      } catch (e) {
        this.log(`cdp-chrome: detach old tab ${oldTabId} after switch failed: ${errText(e)}`);
      }
    }
    this.log(`cdp-chrome: switched debugger attachment to tab ${newTabId}`);
    return { sessionId: ROOT_SESSION_ID };
  }

  /** Target.activateTarget 拦截：协议命令未验证可用性，chrome.tabs.activate 确定可用 */
  private async interceptActivateTarget(params?: object): Promise<Record<string, never>> {
    const targetId =
      typeof (params as { targetId?: unknown } | undefined)?.targetId === "string"
        ? (params as { targetId: string }).targetId
        : "";
    const tabId = await this.tabIdForTarget(targetId);
    if (tabId === null) throw new Error(`activateTarget: target ${targetId} not found`);
    await this.tabs.activate(tabId);
    return {};
  }

  /** Target.closeTarget 拦截：chrome.tabs.remove（TargetInfo.id→tabId 解析） */
  private async interceptCloseTarget(params?: object): Promise<Record<string, never>> {
    const targetId =
      typeof (params as { targetId?: unknown } | undefined)?.targetId === "string"
        ? (params as { targetId: string }).targetId
        : "";
    const tabId = await this.tabIdForTarget(targetId);
    if (tabId === null) throw new Error(`closeTarget: target ${targetId} not found`);
    // 关当前锚定 tab（评审轮 1 [5]）：tab 关闭必然触发 onDetach(target_closed)——登记抑制，
    // core closeTab 随后 getTargets+switchTab 重锚；非当前 tab 的关闭无附着关系、不触发
    if (tabId === this.currentTabId) this.suppressDetachForTab = tabId;
    try {
      await this.tabs.remove(tabId);
    } catch (e) {
      // 关闭未发生（评审轮 2 [2]：用户拖动标签条时 Chrome 拒 "tabs cannot be edited"）——
      // 抑制标记作废（tab 仍附着），残留会误吞该 tab 后续真实 detach（canceled_by_user/
      // replaced_with_devtools），markDetached 失灵
      this.suppressDetachForTab = null;
      throw e;
    }
    this.targetInfosCache = null; // tab 集已变（评审轮 1 [4] 同族：快照立即失效）
    return {};
  }

  private teardownListeners(): void {
    for (const set of this.listeners.values()) set.clear();
    this.listeners.clear();
    this.api.onEvent.removeListener(this.globalEventHandler);
    this.api.onDetach.removeListener(this.globalDetachHandler);
  }

  private markDetached(reason: string): void {
    if (this.detached) return;
    this.detached = true;
    this.detachReason = reason;
    const error = new Error(`Debugger detached: ${reason}`);
    for (const reject of this.pendingRejections) reject(error);
    this.pendingRejections.clear();
    this.onDetached?.(reason);
  }
}

/** 工厂（core TransportFactory 形态）：attach 成功才返回 transport；附着失败原文上抛 */
export async function createChromeDebuggerTransport(
  options: ChromeDebuggerTransportOptions,
): Promise<ChromeDebuggerTransport> {
  await options.api.attach({ tabId: options.tabId }, "1.3");
  return new ChromeDebuggerTransport(options);
}
