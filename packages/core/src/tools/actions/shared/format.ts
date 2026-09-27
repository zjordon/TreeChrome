// 查询落盘族：search_page/find_elements/node_ids 三格式化器（browser-use service.py
// 镜像，:147-263）+ 公共大结果落盘 saveOversizedResult（Python 在 6 处内联重复，
// TS 抽公共函数——p4/02 §8 偏离 4 等价重构登记）。纯函数 + fs 注入。

import type { FileSystemProvider } from "../../fs.js";

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const pluralMatch = (total: number): string => (total !== 1 ? "es" : "");
const pluralElement = (total: number): string => (total !== 1 ? "s" : "");

/** :147-184 search_page 结果 → LLM 可读文本（分页 footer + 属性匹配段） */
export function formatSearchResults(data: Record<string, unknown>, query: string): string {
  const matches = Array.isArray(data.matches) ? data.matches : [];
  const total = Number(data.total ?? 0);
  const hasMore = data.has_more === true;
  const offset = Number(data.offset ?? 0);

  const lines: string[] = [`Found ${total} match${pluralMatch(total)} for "${query}" on page:`, ""];
  for (const [i, m] of matches.entries()) {
    const r = rec(m);
    const context = String(r.context ?? "");
    const path = String(r.element_path ?? "");
    const loc = path ? ` (in ${path})` : "";
    lines.push(`[${i + 1}] ${context}${loc}`);
  }
  if (hasMore) {
    const nextOffset = offset + matches.length;
    lines.push(
      `\n... showing ${offset + 1}–${offset + matches.length} of ${total} total matches. ` +
        `Call again with offset=${nextOffset} for the next batch (or raise max_results).`,
    );
  }
  const attrMatches = Array.isArray(data.attribute_matches) ? data.attribute_matches : [];
  const attrTotal = Number(data.attribute_total ?? 0);
  if (attrTotal) {
    lines.push("");
    lines.push(`Attribute matches for "${query}" (${attrTotal}):`);
    for (const [i, m] of attrMatches.entries()) {
      const r = rec(m);
      const path = String(r.element_path ?? "");
      const loc = path ? ` (in ${path})` : "";
      lines.push(`[${i + 1}] @${String(r.attribute ?? "")}=${String(r.value ?? "")}${loc}`);
    }
    if (attrTotal > attrMatches.length) {
      lines.push(`... showing ${attrMatches.length} of ${attrTotal} attribute matches.`);
    }
  }
  return lines.join("\n");
}

/** :187-235 find_elements 结果 → LLM 可读文本（origin/geometry + 分页 footer） */
export function formatFindResults(data: Record<string, unknown>, selector: string): string {
  const elements = Array.isArray(data.elements) ? data.elements : [];
  const total = Number(data.total ?? 0);
  const offset = Number(data.offset ?? 0);
  const hasMore = data.has_more === true;

  const lines: string[] = [
    `Found ${total} element${pluralElement(total)} matching "${selector}":`,
    "",
  ];
  for (const el of elements) {
    const r = rec(el);
    const idx = Number(r.index ?? 0);
    const tag = String(r.tag ?? "?");
    const text = String(r.text ?? "");
    const attrs = rec(r.attrs);
    const children = Number(r.children_count ?? 0);
    const origin = String(r.origin ?? "");
    const rect = r.rect === null || r.rect === undefined ? null : rec(r.rect);

    const parts = [`[${idx}] <${tag}>`];
    if (text) {
      // Python " ".join(text.split())：split 无参先去首尾并折叠全部空白
      let displayText = text.trim().split(/\s+/).join(" ");
      if (displayText.length > 120) displayText = `${displayText.slice(0, 120)}...`;
      parts.push(`"${displayText}"`);
    }
    if (Object.keys(attrs).length > 0) {
      const attrStrs = Object.entries(attrs).map(([k, v]) => `${k}="${String(v)}"`);
      parts.push(`{${attrStrs.join(", ")}}`);
    }
    parts.push(`(${children} children)`);
    if (rect) {
      const vis = r.visible ? "visible" : "hidden";
      parts.push(
        `(${vis}, ${Math.trunc(Number(rect.w))}x${Math.trunc(Number(rect.h))}@${Math.trunc(Number(rect.x))},${Math.trunc(Number(rect.y))})`,
      );
    }
    if (origin) parts.push(origin.trim());
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

/** :238-263 find_elements_node_ids 结果 → LLM 可读文本（backend_id 直供 index/element_id） */
export function formatNodeIdResults(data: Record<string, unknown>, selector: string): string {
  const nodeIds = Array.isArray(data.node_ids) ? data.node_ids : [];
  const total = Number(data.total ?? 0);
  const offset = Number(data.offset ?? 0);
  const hasMore = data.has_more === true;

  const lines: string[] = [
    `Found ${total} element${pluralElement(total)} matching "${selector}" (node ids):`,
    "",
  ];
  for (const el of nodeIds) {
    const r = rec(el);
    const bid = r.backend_id;
    const tag = String(r.tag ?? "?");
    lines.push(`[${String(bid)}] <${tag}>  (pass as index= or element_id= to click/input_text)`);
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

export interface SaveOversizedOptions {
  /** 结果长度阈值（truncation.*_save_threshold） */
  threshold: number;
  /** 落盘目录（truncation.*_output_dir） */
  outputDir: string;
  /** 文件名前缀（action 名） */
  prefix: string;
  /** 扩展名（extract 按有无 schema 取 json/md；其余 txt） */
  ext: string;
  fs: FileSystemProvider | null;
  log: (message: string) => void;
  /** 时间戳毫秒（缺省 Date.now；测试注入） */
  nowMs?: () => number;
  /** 目录/文件路径拼接（缺省 `/` 连接——宿主 FS 自带分隔符语义时覆盖） */
  join?: (dir: string, name: string) => string;
}

/**
 * 大结果分级落盘（extract :1583-1594 / find_elements / search_page / evaluate 的
 * 公共化）。仅按大小触发；失败只 warning 不失败。fs 未注入返回 null（调用方标注降级）。
 */
export async function saveOversizedResult(
  text: string,
  opts: SaveOversizedOptions,
): Promise<string | null> {
  if (text.length < opts.threshold) return null;
  if (opts.fs === null) {
    opts.log(`${opts.prefix}: save skipped (no filesystem provider injected)`);
    return null;
  }
  try {
    await opts.fs.ensureDir(opts.outputDir);
    const join = opts.join ?? ((dir, name) => `${dir}/${name}`);
    const fpath = join(
      opts.outputDir,
      `${opts.prefix}_${Math.trunc(opts.nowMs?.() ?? Date.now())}.${opts.ext}`,
    );
    await opts.fs.writeTextFile(fpath, text);
    return fpath;
  } catch (e) {
    opts.log(`${opts.prefix}: save to file failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
