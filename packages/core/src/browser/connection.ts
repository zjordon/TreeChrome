// 连接/生命周期/事件态：_connect 握手与域 enable 序列、dialog 自动处理、下载追踪、
// file-chooser 拦截、recent_events、cookie 注入。移植自 TreeWalker session.py:1613-2039
// （@640d52a）。有意偏离（p4/01 §6）：连接经 transportFactory（自愈=重试工厂一次，
// 无 url 比较——discover 在宿主工厂内）；下载目录由宿主显式传入（核心包禁 ambient，
// Python 的 env/~/Downloads 回退属宿主职责）；多播事件下先解订再注册的单例纪律。
// 有意偏离（examples 批，2026-09-30）：连接序列补 Overlay.enable——Python 从不启用
// Overlay 域却直接发 Overlay.highlightNode，Chrome 拒绝（"Overlay must be enabled"），
// Python 侧同款失败被 logger.debug 吞掉不可见；TS 修复使交互高亮真正生效（switchTab
// 侧随 file-chooser 拦截的 per-session 重发先例一并重发）。

import type { SessionInternals } from "./transport.js";
import { bindSend, type CdpTransport } from "./transport.js";
import type { CookieSpec, StorageState } from "./views.js";

export type TransportFactory = () => Promise<CdpTransport>;

export interface StartOptions {
  trackDownloads?: boolean;
  /** 下载落盘目录（宿主解析并确保存在；Python 的 env/~/Downloads 回退不出核心包） */
  downloadsPath?: string;
  enableRecentEvents?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 建立 transport（自愈：握手失败重试工厂一次——Chrome 重启自愈的宿主中立项） */
export async function acquireTransport(
  factory: TransportFactory,
  firstError?: unknown,
): Promise<CdpTransport> {
  if (firstError === undefined) {
    try {
      return await factory();
    } catch (err) {
      return acquireTransport(factory, err);
    }
  }
  // 自愈重试：失败则抛原始握手异常
  try {
    return await factory();
  } catch {
    throw firstError;
  }
}

/**
 * _connect 序列（session.py:1642-1721，顺序保真）：tracker reset → 握手 →
 * target 发现/attach → Page.enable → DOM.enable → Overlay.enable（偏离修复）→
 * dialog 回调（降级）→ Network.enable + tracker 注册（降级）→ setAutoAttach
 * （best-effort）→ file-chooser 拦截 → highlight 接线。
 */
export async function connectSession(s: SessionInternals): Promise<void> {
  s.networkIdle.reset();
  const transport = s.transport;
  if (!transport) throw new Error("connectSession: transport 未设置（内部错误）");

  const targets = await transport.send<Record<string, unknown>>("Target.getTargets", {});
  for (const t of Array.isArray(targets.targetInfos) ? targets.targetInfos : []) {
    if (isRecord(t) && t.type === "page" && typeof t.targetId === "string") {
      s.currentTargetId = t.targetId;
      const result = await transport.send<Record<string, unknown>>("Target.attachToTarget", {
        targetId: s.currentTargetId,
        flatten: true,
      });
      s.currentSessionId = String(result.sessionId);
      break;
    }
  }
  if (!s.currentSessionId) {
    throw new Error("No page target found. Is Chrome running with --remote-debugging-port?");
  }

  await s.send("Page.enable", {});
  await s.send("DOM.enable", {});
  await enableOverlay(s);
  // dialog 回调 always-on（挂起的 alert/confirm 冻结 Runtime.evaluate——493 教训）；
  // 失败降级为不处理
  try {
    setupEventTracking(s);
  } catch (e) {
    s.log(`dialog handler registration failed (degrading): ${String(e)}`);
  }
  // Network 域 + tracker 注册（always-on；wait 由 get_state 显式触发）；失败降级 disabled
  try {
    await s.send("Network.enable", {});
    s.networkIdle.register(transport);
  } catch (e) {
    s.log(`Network.enable / tracker register failed (degrading): ${String(e)}`);
  }
  // 自动发现 iframe target（best-effort）
  try {
    await s.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  } catch {
    // 与 Python 同款：吞掉
  }
  await enableFileChooserIntercept(s);
  s.log(`Browser connected: target=${s.currentTargetId}`);
  s.highlight.attach(s.send);
}

/** 解订全部事件回调（多播下的「覆盖式注册」等价物：重连/停止前调用） */
export function unsubscribeAllEvents(s: SessionInternals): void {
  for (const dispose of s.eventDisposers) dispose();
  s.eventDisposers.length = 0;
  s.fileChooserListenerDispose = null;
}

/**
 * Overlay 域启用（交互高亮的 CDP 前置——偏离修复，见文件头）：best-effort，失败
 * 降级为无高亮（highlight 自身即 non-critical 设计）。per-session——switchTab 换
 * target 后必须重发（与 file-chooser 拦截同款先例）。
 */
export async function enableOverlay(s: SessionInternals): Promise<void> {
  try {
    await s.send("Overlay.enable", {});
  } catch (e) {
    s.log(`Overlay.enable failed (degrading, no highlight): ${String(e)}`);
  }
}

/**
 * 注册 dialog 事件回调（_setup_event_tracking，session.py:1929-1975）：事件本体
 * 无条件记录（自动处理对 LLM 必须可见）；auto_handle 开启时调度
 * Page.handleJavaScriptDialog（beforeunload→accept 放行导航，其余 dismiss——不替
 * 用户确认危险操作）。Python 的 call_soon_threadsafe 移交在 TS 单线程下为微任务。
 */
export function setupEventTracking(s: SessionInternals): void {
  const transport = s.transport;
  if (!transport) throw new Error("setupEventTracking: no transport");
  const dispose = transport.on("Page.javascriptDialogOpening", (event, sessionId) => {
    const e = isRecord(event) ? event : {};
    const message =
      (typeof e.message === "string" && e.message) || (typeof e.url === "string" ? e.url : "");
    const dialogType = typeof e.type === "string" ? e.type : "alert";
    const accept = dialogType === "beforeunload";
    const action = accept ? "auto-accepted" : "auto-dismissed";
    const prefix = message ? `[${dialogType}] ${message}` : `[${dialogType}]`;
    recordEvent(s, {
      type: "dialog",
      message: `${prefix} (${action})`,
      timestamp: Date.now() / 1000,
    });
    if (!s.autoDialogEnabled) return;
    void (async () => {
      try {
        await s.transport?.send(
          "Page.handleJavaScriptDialog",
          { accept, promptText: "" },
          sessionId ?? s.currentSessionId ?? undefined,
        );
        s.log(`JS dialog auto-handled (accept=${accept})`);
      } catch (e2) {
        s.log(`handleJavaScriptDialog failed (already closed?): ${String(e2)}`);
      }
    })();
  });
  s.eventDisposers.push(dispose);
  s.log(`recent_events tracking enabled (dialog; auto_handle=${s.autoDialogEnabled})`);
}

/** 线程安全追加（deque maxlen=20 的数组等价物：溢出丢最老） */
export function recordEvent(s: SessionInternals, event: import("./views.js").BrowserEvent): void {
  s.recentEvents.push(event);
  if (s.recentEvents.length > 20) s.recentEvents.splice(0, s.recentEvents.length - 20);
}

/** 返回并清空近期事件缓冲（get_state 每步消费） */
export function consumeRecentEvents(s: SessionInternals): import("./views.js").BrowserEvent[] {
  const events = [...s.recentEvents];
  s.recentEvents.length = 0;
  return events;
}

/**
 * 启用 OS 文件选择器拦截（per-session——_connect 与 switchTab 都必须重发，
 * Bug-1 回归源）。拦截开启时点击 file input 发 Page.fileChooserOpened 而非弹
 * 原生阻塞对话框。best-effort。
 */
export async function enableFileChooserIntercept(s: SessionInternals): Promise<void> {
  try {
    await s.send("Page.setInterceptFileChooserDialog", { enabled: true });
    const transport = s.transport;
    if (!transport) return;
    // 事件监听是 transport 级的：重发命令（per-session）每次必须，但监听先解订再注册
    // （评审轮 1 #4/#9——多播下重复注册会随 switchTab 次数线性累积）
    s.fileChooserListenerDispose?.();
    s.fileChooserListenerDispose = null;
    const dispose = transport.on("Page.fileChooserOpened", (event, sessionId) => {
      const e = isRecord(event) ? event : {};
      s.lastFileChooser = {
        backendNodeId: typeof e.backendNodeId === "number" ? e.backendNodeId : null,
        mode: typeof e.mode === "string" ? e.mode : null,
        frameId: typeof e.frameId === "string" ? e.frameId : null,
        sessionId: sessionId ?? null,
        ts: Date.now() / 1000,
      };
      s.log(
        `Native file chooser intercepted (suppressed): mode=${s.lastFileChooser.mode}, ` +
          `backendNodeId=${s.lastFileChooser.backendNodeId}, frameId=${s.lastFileChooser.frameId}`,
      );
    });
    s.eventDisposers.push(dispose);
    s.fileChooserListenerDispose = dispose;
    s.fileChooserInterceptEnabled = true;
  } catch (e) {
    s.log(`setInterceptFileChooserDialog unavailable/failed: ${String(e)}`);
  }
}

/**
 * 下载追踪（session.py:1876-1925）：behavior="allow" 必须带 downloadPath（default
 * 行为不发事件）。回调在事件到达时记账，completed 进缓冲供 consume。
 */
export async function setupDownloadTracking(
  s: SessionInternals,
  downloadsPath: string,
): Promise<void> {
  const transport = s.transport;
  if (!transport) throw new Error("setupDownloadTracking: no transport");
  await s.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    eventsEnabled: true,
    downloadPath: downloadsPath,
  });
  s.eventDisposers.push(
    transport.on("Browser.downloadWillBegin", (event) => {
      const e = isRecord(event) ? event : {};
      const guid = typeof e.guid === "string" ? e.guid : "";
      const filename = typeof e.suggestedFilename === "string" ? e.suggestedFilename : "unknown";
      // url 只在 begin 事件携带（评审轮 1 #3：progress 事件无 url——Python :1907-1915
      // 同款缺口，在此捕获；filePath 则相反，只在 progress 的 completed 实发）
      const url = typeof e.url === "string" ? e.url : "";
      s.pendingDownloads.set(guid, { filename, url });
      s.log(`Download started: ${filename}`);
    }),
  );
  s.eventDisposers.push(
    transport.on("Browser.downloadProgress", (event) => {
      const e = isRecord(event) ? event : {};
      if (e.state !== "completed") return;
      const guid = typeof e.guid === "string" ? e.guid : "";
      const entry = s.pendingDownloads.get(guid) ?? { filename: "unknown", url: "" };
      s.pendingDownloads.delete(guid);
      s.completedDownloads.push({
        filename: entry.filename,
        url: entry.url,
        // Python :1914 event.get("filePath") 等价——协议文档未列该字段，但 Chrome
        // 实发（真机日志证实：completed 事件携带 filePath）。path 是「二.C 下载自动
        // 并入 done 附件」的供氧面：null 会让该下载被跳过（用户日志暴露的断链点）
        path: typeof e.filePath === "string" ? e.filePath : null,
      });
      s.log(`Download completed: ${entry.filename}`);
    }),
  );
}

export function consumeCompletedDownloads(
  s: SessionInternals,
): import("./transport.js").DownloadRecord[] {
  const downloads = [...s.completedDownloads];
  s.completedDownloads.length = 0;
  return downloads;
}

/** 轻量 URL 读取（Runtime.evaluate location.href；异常返 ""） */
export async function getCurrentUrl(s: SessionInternals): Promise<string> {
  try {
    const result = await s.send<Record<string, unknown>>("Runtime.evaluate", {
      expression: "location.href",
      returnByValue: true,
    });
    const inner = isRecord(result.result) ? result.result : {};
    return typeof inner.value === "string" ? inner.value : "";
  } catch {
    return "";
  }
}

const SAME_SITE_MAP: Readonly<Record<string, string>> = {
  Strict: "Strict",
  Lax: "Lax",
  None: "None",
};

/**
 * storage_state → Network.setCookie（injectStorageState）。语义照搬评测仓
 * runner.py:80-156（P3 cdp-ws injectCookies 同源）：显式 url 优先；domain 形态
 * 下 localhost 必须走 url 参数绑定（setCookie 对 localhost 域的静默丢弃坑）。
 * 单条失败记账并继续；返回 {injected, failed}。
 */
export async function injectStorageState(
  s: SessionInternals,
  state: StorageState,
  defaultScheme = "http",
): Promise<{ injected: number; failed: number }> {
  const cookies = state.cookies;
  if (!Array.isArray(cookies)) {
    throw new Error("storage_state.cookies 必须是数组（Playwright storage_state 形态）");
  }
  let injected = 0;
  let failed = 0;
  for (const raw of cookies as CookieSpec[]) {
    if (typeof raw.name !== "string" || typeof raw.value !== "string") continue;
    const path = typeof raw.path === "string" && raw.path ? raw.path : "/";
    const params: Record<string, unknown> = {
      name: raw.name,
      value: raw.value,
      path,
    };
    if (typeof raw.expires === "number" && raw.expires > 0) params.expires = raw.expires;
    if (typeof raw.httpOnly === "boolean") params.httpOnly = raw.httpOnly;
    if (typeof raw.secure === "boolean") params.secure = raw.secure;
    if (typeof raw.sameSite === "string") {
      params.sameSite = SAME_SITE_MAP[raw.sameSite] ?? "Lax";
    }
    const domain = typeof raw.domain === "string" ? raw.domain.replace(/^\./, "") : "";
    if (typeof raw.url === "string" && raw.url) {
      params.url = raw.url;
    } else if (domain) {
      if (domain === "localhost") {
        // localhost 域 cookie 必须 url 绑定（runner.py:128-139 实测坑）
        params.url = `${defaultScheme}://localhost${path}`;
      } else {
        params.domain = domain;
      }
    } else {
      params.url = `${defaultScheme}://localhost${path}`;
    }
    try {
      const result = await s.send<Record<string, unknown>>("Network.setCookie", params);
      if (result.success === false) {
        failed += 1;
        s.log(`setCookie 失败（success=false）：${raw.name}`);
      } else {
        injected += 1;
      }
    } catch (e) {
      failed += 1;
      s.log(`setCookie 异常：${raw.name}: ${String(e)}`);
    }
  }
  return { injected, failed };
}

export { bindSend };
