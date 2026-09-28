// find_text 动作（actions.py :1838-1892）：滚动到第 n 个可见匹配并高亮。
// session.findText（search-find.ts）承担主链；本层构造软回显（miss/nth 越界
// 均非工具失败——对齐 browser-use 与 search_page）。

import { ActionResult } from "../../agent/views.js";
import type { FindTextResult } from "../../browser/search-find.js";
import type { ActionHandler, ToolsBrowser } from "../types.js";
import type { ToolsContext } from "./context.js";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createFindTextHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>, browser: ToolsBrowser) => {
    const text = params.text;
    if (typeof text !== "string") {
      return new ActionResult({ error: "find_text requires a string `text` parameter." });
    }
    const nth = typeof params.nth === "number" ? params.nth : 1;
    const caseSensitive = params.case_sensitive === true;
    const highlightRaw = params.highlight;
    const highlight =
      highlightRaw === "selection" || highlightRaw === "none" ? highlightRaw : "box";
    let info: FindTextResult;
    try {
      info = await browser.findText(text, { nth, caseSensitive, highlight });
    } catch (e) {
      ctx.log(`find_text(${JSON.stringify(text)}, nth=${nth}) failed: ${errText(e)}`);
      return new ActionResult({ error: `Find text failed: ${errText(e)}` });
    }
    if (!info.found) {
      if (info.reason === "nth_exceeds") {
        const msg =
          `Text '${text}' found but only ${info.visible_total} visible ` +
          `match(es) (${info.total} total via ${info.method}) ` +
          `— asked for match ${info.requested_nth}, try a smaller nth`;
        return new ActionResult({ extractedContent: msg, longTermMemory: msg });
      }
      const msg = `Text '${text}' not found on page`;
      return new ActionResult({ extractedContent: msg, longTermMemory: msg });
    }
    const method = info.method;
    const tag = info.tag;
    const total = info.total;
    let memory: string;
    if (total !== undefined && total > 1) {
      const counts = `match ${info.match_index} of ${info.visible_total} visible, ${total} total`;
      memory =
        tag !== null && tag !== undefined && tag !== ""
          ? `Scrolled to text '${text}' into view (${counts}, found in <${tag}>, via ${method})`
          : `Scrolled to text '${text}' into view (${counts}, via ${method})`;
    } else {
      memory =
        tag !== null && tag !== undefined && tag !== ""
          ? `Scrolled to text '${text}' into view (found in <${tag}>, via ${method})`
          : `Scrolled to text '${text}' into view (via ${method})`;
    }
    if (info.highlight !== undefined && info.highlight !== "box") {
      memory += ` (${info.highlight} highlight)`;
    }
    return new ActionResult({ extractedContent: memory, longTermMemory: memory });
  };
}
