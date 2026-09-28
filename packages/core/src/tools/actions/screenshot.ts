// screenshot（:1893-1923）与 save_as_pdf（:1924-1953）动作：参数透传 + 落盘/回显。
// 注意（保真）：Python 两个动作的 save_path/path 均不经白名单（与 write_file 族不同）
// ——直写路径是上游语义；TS 照搬，经注入 fs 落盘（未注入即 error）。

import { ActionResult } from "../../agent/views.js";
import type { ActionHandler, ToolsBrowser } from "../types.js";
import type { ToolsContext } from "./context.js";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createScreenshotHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>, browser: ToolsBrowser) => {
    const fmt = typeof params.format === "string" ? params.format : "png";
    const quality = typeof params.quality === "number" ? params.quality : null;
    const clip = params.clip;
    const fullPage = params.full_page === true;
    const savePath = typeof params.save_path === "string" ? params.save_path : "";

    let bytes: Uint8Array;
    try {
      bytes = await browser.takeScreenshot({
        format: fmt === "jpeg" || fmt === "webp" ? fmt : "png",
        quality,
        clip:
          typeof clip === "object" && clip !== null
            ? (clip as { x?: number; y?: number; width?: number; height?: number })
            : null,
        fullPage,
        waitSettle: fullPage,
      });
    } catch (e) {
      ctx.log(`screenshot action failed: ${errText(e)}`);
      return new ActionResult({ error: `Screenshot failed: ${errText(e)}` });
    }

    if (savePath !== "") {
      if (ctx.fs === null) {
        return new ActionResult({
          error: `Failed to save screenshot to ${savePath}: no filesystem provider injected`,
        });
      }
      try {
        await ctx.fs.writeBytes(savePath, bytes);
      } catch (e) {
        return new ActionResult({
          error: `Failed to save screenshot to ${savePath}: ${errText(e)}`,
        });
      }
      return new ActionResult({
        extractedContent: `Screenshot saved to ${savePath} (${bytes.length} bytes)`,
      });
    }
    let meta = `format=${fmt}, ${bytes.length} bytes`;
    if (fullPage) meta += ", full_page";
    if (typeof clip === "object" && clip !== null) {
      const c = clip as { width?: number; height?: number };
      meta += `, clip=${c.width}x${c.height}`;
    }
    return new ActionResult({
      extractedContent: `Screenshot captured (${meta}) but not saved (no save_path).`,
    });
  };
}

export function createSaveAsPdfHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>, browser: ToolsBrowser) => {
    const path = params.path;
    if (typeof path !== "string") {
      return new ActionResult({ error: "save_as_pdf requires a string `path` parameter." });
    }
    const paperFormat = typeof params.paper_format === "string" ? params.paper_format : "letter";
    const paper =
      paperFormat === "legal" ||
      paperFormat === "a4" ||
      paperFormat === "a3" ||
      paperFormat === "tabloid"
        ? paperFormat
        : "letter";
    const landscape = params.landscape === true;
    const printBackground = params.print_background !== false;
    const scale = typeof params.scale === "number" ? params.scale : 1.0;

    let bytes: Uint8Array;
    try {
      bytes = await browser.printToPdf({
        paperFormat: paper,
        landscape,
        printBackground,
        scale,
      });
    } catch (e) {
      ctx.log(`save_as_pdf action failed: ${errText(e)}`);
      return new ActionResult({ error: `Failed to generate PDF: ${errText(e)}` });
    }

    if (ctx.fs === null) {
      return new ActionResult({
        error: `Failed to save PDF to ${path}: no filesystem provider injected`,
      });
    }
    try {
      await ctx.fs.writeBytes(path, bytes);
    } catch (e) {
      return new ActionResult({ error: `Failed to save PDF to ${path}: ${errText(e)}` });
    }
    let meta = `paper=${paperFormat}, ${bytes.length} bytes`;
    if (landscape) meta += ", landscape";
    return new ActionResult({ extractedContent: `PDF saved to ${path} (${meta})` });
  };
}
