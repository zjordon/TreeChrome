// 导航与页面稳定：navigate/go_back、readyState settle（内部版）、requirejs 稳定
// settle（公开版）+ KO 网格行渲染冻结 kick、scroll。移植自 TreeWalker session.py
// :2350-2436（导航）、:2866-2985（settle/kick）、:3542-3613（scroll）@640d52a。
// 人工时序（勿优化）：scroll 后固定 0.2s 且不用 readyState settle（不变化=无等待）。

import { evaluateScript } from "./evaluate-basic.js";
import { takeScreenshot } from "./screenshot.js";
import { createTab } from "./tabs.js";
import type { SessionInternals } from "./transport.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * 导航（session.py:2350-2376）：newTab 先开空白页（保留 errorText 检查链）；清
 * 两层 selector_map 缓存；errorText 存在即失败。返回 newTab 的 targetId 或 null。
 */
export async function navigate(
  s: SessionInternals,
  url: string,
  options: { newTab?: boolean } = {},
): Promise<string | null> {
  const targetId = options.newTab ? await createTab(s, "about:blank") : null;
  s.clearSelectorMapCaches();
  const result = await s.send<Record<string, unknown>>("Page.navigate", {
    url,
    transitionType: "address_bar",
  });
  // errorText 仅在导航失败时存在（CDP：present if and only if navigation has failed）
  const errorText = isRecord(result) ? result.errorText : undefined;
  if (typeof errorText === "string" && errorText) {
    throw new Error(`Navigation failed: ${errorText}`);
  }
  await waitForReadyStateSettle(s);
  return targetId;
}

/** 后退（:2378-2403）：无历史返回 null（动作层给明确反馈）；返回目标条目 URL */
export async function goBack(s: SessionInternals): Promise<string | null> {
  s.clearSelectorMapCaches();
  const history = await s.send<Record<string, unknown>>("Page.getNavigationHistory", {});
  const idx = typeof history.currentIndex === "number" ? history.currentIndex : 0;
  const entries = Array.isArray(history.entries) ? history.entries : [];
  if (idx <= 0 || entries.length === 0) return null;
  const prev = isRecord(entries[idx - 1]) ? entries[idx - 1] : null;
  if (!prev) return null;
  await s.send("Page.navigateToHistoryEntry", { entryId: prev.id });
  await waitForReadyStateSettle(s);
  return typeof prev.url === "string" ? prev.url : null;
}

/**
 * 内部 settle（:2405-2436）：轮询 document.readyState 至 complete。超时静默放行；
 * CDP 打嗝重试而非中止。navigate/go_back/截图前/switch_tab 用。
 */
export async function waitForReadyStateSettle(
  s: SessionInternals,
  options: { timeout?: number; pollInterval?: number } = {},
): Promise<void> {
  if (!s.transport || !s.currentSessionId) return;
  const timeout = options.timeout ?? s.settings.pageSettleTimeout;
  const pollInterval = options.pollInterval ?? s.settings.pageSettlePollInterval;
  const deadline = s.now() + timeout;
  while (s.now() < deadline) {
    try {
      const result = await s.send<Record<string, unknown>>("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });
      const inner = isRecord(result.result) ? result.result : {};
      if (inner.value === "complete") return;
    } catch {
      // CDP hiccup——下轮重试
    }
    await s.sleep(pollInterval * 1000);
  }
}

// B3-1：页面级 settle 探测 JS——readyState + requirejs 模块数。无反斜杠（避开
// evaluate 转义链路）。无 requirejs 的页面直接就绪（零等待）。
const PAGE_SETTLE_JS = `
(function(){
	if (document.readyState !== 'complete') { return JSON.stringify({ready: false, stage: 'readyState', n: 0}); }
	try {
		var ctx = (window.require && require.s && require.s.contexts) ? require.s.contexts._ : null;
		if (!ctx) { return JSON.stringify({ready: true, stage: 'no-requirejs', n: 0}); }
		var n = Object.keys(ctx.defined || {}).length;
		return JSON.stringify({ready: false, stage: 'requirejs', n: n});
	} catch (e) { return JSON.stringify({ready: true, stage: 'error', n: 0}); }
})()`;

export interface PageSettleResult {
  ready: boolean;
  stage?: unknown;
  n?: number;
  timeout?: boolean;
  waited: number;
  error?: string;
}

/** 网格 kick 的诊断增量（waitForPageSettle 合并进返回值） */
export interface GridKickResult {
  grid_kick: boolean;
  grid_rows: number;
  grid_rendered: boolean;
}

/**
 * 公开 settle（:2877-2902，与内部版同名不同义）：requirejs 模块数连续
 * stablePolls 次不变或无 requirejs 即就绪；settle 后跑网格 kick。降级原则：超时/
 * 异常都安全返回，不阻断导航。
 */
export async function waitForPageSettle(
  s: SessionInternals,
  options: { timeout?: number; poll?: number; stablePolls?: number } = {},
): Promise<PageSettleResult & Partial<GridKickResult>> {
  const result = await settlePoll(s, options);
  const kick = await kickFrozenDataGrid(s);
  return kick ? { ...result, ...kick } : result;
}

async function settlePoll(
  s: SessionInternals,
  options: { timeout?: number; poll?: number; stablePolls?: number },
): Promise<PageSettleResult> {
  const timeout = options.timeout ?? 10.0;
  const poll = options.poll ?? 0.5;
  const stablePolls = options.stablePolls ?? 4;
  const start = s.now();
  let lastN: number | null = null;
  let stable = 0;
  try {
    for (;;) {
      const raw = await evaluateScript(s, PAGE_SETTLE_JS, { awaitPromise: false });
      let st: Record<string, unknown> = {};
      try {
        st = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        st = {};
      }
      if (st.ready) {
        return { ...(st as unknown as PageSettleResult), waited: round2(s.now() - start) };
      }
      const n = Number(st.n ?? 0) || 0;
      if (n === lastN) {
        stable += 1;
        if (stable >= stablePolls) {
          return {
            ready: true,
            stage: st.stage,
            n,
            waited: round2(s.now() - start),
          };
        }
      } else {
        stable = 0;
      }
      lastN = n;
      if (s.now() - start >= timeout) {
        return {
          ready: false,
          stage: st.stage,
          n,
          timeout: true,
          waited: round2(s.now() - start),
        };
      }
      await s.sleep(poll * 1000);
    }
  } catch (e) {
    return {
      ready: false,
      error: String(e).slice(0, 120),
      waited: round2(s.now() - start),
    };
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// KO 数据网格「行渲染冻结」检测：记录数文本可见但 tbody 行文本全空 = 模板未绑定。
const GRID_EMPTY_ROWS_JS = `
(function(){
    var rows = document.querySelectorAll('.admin__data-grid tbody tr, table.data-grid tbody tr');
    if (!rows.length) { return JSON.stringify({grid: false}); }
    for (var i = 0; i < rows.length; i++) {
        var t = (rows[i].innerText || rows[i].textContent || '').trim();
        if (t) { return JSON.stringify({grid: true, empty: false, rows: rows.length}); }
    }
    return JSON.stringify({grid: true, empty: true, rows: rows.length});
})()`;

/**
 * 网格行渲染冻结 kick（:2953-2985）：窗口不产帧时行保持空模板，一次丢弃式截图
 * 强制产一帧即解锁（454 等 7 任务实证）。无网格/行有文本零开销；永不 raise。
 */
async function kickFrozenDataGrid(s: SessionInternals): Promise<GridKickResult | null> {
  try {
    const raw = await evaluateScript(s, GRID_EMPTY_ROWS_JS, { awaitPromise: false });
    let st: Record<string, unknown>;
    try {
      st = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      return null;
    }
    if (!st.grid || !st.empty) return null;
    await takeScreenshot(s, { format: "jpeg", quality: 20 });
    await s.sleep(300);
    const raw2 = await evaluateScript(s, GRID_EMPTY_ROWS_JS, { awaitPromise: false });
    let st2: Record<string, unknown> = {};
    try {
      st2 = typeof raw2 === "string" ? (JSON.parse(raw2) as Record<string, unknown>) : {};
    } catch {
      st2 = {};
    }
    const rendered = Boolean(st2.grid && !st2.empty);
    s.log(
      `data-grid render kick: rows=${String(st.rows)} rendered_after=${rendered} ` +
        "(frozen KO grid, forced one frame)",
    );
    return { grid_kick: true, grid_rows: Number(st.rows), grid_rendered: rendered };
  } catch (e) {
    s.log(`data-grid render kick skipped: ${String(e)}`);
    return null;
  }
}

export interface ScrollResult {
  vertical_percentage: number | null;
  at_edge: boolean;
}

/** 页面滚动（:3542-3613）：视口中心 mouseWheel；回读位置与边界（读失败降级不报） */
export async function scroll(
  s: SessionInternals,
  direction: "up" | "down" = "down",
  amount = 3,
): Promise<ScrollResult> {
  const metrics = await s.send<Record<string, unknown>>("Page.getLayoutMetrics", {});
  const viewport = isRecord(metrics.cssVisualViewport) ? metrics.cssVisualViewport : {};
  const viewportHeight = numberOr(viewport.clientHeight, 1000);
  const viewportWidth = numberOr(viewport.clientWidth, 1280);
  let delta = amount * viewportHeight;
  if (direction === "up") delta = -delta;
  await s.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: viewportWidth / 2,
    y: viewportHeight / 2,
    deltaX: 0,
    deltaY: delta,
  });
  // 滚动动画 + 懒加载渲染窗口；不用 readyState settle（scroll 不改 readyState，等于无等待）
  await s.sleep(200);
  const position: ScrollResult = { vertical_percentage: null, at_edge: false };
  try {
    const result = await s.send<Record<string, unknown>>("Runtime.evaluate", {
      expression:
        "(() => {" +
        "  const d = document.documentElement, b = document.body;" +
        "  const sy = Math.max(d.scrollTop || 0, b ? b.scrollTop || 0 : 0);" +
        "  const sh = Math.max(d.scrollHeight || 0, b ? b.scrollHeight || 0 : 0);" +
        "  const ch = d.clientHeight || window.innerHeight || 0;" +
        "  const max = sh - ch;" +
        "  const pct = max > 0 ? (sy / max) * 100 : 100;" +
        "  return JSON.stringify({ sy, sh, ch, pct });" +
        "})()",
      returnByValue: true,
    });
    const inner = isRecord(result.result) ? result.result : {};
    const val = JSON.parse(typeof inner.value === "string" ? inner.value : "{}") as {
      sy: number;
      sh: number;
      ch: number;
    };
    const { sy, sh, ch } = val;
    const maxTop = sh - ch;
    position.vertical_percentage = maxTop > 0 ? Math.round((sy / maxTop) * 1000) / 10 : 100.0;
    position.at_edge = direction === "down" ? sy + ch >= sh - 1 : sy <= 1;
  } catch {
    // 位置读取失败不影响滚动本身——回显退化
  }
  return position;
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && v > 0 ? v : fallback;
}
