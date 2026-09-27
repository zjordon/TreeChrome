// extract 动作（actions.py :1516-1610）：getPageHtml（降级 outerHTML）→ 干净 markdown →
// 未接 LLM 截断降级 → 结构分块定位 start_from_char → llm.extract → 分页 hint →
// 大结果分级落盘（fs 未注入跳过 + metadata 标注——p4/02 偏离 6）。

import { ActionResult } from "../../agent/views.js";
import { LLMCallTimeoutError } from "../../llm/errors.js";
import { chunkMarkdownByStructure, extractCleanMarkdown } from "../extract-markdown.js";
import type { ActionHandler, ToolsBrowser } from "../types.js";
import type { ToolsContext } from "./context.js";
import { saveOversizedResult } from "./shared/format.js";
import { errText } from "./shared/nav-health.js";

export function createExtractHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>, browser: ToolsBrowser) => {
    const query = String(params.query ?? "");
    const extractLinks = params.extract_links === undefined ? true : params.extract_links === true;
    const extractImages =
      params.extract_images === undefined ? true : params.extract_images === true;
    const startFromChar = Math.trunc(Number(params.start_from_char ?? 0));
    const alreadyCollected = Array.isArray(params.already_collected)
      ? (params.already_collected as unknown[]).filter(
          (v): v is string => typeof v === "string" && v.trim() !== "",
        )
      : null;
    const tr = ctx.truncation;
    const schema = ctx.extractionSchema;

    // 1) 源：CDP HTML → markdown（取代阶段一的 document.body.innerText）
    let htmlText = await browser.getPageHtml({ extractLinks, extractImages });
    if (!htmlText) {
      // 降级到 execute_js outerHTML
      try {
        htmlText = String((await browser.executeJs("document.documentElement.outerHTML")) ?? "");
      } catch (e) {
        ctx.log(`extract: HTML source failed: ${errText(e)}`);
        htmlText = "";
      }
    }
    if (!htmlText) {
      return new ActionResult({ extractedContent: "(empty page)" });
    }

    const md = extractCleanMarkdown(htmlText, { extractLinks, extractImages });
    if (md.trim() === "") {
      return new ActionResult({ extractedContent: "(empty page)" });
    }

    if (ctx.extractClient === null) {
      // 未接 LLM（如脱离 Agent 直接用 Tools）——显式降级为截断 markdown 片段
      const snippet = md.slice(startFromChar, startFromChar + tr.extractFallbackMaxChars);
      return new ActionResult({ extractedContent: snippet || "(no content at offset)" });
    }

    // 2) 分页：取 start_from_char 所在的单块（一次 extract 只抽一块）
    const chunks = chunkMarkdownByStructure(md, tr.extractChunkMaxChars);
    if (startFromChar >= chunks[chunks.length - 1].end) {
      return new ActionResult({
        extractedContent: "(no more content at this offset; extraction complete)",
      });
    }
    let targetIdx = 0;
    for (const [i, c] of chunks.entries()) {
      if (c.start <= startFromChar && startFromChar < c.end) {
        targetIdx = i;
        break;
      }
    }
    const localOffset = Math.max(0, startFromChar - chunks[targetIdx].start);
    const chunkContent = chunks[targetIdx].content.slice(localOffset);

    // 3) 抽取（含去重 + 内层超时）
    let result: string;
    try {
      result = await ctx.extractClient.extract(query, chunkContent, {
        maxContentChars: tr.extractChunkMaxChars,
        outputSchema: schema,
        alreadyCollected,
        callTimeoutMs: tr.extractCallTimeoutS > 0 ? tr.extractCallTimeoutS * 1000 : null,
      });
    } catch (e) {
      if (e instanceof LLMCallTimeoutError) {
        ctx.log(`extract: LLM call timed out: ${errText(e)}`);
        return new ActionResult({ error: `Extract timed out: ${errText(e)}` });
      }
      ctx.log(`extract: LLM call failed: ${errText(e)}`);
      return new ActionResult({ error: `Extract failed: ${errText(e)}` });
    }

    // 4) 分页进度（提示必须落在 500 字窗口内可见）
    const nextOffset = targetIdx + 1 < chunks.length ? chunks[targetIdx + 1].start : null;
    let remaining = 0;
    for (const c of chunks.slice(targetIdx + 1)) remaining += c.end - c.start;
    let hint = "";
    if (nextOffset !== null) {
      hint =
        `[chunk ${targetIdx + 1}/${chunks.length}; ~${remaining} chars remain; ` +
        `call extract again with start_from_char=${nextOffset} to continue]`;
    }

    // 5) 大结果分级落盘（仅按大小，与分页解耦）
    let savedTo: string | null = null;
    let saveSkippedNoFs = false;
    if (result.length >= tr.extractSaveThreshold) {
      if (ctx.fs !== null) {
        savedTo = await saveOversizedResult(result, {
          threshold: tr.extractSaveThreshold,
          outputDir: tr.extractOutputDir,
          prefix: "extract",
          ext: schema ? "json" : "md",
          fs: ctx.fs,
          log: ctx.log,
        });
      } else {
        saveSkippedNoFs = true;
        ctx.log("extract: save skipped (no filesystem provider injected)");
      }
    }

    // 结构化结果保持 JSON 纯净；free-text 提示前置（防 __str__ 500 字截断）
    let visible: string;
    if (schema != null) {
      visible = savedTo
        ? `Extraction (${result.length} chars) saved to ${savedTo}. Preview: ${result.slice(0, 200)}...\n${hint}`.trim()
        : result; // 纯 JSON；hint 走 long_term_memory
    } else {
      visible = hint ? `${hint}\n${result}` : result;
    }
    const memParts: string[] = [];
    if (savedTo) memParts.push(`extract result saved: ${savedTo}`);
    if (hint) memParts.push(hint);
    const metadata: Record<string, unknown> | null = saveSkippedNoFs
      ? { extract_save_skipped: "no filesystem provider" }
      : null;
    return new ActionResult({
      extractedContent: visible,
      longTermMemory: memParts.length > 0 ? memParts.join(" | ") : null,
      metadata,
    });
  };
}
