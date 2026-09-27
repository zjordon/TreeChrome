// 截图与 PDF：takeScreenshot（单请求超时护栏）与 printToPdf。移植自 TreeWalker
// session.py:2206-2346 @640d52a。护栏超时的归因文案是 LLM 可见错误（进 ActionResult）
// ——逐字节保真。bytes → Uint8Array（atob 在 Node 18+/MV3 SW 均原生）。

import { waitForReadyStateSettle } from "./navigation.js";
import type { SessionInternals } from "./transport.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 护栏超时的内部标记（与 CDP 传输层自身的超时区分——后者原样上抛） */
class GuardTimeout extends Error {}

export interface ScreenshotOptions {
  format?: "png" | "jpeg" | "webp";
  /** 0-100，仅 format=jpeg 生效（CDP 约束） */
  quality?: number | null;
  /** CSS px 矩形 {x,y,width,height}（scale 强制 1） */
  clip?: { x?: number; y?: number; width?: number; height?: number } | null;
  fullPage?: boolean;
  waitSettle?: boolean;
}

function decodeBase64(data: string): Uint8Array {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * 视口截图（:2206-2290）。captureScreenshot 等不到合成器新帧会无限挂（最小化/
 * 遮挡窗口、裸媒体页）——单请求超时护栏（screenshotTimeout；≤0 关护栏）。
 */
export async function takeScreenshot(
  s: SessionInternals,
  options: ScreenshotOptions = {},
): Promise<Uint8Array> {
  const format = options.format ?? "png";
  if (options.waitSettle) {
    try {
      await waitForReadyStateSettle(s);
    } catch (e) {
      s.log(`Pre-screenshot wait_settle failed: ${String(e)}`);
    }
  }
  const params: Record<string, unknown> = { format };
  if (options.fullPage) params.captureBeyondViewport = true;
  if (options.quality !== undefined && options.quality !== null && format === "jpeg") {
    params.quality = Math.trunc(options.quality);
  }
  if (options.clip) {
    params.clip = {
      x: options.clip.x ?? 0.0,
      y: options.clip.y ?? 0.0,
      width: options.clip.width ?? 0.0,
      height: options.clip.height ?? 0.0,
      scale: 1,
    };
  }
  const timeout = s.settings.screenshotTimeout;
  let result: Record<string, unknown>;
  try {
    const call = s.send<Record<string, unknown>>("Page.captureScreenshot", params);
    if (timeout > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      result = await Promise.race([
        call,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new GuardTimeout()), timeout * 1000);
        }),
      ]).finally(() => {
        // 提前成功也要清计时器（评审轮 1 #10）：悬挂句柄会把进程退出挂住至多 timeout 秒
        if (timer !== undefined) clearTimeout(timer);
      });
    } else {
      result = await call;
    }
  } catch (e) {
    if (e instanceof GuardTimeout && timeout > 0) {
      // 文案逐字节对齐 Python（task_374 教训：空消息烧 6 步止损）
      const msg =
        `timed out after ${timeout}s waiting for a frame — raw media pages ` +
        "(image/video URLs have no page DOM to screenshot) and minimized/" +
        "occluded windows both cause this; navigate to an HTML page wrapping " +
        "the media, or report/save the media URL instead of screenshotting";
      s.log(`Page.captureScreenshot failed: ${msg}`);
      throw new Error(msg);
    }
    s.log(`Page.captureScreenshot failed: ${String(e)}`);
    throw e;
  }
  if (!isRecord(result) || typeof result.data !== "string") {
    throw new Error("Screenshot failed - no data returned");
  }
  return decodeBase64(result.data);
}

export interface PrintToPdfOptions {
  paperFormat?: "letter" | "legal" | "a4" | "a3" | "tabloid";
  landscape?: boolean;
  printBackground?: boolean;
  scale?: number;
  waitSettle?: boolean;
}

const PAPER_SIZES: Record<string, [number, number]> = {
  letter: [8.5, 11.0],
  legal: [8.5, 14.0],
  a4: [8.27, 11.69],
  a3: [11.69, 16.54],
  tabloid: [11.0, 17.0],
};

/** 页面 → PDF 字节（:2292-2346）；动作侧 save_as_pdf 在 P4b，方法先行（体量小） */
export async function printToPdf(
  s: SessionInternals,
  options: PrintToPdfOptions = {},
): Promise<Uint8Array> {
  const paperFormat = options.paperFormat ?? "letter";
  const [paperWidth, paperHeight] = PAPER_SIZES[paperFormat.toLowerCase()] ?? [8.5, 11.0];
  if (options.waitSettle) {
    try {
      await waitForReadyStateSettle(s);
    } catch (e) {
      s.log(`Pre-pdf wait_settle failed: ${String(e)}`);
    }
  }
  const params: Record<string, unknown> = {
    printBackground: options.printBackground ?? true,
    landscape: options.landscape ?? false,
    scale: options.scale ?? 1.0,
    paperWidth,
    paperHeight,
    preferCSSPageSize: true,
  };
  let result: Record<string, unknown>;
  try {
    result = await s.send<Record<string, unknown>>("Page.printToPDF", params);
  } catch (e) {
    s.log(`Page.printToPDF failed: ${String(e)}`);
    throw e;
  }
  if (!isRecord(result) || typeof result.data !== "string") {
    throw new Error("printToPDF failed - no data returned");
  }
  return decodeBase64(result.data);
}
