// read_grid 动作（actions.py :2816-3139）：参数守卫 → 三通道降级链（uiRegistry →
// legacy ExtJS → DOM 表格）→ group_count 聚合 / 合计行交叉校验（容差按行数缩放）
// → 大结果落盘 + 元信息回显。_parse_grid_number :688-728 / _grid_footer_row_role
// :729-754 及全部文案逐字节锚定 batch2c.json。
// 微偏离：default=str 分支不可达（rows 来自 JSON 解析，无 Python 侧 datetime 类
// 值）；page_size/page 的 bool 输入按 error 拒（Python int(True)=1）。

import { ActionResult } from "../../agent/views.js";
import { pyFormatG } from "../../browser/evaluate-enhanced.js";
import {
  DOM_TABLE_READ_JS,
  type GridReadPayload,
  LEGACY_GRID_READ_JS,
} from "../../browser/grid-read.js";
import { pyJsonDumps } from "../py-json.js";
import type { ActionHandler, ToolsBrowser } from "../types.js";
import type { ToolsContext } from "./context.js";
import { pyRepr } from "./shared/element-lookup.js";
import { saveOversizedResult } from "./shared/format.js";

/** :684-685 数值剥离字符（含 \xa0）与千分位形态 */
const GRID_NUM_STRIP_ENDS = " \t\r\n\u00A0$€£¥%";
const GRID_THOUSANDS_RE = /^\d{1,3}(,\d{3})+(\.\d+)?$/;

/** Python str.strip(chars)：两端逐字符剥离集合内字符 */
function pyStrip(s: string, chars: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start])) start += 1;
  while (end > start && chars.includes(s[end - 1])) end -= 1;
  return s.slice(start, end);
}

/**
 * :688-728 报表/网格单元格值 → number；不可解析返回 null（None 安全，不抛）。
 * 千分位须整体合法形态；_ 下划线分隔拒；± 号先剥离；strip 集合含 \xa0。
 */
export function parseGridNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return null; // bool 不是数值
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let s = String(value).trim();
  let neg = false;
  if (s.slice(0, 1) === "-" || s.slice(0, 1) === "+") {
    neg = s[0] === "-";
    s = s.slice(1).trim();
  }
  s = pyStrip(s, GRID_NUM_STRIP_ENDS);
  if (s === "" || s.includes("_")) return null;
  if (s.includes(",")) {
    if (!GRID_THOUSANDS_RE.test(s)) return null;
    s = s.replaceAll(",", "");
  }
  const n = toPyFloat(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/** Python float() 接受 Unicode 十进制数字（Nd 类）——JS Number 不认。Nd 十进制
 *  块均自成 0-9 连续段：回扫至非 Nd 边界，段内偏移即数值（≤9 校验；段界异常放弃） */
function ndDigitValue(cp: number): number | null {
  let start = cp;
  for (let i = 0; i < 9; i++) {
    const prev = start - 1;
    if (prev < 0) break;
    if (!/\p{Nd}/u.test(String.fromCodePoint(prev))) break;
    start = prev;
  }
  const v = cp - start;
  return v >= 0 && v <= 9 ? v : null;
}

function toPyFloat(s: string): number {
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  if (!/\p{Nd}/gu.test(s)) return Number.NaN;
  let out = "";
  for (const ch of s) {
    if (/[0-9]/.test(ch)) {
      out += ch;
      continue;
    }
    if (/\p{Nd}/u.test(ch)) {
      const v = ndDigitValue(ch.codePointAt(0) ?? 0);
      if (v === null) return Number.NaN;
      out += String(v);
      continue;
    }
    out += ch;
  }
  return Number(out);
}

/** :713-716 合计行标签集合（skip 优先于 base） */
const GRID_FOOTER_BASE_LABELS = new Set(["total", "totals", "grand total", "合计", "总计"]);
const GRID_FOOTER_SKIP_LABELS = new Set([
  "subtotal",
  "小计",
  "tax",
  "shipping",
  "discount",
  "discounts",
  "freight",
]);

/** :718-733 "base"（全列和基准）/ "skip"（中间合计/单项行）/ null（无已知标签） */
export function gridFooterRowRole(frow: Record<string, unknown>): string | null {
  let base = false;
  for (const v of Object.values(frow)) {
    const t = String(v).trim().toLowerCase();
    if (GRID_FOOTER_SKIP_LABELS.has(t)) return "skip";
    if (GRID_FOOTER_BASE_LABELS.has(t)) base = true;
  }
  return base ? "base" : null;
}

/** :756-758 非可加列（均值/比率/百分比）表头标记——Total 格非列和，跳过比对 */
const GRID_NON_ADDITIVE_HEADER_MARKERS = ["avg", "average", "rate", "ratio", "percent", "%"];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Python bool() 真值（None/False/0/""/空容器 falsy） */
const pyTruthy = (v: unknown): boolean => {
  if (v === null || v === undefined || v === false) return false;
  if (v === 0) return false;
  if (v === "") return false;
  if (Array.isArray(v) && v.length === 0) return false;
  if (isRecord(v) && Object.keys(v).length === 0) return false;
  return true;
};

/** Python f-string {value} 形态：None → "None"；list → repr（元素 repr 单引号） */
const pyReprOf = (v: unknown): string => {
  if (v === null || v === undefined) return "None";
  if (Array.isArray(v)) return `[${v.map((item) => pyRepr(String(item))).join(", ")}]`;
  return String(v);
};

/** Python int() 宽松转换（字符串整数形态/数字截断）；不可转 null */
function pyIntOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^[+-]?\d+$/.test(v.trim())) return Number.parseInt(v.trim(), 10);
  if (typeof v === "boolean") return null; // 微偏离：Python int(True)=1，此处拒
  return null;
}

export function createReadGridHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>, browser: ToolsBrowser) => {
    // 参数守卫（registry 不校验 execute 路径）
    const namespace = params.namespace ?? null;
    if (namespace !== null && typeof namespace !== "string") {
      return new ActionResult({ error: "read_grid failed: namespace must be a string." });
    }
    const filters = params.filters ?? null;
    if (filters !== null && !isRecord(filters)) {
      return new ActionResult({
        error: "read_grid failed: filters must be an object, e.g. {'status': 'complete'}.",
      });
    }
    const search = params.search ?? null;
    if (search !== null && typeof search !== "string") {
      return new ActionResult({ error: "read_grid failed: search must be a string." });
    }
    const sortingRaw = params.sorting;
    let sorting: { field: string; direction: string } | null = null;
    if (typeof sortingRaw === "string" && sortingRaw.trim() !== "") {
      const parts = sortingRaw.trim().split(/\s+/);
      const direction = parts.length > 1 ? parts[1].toLowerCase() : "asc";
      sorting = {
        field: parts[0],
        direction: direction === "asc" || direction === "desc" ? direction : "asc",
      };
    }
    const rawPageSize = pyIntOrNull(params.page_size ?? 200);
    const rawPage = pyIntOrNull(params.page ?? 1);
    if (rawPageSize === null || rawPage === null) {
      return new ActionResult({ error: "read_grid failed: page_size/page must be integers." });
    }
    const pageSize = Math.max(1, Math.min(rawPageSize, 2000));
    const page = Math.max(1, rawPage);
    const fields = params.fields ?? null;
    if (
      fields !== null &&
      (!Array.isArray(fields) || !fields.every((f) => typeof f === "string"))
    ) {
      return new ActionResult({ error: "read_grid failed: fields must be a list of strings." });
    }
    // issue #185 现象②：group_count 守卫 + 归一化（带空格的 LLM 输出须 strip）
    let groupField: string | null = null;
    if (typeof params.group_count === "string") groupField = params.group_count;
    if (groupField !== null && groupField.trim() === "") {
      return new ActionResult({
        error: "read_grid failed: group_count must be a non-empty string field name.",
      });
    }
    if (groupField !== null) groupField = groupField.trim();
    const fresh = params.fresh === undefined ? true : pyTruthy(params.fresh);

    const payload: GridReadPayload = {
      namespace,
      filters,
      search,
      sorting,
      paging: { pageSize, current: page },
      fields,
      fresh,
      waitMs: 8000,
    };

    // 通道 1：uiRegistry（Magento admin 列表页 KO 网格）
    let result = await browser.readUiGrid(payload);
    const notes: string[] = [];
    // 通道 2：legacy ExtJS 网格（无 uiRegistry；不支持 filters/search）
    if (result.channel_error !== undefined) {
      const legacy = await browser.evalGridChannel(LEGACY_GRID_READ_JS, payload);
      if (legacy !== null && legacy.channel_error === undefined) {
        if (pyTruthy(filters) || pyTruthy(search)) {
          legacy.note = `${String(legacy.note ?? "")} legacy channel: filters/search not applied (paging/sorting only)`;
        }
        result = legacy;
      }
    }
    // 通道 3：DOM 表格兜底
    if (result.channel_error !== undefined) {
      const dom = await browser.evalGridChannel(DOM_TABLE_READ_JS, payload);
      if (dom !== null && dom.channel_error === undefined) {
        result = dom;
      }
    }
    if (result.channel_error !== undefined) {
      return new ActionResult({
        error:
          `read_grid failed: ${String(result.channel_error)} ` +
          "(no UI-component grid, legacy grid, or table found on this page)",
      });
    }

    const rows = Array.isArray(result.rows) ? (result.rows as Record<string, unknown>[]) : [];
    // rows_returned（通道未回传时回退行数；Python .get(key, len) 同形）
    const rowsReturnedRaw = result.rows_returned;
    const rowsReturned = typeof rowsReturnedRaw === "number" ? rowsReturnedRaw : rows.length;

    // group_count 聚合（Python 侧确定性计数——通道无关；把「数数」从上下文 tally 解救）
    let groupCounts: Array<[string, number]> | null = null;
    if (groupField !== null) {
      const counts = new Map<string, number>();
      for (const r of rows) {
        const v = r[groupField];
        const k =
          v === null || v === undefined || (typeof v === "string" && v.trim() === "")
            ? "(missing)"
            : String(v);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      groupCounts = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    }

    // 大结果落盘（evaluate 同款分级）
    const text = pyJsonDumps(result);
    const tr = ctx.truncation;
    const savedTo = await saveOversizedResult(text, {
      prefix: "grid",
      outputDir: tr.evalOutputDir,
      ext: "json",
      threshold: tr.evalSaveThreshold,
      fs: ctx.fs,
      log: ctx.log,
    });

    const metaBits: string[] = [];
    if (result.namespace) metaBits.push(`ns=${String(result.namespace)}`);
    metaBits.push(`rows=${rowsReturned}`);
    if (result.total_records !== null && result.total_records !== undefined) {
      metaBits.push(`total=${String(result.total_records)}`);
    }
    const applied = isRecord(result.applied) ? result.applied : {};
    const sortingApplied = isRecord(applied.sorting) ? applied.sorting : null;
    if (sortingApplied?.field) {
      metaBits.push(
        `sorted=${String(sortingApplied.field)} ${String(sortingApplied.direction ?? "asc")}`,
      );
    }
    const activeBefore = isRecord(result.active_before) ? result.active_before : {};
    if (pyTruthy(activeBefore.filters) || pyTruthy(activeBefore.search)) {
      const leftover = pyJsonDumps({
        filters: activeBefore.filters ?? null,
        search: activeBefore.search ?? null,
      });
      notes.push(`cleared leftover grid state before read: ${leftover.slice(0, 140)}`);
    }
    if (result.partial === true) {
      notes.push(
        "partial: data was still loading when the read returned — totals may be stale; retry if counts look short",
      );
    }
    // 三类「成功但无数据」形态诊断（legacy/DOM 通道按显示名表头过滤 fields）。
    // fields/heads 嵌入 Python f-string 的 list repr 形态（['a', 'b']——非 JSON）
    const channel = result.channel;
    if (channel === "legacy_ajax" || channel === "dom_table") {
      const heads = Array.isArray(result.headers) ? (result.headers as unknown[]) : [];
      if (rows.length > 0 && rows.every((r) => Object.keys(r).length === 0)) {
        notes.push(
          `all ${rows.length} rows came back EMPTY: requested fields ${pyReprOf(fields)} ` +
            `match none of this channel's headers ${pyReprOf(heads.slice(0, 12))} — legacy/DOM ` +
            "channels key rows by display-name headers; retry without fields " +
            "or with the listed header names",
        );
      } else if (rows.length === 0) {
        if (pyTruthy(filters) || pyTruthy(search)) {
          notes.push(
            "0 rows returned; note the requested filters/search were NOT " +
              "applied on this channel, so they are not the cause — verify " +
              "the grid shows rows on this page or use the UI Filters panel",
          );
        } else {
          notes.push(
            "0 rows returned; if the grid visibly shows rows, the channel " +
              "may have parsed a stale/empty response — retry or read via evaluate",
          );
        }
      }
    } else if (channel === "uiregistry") {
      if (rows.length > 0 && rows.every((r) => Object.keys(r).length === 0)) {
        notes.push(
          `all ${rows.length} rows came back EMPTY: requested fields ${pyReprOf(fields)} ` +
            "match none of this grid's data-source field names — retry " +
            "without fields to see the available keys",
        );
      }
    }

    // group_count 回显（不受 saved_to 分支影响——rows 落盘时结论仍须可见）
    let gcLine: string | null = null;
    if (groupCounts !== null && groupField !== null) {
      const rowsRead = rowsReturned;
      const top = groupCounts.slice(0, 50);
      const topObj: Record<string, number> = {};
      for (const [k, v] of top) topObj[k] = v;
      gcLine = `group_count[${groupField}] over ${rowsRead} rows: ${pyJsonDumps(topObj)}`;
      if (groupCounts.length > top.length) {
        gcLine += ` (+${groupCounts.length - top.length} more values omitted)`;
      }
      const total = result.total_records;
      if (typeof total === "number" && Number.isInteger(total) && total > rowsRead) {
        gcLine +=
          ` — ⚠️ counted ${rowsRead} of total ${total} rows; ` +
          "read remaining pages for exact counts";
      } else if (channel === "legacy_ajax" || channel === "dom_table") {
        gcLine +=
          " — ⚠️ page-local counts: this channel returns only the " +
          "current page/pageSize rows and reports no total; " +
          "page through or filter per-candidate for exact counts";
      }
      if (groupCounts.length === 1 && groupCounts[0][0] === "(missing)") {
        gcLine +=
          " — ⚠️ field not present in returned rows; check the " +
          "field name (legacy/DOM channels use display-name headers)";
      }
    }

    // 合计行交叉校验（只在 footer 非空时算；只与 Total 类基准行比对；容差按行数缩放）
    let totalCheckLine: string | null = null;
    let totalCheckOk: boolean | null = null;
    const footerRows = Array.isArray(result.footer)
      ? (result.footer as Array<Record<string, unknown>>)
      : [];
    if (footerRows.length > 0) {
      const colVals = new Map<string, number[]>();
      const colBroken = new Set<string>();
      const colEmpty = new Map<string, number>();
      for (const r of rows) {
        for (const [k, v] of Object.entries(r)) {
          if (colBroken.has(k)) continue;
          const n = parseGridNumber(v);
          if (n !== null) {
            const list = colVals.get(k) ?? [];
            list.push(n);
            colVals.set(k, list);
          } else if (v === null || v === undefined || String(v).trim() === "") {
            colEmpty.set(k, (colEmpty.get(k) ?? 0) + 1);
          } else {
            colBroken.add(k);
            colVals.delete(k);
          }
        }
      }
      // 行级角色过滤：全部无已知标签时退化为「单行=基准」；显式 skip 不得升级
      let roles = footerRows.map((f) => gridFooterRowRole(f));
      if (footerRows.length === 1 && roles[0] === null) {
        roles = ["base"];
      }
      const checkParts: string[] = [];
      let hasMismatch = false;
      const nonAdditive = [...colVals.keys()]
        .filter((k) => GRID_NON_ADDITIVE_HEADER_MARKERS.some((m) => k.toLowerCase().includes(m)))
        .sort();
      footerRows.forEach((frow, i) => {
        if (roles[i] !== "base") return;
        for (const [k, vals] of colVals) {
          if (vals.length === 0 || nonAdditive.includes(k)) continue;
          const sum = vals.reduce((a, b) => a + b, 0);
          const fcell = parseGridNumber(frow[k]);
          if (fcell === null) continue;
          const tol = 0.005 * (vals.length + 1);
          const ok = Math.abs(sum - fcell) <= tol;
          let entry = `${k}: sum ${pyFormatG(sum)} ${ok ? "==" : "≠"} footer ${pyFormatG(fcell)}`;
          if (!ok) {
            hasMismatch = true;
            entry += " ✗";
            const empties = colEmpty.get(k);
            if (empties !== undefined && empties > 0) {
              entry += ` (${empties} empty cells skipped)`;
            }
          }
          checkParts.push(entry);
        }
      });
      if (checkParts.length > 0) {
        totalCheckOk = !hasMismatch;
        totalCheckLine = `totals-check: ${checkParts.join(" | ")}`;
        if (hasMismatch) {
          totalCheckLine +=
            " — a column sum that ≠ its Total-row cell means wrong " +
            "column or missing rows, OR a paginated table (this read " +
            "is page-local): page through all rows before concluding; " +
            "if it still mismatches, re-check the column binding";
          if (channel === "legacy_ajax" && rowsReturned >= pageSize) {
            totalCheckLine +=
              " (rows hit the page_size cap — the read is likely " +
              "truncated; raise page_size and re-read)";
          }
        }
        if (nonAdditive.length > 0) {
          totalCheckLine += ` (non-additive columns skipped — Total cell is a mean/ratio, not a sum: ${nonAdditive.join(", ")})`;
        }
      }
    }

    let visible: string;
    if (savedTo !== null) {
      visible =
        `read_grid [${metaBits.join(" | ")}] full result (${text.length} chars) ` +
        `saved to ${savedTo}. Preview: ${text.slice(0, 300)}...`;
    } else {
      visible = `read_grid [${metaBits.join(" | ")}] ${text.slice(0, tr.evalResultMaxChars)}`;
    }
    if (gcLine !== null) visible = `${gcLine} | ${visible}`;
    if (totalCheckLine !== null) visible = `${totalCheckLine} | ${visible}`;
    for (const n of notes) visible += `  ⚠️ ${n}`;
    let memory = `read_grid: ${metaBits.join(", ")}${savedTo !== null ? `, saved=${savedTo}` : ""}`;
    if (groupCounts !== null && groupField !== null) {
      memory += `, group_count(${groupField})=${groupCounts.length} values`;
    }
    if (totalCheckOk !== null) {
      memory += totalCheckOk ? ", totals-ok" : ", totals-mismatch";
    }
    // 查询总计结构化旁路：legacy/dom 从不应用 filters/search——0 行非「查询零命中」
    let qt: unknown = result.total_records;
    if (!(typeof qt === "number" && Number.isInteger(qt))) qt = rows.length;
    if ((pyTruthy(filters) || pyTruthy(search)) && channel !== "uiregistry") {
      qt = null;
    }
    const metadata = typeof qt === "number" && Number.isInteger(qt) ? { query_total: qt } : null;
    return new ActionResult({
      extractedContent: visible,
      longTermMemory: memory,
      ...(metadata !== null ? { metadata } : {}),
    });
  };
}
