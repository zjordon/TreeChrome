// BrowserSession Facade：组装 16 个功能模块，持有会话状态（连接态/两层 selector_map
// 缓存/事件态）。移植自 TreeWalker session.py 的编排层 @640d52a；连接经
// transportFactory 注入（p4/01 §3.1）。get_state 九步顺序保真（p4/01 §4）。

import {
  buildDomState,
  DOMDegradationLevel,
  type DOMSelectorMap,
  EMPTY_DOM_STATE,
  type SerializedDOMState,
} from "@tw/dom-snapshot";
import type { Logger } from "../agent/action-shape.js";
import type { AttachmentPayload } from "../tools/fs.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import type { StartOptions, TransportFactory } from "./connection.js";
import {
  acquireTransport,
  connectSession,
  consumeCompletedDownloads,
  consumeRecentEvents,
  getCurrentUrl,
  injectStorageState,
  setupDownloadTracking,
  unsubscribeAllEvents,
} from "./connection.js";
import { getPageHtml } from "./dom-access.js";
import {
  type DropdownDispatchResult,
  type DropdownOption,
  type DropdownSetterResult,
  expandAndFetchComboboxOptions,
  expandAndFetchCustomOptions,
  fetchDropdownOptions,
  fetchSelectOptions,
  setComboboxOption,
  setCustomDropdownOption,
  setDropdownOption,
  setSelectOption,
  setSelectOptionMulti,
} from "./dropdown.js";
import { clickElement, getElementCoordinates, isElementOccluded } from "./element-pointer.js";
import { evalFunctionOnNode, executeJs } from "./evaluate-basic.js";
import { type EvaluateRequest, evaluateEnhanced } from "./evaluate-enhanced.js";
import { readGridMeta } from "./grid-meta.js";
import { evalGridChannel, type GridReadPayload, readUiGrid } from "./grid-read.js";
import { HighlightManager } from "./highlight.js";
import { sendKeys } from "./keyboard.js";
import type { PageSettleResult, ScrollResult } from "./navigation.js";
import {
  goBack,
  navigate,
  scroll,
  waitForPageSettle,
  waitForReadyStateSettle,
} from "./navigation.js";
import { NetworkIdleTracker } from "./network-idle.js";
import type { PrintToPdfOptions, ScreenshotOptions } from "./screenshot.js";
import { printToPdf, takeScreenshot } from "./screenshot.js";
import type {
  FindElementsData,
  FindElementsNodeIdsData,
  FindTextResult,
  SearchPageData,
} from "./search-find.js";
import { findElements, findElementsNodeIds, findText, searchPage } from "./search-find.js";
import { closeTab, createTab, getTabs, switchTab } from "./tabs.js";
import { clearTextField, forceSetValue, readActiveText, typeText } from "./text-input.js";
import type { BoundSend, CdpTransport, DownloadRecord, SessionInternals } from "./transport.js";
import { discoverFileInputViaClick, setFileInput, setFileInputData } from "./upload.js";
import type {
  BrowserEvent,
  BrowserSessionSettings,
  BrowserStateSummary,
  DOMRect,
  StorageState,
  TabInfo,
} from "./views.js";
import { DEFAULT_BROWSER_SESSION_SETTINGS } from "./views.js";

export interface BrowserSessionOptions {
  log?: Logger;
  /** 可中止睡眠（缺省 setTimeout 包装；测试注入 fake timers 用） */
  sleep?: (ms: number) => Promise<void>;
  /** 单调时钟·秒（缺省 performance.now()/1000） */
  now?: () => number;
}

export interface GetStateOptions {
  /** Python 缺省 true */
  includeScreenshot?: boolean;
  waitSettle?: boolean;
  waitNetworkidle?: boolean;
}

export class BrowserSession {
  private readonly settings: BrowserSessionSettings;
  /** 动作间反检测等待·秒的公开只读面（Agent 构造快照消费——Python agent.py:93
   *  读 browser._settings.wait_between_actions 的私有访问公开化） */
  readonly waitBetweenActionsS: number;
  private readonly transportFactory: TransportFactory;
  private readonly log: Logger;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly nowImpl: () => number;
  // 两层 DOM 缓存（新元素 `*` 前缀的根基；5 处失效点：navigate/goBack/switchTab/reconnect/stop）
  private cachedSelectorMap: DOMSelectorMap | null = null;
  private previousCachedSelectorMap: DOMSelectorMap | null = null;
  private readonly domCircuitBreaker: CircuitBreaker;
  private readonly networkIdle: NetworkIdleTracker;
  private readonly highlight: HighlightManager;
  private readonly recentEventsBuf: BrowserEvent[] = [];
  private readonly pendingDownloads = new Map<string, { filename: string; url: string }>();
  private readonly completedDownloads: DownloadRecord[] = [];
  private lastFileChooserRef: SessionInternals["lastFileChooser"] = null;
  private fileChooserInterceptEnabledRef = false;
  private fileChooserListenerDisposeRef: (() => void) | null = null;
  /** start(trackDownloads) 的路径——reconnect 后据此重建下载追踪 */
  private downloadsPath: string | null = null;
  private recentEventsEnabled = false;
  private readonly eventDisposers: Array<() => void> = [];
  private readonly gridNoGridUrls = new Set<string>();
  private transportRef: CdpTransport | null = null;
  private targetIdRef: string | null = null;
  private sessionIdRef: string | null = null;
  private ctx: SessionInternals | null = null;

  constructor(
    transportFactory: TransportFactory,
    settings: Partial<BrowserSessionSettings> = {},
    options: BrowserSessionOptions = {},
  ) {
    this.transportFactory = transportFactory;
    this.settings = { ...DEFAULT_BROWSER_SESSION_SETTINGS, ...settings };
    this.waitBetweenActionsS = this.settings.waitBetweenActions;
    this.log = options.log ?? (() => {});
    this.sleepImpl = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.nowImpl = options.now ?? (() => performance.now() / 1000);
    this.domCircuitBreaker = new CircuitBreaker({
      failureThreshold: this.settings.circuitBreakerThreshold,
      recoveryTimeout: this.settings.circuitBreakerRecoveryS,
      log: this.log,
    });
    this.networkIdle = new NetworkIdleTracker({
      timeout: this.settings.networkIdleTimeout,
      stabilityWindow: this.settings.networkIdleStabilityWindow,
      pollInterval: this.settings.networkIdlePollInterval,
      sleep: this.sleepImpl,
      log: this.log,
    });
    this.highlight = new HighlightManager(this.settings.highlight, {
      executeJs: (code) => executeJs(this.context(), code),
      send: null,
      log: this.log,
    });
  }

  /** 模块共享上下文（单一实例；可变连接态经 getter/setter 直达会话字段） */
  private context(): SessionInternals {
    const cached = this.ctx;
    if (cached) return cached;
    const self = this;
    const ctx: SessionInternals = {
      settings: this.settings,
      log: this.log,
      get transport() {
        return self.transportRef;
      },
      get currentTargetId() {
        return self.targetIdRef;
      },
      set currentTargetId(v) {
        self.targetIdRef = v;
      },
      get currentSessionId() {
        return self.sessionIdRef;
      },
      set currentSessionId(v) {
        self.sessionIdRef = v;
      },
      send: (method, params) => self.boundSend(method, params),
      networkIdle: this.networkIdle,
      domCircuitBreaker: this.domCircuitBreaker,
      highlight: this.highlight,
      highlightSettings: this.settings.highlight,
      get autoDialogEnabled() {
        return self.settings.autoHandleJsDialog;
      },
      get recentEventsEnabled() {
        return self.recentEventsEnabled;
      },
      recentEvents: this.recentEventsBuf,
      pendingDownloads: this.pendingDownloads,
      completedDownloads: this.completedDownloads,
      get lastFileChooser() {
        return self.lastFileChooserRef;
      },
      set lastFileChooser(v) {
        self.lastFileChooserRef = v;
      },
      get fileChooserInterceptEnabled() {
        return self.fileChooserInterceptEnabledRef;
      },
      set fileChooserInterceptEnabled(v) {
        self.fileChooserInterceptEnabledRef = v;
      },
      get fileChooserListenerDispose() {
        return self.fileChooserListenerDisposeRef;
      },
      set fileChooserListenerDispose(v) {
        self.fileChooserListenerDisposeRef = v;
      },
      eventDisposers: this.eventDisposers,
      gridNoGridUrls: this.gridNoGridUrls,
      sleep: this.sleepImpl,
      now: this.nowImpl,
      clearSelectorMapCaches: () => this.clearSelectorMapCaches(),
    };
    // highlight 的 executeJs 闭包引用 context()——构造期先装订（连接前调用会因
    // transport 空走各自降级路径，与 Python 未连线行为一致）
    this.highlight.attach(null);
    this.ctx = ctx;
    return ctx;
  }

  private boundSend: BoundSend = <T>(method: string, params?: object) => {
    if (!this.transportRef) throw new Error("BrowserSession: not connected");
    return this.transportRef.send<T>(method, params, this.sessionIdRef ?? undefined);
  };

  get isConnected(): boolean {
    return this.transportRef !== null;
  }
  get currentSessionId(): string | null {
    return this.sessionIdRef;
  }
  get currentTargetId(): string | null {
    return this.targetIdRef;
  }

  async start(options: StartOptions = {}): Promise<void> {
    this.transportRef = await acquireTransport(this.transportFactory);
    try {
      await connectSession(this.context());
    } catch (e) {
      // 回滚半连接态（评审轮 1 #2）：connect 中途失败不得遗留 isConnected=true 的
      // 空壳——与 reconnect 失败分支的不变量一致
      unsubscribeAllEvents(this.context());
      this.transportRef = null;
      throw e;
    }
    if (options.trackDownloads) {
      if (!options.downloadsPath) {
        throw new Error(
          "trackDownloads 需要显式 downloadsPath（宿主解析并确保目录存在——核心包不读 env/home）",
        );
      }
      this.downloadsPath = options.downloadsPath;
      await setupDownloadTracking(this.context(), options.downloadsPath);
    }
    this.recentEventsEnabled = options.enableRecentEvents ?? false;
  }

  /** 单次重连（重连循环在 agent 侧——step 层的连接错误分支） */
  async reconnect(): Promise<boolean> {
    try {
      unsubscribeAllEvents(this.context());
      await this.transportRef?.stop();
      this.targetIdRef = null;
      this.sessionIdRef = null;
      this.clearSelectorMapCaches();
      this.domCircuitBreaker.reset();
      this.transportRef = await acquireTransport(this.transportFactory);
      await connectSession(this.context());
      // 下载追踪随 unsubscribeAllEvents 一并释放，重连成功后按原路径重建
      // （评审轮 1 #1——Python :1856-1874 同款缺口，TS 侧补齐）
      if (this.downloadsPath) {
        await setupDownloadTracking(this.context(), this.downloadsPath);
      }
      return true;
    } catch (e) {
      this.log(`Reconnect failed: ${String(e)}`);
      this.transportRef = null;
      return false;
    }
  }

  async stop(): Promise<void> {
    this.clearSelectorMapCaches();
    unsubscribeAllEvents(this.context());
    this.highlight.detach();
    this.networkIdle.unsubscribe();
    await this.transportRef?.stop();
    this.transportRef = null;
    this.targetIdRef = null;
    this.sessionIdRef = null;
    this.log("Browser disconnected");
  }

  private clearSelectorMapCaches(): void {
    this.cachedSelectorMap = null;
    this.previousCachedSelectorMap = null;
  }

  getCurrentUrl(): Promise<string> {
    return getCurrentUrl(this.context());
  }

  /**
   * 全量状态（Python get_state:2041-2143，九步顺序保真）：settle → networkidle →
   * 缓存轮转 → url/title → tabs → DOM 采集（熔断）→ 高亮移除/截图/回注 →
   * grid_meta → recentEvents 取走。
   */
  async getState(options: GetStateOptions = {}): Promise<BrowserStateSummary> {
    const s = this.context();
    const includeScreenshot = options.includeScreenshot ?? true;
    if (options.waitSettle) {
      try {
        await waitForReadyStateSettle(s);
      } catch (e) {
        this.log(`Pre-get_state wait_settle failed: ${String(e)}`);
      }
    }
    if (options.waitNetworkidle) {
      try {
        await this.networkIdle.waitUntilIdle();
      } catch (e) {
        this.log(`Pre-get_state wait_networkidle failed: ${String(e)}`);
      }
    }
    // 轮转缓存：当前 → 前一步（新元素检测用）
    this.previousCachedSelectorMap = this.cachedSelectorMap;

    let url = "";
    let title = "";
    try {
      const result = await this.boundSend<{ result?: { value?: unknown } }>("Runtime.evaluate", {
        expression: "JSON.stringify({url: location.href, title: document.title})",
        returnByValue: true,
      });
      const info = JSON.parse(String(result.result?.value ?? "{}")) as {
        url?: string;
        title?: string;
      };
      url = info.url ?? "";
      title = info.title ?? "";
    } catch {
      // 与 Python 同款：吞掉（空串兜底）
    }

    const tabs = await getTabs(s);

    let domState: SerializedDOMState | null = null;
    if (this.domCircuitBreaker.isOpen) {
      this.log("DOM circuit breaker is open; returning empty DOM state");
      domState = EMPTY_DOM_STATE;
    } else {
      const transport = this.transportRef;
      if (!transport) throw new Error("get_state: not connected");
      try {
        const { state, metrics } = await buildDomState(transport, this.sessionIdRef, {
          previousSelectorMap: this.previousCachedSelectorMap,
          config: {
            cdpFirstTimeout: this.settings.cdpFirstTimeout,
            cdpRetryTimeout: this.settings.cdpRetryTimeout,
            maxIframes: this.settings.maxIframes,
            heavyPageElementThreshold: this.settings.heavyPageElementThreshold,
          },
        });
        if (metrics.degradationLevel === DOMDegradationLevel.FAILED) {
          this.domCircuitBreaker.recordFailure();
        } else {
          this.domCircuitBreaker.recordSuccess();
        }
        domState = state;
      } catch (e) {
        this.log(`build_dom_state raised: ${String(e)}`);
        this.domCircuitBreaker.recordFailure();
        domState = EMPTY_DOM_STATE;
      }
    }
    this.cachedSelectorMap = domState ? domState.selectorMap : null;

    // debug 高亮：截前移除、截后回注（高亮只给人看，不进 LLM 图）
    const debugHighlight = this.settings.highlight.enabled && this.settings.highlight.debugMode;
    if (debugHighlight) {
      try {
        await this.highlight.removeHighlights();
      } catch {
        // 吞掉
      }
    }
    let screenshot: Uint8Array | null = null;
    if (includeScreenshot) {
      try {
        screenshot = await takeScreenshot(s);
      } catch (e) {
        this.log(`get_state: take_screenshot failed: ${String(e)}`);
        screenshot = null;
      }
    }
    if (debugHighlight && this.cachedSelectorMap) {
      try {
        await this.highlight.addDebugHighlights(this.cachedSelectorMap);
      } catch {
        // 吞掉
      }
    }

    const gridMeta = await readGridMeta(s, url);
    return {
      url,
      title,
      tabs,
      domState,
      screenshot,
      gridMeta,
      recentEvents: consumeRecentEvents(s),
    };
  }

  // ── 动作面委托（batch1 十动作 + 内部依赖）──
  navigate(url: string, options?: { newTab?: boolean }): Promise<string | null> {
    return navigate(this.context(), url, options);
  }
  goBack(): Promise<string | null> {
    return goBack(this.context());
  }
  waitForPageSettle(options?: {
    timeout?: number;
    poll?: number;
    stablePolls?: number;
  }): Promise<PageSettleResult> {
    return waitForPageSettle(this.context(), options);
  }
  scroll(direction?: "up" | "down", amount?: number): Promise<ScrollResult> {
    return scroll(this.context(), direction, amount);
  }
  highlightElement(backendNodeId: number): Promise<void> {
    return this.highlight.highlightElement(backendNodeId);
  }
  clickElement(backendNodeId: number): Promise<boolean> {
    return clickElement(this.context(), backendNodeId);
  }
  typeText(text: string, options?: { clear?: boolean }): Promise<void> {
    return typeText(this.context(), text, options);
  }
  /** Python 私有方法的 Facade 委托（tools 层 input_text 直赋值分支/回读验证消费） */
  clearTextField(): Promise<boolean> {
    return clearTextField(this.context());
  }
  forceSetValue(text: string): Promise<void> {
    return forceSetValue(this.context(), text);
  }
  readActiveText(): Promise<string> {
    return readActiveText(this.context());
  }
  sendKeys(keys: string): Promise<void> {
    return sendKeys(this.context(), keys);
  }
  /** 三级回退坐标（actionability 探测/几何归一化消费） */
  getElementCoordinates(backendNodeId: number): Promise<DOMRect | null> {
    return getElementCoordinates(this.context(), backendNodeId);
  }
  /** elementFromPoint 运行时遮挡（actionability L3 消费） */
  isElementOccluded(backendNodeId: number, x: number, y: number): Promise<boolean> {
    return isElementOccluded(this.context(), backendNodeId, x, y);
  }
  getTabs(): Promise<TabInfo[]> {
    return getTabs(this.context());
  }
  switchTab(targetId: string): Promise<void> {
    return switchTab(this.context(), targetId);
  }
  closeTab(targetId: string): Promise<void> {
    return closeTab(this.context(), targetId);
  }
  createTab(url?: string): Promise<string> {
    return createTab(this.context(), url);
  }
  executeJs(code: string): Promise<unknown> {
    return executeJs(this.context(), code);
  }
  evalFunctionOnNode(backendNodeId: number, fn: string): Promise<unknown> {
    return evalFunctionOnNode(this.context(), backendNodeId, fn);
  }
  /** P4b 搜索/查找族（search-find.ts 四方法族） */
  findText(
    text: string,
    opts?: { nth?: number; caseSensitive?: boolean; highlight?: "box" | "selection" | "none" },
  ): Promise<FindTextResult> {
    return findText(this.context(), text, opts);
  }
  findElements(
    selector: string,
    opts?: {
      attributes?: string[] | null;
      maxResults?: number;
      offset?: number;
      includeText?: boolean;
      firstOnly?: boolean;
      includeGeometry?: boolean;
    },
  ): Promise<FindElementsData> {
    return findElements(this.context(), selector, opts);
  }
  findElementsNodeIds(
    selector: string,
    opts?: { maxResults?: number; offset?: number; includeUserAgentShadow?: boolean },
  ): Promise<FindElementsNodeIdsData> {
    return findElementsNodeIds(this.context(), selector, opts);
  }
  searchPage(
    pattern: string,
    opts?: {
      regex?: boolean;
      caseSensitive?: boolean;
      contextChars?: number;
      cssScope?: string | null;
      maxResults?: number;
      offset?: number;
      searchAttributes?: boolean;
    },
  ): Promise<SearchPageData> {
    return searchPage(this.context(), pattern, opts);
  }
  // ── P4b 段 2：下拉族 + 上传族委托 ──
  fetchSelectOptions(backendNodeId: number): Promise<DropdownOption[]> {
    return fetchSelectOptions(this.context(), backendNodeId);
  }
  fetchDropdownOptions(backendNodeId: number): Promise<DropdownDispatchResult> {
    return fetchDropdownOptions(this.context(), backendNodeId);
  }
  setSelectOption(backendNodeId: number, value: string): Promise<DropdownSetterResult> {
    return setSelectOption(this.context(), backendNodeId, value);
  }
  setSelectOptionMulti(backendNodeId: number, values: string[]): Promise<DropdownSetterResult> {
    return setSelectOptionMulti(this.context(), backendNodeId, values);
  }
  setDropdownOption(backendNodeId: number, value: string): Promise<DropdownSetterResult> {
    return setDropdownOption(this.context(), backendNodeId, value);
  }
  setComboboxOption(backendNodeId: number, value: string): Promise<DropdownSetterResult> {
    return setComboboxOption(this.context(), backendNodeId, value);
  }
  setCustomDropdownOption(backendNodeId: number, value: string): Promise<DropdownSetterResult> {
    return setCustomDropdownOption(this.context(), backendNodeId, value);
  }
  expandAndFetchComboboxOptions(backendNodeId: number): Promise<DropdownOption[]> {
    return expandAndFetchComboboxOptions(this.context(), backendNodeId);
  }
  expandAndFetchCustomOptions(backendNodeId: number): Promise<DropdownOption[]> {
    return expandAndFetchCustomOptions(this.context(), backendNodeId);
  }
  setFileInput(
    backendNodeId: number | null,
    filePath: string,
    fileInputBackendIds?: number[] | null,
  ): Promise<void> {
    return setFileInput(this.context(), backendNodeId, filePath, fileInputBackendIds ?? null);
  }
  /** bytes 注入（M5 段 C 扩展形态）：与 setFileInput 对称的附件通道端点 */
  setFileInputData(backendNodeId: number, payload: AttachmentPayload): Promise<void> {
    return setFileInputData(this.context(), backendNodeId, payload);
  }
  discoverFileInputViaClick(backendNodeId: number, timeoutMs?: number): Promise<number | null> {
    return discoverFileInputViaClick(this.context(), backendNodeId, timeoutMs);
  }
  // ── P4b 段 3：evaluate 增强 + 网格读取 ──
  evaluateEnhanced(req: EvaluateRequest): Promise<string> {
    return evaluateEnhanced(this.context(), req);
  }
  readUiGrid(
    payload: GridReadPayload,
    timeoutMs?: number | null,
  ): Promise<Record<string, unknown>> {
    return readUiGrid(this.context(), payload, timeoutMs);
  }
  evalGridChannel(js: string, payload: GridReadPayload): Promise<Record<string, unknown> | null> {
    return evalGridChannel(this.context(), js, payload);
  }
  getPageHtml(options?: { extractLinks?: boolean; extractImages?: boolean }): Promise<string> {
    return getPageHtml(this.context(), options);
  }
  takeScreenshot(options?: ScreenshotOptions): Promise<Uint8Array> {
    return takeScreenshot(this.context(), options);
  }
  printToPdf(options?: PrintToPdfOptions): Promise<Uint8Array> {
    return printToPdf(this.context(), options);
  }
  consumeCompletedDownloads() {
    return consumeCompletedDownloads(this.context());
  }

  /** 裸 CDP 逃生口（绑定 currentSessionId；评测 adapter 与 step 内部用） */
  rawSend<T>(method: string, params?: object): Promise<T> {
    return this.boundSend<T>(method, params);
  }

  injectStorageState(
    state: StorageState,
    defaultScheme?: string,
  ): ReturnType<typeof injectStorageState> {
    return injectStorageState(this.context(), state, defaultScheme);
  }
}
