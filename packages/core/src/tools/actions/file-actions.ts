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
    // 白名单比对前归一化（fs.resolve：.. 与分隔符归一）。Python 侧是裸 startswith
    // （actions.py :2361），../ 穿越形态在 Python 会静默写出白名单外；此处收严为
    // 拒绝（评审轮 1 [6]，已登记偏离）
    const p = ctx.fs !== null ? ctx.fs.resolve(path) : path;
    if (!whitelistAllows(ctx.allowedWritePaths, p)) {
      return new ActionResult({ error: `File path not in allowed write paths: ${p}` });
    }
    let body = content;
    if (leadingNewline) body = `\n${body}`;
    if (trailingNewline && !body.endsWith("\n")) body = `${body}\n`;

    if (ctx.fs === null) {
      return new ActionResult({
        error: `Failed to write file ${p}: no filesystem provider injected`,
      });
    }
    try {
      if (append) {
        // Python open(path,"a")：O(1) 非原子（刻意选择）；不读不重写既有内容——
        // 既有二进制/非 utf-8 字节零接触（评审轮 1 [7]：读旧拼新会腐蚀既有字节）
        await ctx.fs.appendTextFile(p, body);
      } else {
        await ctx.fs.writeTextFile(p, body);
      }
    } catch (e) {
      ctx.log(`write_file(${JSON.stringify(p)}) failed: ${errText(e)}`);
      return new ActionResult({ error: `Failed to write file ${p}: ${errText(e)}` });
    }
    const written = utf8Len(body);
    const actionWord = append ? "Appended" : "Wrote";
    const memory = `${actionWord} ${written} bytes to ${p}`;
    return new ActionResult({ extractedContent: memory, longTermMemory: memory });
  };
}

export function createReadFileHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>) => {
    const path = params.path;
    if (typeof path !== "string") {
      return new ActionResult({ error: "read_file requires a string `path` parameter." });
    }
    // 白名单比对前归一化（同 write_file；Python :2417 是裸 startswith，此处收严）
    const p = ctx.fs !== null ? ctx.fs.resolve(path) : path;
    if (!whitelistAllows(ctx.allowedReadPaths, p)) {
      return new ActionResult({ error: `File path not in allowed read paths: ${p}` });
    }
    if (ctx.fs === null) {
      return new ActionResult({
        error: `Failed to read file ${p}: no filesystem provider injected`,
      });
    }
    // 嗅探（magic 头优先 12 字节）：isFile 先行区分 not found 与读失败
    let head: Uint8Array | null;
    if (!(await ctx.fs.isFile(p))) {
      return new ActionResult({ error: `File not found: ${p}` });
    }
    try {
      head = await ctx.fs.readHead(p, SNIFF_HEAD);
    } catch (e) {
      ctx.log(`read_file(${JSON.stringify(p)}) sniff failed: ${errText(e)}`);
      return new ActionResult({ error: `Failed to read file ${p}: ${errText(e)}` });
    }
    if (head === null) {
      return new ActionResult({ error: `Failed to read file ${p}: read head returned nothing` });
    }
    const kind = sniffFileKind(head, p);
    if (kind === "binary") {
      return new ActionResult({
        error:
          `${p} looks like a binary file; read_file reads UTF-8 text, ` +
          "PDF, DOCX, or images (PNG/JPEG/GIF/WebP).",
      });
    }
    if (kind === "pdf" || kind === "docx" || kind === "image") {
      return readRichDocument(ctx, p, kind);
    }
    let content: string;
    try {
      content = await ctx.fs.readTextFile(p);
    } catch (e) {
      ctx.log(`read_file(${JSON.stringify(p)}) failed: ${errText(e)}`);
      return new ActionResult({ error: `Failed to read file ${p}: ${errText(e)}` });
    }
    return windowAndEcho(content, p, params, utf8Len(content), ctx.truncation);
  };
}

/** re.escape 等价（literal 在 regex/case-insensitive 模式下当字面量） */
function escapeRegExp(s: string): string {
  return s.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
}

/**
 * CPython 3.12 re._parser.parse_template 等价（语义与错误文案经 venv 实跑锚定）：
 * \g<name>/<num> 与 \1..\99 组引用（\0 起头是八进制字面量非组 0；三位八进制如
 * \123 也是字面量）；\a\b\f\n\r\t\v 控制字符；\\ 单反斜杠；其余 ASCII 字母 =
 * re.error bad escape；非字母保留字面反斜杠。产出 JS 替换模板（字面 $ 转义、
 * 组引用 → $&/$n/$<name>）。错误位置口径（绝对下标，b=反斜杠位）：组引用越界
 * =数字起始位；bad escape/八进制越界/尾部孤立反斜杠=b；missing <=g 后位；
 * 名字类（missing >/missing group name/bad character）=名字起始位。
 * 未知组名是 IndexError（Python 落 Tools.execute 通用 catch，error=str(e) 原样）。
 */
export class PythonTemplateError extends Error {
  constructor(
    message: string,
    readonly kind: "reerror" | "indexerror",
  ) {
    super(message);
  }
}

const TEMPLATE_CONTROL: Record<string, string> = {
  a: "\x07",
  b: "\x08",
  f: "\x0c",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\x0b",
  "\\": "\\", // CPython ESCAPES['\\\\'] = chr(0x5c)：转义反斜杠折叠为单个
};
const OCTDIGITS = "01234567";
const MAXGROUPS = 0xffffffff; // re._constants.MAXGROUPS（\g<数字> 上界）

/** 数 JS 正则源的捕获组（Python pattern.groups 等价）：未转义 "("（含字符类穿越），
 *  (?:/(?=/!? 除外；命名组 (?<name> 同时收集名（\g<name> 引用校验用） */
function scanGroups(source: string): { count: number; names: ReadonlySet<string> } {
  let count = 0;
  const names = new Set<string>();
  let escaped = false;
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch !== "(") continue;
    if (source[i + 1] !== "?") {
      count += 1;
    } else if (source[i + 2] === "<" && source[i + 3] !== "=" && source[i + 3] !== "!") {
      count += 1;
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(i + 3));
      if (m !== null) names.add(m[0]);
    }
  }
  return { count, names };
}

export function pythonTemplateToJs(
  repl: string,
  groups: { count: number; names: ReadonlySet<string> },
): string {
  const out: string[] = [];
  const literal = (s: string): void => {
    // 字面 $ 转 $$（JS 替换串语义；"$$$$" 经引擎解析为 "$$"）
    if (s !== "") out.push(s.replace(/\$/g, "$$$$"));
  };
  const groupRef = (index: number, digitStart: number): void => {
    if (index > groups.count) {
      throw new PythonTemplateError(
        `invalid group reference ${index} at position ${digitStart}`,
        "reerror",
      );
    }
    out.push(index === 0 ? "$&" : `$${index}`);
  };
  let i = 0;
  const n = repl.length;
  while (i < n) {
    const c = repl[i];
    if (c !== "\\") {
      literal(c);
      i += 1;
      continue;
    }
    const b = i; // 反斜杠位（错误位置基准）
    if (i === n - 1) {
      throw new PythonTemplateError(`bad escape (end of pattern) at position ${b}`, "reerror");
    }
    const d = repl[i + 1];
    if (d === "g") {
      if (repl[i + 2] !== "<") {
        throw new PythonTemplateError(`missing < at position ${b + 2}`, "reerror");
      }
      const gt = repl.indexOf(">", i + 3);
      if (gt < 0) {
        throw new PythonTemplateError(
          `missing >, unterminated name at position ${b + 3}`,
          "reerror",
        );
      }
      const name = repl.slice(i + 3, gt);
      if (name === "") {
        throw new PythonTemplateError(`missing group name at position ${b + 3}`, "reerror");
      }
      if (/^[0-9]+$/.test(name)) {
        const index = Number(name);
        if (index >= MAXGROUPS) {
          throw new PythonTemplateError(
            `invalid group reference ${index} at position ${b + 3}`,
            "reerror",
          );
        }
        groupRef(index, b + 3);
      } else {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          throw new PythonTemplateError(
            `bad character in group name '${name}' at position ${b + 3}`,
            "reerror",
          );
        }
        if (!groups.names.has(name)) {
          throw new PythonTemplateError(`unknown group name '${name}'`, "indexerror");
        }
        out.push(`$<${name}>`);
      }
      i = gt + 1;
      continue;
    }
    if (d === "0") {
      // \0 + 至多两个八进制位 → 字面字符（\0 是 NUL，不是组 0 引用）
      let val = 0;
      let j = i + 1; // 从 '0' 自身起计入（对 val 无贡献）
      while (j < n && j - i <= 3 && OCTDIGITS.includes(repl[j])) {
        val = val * 8 + Number(repl[j]);
        j += 1;
      }
      literal(String.fromCharCode(val & 0xff));
      i = j;
      continue;
    }
    if (d >= "1" && d <= "9") {
      // 多位数字：三连八进制（如 \123）是字面字符，否则是组引用（\10=组 10）
      let digits = d;
      let j = i + 2; // d 在 i+1，第二位从 i+2 起
      if (j < n && repl[j] >= "0" && repl[j] <= "9") {
        digits += repl[j];
        j += 1;
        if (
          OCTDIGITS.includes(digits[0]) &&
          OCTDIGITS.includes(digits[1]) &&
          j < n &&
          OCTDIGITS.includes(repl[j])
        ) {
          digits += repl[j];
          j += 1;
          const val = Number.parseInt(digits, 8);
          if (val > 0o377) {
            throw new PythonTemplateError(
              `octal escape value \\${digits} outside of range 0-0o377 at position ${b}`,
              "reerror",
            );
          }
          literal(String.fromCharCode(val));
          i = j;
          continue;
        }
      }
      groupRef(Number(digits), b + 1);
      i = j;
      continue;
    }
    if (TEMPLATE_CONTROL[d] !== undefined) {
      literal(TEMPLATE_CONTROL[d]);
      i += 2;
      continue;
    }
    if (/^[A-Za-z]$/.test(d)) {
      throw new PythonTemplateError(`bad escape \\${d} at position ${b}`, "reerror");
    }
    // 非字母（\- \$ 等）：保留字面反斜杠
    literal(`\\${d}`);
    i += 2;
  }
  return out.join("");
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

    // 白名单比对前归一化（同 write_file；Python :2611 是裸 startswith，此处收严）
    const p = ctx.fs !== null ? ctx.fs.resolve(path) : path;
    if (!whitelistAllows(ctx.allowedWritePaths, p)) {
      return new ActionResult({ error: `File path not in allowed write paths: ${p}` });
    }
    if (ctx.fs === null) {
      return new ActionResult({
        error: `Failed to replace text in ${p}: no filesystem provider injected`,
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
          `replace_file(${JSON.stringify(p)}) invalid regex ${JSON.stringify(oldStr)}: ${errText(e)}`,
        );
        return new ActionResult({
          error: `Invalid regex pattern ${pyReprDeep(oldStr)}: ${errText(e)}`,
        });
      }
    }

    let content: string;
    try {
      if (!(await ctx.fs.isFile(p))) {
        return new ActionResult({ error: `File not found: ${p}` });
      }
      content = await ctx.fs.readTextFile(p);
    } catch (e) {
      ctx.log(`replace_file(${JSON.stringify(p)}) failed: ${errText(e)}`);
      return new ActionResult({ error: `Failed to replace text in ${p}: ${errText(e)}` });
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
        `replace_file expected ${expectedCount} match(es) for ${pyReprDeep(oldStr)} in ${p}, ` +
        `found ${rawTotal}; file unchanged`;
      return new ActionResult({ error: msg });
    }
    if (rawTotal === 0) {
      // 软失败：不写、成功语义（绝不假装改了）
      const msg = `No occurrences of ${pyReprDeep(oldStr)} found in ${p}; file unchanged`;
      return new ActionResult({ extractedContent: msg, longTermMemory: msg });
    }
    const bak = `${p}.bak`;
    if (backup) {
      try {
        await ctx.fs.writeTextFile(bak, content);
      } catch (e) {
        ctx.log(`replace_file(${JSON.stringify(p)}) backup failed: ${errText(e)}`);
        return new ActionResult({ error: `Failed to create backup ${bak}: ${errText(e)}` });
      }
    }

    let newContent: string;
    let replaced: number;
    if (pattern !== undefined) {
      // regex=true：new 按 Python 替换模板语义（re._parser.parse_template 等价转换，
      // 越界/未定义引用与非法转义在此抛错——Python 同序：backup 之后、subn 处，
      // .bak 已生成、文件不动）；否则（大小写不敏感 literal）new 是不透明字面量
      // （$ 转义字面化）。替换必须用**字符串形态**传 replace——replacer 函数
      // 返回值不做 $ 替换（JS 规范），$n 会变字面文本
      let replacement: string;
      try {
        replacement = regex
          ? pythonTemplateToJs(newStr, scanGroups(pattern.source))
          : newStr.replace(/\$/g, "$$$$");
      } catch (e) {
        if (e instanceof PythonTemplateError) {
          ctx.log(`replace_file(${JSON.stringify(p)}) substitution failed: ${e.message}`);
          return new ActionResult({
            error:
              e.kind === "reerror"
                ? `Regex substitution failed for ${pyReprDeep(oldStr)}: ${e.message}`
                : e.message,
          });
        }
        throw e;
      }
      if (count === undefined || count === null) {
        newContent = content.replace(pattern, replacement);
        replaced = rawTotal;
      } else {
        // 单遍在原文上取前 count 个匹配后拼接，绝不重扫替换产物（Python subn 的
        // count 语义——new ⊇ old 时重扫会漏改原文且 replaced 虚报，评审轮 1 [8]）。
        // 每段用字符串形态替换让引擎展开 $ 模板
        const single = new RegExp(pattern.source, pattern.flags.replace("g", ""));
        let out = "";
        let rest = content;
        let done = 0;
        while (done < count) {
          const m = single.exec(rest);
          if (m === null) break;
          out += rest.slice(0, m.index + m[0].length).replace(single, replacement);
          if (m[0] === "") {
            // 零宽匹配：吃一个后续字符前进防原地打转；串尾零宽替换一次即停
            if (m.index >= rest.length) break;
            out += rest.slice(m.index, m.index + 1);
            rest = rest.slice(m.index + 1);
          } else {
            rest = rest.slice(m.index + m[0].length);
          }
          done += 1;
        }
        newContent = out + rest;
        replaced = done;
      }
    } else if (count === undefined || count === null) {
      newContent = content.split(oldStr).join(newStr);
      replaced = rawTotal;
    } else {
      // literal count：同样只扫原文（indexOf 推进，不重扫替换产物）
      let out = "";
      let rest = content;
      let done = 0;
      while (done < count) {
        const idx = rest.indexOf(oldStr);
        if (idx < 0) break;
        out += rest.slice(0, idx) + newStr;
        rest = rest.slice(idx + oldStr.length);
        done += 1;
      }
      newContent = out + rest;
      replaced = done;
    }
    try {
      await ctx.fs.writeTextFile(p, newContent);
    } catch (e) {
      ctx.log(`replace_file(${JSON.stringify(p)}) failed: ${errText(e)}`);
      return new ActionResult({ error: `Failed to replace text in ${p}: ${errText(e)}` });
    }

    const finalBytes = utf8Len(newContent);
    const matchClause =
      count !== undefined && count !== null && replaced < rawTotal
        ? `${replaced} of ${rawTotal} occurrence${rawTotal !== 1 ? "s" : ""}`
        : `${replaced} occurrence${replaced !== 1 ? "s" : ""}`;
    const memory =
      `Replaced ${matchClause} of ${pyReprDeep(oldStr)} with ${pyReprDeep(newStr)} ` +
      `in ${p} (${finalBytes} bytes)`;
    return new ActionResult({ extractedContent: memory, longTermMemory: memory });
  };
}
