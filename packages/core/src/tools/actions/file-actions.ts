// 文件三动作：write_file（:2348-2412）/ read_file（:2413-2465 + 嗅探 :114-144 +
// 富文档降级 :2528-2582 + 窗口 :2466-2527）/ replace_file（:2583-2729）。
// 全部经注入 FileSystemProvider；白名单前缀匹配（None=全放行）。
// 偏离（p4b/01 §6）：富文档解析不进核心包（降级文案）；encoding 收窄 utf-8；
// tmp+rename 原子性由宿主 fs 实现（接口无 rename）。

import { pyReprDeep } from "../../agent/py-repr.js";
import { ActionResult } from "../../agent/views.js";
import type { ToolsTruncationSettings } from "../settings.js";
import type { ActionHandler } from "../types.js";
import type { ToolsContext } from "./context.js";

const READ_FILE_FOOTER_RESERVE = 160; // :661
const SNIFF_HEAD = 12;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const utf8Len = (s: string): number => new TextEncoder().encode(s).length;

function whitelistAllows(allowed: string[] | null, path: string): boolean {
  return allowed === null || allowed.some((p) => path.startsWith(p));
}

/** :114-144 magic 头嗅探（head = 前 12 字节；扩展名仅 zip 容器族兜底） */
export function sniffFileKind(
  head: Uint8Array,
  path: string,
): "text" | "pdf" | "docx" | "image" | "binary" {
  const startsWith = (sig: number[]): boolean => sig.every((b, i) => head[i] === b);
  const latin = (offset: number, len: number): string =>
    String.fromCharCode(...Array.from(head.slice(offset, offset + len)));
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image"; // PNG
  if (startsWith([0xff, 0xd8, 0xff])) return "image"; // JPEG
  if (latin(0, 6) === "GIF87a" || latin(0, 6) === "GIF89a") return "image";
  if (latin(0, 4) === "RIFF") {
    return latin(8, 4) === "WEBP" ? "image" : "binary"; // WebP vs AVI/WAV
  }
  if (latin(0, 5) === "%PDF-") return "pdf";
  if (startsWith([0x50, 0x4b, 0x03, 0x04])) {
    // zip 容器：仅 .docx 判 docx，其余（xlsx/pptx/plain zip）不支持
    return path.toLowerCase().endsWith(".docx") ? "docx" : "binary";
  }
  if (latin(0, 4) === "\x7fELF" || latin(0, 2) === "MZ") return "binary"; // 可执行
  if (latin(0, 2) === "\x1f\x8b" || latin(0, 3) === "BZh" || latin(0, 4) === "Rar!") {
    return "binary"; // gzip / bzip2 / rar
  }
  if (latin(0, 6) === "7z\xbc\xaf'\x1c") return "binary"; // 7z
  return "text";
}

/** image 扩展名 → mime（mimetypes.guess_type 最小面；未知给 octet-stream） */
function guessMime(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

/** :2466-2527 窗口分页 + 截断 footer（字符级 offset；footer 预算见 :661 注释） */
export function windowAndEcho(
  content: string,
  path: string,
  params: Record<string, unknown>,
  totalBytes: number,
  tr: ToolsTruncationSettings,
): ActionResult {
  const totalChars = content.length;
  if (content === "") {
    const msg = `${path} is empty (0 bytes)`;
    return new ActionResult({ extractedContent: msg, longTermMemory: msg });
  }
  const offset = typeof params.offset === "number" ? params.offset : 0;
  const limit = typeof params.limit === "number" ? params.limit : null;
  const maxChars = Math.max(
    200,
    Math.min(tr.readFileMaxChars, tr.displayMaxChars) - READ_FILE_FOOTER_RESERVE,
  );
  const window = limit !== null && limit < maxChars ? limit : maxChars;
  if (offset >= totalChars) {
    const msg = `offset ${offset} is at or past end of ${path} (${totalChars} chars); nothing to read`;
    return new ActionResult({ extractedContent: msg, longTermMemory: msg });
  }
  const contentWindow = content.slice(offset, offset + window);
  const shown = contentWindow.length;
  const remaining = totalChars - offset - shown;
  if (remaining > 0) {
    const end = offset + shown;
    const extracted =
      contentWindow +
      `\n[...truncated: showing ${shown} of ${totalChars} chars ` +
      `from offset ${offset} (${totalBytes} bytes total); ` +
      `use offset=${end} to continue]`;
    const memory =
      `Read ${path} (${shown} of ${totalChars} chars from offset ${offset}, ` +
      `${totalBytes} bytes; truncated)`;
    return new ActionResult({ extractedContent: extracted, longTermMemory: memory });
  }
  if (offset > 0) {
    const memory =
      `Read ${path} chars ${offset}-${offset + shown} of ${totalChars} ` +
      `(${totalBytes} bytes; final page)`;
    return new ActionResult({ extractedContent: contentWindow, longTermMemory: memory });
  }
  const memory = `Read ${path} (${totalChars} chars, ${totalBytes} bytes)`;
  return new ActionResult({ extractedContent: contentWindow, longTermMemory: memory });
}

/** :2528-2582 富文档降级（image 提示逐字节；pdf/docx 可操作 error——TS 无 extras 概念） */
async function readRichDocument(
  ctx: ToolsContext,
  path: string,
  kind: "pdf" | "docx" | "image",
): Promise<ActionResult> {
  if (kind === "image") {
    const mime = guessMime(path);
    const stat = ctx.fs !== null ? await ctx.fs.stat(path) : null;
    const nbytes = stat?.size ?? 0;
    const msg =
      `${path} is an image (${mime}, ${nbytes} bytes). read_file cannot inline images ` +
      "yet (vision channel not wired); re-save as text/PDF, or use a vision-capable flow.";
    return new ActionResult({ extractedContent: msg, longTermMemory: msg });
  }
  const what = kind === "pdf" ? "PDF" : "DOCX";
  return new ActionResult({
    error:
      `${path} is a ${what}; text extraction needs a host-injected parser ` +
      "(M5 rich-document hook) — re-save as text, or read via a vision-capable flow",
  });
}

export function createWriteFileHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>) => {
    const path = params.path;
    const content = params.content;
    if (typeof path !== "string") {
      return new ActionResult({ error: "write_file requires a string `path` parameter." });
    }
    if (typeof content !== "string") {
      return new ActionResult({ error: "write_file requires a string `content` parameter." });
    }
    const append = params.append === true;
    const trailingNewline = params.trailing_newline !== false;
    const leadingNewline = params.leading_newline === true;
    const enc =
      typeof params.encoding === "string" && params.encoding !== "" ? params.encoding : "utf-8";
    // 偏离（p4b/01）：TS 侧仅 utf-8（TextEncoder）；Python 任意 codec。已知非 utf-8
    // 在 Python 会成功——此处按可操作 error 拒（宿主 fs 需自行扩展）
    if (enc !== "utf-8") {
      return new ActionResult({
        error: `Unsupported encoding ${pyReprDeep(enc)}: only utf-8 is available in this build`,
      });
    }
    if (!whitelistAllows(ctx.allowedWritePaths, path)) {
      return new ActionResult({ error: `File path not in allowed write paths: ${path}` });
    }
    let body = content;
    if (leadingNewline) body = `\n${body}`;
    if (trailingNewline && !body.endsWith("\n")) body = `${body}\n`;

    if (ctx.fs === null) {
      return new ActionResult({
        error: `Failed to write file ${path}: no filesystem provider injected`,
      });
    }
    try {
      if (append) {
        // append 直写（O(1) 非原子——Python 同款刻意选择）；读旧拼新（接口无 append 模式）
        const existing = (await ctx.fs.isFile(path)) ? await ctx.fs.readTextFile(path) : "";
        await ctx.fs.writeTextFile(path, existing + body);
      } else {
        await ctx.fs.writeTextFile(path, body);
      }
    } catch (e) {
      ctx.log(`write_file(${JSON.stringify(path)}) failed: ${errText(e)}`);
      return new ActionResult({ error: `Failed to write file ${path}: ${errText(e)}` });
    }
    const written = utf8Len(body);
    const actionWord = append ? "Appended" : "Wrote";
    let memory = `${actionWord} ${written} bytes to ${path}`;
    if (enc !== "utf-8") memory += ` (encoding: ${enc})`;
    return new ActionResult({ extractedContent: memory, longTermMemory: memory });
  };
}

export function createReadFileHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>) => {
    const path = params.path;
    if (typeof path !== "string") {
      return new ActionResult({ error: "read_file requires a string `path` parameter." });
    }
    if (!whitelistAllows(ctx.allowedReadPaths, path)) {
      return new ActionResult({ error: `File path not in allowed read paths: ${path}` });
    }
    if (ctx.fs === null) {
      return new ActionResult({
        error: `Failed to read file ${path}: no filesystem provider injected`,
      });
    }
    // 嗅探（magic 头优先 12 字节）：isFile 先行区分 not found 与读失败
    let head: Uint8Array | null;
    if (!(await ctx.fs.isFile(path))) {
      return new ActionResult({ error: `File not found: ${path}` });
    }
    try {
      head = await ctx.fs.readHead(path, SNIFF_HEAD);
    } catch (e) {
      ctx.log(`read_file(${JSON.stringify(path)}) sniff failed: ${errText(e)}`);
      return new ActionResult({ error: `Failed to read file ${path}: ${errText(e)}` });
    }
    if (head === null) {
      return new ActionResult({ error: `Failed to read file ${path}: read head returned nothing` });
    }
    const kind = sniffFileKind(head, path);
    if (kind === "binary") {
      return new ActionResult({
        error:
          `${path} looks like a binary file; read_file reads UTF-8 text, ` +
          "PDF, DOCX, or images (PNG/JPEG/GIF/WebP).",
      });
    }
    if (kind === "pdf" || kind === "docx" || kind === "image") {
      return readRichDocument(ctx, path, kind);
    }
    let content: string;
    try {
      content = await ctx.fs.readTextFile(path);
    } catch (e) {
      ctx.log(`read_file(${JSON.stringify(path)}) failed: ${errText(e)}`);
      return new ActionResult({ error: `Failed to read file ${path}: ${errText(e)}` });
    }
    return windowAndEcho(content, path, params, utf8Len(content), ctx.truncation);
  };
}

/** re.escape 等价（literal 在 regex/case-insensitive 模式下当字面量） */
function escapeRegExp(s: string): string {
  return s.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
}

/**
 * Python re 替换模板 → JS 替换模板：先转义 $（字面量化），再转换 \g<name>/\1 形态
 * 反向引用（模型按 Python 约定写 \1——JS String.replace 需要 $1）。非法 \g 形态
 * Python 会在 subn 抛 re.error，此处保持字面量（登记漂移）。
 */
function pythonReplToJs(repl: string): string {
  return repl
    .replace(/\$/g, "$$$$")
    .replace(/\\g<(\w+)>/g, "$<$1>")
    .replace(/\\(\d+)/g, "$$$1");
}

export function createReplaceFileHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>) => {
    const path = params.path;
    const oldStr = params.old;
    const newStr = params.new;
    if (typeof path !== "string") {
      return new ActionResult({ error: "replace_file requires a string `path` parameter." });
    }
    if (typeof oldStr !== "string" || typeof newStr !== "string") {
      return new ActionResult({
        error: "replace_file requires string `old` and `new` parameters.",
      });
    }
    if (oldStr === "") {
      return new ActionResult({ error: "replace_file 'old' must be a non-empty string" });
    }
    const count = params.count;
    if (
      count !== undefined &&
      count !== null &&
      (typeof count !== "number" ||
        !Number.isInteger(count) ||
        typeof count === "boolean" ||
        count < 1)
    ) {
      return new ActionResult({
        error: `replace_file 'count' must be a positive integer (got ${pyReprDeep(count)})`,
      });
    }
    const expectedCount = params.expected_count;
    if (
      expectedCount !== undefined &&
      expectedCount !== null &&
      (typeof expectedCount !== "number" ||
        !Number.isInteger(expectedCount) ||
        typeof expectedCount === "boolean" ||
        expectedCount < 0)
    ) {
      return new ActionResult({
        error: `replace_file 'expected_count' must be a non-negative integer (got ${pyReprDeep(expectedCount)})`,
      });
    }
    const regex = params.regex === true;
    const caseSensitive = params.case_sensitive !== false; // 默认 True
    const backup = params.backup === true;

    if (!whitelistAllows(ctx.allowedWritePaths, path)) {
      return new ActionResult({ error: `File path not in allowed write paths: ${path}` });
    }
    if (ctx.fs === null) {
      return new ActionResult({
        error: `Failed to replace text in ${path}: no filesystem provider injected`,
      });
    }
    const useRe = regex || !caseSensitive;
    // 正则：global + 按大小写；literal 在 case-insensitive 下也按字面量替换（不展开 \1）
    let pattern: RegExp | undefined;
    if (useRe) {
      const source = regex ? oldStr : escapeRegExp(oldStr);
      try {
        pattern = new RegExp(source, caseSensitive ? "g" : "gi");
      } catch (e) {
        ctx.log(
          `replace_file(${JSON.stringify(path)}) invalid regex ${JSON.stringify(oldStr)}: ${errText(e)}`,
        );
        return new ActionResult({
          error: `Invalid regex pattern ${pyReprDeep(oldStr)}: ${errText(e)}`,
        });
      }
    }

    let content: string;
    try {
      if (!(await ctx.fs.isFile(path))) {
        return new ActionResult({ error: `File not found: ${path}` });
      }
      content = await ctx.fs.readTextFile(path);
    } catch (e) {
      ctx.log(`replace_file(${JSON.stringify(path)}) failed: ${errText(e)}`);
      return new ActionResult({ error: `Failed to replace text in ${path}: ${errText(e)}` });
    }

    let rawTotal: number;
    if (pattern !== undefined) {
      const matches = content.match(pattern);
      rawTotal = matches === null ? 0 : matches.length;
    } else {
      rawTotal = content.split(oldStr).length - 1;
    }

    if (expectedCount !== undefined && expectedCount !== null && rawTotal !== expectedCount) {
      const msg =
        `replace_file expected ${expectedCount} match(es) for ${pyReprDeep(oldStr)} in ${path}, ` +
        `found ${rawTotal}; file unchanged`;
      return new ActionResult({ error: msg });
    }
    if (rawTotal === 0) {
      // 软失败：不写、成功语义（绝不假装改了）
      const msg = `No occurrences of ${pyReprDeep(oldStr)} found in ${path}; file unchanged`;
      return new ActionResult({ extractedContent: msg, longTermMemory: msg });
    }
    const bak = `${path}.bak`;
    if (backup) {
      try {
        await ctx.fs.writeTextFile(bak, content);
      } catch (e) {
        ctx.log(`replace_file(${JSON.stringify(path)}) backup failed: ${errText(e)}`);
        return new ActionResult({ error: `Failed to create backup ${bak}: ${errText(e)}` });
      }
    }

    let newContent: string;
    let replaced: number;
    if (pattern !== undefined) {
      // regex=true：new 按 Python 替换模板语义（\1 反向引用，pythonReplToJs 转 $1）；
      // 否则 new 是不透明字面量（$ 转义字面化）。注意：替换必须用**字符串形态**
      // 传给 replace——replacer 函数返回值不做 $ 替换（JS 规范），$n 会变字面文本
      const replacement = regex ? pythonReplToJs(newStr) : newStr.replace(/\$/g, "$$$$");
      if (count === undefined || count === null) {
        newContent = content.replace(pattern, replacement);
        replaced = rawTotal;
      } else {
        const single = new RegExp(pattern.source, pattern.flags.replace("g", ""));
        let cur = content;
        let next = cur.replace(single, replacement);
        let done = 0;
        while (done < count && next !== cur) {
          cur = next;
          done += 1;
          next = cur.replace(single, replacement);
        }
        newContent = cur;
        replaced = Math.min(count, rawTotal);
      }
    } else if (count === undefined || count === null) {
      newContent = content.split(oldStr).join(newStr);
      replaced = rawTotal;
    } else {
      newContent = content;
      let done = 0;
      while (done < count) {
        const idx = newContent.indexOf(oldStr);
        if (idx < 0) break;
        newContent = newContent.slice(0, idx) + newStr + newContent.slice(idx + oldStr.length);
        done += 1;
      }
      replaced = Math.min(count, rawTotal);
    }
    try {
      await ctx.fs.writeTextFile(path, newContent);
    } catch (e) {
      ctx.log(`replace_file(${JSON.stringify(path)}) failed: ${errText(e)}`);
      return new ActionResult({ error: `Failed to replace text in ${path}: ${errText(e)}` });
    }

    const finalBytes = utf8Len(newContent);
    const matchClause =
      count !== undefined && count !== null && replaced < rawTotal
        ? `${replaced} of ${rawTotal} occurrence${rawTotal !== 1 ? "s" : ""}`
        : `${replaced} occurrence${replaced !== 1 ? "s" : ""}`;
    const memory =
      `Replaced ${matchClause} of ${pyReprDeep(oldStr)} with ${pyReprDeep(newStr)} ` +
      `in ${path} (${finalBytes} bytes)`;
    return new ActionResult({ extractedContent: memory, longTermMemory: memory });
  };
}
