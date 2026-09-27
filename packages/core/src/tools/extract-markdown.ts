// HTML → 干净 markdown + 结构感知分块（extract 动作的两段纯函数）。移植自
// TreeWalker tools/extract_markdown.py @640d52a。
// - extractCleanMarkdown：turndown 替代 markdownify（README 决策 6）——输出**不锚定
//   字节**（LLM 消费非契约），但 link/image 门控正则与噪声 strip 列表逐条对照移植；
// - chunkMarkdownByStructure：算法保真移植（行级 unit → 贪心打包 → 表头延续 +
//   反孤岛），chunk 边界锚定 Python 实跑（fixtures chunk 样例）。

import TurndownService from "turndown";

// markdownify 前要剥的结构噪声标签（script/style 等已在 html-source 剥除）。
// markdownify 的 strip= 语义是摘除标签本身、保留内容——turndown 对未特化块级元素
// 天然按子内容展开，效果等价；列表保留在此仅作文档锚（不改变行为）。
const NOISE_STRIP = ["nav", "footer", "header", "form"] as const;
// 折叠 3+ 连续换行为 2 个
const WS_RE = /\n{3,}/g;

/** 单个 markdown 分块。start/end 索引**原始 markdown**（content 可因表头延续略长） */
export interface MarkdownChunk {
  content: string;
  /** 在原始 markdown 中的偏移（inclusive） */
  start: number;
  /** exclusive */
  end: number;
}

const turndown = new TurndownService({ headingStyle: "atx" });
// 门控在转换前用正则去标签（比清洗 markdown 更便宜、更稳——Python 同款取舍）
const ANCHOR_WITH_TEXT_RE = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
const ANCHOR_SELF_CLOSING_RE = /<a\b[^>]*\/?>/gi;
const IMG_RE = /<img\b[^>]*>/gi;

/** HTML → 干净 markdown。空输入返回 "" */
export function extractCleanMarkdown(
  html: string,
  options: { extractLinks?: boolean; extractImages?: boolean } = {},
): string {
  const { extractLinks = true, extractImages = true } = options;
  if (!html?.trim()) return "";
  let src = html;
  if (!extractLinks) {
    // 去掉 <a> 的 href 与标签本身，保留链接文本
    src = src.replace(ANCHOR_WITH_TEXT_RE, "$1").replace(ANCHOR_SELF_CLOSING_RE, "");
  }
  if (!extractImages) {
    src = src.replace(IMG_RE, "");
  }
  void NOISE_STRIP; // 见上方注释：turndown 对这些元素默认即「摘标签留内容」
  const md = turndown.turndown(src);
  return md.replace(WS_RE, "\n\n").trim();
}

// ── 分块 ──────────────────────────────────────────────────────────────

interface Unit {
  start: number;
  end: number;
  text: string;
}

/** offs[k] = 第 k 行在原文中的起始偏移；末元素 = 全文长度 */
function lineOffsets(lines: string[]): number[] {
  const offs = new Array<number>(lines.length + 1).fill(0);
  for (const [i, ln] of lines.entries()) offs[i + 1] = offs[i] + ln.length;
  return offs;
}

function isTableRow(line: string): boolean {
  const s = line.trim();
  return s.startsWith("|") && s.endsWith("|") && countPipes(s) >= 2;
}

function countPipes(s: string): number {
  let n = 0;
  for (const ch of s) if (ch === "|") n++;
  return n;
}

function isTableSep(line: string): boolean {
  const s = line.trim();
  if (!(s.startsWith("|") && s.endsWith("|"))) return false;
  // 多列表格的分隔行 |---|---| 去掉首尾 | 后仍含列分隔 |，故按列切分逐格校验
  const cells = s.slice(1, -1).split("|");
  if (cells.length === 0) return false;
  for (const cell of cells) {
    const c = cell.trim();
    if (!c || ![...c].every((ch) => ch === "-" || ch === ":" || ch === " ") || !c.includes("-")) {
      return false;
    }
  }
  return true;
}

/** 按行切 unit（每行一个；超长行按 maxChars 硬切）。行级粒度让打包天然尊重表格行/段落/标题边界 */
function buildUnits(md: string, maxChars: number): Unit[] {
  const lines = md.split("\n");
  // split("\n") 丢换行符：行文本补回 \n 还原偏移（末行可能无换行——单独处理）
  const withEnds = lines.map((ln, i) => (i < lines.length - 1 ? `${ln}\n` : ln));
  if (withEnds.length === 0 || (withEnds.length === 1 && withEnds[0] === "")) return [];
  const offsets = lineOffsets(withEnds);
  const units: Unit[] = [];
  for (const [i, ln] of withEnds.entries()) {
    const start = offsets[i];
    const end = offsets[i + 1];
    if (end - start <= maxChars) {
      units.push({ start, end, text: ln });
    } else {
      let s = start;
      while (s < end) {
        const e = Math.min(s + maxChars, end);
        units.push({ start: s, end: e, text: md.slice(s, e) });
        s = e;
      }
    }
  }
  return units;
}

interface RawChunk {
  start: number;
  end: number;
  text: string;
}

/**
 * 贪心把相邻 unit 装进同一块，直到再加下一块会超 max_chars。
 * 反孤岛：当前块过小（< max_chars/4）时，即使略超预算也把下一个 unit 并入，
 * 避免整页压成单行时开头 nav/header 被切成无内容空壳块（issue #86）。
 */
function packUnits(units: Unit[], maxChars: number): RawChunk[] {
  if (units.length === 0) return [];
  const minChunk = Math.max(Math.floor(maxChars / 4), 1);
  const chunks: RawChunk[] = [];
  let curStart = units[0].start;
  let curEnd = units[0].end;
  let curText = units[0].text;
  for (const u of units.slice(1)) {
    const curSize = curEnd - curStart;
    if (curSize + (u.end - u.start) <= maxChars) {
      curEnd = u.end;
      curText += u.text;
    } else if (curSize < minChunk) {
      // 当前块过小（孤岛）→ 并入下一块（允许略超 max_chars）
      curEnd = u.end;
      curText += u.text;
    } else {
      chunks.push({ start: curStart, end: curEnd, text: curText });
      curStart = u.start;
      curEnd = u.end;
      curText = u.text;
    }
  }
  chunks.push({ start: curStart, end: curEnd, text: curText });
  return chunks;
}

/** 返回 text 中最后一个 `| header |\n| --- |\n` 表头对，找不到返回 "" */
function lastTableHeader(text: string): string {
  const lines = text.split("\n").map((ln) => ln.replace(/\r?\n$/, ""));
  let last = "";
  for (let i = 0; i + 1 < lines.length; i++) {
    if (isTableRow(lines[i]) && isTableSep(lines[i + 1])) {
      last = `${lines[i]}\n${lines[i + 1]}\n`;
    }
  }
  return last;
}

/** text 以表格数据行开头、但开头不是「表头 + 分隔行」 */
function startsWithTableRowNoHeader(text: string): boolean {
  const lines = text.split("\n").map((ln) => ln.replace(/\r?\n$/, ""));
  if (lines.length === 0 || !isTableRow(lines[0])) return false;
  if (lines.length >= 2 && isTableSep(lines[1])) return false; // 本身就是表头
  return true;
}

/** 表头延续：块以数据行开头（无表头）时把当前表头合成的其 content 顶部（start 不变） */
function applyTableContinuation(rawChunks: RawChunk[]): MarkdownChunk[] {
  if (rawChunks.length === 0) return [];
  const result: MarkdownChunk[] = [];
  let currentHeader = "";
  for (const { start, end, text } of rawChunks) {
    let content = text;
    const ownHeader = lastTableHeader(text);
    if (ownHeader) currentHeader = ownHeader;
    if (currentHeader && !ownHeader && startsWithTableRowNoHeader(text)) {
      content = currentHeader + content;
    }
    // 块首非表格行 → 表格已结束，清空当前表头
    const firstLines = text.split("\n").map((ln) => ln.replace(/\r?\n$/, ""));
    if (firstLines.length === 0 || !isTableRow(firstLines[0])) {
      currentHeader = "";
    }
    result.push({ content, start, end });
  }
  return result;
}

/**
 * 按结构分块：行级 unit → 贪心打包 → 表头延续。返回 start/end 单调递增、连续、
 * 覆盖全 md 的块；md ≤ max_chars 返回单块；空串返回 []。反孤岛例外下块跨度可略超
 * max_chars（≤ 1.25×）。
 */
export function chunkMarkdownByStructure(md: string, maxChars = 8000): MarkdownChunk[] {
  if (!md) return [];
  const total = md.length;
  if (total <= maxChars) {
    return [{ content: md, start: 0, end: total }];
  }
  const units = buildUnits(md, maxChars);
  const rawChunks = packUnits(units, maxChars);
  return applyTableContinuation(rawChunks);
}
