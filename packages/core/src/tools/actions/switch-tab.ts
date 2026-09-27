// switch_tab 动作（actions.py :1626-1645）：get_tabs 后缀匹配（targetId 后 4 位）
// + 撞车报错。

import { ActionResult } from "../../agent/views.js";
import type { ActionHandler } from "../types.js";
import type { ToolsContext } from "./context.js";
import { summarizeTabs } from "./shared/element-lookup.js";

export function createSwitchTabHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>, browser) => {
    // 必填守卫（Python params["tab_id"] KeyError 的等价补偿）：漏传若落到
    // String(undefined ?? "") 的空后缀 endswith("") 恒真——匹配全部标签页
    if (typeof params.tab_id !== "string") {
      return new ActionResult({ error: "switch_tab requires a string `tab_id` parameter." });
    }
    const tabIdSuffix = params.tab_id;
    const tabs = await browser.getTabs();
    const matches = tabs.filter((t) => t.targetId.endsWith(tabIdSuffix));
    if (matches.length === 0) {
      return new ActionResult({
        error: `No tab ending with '${tabIdSuffix}'. Open tabs: ${summarizeTabs(tabs)}`,
      });
    }
    if (matches.length > 1) {
      // 后缀撞车：切错页风险，要求更长后缀/完整 target_id
      return new ActionResult({
        error:
          `Multiple tabs match '${tabIdSuffix}' (${matches.length}). ` +
          "Use more characters or the full target_id. " +
          `Matches: ${summarizeTabs(matches)}`,
      });
    }
    const target = matches[0];
    await browser.switchTab(target.targetId);
    const memory = `Switched to tab [${tabIdSuffix}] ${target.title} (${target.url})`;
    ctx.log(memory);
    return new ActionResult({ extractedContent: memory, longTermMemory: memory });
  };
}
