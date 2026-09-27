// CdpTransport 接口：core 侧的宿主中立 CDP 通道契约（架构 §4，P4 01 §1）。
// 形状与 @tw/cdp-ws CdpWsClient 鸭子兼容（cdp-ws 侧 contract test 断言）；core
// 运行时零依赖 cdp-ws——连接方式经 transportFactory 注入（Node=ws，扩展=chrome.debugger）。
// SessionInternals 是 16 功能模块共享的会话上下文类型（Python `self` 的显式化），
// 仅类型引用，与各模块构成 type-only 环（编译期安全、运行期消除）。

import type { Logger } from "../agent/action-shape.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import type { HighlightManager } from "./highlight.js";
import type { NetworkIdleTracker } from "./network-idle.js";
import type {
  BrowserEvent,
  BrowserSessionSettings,
  CookieSpec,
  HighlightSettings,
  StorageState,
} from "./views.js";

export type CdpEventListener = (params: unknown, sessionId: string | undefined) => void;

export interface CdpTransport {
  send<T>(method: string, params?: object, sessionId?: string): Promise<T>;
  /** 订阅 CDP 事件（method 全名），返回解订函数 */
  on(method: string, listener: CdpEventListener): () => void;
  /** 幂等拆卸：拒绝 pending → 断连接（命名对齐 CdpWsClient.stop 实测签名，p4/01 §1 预留项） */
  stop(): Promise<void> | void;
}

/** 绑定 currentSessionId 的发送捷径（模块内绝大多数 CDP 调用都用它） */
export type BoundSend = <T>(method: string, params?: object) => Promise<T>;

export function bindSend(transport: CdpTransport, sessionId: string | null): BoundSend {
  return <T>(method: string, params?: object) =>
    transport.send<T>(method, params, sessionId ?? undefined);
}

/** 已完成的下载记录（consumeCompletedDownloads 的条目形态，对齐 Python dict） */
export interface DownloadRecord {
  filename: string;
  url: string;
  path: string | null;
}

/** Page.fileChooserOpened 的截获记录（upload 族 P4b 消费；batch1 只记录） */
export interface FileChooserRecord {
  backendNodeId: number | null;
  mode: string | null;
  frameId: string | null;
  sessionId: string | null;
  ts: number;
}

/**
 * 功能模块共享的会话上下文。Python BrowserSession 的 self 状态与工具的显式化：
 * session.ts 的 BrowserSession 实现它，各功能模块收它作首参（测试可用部分对象
 * 满足结构类型）。时序敏感（click 三段间隔/退避等）经 sleep/now 注入以便 fake timers。
 */
export interface SessionInternals {
  readonly settings: BrowserSessionSettings;
  readonly log: Logger;
  transport: CdpTransport | null;
  currentTargetId: string | null;
  currentSessionId: string | null;
  /** 绑定 currentSessionId 的 send（连接期使用；实现处每次读当前值） */
  send: BoundSend;
  readonly networkIdle: NetworkIdleTracker;
  readonly domCircuitBreaker: CircuitBreaker;
  readonly highlight: HighlightManager;
  readonly highlightSettings: HighlightSettings;
  // ── 事件态（connection.ts 维护）──
  autoDialogEnabled: boolean;
  recentEventsEnabled: boolean;
  readonly recentEvents: BrowserEvent[];
  /** begin 事件捕获的 {filename, url}（url 只在 downloadWillBegin 携带） */
  readonly pendingDownloads: Map<string, { filename: string; url: string }>;
  readonly completedDownloads: DownloadRecord[];
  lastFileChooser: FileChooserRecord | null;
  fileChooserInterceptEnabled: boolean;
  /** fileChooserOpened 监听的去重解订柄（重发命令 per-session，监听只此一份） */
  fileChooserListenerDispose: (() => void) | null;
  /** transport.on 的解订函数集合（重连/停止先全量解订——多播下的单例纪律） */
  readonly eventDisposers: Array<() => void>;
  /** 非网格页 URL 缓存（grid-meta 跳过重复探测） */
  readonly gridNoGridUrls: Set<string>;
  // ── 可注入时钟/睡眠 ──
  sleep(ms: number): Promise<void>;
  /** 单调时钟（秒）——settle/deadline 轮询用 */
  now(): number;
  /** 清空两层 selector_map 缓存（导航/切页 5 处失效点共用） */
  clearSelectorMapCaches(): void;
}

/** cookie 注入结果（injectStorageState 返回） */
export interface InjectStorageStateResult {
  injected: number;
  failed: number;
}

/** storage_state → Network.setCookie（语义照搬评测仓 runner.py:80-156；实现见 connection.ts） */
export type InjectStorageStateFn = (
  s: SessionInternals,
  state: StorageState,
) => Promise<InjectStorageStateResult>;

export type { CookieSpec };
