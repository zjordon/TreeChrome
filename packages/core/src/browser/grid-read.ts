// 网格读取通道（session.py :3114-3139 read_ui_grid + actions.py :3125-3139
// _eval_grid_channel）：uiRegistry 主通道 + legacy/DOM 回落通道的执行与解析。
// JS 体在 grid-read-js.ts（batch2c.json 逐字节）；grid-meta/kick 复用 P4 既有面。

import { evaluateEnhanced } from "./evaluate-enhanced.js";
import { DOM_TABLE_READ_JS, GRID_READ_JS, LEGACY_GRID_READ_JS } from "./grid-read-js.js";
import type { SessionInternals } from "./transport.js";

export { DOM_TABLE_READ_JS, GRID_READ_JS, LEGACY_GRID_READ_JS };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** read_ui_grid 的 payload 形态（tools.models ReadGridParams + waitMs） */
export interface GridReadPayload {
  namespace: string | null;
  filters: Record<string, unknown> | null;
  search: string | null;
  sorting: { field: string; direction: string } | null;
  paging: { pageSize: number; current: number };
  fields: string[] | null;
  fresh: boolean;
  waitMs: number;
}

/**
 * :3114-3131 uiRegistry 主通道：evaluate(GRID_READ_JS, args=[payload])，成功返回
 * 结果 dict；通道不可用返回 {channel_error}（evaluate-failed/unexpected-result/
 * unparseable），由调用方决定回落。
 */
export async function readUiGrid(
  s: SessionInternals,
  payload: GridReadPayload,
  timeoutMs?: number | null,
): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await evaluateEnhanced(s, {
      code: GRID_READ_JS,
      args: [payload],
      awaitPromise: true,
      ...(timeoutMs !== undefined && timeoutMs !== null ? { timeoutMs } : {}),
    });
  } catch (e) {
    return { channel_error: `evaluate-failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  return parseGridChannelResult(raw);
}

/** :3132-3139 求值结果 → dict；不可解析返回 {channel_error: unexpected-result/unparseable} */
export function parseGridChannelResult(raw: string): Record<string, unknown> {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { channel_error: `unparseable: ${String(raw).slice(0, 120)}` };
    }
  }
  return isRecord(parsed) ? parsed : { channel_error: "unexpected-result" };
}

/**
 * :3125-3139 跑一条回落通道 JS 并解析 dict；异常/不可解析返回 null（不抛）。
 * Python 经 browser.evaluate（args 编组 + awaitPromise + timeout 30000）。
 */
export async function evalGridChannel(
  s: SessionInternals,
  js: string,
  payload: GridReadPayload,
): Promise<Record<string, unknown> | null> {
  let raw: unknown;
  try {
    raw = await evaluateEnhanced(s, {
      code: js,
      args: [payload],
      awaitPromise: true,
      timeoutMs: 30000,
    });
  } catch (e) {
    s.log(`grid channel evaluate failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return isRecord(parsed) ? parsed : null;
}
