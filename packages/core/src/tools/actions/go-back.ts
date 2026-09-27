// go_back 动作（actions.py :1702-1717）+ 轻量健康检查接线。

import { ActionResult } from "../../agent/views.js";
import type { ActionHandler } from "../types.js";
import type { ToolsContext } from "./context.js";
import { errText, goBackHealthCheck } from "./shared/nav-health.js";

export function createGoBackHandler(ctx: ToolsContext): ActionHandler {
  return async (_params: Record<string, unknown>, browser) => {
    let targetUrl: string | null;
    try {
      targetUrl = await browser.goBack();
    } catch (e) {
      return new ActionResult({ error: `Failed to go back: ${errText(e)}` });
    }

    if (targetUrl === null) {
      // 无历史可退（currentIndex <= 0）——明确告知，避免 LLM 误以为已后退
      return new ActionResult({ error: "No previous page in history to go back to" });
    }

    // 轻量健康检查：SPA 后退未渲染给一次重试机会（仍空仅 warning，不硬失败）
    await goBackHealthCheck(targetUrl, browser, ctx.sleep, ctx.log);

    const memory = `Navigated back to ${targetUrl}`;
    ctx.log(memory);
    return new ActionResult({ extractedContent: memory, longTermMemory: memory });
  };
}
