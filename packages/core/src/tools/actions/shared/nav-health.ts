// 导航健康族：_dom_appears_empty/_navigate_health_check/_go_back_health_check/
// _map_navigation_error + 等待常量与网络错误标记。移植自 TreeWalker tools/actions.py
// @640d52a（:891-947、:1686-1742、:628-646）。

import { ActionResult } from "../../../agent/views.js";
import type { BrowserStateSummary } from "../../../browser/views.js";
import type { ToolsBrowser } from "../../types.js";

/** 首次发现空 DOM 后等待重查（秒） */
export const NAVIGATE_EMPTY_RETRY_WAIT_S = 3.0;
/** reload 后等待（秒） */
export const NAVIGATE_EMPTY_RELOAD_WAIT_S = 5.0;

/** 网络错误码 → 触发 "site unavailable" 友好提示 */
export const NAVIGATE_NET_ERROR_MARKERS = [
  "ERR_NAME_NOT_RESOLVED",
  "ERR_INTERNET_DISCONNECTED",
  "ERR_CONNECTION_REFUSED",
  "ERR_TIMED_OUT",
  "ERR_TUNNEL_CONNECTION_FAILED",
  "net::",
] as const;

const isHttpUrl = (url: string): boolean =>
  url.toLowerCase().startsWith("http://") || url.toLowerCase().startsWith("https://");

/** :891-901 判定页面是否为空（llm_representation 在无根时返回占位符，须单独查 root） */
export function domAppearsEmpty(state: BrowserStateSummary): boolean {
  const ds = state.domState;
  if (ds === null) return true;
  return ds.root === null || ds.elementTreeText.trim() === "";
}

/**
 * :903-937 导航后空 DOM 三阶段检查：get_state 检查 → 3s 重查 → 重新 navigate+5s →
 * 仍空 raise。仅 http(s) URL + 当前标签页触发。
 */
export async function navigateHealthCheck(
  url: string,
  browser: ToolsBrowser,
  sleep: (ms: number) => Promise<void>,
  log: (message: string) => void,
): Promise<void> {
  let state = await browser.getState({ includeScreenshot: false });
  if (!(isHttpUrl(state.url) && domAppearsEmpty(state))) return;

  log(
    `Empty DOM after navigating to ${url}, waiting ${NAVIGATE_EMPTY_RETRY_WAIT_S}s and rechecking`,
  );
  await sleep(NAVIGATE_EMPTY_RETRY_WAIT_S * 1000);
  state = await browser.getState({ includeScreenshot: false });
  if (!(isHttpUrl(state.url) && domAppearsEmpty(state))) return;

  log(`Still empty after ${NAVIGATE_EMPTY_RETRY_WAIT_S}s, reloading ${url}`);
  // reload：重新 navigate，异常吞掉（避免健康检查二次失败中断「初次导航已成功」外层路径）
  try {
    await browser.navigate(url);
  } catch (reloadErr) {
    log(`Reload during health check failed: ${errText(reloadErr)}`);
  }
  await sleep(NAVIGATE_EMPTY_RELOAD_WAIT_S * 1000);

  state = await browser.getState({ includeScreenshot: false });
  if (isHttpUrl(state.url)) {
    const ds = state.domState;
    if (ds === null || ds.root === null) {
      throw new Error(
        `Page loaded but returned empty content for ${url}. ` +
          "The page may require JavaScript that failed to render, use anti-bot measures, " +
          "or have a connection issue (e.g. tunnel/proxy error). Try a different URL or approach.",
      );
    }
  }
}

/** :940-947 导航异常 → LLM 友好 ActionResult.error */
export function mapNavigationError(url: string, e: unknown): ActionResult {
  const errorMsg = errText(e);
  if (NAVIGATE_NET_ERROR_MARKERS.some((marker) => errorMsg.includes(marker))) {
    return new ActionResult({ error: `Navigation failed - site unavailable: ${url}` });
  }
  return new ActionResult({ error: `Navigation failed: ${errorMsg}` });
}

/**
 * :1719-1742 后退后轻量空 DOM 检测（用户选：轻量，不 reload、不硬失败）——仅一次
 * 重试等待，持续空只 warning，交由 LLM 下一轮 get_state 自行感知。
 */
export async function goBackHealthCheck(
  targetUrl: string | null,
  browser: ToolsBrowser,
  sleep: (ms: number) => Promise<void>,
  log: (message: string) => void,
): Promise<void> {
  let state = await browser.getState({ includeScreenshot: false });
  if (!(isHttpUrl(state.url) && domAppearsEmpty(state))) return;

  log(
    `Empty DOM after going back to ${targetUrl}, waiting ${NAVIGATE_EMPTY_RETRY_WAIT_S}s and rechecking`,
  );
  await sleep(NAVIGATE_EMPTY_RETRY_WAIT_S * 1000);
  state = await browser.getState({ includeScreenshot: false });
  if (isHttpUrl(state.url) && domAppearsEmpty(state)) {
    log(
      `Still empty after going back to ${targetUrl}; SPA may still be rendering. ` +
        "Not failing hard (no clean reload for history navigation).",
    );
  }
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
