// UI 网格元信息（get_state 附带 [Grid] 段的来源）。移植自 TreeWalker session.py
// :3116-3191（_GRID_META_JS + _read_grid_meta）@640d52a。只读不 reload——报告
// 「现在」的 total/sorting/活动过滤；非网格页按 URL 缓存跳过（零重复成本）。
// read_grid 动作（结构化读）在 P4b。

import { evaluateScript } from "./evaluate-basic.js";
import type { SessionInternals } from "./transport.js";

// JS 体逐字节照抄（无反斜杠，避开 evaluate 转义链路）
const GRID_META_JS = `
(async function(){
    try {
        var wrap = document.querySelectorAll('.admin__data-grid-wrap, table.data-grid');
        if (wrap.length === 0) { return ''; }
        if (typeof require !== 'function') { return ''; }
        var reg = await new Promise(function(r){ require(['uiRegistry'], r); });
        var names = await new Promise(function(resolve){
            var acc = [];
            try { reg.get(function(c){ if (c && c.name) { acc.push(c.name); } return false; }); }
            catch (e) {}
            setTimeout(function(){ resolve(acc); }, 300);
        });
        var dsName = null;
        for (var i = 0; i < names.length; i++) {
            var n = names[i];
            if (n.indexOf('notification_area') !== 0 && n.slice(-12) === '_data_source'
                && n.indexOf('.') === n.lastIndexOf('.')) { dsName = n; break; }
        }
        if (!dsName) { return ''; }
        var ds = await new Promise(function(resolve){
            var done = false;
            reg.get(dsName, function(c){ done = true; resolve(c); });
            setTimeout(function(){ if (!done) { resolve(null); } }, 1200);
        });
        if (!ds || !ds.data) { return ''; }
        var d = ds.data, prm = ds.params || {};
        var filters = {}, f = prm.filters || {};
        for (var k in f) {
            if (k !== 'placeholder' && Object.prototype.hasOwnProperty.call(f, k)) { filters[k] = f[k]; }
        }
        var sorting = prm.sorting || null;
        var first = (d.items instanceof Array && d.items.length) ? d.items[0] : null;
        var firstVal = null;
        if (first && sorting && sorting.field && Object.prototype.hasOwnProperty.call(first, sorting.field)) {
            firstVal = String(first[sorting.field]).slice(0, 40);
        }
        return JSON.stringify({
            namespace: dsName.split('.')[0],
            rows_loaded: (d.items instanceof Array) ? d.items.length : 0,
            total_records: (typeof d.totalRecords !== 'undefined') ? d.totalRecords : null,
            page: prm.paging ? prm.paging.current : null,
            page_size: prm.paging ? prm.paging.pageSize : null,
            sorting: sorting,
            first_sorted_value: firstVal,
            active_filters: filters,
            active_search: prm.search || ''
        });
    } catch (e) { return ''; }
})()`;

/**
 * 读当前页网格元信息；非网格页按 URL 缓存跳过。失败一律 null（元信息是增强不是
 * 依赖）；网格页每步重读——total/过滤随动作变化正是要暴露的信息。
 */
export async function readGridMeta(
  s: SessionInternals,
  url: string,
): Promise<Record<string, unknown> | null> {
  if (s.gridNoGridUrls.has(url)) return null;
  let text = "";
  try {
    const raw = await evaluateScript(s, GRID_META_JS, { timeoutMs: 8000 });
    text = typeof raw === "string" ? raw : "";
  } catch (e) {
    s.log(`grid meta read failed: ${String(e)}`);
    return null;
  }
  if (!text.trim()) {
    s.gridNoGridUrls.add(url);
    return null;
  }
  try {
    const meta = JSON.parse(text) as unknown;
    return typeof meta === "object" && meta !== null && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
