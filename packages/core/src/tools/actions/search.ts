// search 动作（actions.py :1530-1540）：引擎 URL 模板直导航。URL 表 :360-365
// 逐字节（含 google 的 udm=14 反 AI 摘要参数）——引擎形态变更是上游关注点，保真优先。

import { ActionResult } from "../../agent/views.js";
import type { ActionHandler, ToolsBrowser } from "../types.js";

export const SEARCH_ENGINE_URLS: Readonly<Record<string, string>> = {
  baidu: "https://www.baidu.com/s?wd={query}",
  google: "https://www.google.com/search?q={query}&udm=14",
  bing: "https://www.bing.com/search?q={query}",
  duckduckgo: "https://duckduckgo.com/?q={query}",
};

/** urllib.parse.quote_plus 等价（空格→+；! ' ( ) * 编码——encodeURIComponent 不编） */
function quotePlus(s: string): string {
  return encodeURIComponent(s)
    .replaceAll(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replaceAll("%20", "+");
}

export function createSearchHandler(): ActionHandler {
  return async (params: Record<string, unknown>, browser: ToolsBrowser) => {
    const query = params.query;
    if (typeof query !== "string") {
      return new ActionResult({ error: "search requires a string `query` parameter." });
    }
    const engine = typeof params.engine === "string" ? params.engine : "baidu";
    const template = SEARCH_ENGINE_URLS[engine];
    if (template === undefined) {
      return new ActionResult({ error: `Unknown search engine: ${engine}` });
    }
    const url = template.replaceAll("{query}", quotePlus(query));
    await browser.navigate(url);
    const memory = `Searched ${engine.charAt(0).toUpperCase()}${engine.slice(1)} for '${query}'`;
    return new ActionResult({ extractedContent: memory, longTermMemory: memory });
  };
}
