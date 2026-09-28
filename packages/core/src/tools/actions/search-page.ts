// search_page 动作（actions.py :3140-3201）：grep 式页内搜索 + formatter
// （:147-186 逐字节锚定 batch2.json）+ 大结果分级落盘 + query_total 旁路
// （total==0 且 attr>0 时合并计数——review7 #1）。

import { ActionResult } from "../../agent/views.js";
import type { SearchPageData } from "../../browser/search-find.js";
import type { ActionHandler, ToolsBrowser } from "../types.js";
import type { ToolsContext } from "./context.js";
import { saveOversizedResult } from "./shared/format.js";

interface SearchMatchRow {
  context?: string;
  element_path?: string;
}

/** :147-186 逐字节（caller 保证 total>0 或 attribute_total>0） */
export function formatSearchResults(data: SearchPageData, query: string): string {
  const matches = (data.matches ?? []) as SearchMatchRow[];
  const total = data.total ?? 0;
  const hasMore = data.has_more ?? false;
  const offset = data.offset ?? 0;

  const lines: string[] = [
    `Found ${total} match${total !== 1 ? "es" : ""} for "${query}" on page:`,
    "",
  ];
  for (const [i, m] of matches.entries()) {
    const context = m.context ?? "";
    const path = m.element_path ?? "";
    const loc = path !== "" ? ` (in ${path})` : "";
    lines.push(`[${i + 1}] ${context}${loc}`);
  }
  if (hasMore) {
    const nextOffset = offset + matches.length;
    lines.push(
      `\n... showing ${offset + 1}–${offset + matches.length} of ${total} total matches. ` +
        `Call again with offset=${nextOffset} for the next batch (or raise max_results).`,
    );
  }
  const attrMatches = data.attribute_matches ?? [];
  const attrTotal = data.attribute_total ?? 0;
  if (attrTotal > 0) {
    lines.push("");
    lines.push(`Attribute matches for "${query}" (${attrTotal}):`);
    for (const [i, m] of attrMatches.entries()) {
      const path = m.element_path ?? "";
      const loc = path !== "" ? ` (in ${path})` : "";
      lines.push(`[${i + 1}] @${m.attribute ?? ""}=${m.value ?? ""}${loc}`);
    }
    if (attrTotal > attrMatches.length) {
      lines.push(`... showing ${attrMatches.length} of ${attrTotal} attribute matches.`);
    }
  }
  return lines.join("\n");
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createSearchPageHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>, browser: ToolsBrowser) => {
    const query = params.query;
    if (typeof query !== "string") {
      return new ActionResult({ error: "search_page requires a string `query` parameter." });
    }
    let data: SearchPageData;
    try {
      data = await browser.searchPage(query, {
        regex: params.regex === true,
        caseSensitive: params.case_sensitive === true,
        contextChars: typeof params.context_chars === "number" ? params.context_chars : 150,
        cssScope: typeof params.css_scope === "string" ? params.css_scope : null,
        maxResults: typeof params.max_results === "number" ? params.max_results : 25,
        offset: typeof params.offset === "number" ? params.offset : 0,
        searchAttributes: params.search_attributes === true,
      });
    } catch (e) {
      ctx.log(`search_page(${JSON.stringify(query)}) failed: ${errText(e)}`);
      return new ActionResult({ error: `Search page failed: ${errText(e)}` });
    }
    const total = data.total ?? 0;
    const attrTotal = data.attribute_total ?? 0;
    if (total === 0 && attrTotal === 0) {
      const msg = `No matches for '${query}'`;
      return new ActionResult({
        extractedContent: msg,
        longTermMemory: msg,
        metadata: { query_total: 0 },
      });
    }
    const formatted = formatSearchResults(data, query);
    const savedTo = await saveOversizedResult(formatted, {
      prefix: "search_page",
      outputDir: ctx.truncation.searchPageOutputDir,
      ext: "txt",
      threshold: ctx.truncation.searchPageSaveThreshold,
      fs: ctx.fs,
      log: ctx.log,
    });
    const visible =
      savedTo !== null
        ? `Search results (${formatted.length} chars) saved to ${savedTo}. Preview: ${formatted.slice(0, 200)}...`.trim()
        : formatted;
    let memory = `Searched page for "${query}": ${total} match${total !== 1 ? "es" : ""} found.`;
    if (attrTotal > 0) memory += ` (+${attrTotal} attribute match${attrTotal !== 1 ? "es" : ""})`;
    if (savedTo !== null) memory += ` Results saved: ${savedTo}`;
    return new ActionResult({
      extractedContent: visible,
      longTermMemory: memory,
      metadata: { query_total: total + attrTotal },
    });
  };
}
