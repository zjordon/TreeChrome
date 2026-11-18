// 转录搜索（issue #41 U4 批 B，验收①）：会话内全文搜索的纯函数面 + 高亮渲染件。
// 搜索范围 = 对话语义面（用户气泡 task + run 块 lastError/finalResult——D2）：
// 事件明细是调试面（调试页承载原始流）不进搜索。命中按 DOM 序编全局序号
// （条目序 → 条目内 lastError 先于 finalResult——与 FinalResult 渲染序一致），
// activeOrdinal 驱动当前命中强标识与滚动定位。

import { type ReactElement, useMemo } from "react";
import type { TranscriptItem } from "./transcript.js";

/** 文本分段（命中处标 hit——渲染 mark 用） */
export interface TextSegment {
  text: string;
  hit: boolean;
}

export function isSearchableQuery(query: string): boolean {
  return query.trim() !== "";
}

/** 大小写不敏感切分：命中段与非命中段交替；空查询整段非命中 */
export function splitTextByQuery(text: string, query: string): TextSegment[] {
  if (!isSearchableQuery(query)) return [{ text, hit: false }];
  const out: TextSegment[] = [];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let cursor = 0;
  for (;;) {
    const at = lowerText.indexOf(lowerQuery, cursor);
    if (at === -1) break;
    if (at > cursor) out.push({ text: text.slice(cursor, at), hit: false });
    out.push({ text: text.slice(at, at + query.length), hit: true });
    cursor = at + query.length;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
  return out.length === 0 ? [{ text: "", hit: false }] : out;
}

export function countTextMatches(text: string, query: string): number {
  return splitTextByQuery(text, query).filter((s) => s.hit).length;
}

/** 条目的可搜索文本（DOM 序：run 块 lastError 先于 finalResult——FinalResult 渲染序） */
export function searchTextsOf(item: TranscriptItem): string[] {
  if (item.kind === "user-turn") return [item.task];
  return [item.lastError, item.finalResult].filter(
    (t): t is string => t !== null && t !== undefined,
  );
}

export function countItemMatches(item: TranscriptItem, query: string): number {
  if (!isSearchableQuery(query)) return 0;
  return searchTextsOf(item).reduce((n, t) => n + countTextMatches(t, query), 0);
}

/** 全会话命中总数（SearchOverlay 计数与宿主导航上界共用） */
export function totalTranscriptMatches(items: TranscriptItem[], query: string): number {
  if (!isSearchableQuery(query)) return 0;
  return items.reduce((n, item) => n + countItemMatches(item, query), 0);
}

/** 条目 → 该条目首个命中的全局序号（此前命中已占用的数量） */
export function ordinalBasesOf(items: TranscriptItem[], query: string): Map<string, number> {
  const map = new Map<string, number>();
  if (!isSearchableQuery(query)) return map;
  let acc = 0;
  for (const item of items) {
    map.set(item.kind === "user-turn" ? item.turnId : item.runId, acc);
    acc += countItemMatches(item, query);
  }
  return map;
}

export interface TranscriptHighlight {
  query: string;
  /** 本文本段之前已被占用的全局命中序号（条目内按 DOM 序累计） */
  baseOrdinal: number;
  /** 全局当前命中序号（0-based） */
  activeOrdinal: number;
}

/** 高亮文本（无命中时原样）：命中段 mark，当前命中强标识 data-search-ordinal */
export function HighlightedText({
  text,
  highlight,
}: {
  text: string;
  highlight: TranscriptHighlight;
}): ReactElement {
  const segments = useMemo(() => splitTextByQuery(text, highlight.query), [text, highlight.query]);
  let ordinal = highlight.baseOrdinal;
  return (
    <>
      {segments.map((seg, i) =>
        seg.hit ? (
          <mark
            // biome-ignore lint/suspicious/noArrayIndexKey: 分段序即命中序——查询不变时稳定
            key={i}
            className={
              ordinal === highlight.activeOrdinal
                ? "tc-search-hit tc-search-hit--active"
                : "tc-search-hit"
            }
            data-search-ordinal={ordinal++}
          >
            {seg.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: 分段序即命中序——查询不变时稳定
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}
