// navigate 动作（actions.py :844-889）：URL 补 https → browser.navigate → 健康检查
// （仅当前标签页 + http(s)）→ 增强 settle（降级放行）→ 回显。

import { ActionResult } from "../../agent/views.js";
import type { ActionHandler, ToolsBrowser } from "../types.js";
import type { ToolsContext } from "./context.js";
import { errText, mapNavigationError, navigateHealthCheck } from "./shared/nav-health.js";

export function createNavigateHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>, browser: ToolsBrowser) => {
    // 必填守卫（Python params["url"] KeyError → execute 包装 error 的等价补偿）：
    // 漏传若落到 String(undefined ?? "") 会导航 "https://" 空目标
    if (typeof params.url !== "string") {
      return new ActionResult({ error: "navigate requires a string `url` parameter." });
    }
    let url = params.url;
    if (!(url.startsWith("http://") || url.startsWith("https://"))) {
      url = "https://" + url;
    }
    const newTab = params.new_tab === true;

    try {
      await browser.navigate(url, { newTab });
      // 健康检查：仅当前标签页 + http(s) URL（chrome://、about:、new_tab=True 跳过）
      if (!newTab) {
        await navigateHealthCheck(url, browser, ctx.sleep, ctx.log);
      }
      // B3-1：页面级 settle——等 requirejs 模块数稳定。降级放行：超时/异常不阻断导航。
      let settleNote = "";
      if (ctx.pageSettleEnabled && !newTab) {
        try {
          const settle = await browser.waitForPageSettle({
            timeout: ctx.pageSettleTimeoutS,
            poll: ctx.pageSettlePollS,
            stablePolls: ctx.pageSettleStablePolls,
          });
          const stage = settle.stage ?? "?";
          if (settle.ready) {
            settleNote = ` (page settled: ${String(stage)}, ${settle.waited ?? 0}s)`;
          } else {
            settleNote =
              ` (page settle ${String(stage)} not confirmed after ` +
              `${settle.waited ?? 0}s — page JS may still be loading)`;
          }
          if (settle.grid_kick) {
            settleNote +=
              " (data-grid render kick applied — frozen grid rows forced" +
              " to render; if rows still look empty, take a screenshot)";
          }
        } catch (e) {
          ctx.log(`page settle skipped: ${errText(e)}`);
        }
      }
      const memory = newTab ? `Opened new tab with URL ${url}` : `Navigated to ${url}${settleNote}`;
      ctx.log(memory);
      return new ActionResult({ extractedContent: memory, longTermMemory: memory });
    } catch (e) {
      return mapNavigationError(url, e);
    }
  };
}
