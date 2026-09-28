// find_elements 动作（actions.py :1769-1837）：CSS 查询 + 两 formatter
// （:187-268 逐字节锚定 batch2.json）+ 大结果分级落盘 + query_total 结构化旁路。

import { ActionResult } from "../../agent/views.js";
import type { FindElementsData, FindElementsNodeIdsData } from "../../browser/search-find.js";
import type { ActionHandler, ToolsBrowser } from "../types.js";
import type { ToolsContext } from "./context.js";
import { saveOversizedResult } from "./shared/format.js";

interface FindElementRow {
  index?: number;
  tag?: string;
  text?: string;
  attrs?: Record<string, string>;
  children_count?: number;
  origin?: string;
  rect?: { x?: number; y?: number; w?: number; h?: number } | null;
  visible?: boolean;
}

/** :187-237 逐字节（caller 保证 total>0） */
export function formatFindResults(data: FindElementsData, selector: string): string {
  const elements = (data.elements ?? []) as FindElementRow[];
  const total = data.total ?? 0;
  const offset = data.offset ?? 0;
  const hasMore = data.has_more ?? false;

  const lines: string[] = [
    `Found ${total} element${total !== 1 ? "s" : ""} matching "${selector}":`,
    "",
  ];
  for (const el of elements) {
    const parts: string[] = [`[${el.index ?? 0}] <${el.tag ?? "?"}>`];
    if (el.text) {
      let displayText = el.text.split(/\s+/).join(" ");
      if (displayText.length > 120) displayText = `${displayText.slice(0, 120)}...`;
      parts.push(`"${displayText}"`);
    }
    if (el.attrs && Object.keys(el.attrs).length > 0) {
      const attrStrs = Object.entries(el.attrs).map(([k, v]) => `${k}="${v}"`);
      parts.push(`{${attrStrs.join(", ")}}`);
    }
    parts.push(`(${el.children_count ?? 0} children)`);
    if (el.rect) {
      const vis = el.visible ? "visible" : "hidden";
      parts.push(
        `(${vis}, ${Math.trunc(el.rect.w ?? 0)}x${Math.trunc(el.rect.h ?? 0)}@${Math.trunc(el.rect.x ?? 0)},${Math.trunc(el.rect.y ?? 0)})`,
      );
    }
    if (el.origin) parts.push(el.origin.trim());
    lines.push(parts.join(" "));
  }
  if (hasMore) {
    const nextOffset = offset + elements.length;
    lines.push(
      `\n... showing ${offset + 1}–${offset + elements.length} of ${total} total elements. ` +
        `Call again with offset=${nextOffset} for the next batch (or raise max_results).`,
    );
  }
  return lines.join("\n");
}

/** :238-268 逐字节（caller 保证 total>0） */
export function formatNodeIdResults(data: FindElementsNodeIdsData, selector: string): string {
  const nodeIds = data.node_ids ?? [];
  const total = data.total ?? 0;
  const offset = data.offset ?? 0;
  const hasMore = data.has_more ?? false;

  const lines: string[] = [
    `Found ${total} element${total !== 1 ? "s" : ""} matching "${selector}" (node ids):`,
    "",
  ];
  for (const el of nodeIds) {
    lines.push(
      `[${el.backend_id}] <${el.tag ?? "?"}>  (pass as index= or element_id= to click/input_text)`,
    );
  }
  if (hasMore) {
    const nextOffset = offset + nodeIds.length;
    lines.push(
      `\n... showing ${offset + 1}–${offset + nodeIds.length} of ${total} total elements. ` +
        `Call again with offset=${nextOffset} for the next batch.`,
    );
  }
  return lines.join("\n");
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createFindElementsHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>, browser: ToolsBrowser) => {
    const selector = params.selector;
    if (typeof selector !== "string") {
      return new ActionResult({ error: "find_elements requires a string `selector` parameter." });
    }
    const maxResults = typeof params.max_results === "number" ? params.max_results : 50;
    const offset = typeof params.offset === "number" ? params.offset : 0;
    const returnNodeIds = params.return_node_ids === true;
    let data: FindElementsData | FindElementsNodeIdsData;
    let formatted: string;
    let total: number;
    try {
      if (returnNodeIds) {
        data = await browser.findElementsNodeIds(selector, { maxResults, offset });
        total = data.total;
        formatted = total > 0 ? formatNodeIdResults(data, selector) : "";
      } else {
        data = await browser.findElements(selector, {
          attributes: Array.isArray(params.attributes) ? (params.attributes as string[]) : null,
          maxResults,
          offset,
          includeText: params.include_text !== false,
          firstOnly: params.first_only === true,
          includeGeometry: params.include_geometry === true,
        });
        total = data.total;
        formatted = total > 0 ? formatFindResults(data, selector) : "";
      }
    } catch (e) {
      ctx.log(`find_elements(${JSON.stringify(selector)}) failed: ${errText(e)}`);
      return new ActionResult({ error: `Find elements failed: ${errText(e)}` });
    }
    if (total === 0) {
      // 零结果是可行动信息（软回显）+ query_total 结构化旁路（#186-c2 形态②）
      const msg = `No elements found matching "${selector}"`;
      return new ActionResult({
        extractedContent: msg,
        longTermMemory: msg,
        metadata: { query_total: 0 },
      });
    }
    const savedTo = await saveOversizedResult(formatted, {
      prefix: "find_elements",
      outputDir: ctx.truncation.findElementsOutputDir,
      ext: "txt",
      threshold: ctx.truncation.findElementsSaveThreshold,
      fs: ctx.fs,
      log: ctx.log,
    });
    const visible =
      savedTo !== null
        ? `Find results (${formatted.length} chars) saved to ${savedTo}. Preview: ${formatted.slice(0, 200)}...`.trim()
        : formatted;
    const nidSuffix = returnNodeIds ? " (node ids)" : "";
    let memory = `Found ${total} element${total !== 1 ? "s" : ""} matching "${selector}"${nidSuffix}.`;
    if (savedTo !== null) memory += ` Results saved: ${savedTo}`;
    return new ActionResult({
      extractedContent: visible,
      longTermMemory: memory,
      metadata: { query_total: total },
    });
  };
}
