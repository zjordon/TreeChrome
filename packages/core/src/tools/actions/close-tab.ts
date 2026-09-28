// close_tab 动作（actions.py :1682-1722）：tab_id 后缀匹配 + 撞车检测（要求更长
// 后缀）+ 未命中列出全部 open tabs（_summarize_tabs :1673-1681）；空 tab_id=当前页；
// 关闭失败软降级（"already closed or invalid"——G5 对齐 browser-use）。

import { ActionResult } from "../../agent/views.js";
import type { TabInfo } from "../../browser/views.js";
import type { ActionHandler, ToolsBrowser } from "../types.js";
import type { ToolsContext } from "./context.js";

/** :1673-1681 逐字节：`[ABCD] title (url)` 行列表 */
export function summarizeTabs(tabs: TabInfo[]): string {
  return tabs.map((t) => `[${t.targetId.slice(-4)}] ${t.title} (${t.url})`).join(", ");
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createCloseTabHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>, browser: ToolsBrowser) => {
    // Python params.get("tab_id", "")：非字符串真值（如数字形态的后缀）在
    // target_id.endswith(int) 抛 TypeError → Tools.execute 通用 catch → error
    // （:810-822）；null/undefined 是 falsy = 关当前页。此处同构：非字符串非
    // nullish 显式 error（switch_tab 守卫同款文案），nullish 落当前页分支。
    const rawTabId = params.tab_id;
    if (rawTabId !== undefined && rawTabId !== null && typeof rawTabId !== "string") {
      return new ActionResult({ error: "close_tab requires a string `tab_id` parameter." });
    }
    const tabIdSuffix = typeof rawTabId === "string" ? rawTabId : "";
    const tabs = await browser.getTabs();
    let targetId: string;
    let idEcho: string;
    let title: string;
    let url: string;
    if (tabIdSuffix !== "") {
      const matches = tabs.filter((t) => t.targetId.endsWith(tabIdSuffix));
      if (matches.length === 0) {
        return new ActionResult({
          error: `No tab ending with '${tabIdSuffix}'. Open tabs: ${summarizeTabs(tabs)}`,
        });
      }
      if (matches.length > 1) {
        // 后缀撞车：关错页风险，要求更长后缀/完整 target_id
        return new ActionResult({
          error:
            `Multiple tabs match '${tabIdSuffix}' (${matches.length}). ` +
            `Use more characters or the full target_id. ` +
            `Matches: ${summarizeTabs(matches)}`,
        });
      }
      const target = matches[0];
      targetId = target.targetId;
      idEcho = tabIdSuffix;
      title = target.title;
      url = target.url;
    } else {
      // 空 tab_id = 关当前页（G6）
      const current = browser.currentTargetId;
      if (current === null || current === "") {
        return new ActionResult({ error: "No current tab to close" });
      }
      targetId = current;
      const cur = tabs.find((t) => t.targetId === targetId) ?? null;
      idEcho = targetId.slice(-4);
      title = cur !== null ? cur.title : "";
      url = cur !== null ? cur.url : "";
    }
    try {
      await browser.closeTab(targetId);
    } catch (e) {
      ctx.log(`close_tab(${targetId}) failed: ${errText(e)}`);
      const memory = `Tab [${idEcho}] ${title} (${url}) was already closed or invalid`;
      return new ActionResult({ extractedContent: memory, longTermMemory: memory });
    }
    const memory = `Closed tab [${idEcho}] ${title} (${url})`;
    return new ActionResult({ extractedContent: memory, longTermMemory: memory });
  };
}
