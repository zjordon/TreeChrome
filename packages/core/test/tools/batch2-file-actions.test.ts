// 文件三动作 handler 锚定（batch2.json fileActions——venv 实跑 Python handler 的
// 全输出：路径已稳定化为 /ANCHOR_TMP 占位）。TS 侧用内存 fs 复现同一输入形态，
// 期望值按占位替换后逐字节比对；已知偏离（encoding 收窄/pdf-docx 降级文案）按
// 各自断言面处理。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ActionResult } from "../../src/agent/views.js";
import type { Tools } from "../../src/tools/actions/index.js";
import { makeTools } from "./fake-browser.js";
import { type FakeFs, makeFakeFs } from "./fake-fs.js";

const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/python-anchors/batch2.json", import.meta.url)),
    "utf8",
  ),
  // biome-ignore lint/suspicious/noExplicitAny: fixture 是外部 JSON 的弱形态读取面
) as Record<string, any>;
const FA = FIXTURE.fileActions;

const T = "/ANCHOR_TMP";
const enc = (s: string) => new TextEncoder().encode(s);

/** ActionResult → fixture 形态（error null 化 + 字符串化） */
function shape(r: ActionResult): Record<string, unknown> {
  const out: Record<string, unknown> = {
    extracted_content: r.extractedContent,
    long_term_memory: r.longTermMemory,
    error: r.error,
  };
  if (r.metadata) out.metadata = r.metadata;
  return out;
}

async function execFile(
  tools: Tools,
  fs: FakeFs,
  action: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  tools.ctx.fs = fs;
  const r = await tools.execute(action, params, undefined as never);
  return shape(r);
}

/** 按键挑三个输出面比对（metadata 键集不含 query_total 的文件族恒等） */
function expectMatch(actual: Record<string, unknown>, expected: Record<string, unknown>) {
  for (const key of ["extracted_content", "long_term_memory", "error"] as const) {
    expect(actual[key]).toBe(expected[key]);
  }
}

describe("write_file", () => {
  it("overwrite + append + newline 簿记（逐字节）", async () => {
    const { tools } = makeTools();
    const fs = makeFakeFs();
    const w1 = `${T}/w1.txt`;
    expectMatch(
      await execFile(tools, fs, "write_file", { path: w1, content: "line1\nline2" }),
      FA.writeOverwrite,
    );
    expect(fs.files.get(w1)).toBe(FA.writeOverwriteFile);
    expectMatch(
      await execFile(tools, fs, "write_file", { path: w1, content: "line3", append: true }),
      FA.writeAppend,
    );
    expect(fs.files.get(w1)).toBe(FA.writeAppendFile);
    expectMatch(
      await execFile(tools, fs, "write_file", {
        path: w1,
        content: "x",
        trailing_newline: false,
        leading_newline: true,
      }),
      FA.writeNoTrailing,
    );
    expect(fs.files.get(w1)).toBe(FA.writeNoTrailingFile);
  });
  it("未知编码可操作 error（偏离：TS 仅 utf-8——文案形态不同，Python 为 LookupError 文案）", async () => {
    const { tools } = makeTools();
    const r = await execFile(tools, makeFakeFs(), "write_file", {
      path: `${T}/w2.txt`,
      content: "x",
      encoding: "no-such-codec",
    });
    expect(r.error).toContain("Unsupported encoding 'no-such-codec'");
    expect(r.extracted_content).toBeNull();
  });
  it("白名单拒（前缀匹配；None=全放行）", async () => {
    const { tools } = makeTools({ allowedWritePaths: [`${T}/ok`] });
    const r = await execFile(tools, makeFakeFs(), "write_file", {
      path: `${T}/elsewhere.txt`,
      content: "x",
    });
    expectMatch(r, FA.writeWhitelistReject);
  });
  it("fs 未注入 → error", async () => {
    const { tools } = makeTools();
    const r = await tools.execute(
      "write_file",
      { path: `${T}/x`, content: "y" },
      undefined as never,
    );
    expect(r.error).toContain("no filesystem provider injected");
  });
});

describe("read_file", () => {
  it("文本窗口/footer/offset 尾页/越界/空文件（逐字节）", async () => {
    const { tools } = makeTools();
    const fs = makeFakeFs({ [`${T}/r.txt`]: "A".repeat(6000), [`${T}/empty.txt`]: "" });
    expectMatch(await execFile(tools, fs, "read_file", { path: `${T}/r.txt` }), FA.readWindow);
    expectMatch(
      await execFile(tools, fs, "read_file", { path: `${T}/r.txt`, offset: 5990 }),
      FA.readOffsetTail,
    );
    expectMatch(
      await execFile(tools, fs, "read_file", { path: `${T}/r.txt`, offset: 9999 }),
      FA.readOffsetPastEnd,
    );
    expectMatch(await execFile(tools, fs, "read_file", { path: `${T}/empty.txt` }), FA.readEmpty);
    expectMatch(
      await execFile(tools, fs, "read_file", { path: `${T}/r.txt`, offset: 10, limit: 5 }),
      FA.readLimit,
    );
  });
  it("PE 头二进制拒（逐字节）", async () => {
    const { tools } = makeTools();
    const fs = makeFakeFs({
      [`${T}/r.bin`]: new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0, 0, 0, 4]),
    });
    expectMatch(
      await execFile(tools, fs, "read_file", { path: `${T}/r.bin` }),
      FA.readBinaryReject,
    );
  });
  it("image 提示逐字节（mime+字节量；stat 经内存 fs）", async () => {
    const { tools } = makeTools();
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const fs = makeFakeFs({ [`${T}/r.png`]: png });
    expectMatch(await execFile(tools, fs, "read_file", { path: `${T}/r.png` }), FA.readImageHint);
  });
  it("pdf 降级（偏离文案：TS 无 extras 概念，指向 M5 hook；Python 文案见 fixture 留档）", async () => {
    const { tools } = makeTools();
    const fs = makeFakeFs({ [`${T}/r.pdf`]: new Uint8Array(enc("%PDF-1.4\n%%EOF")) });
    const r = await execFile(tools, fs, "read_file", { path: `${T}/r.pdf` });
    expect(r.error).toContain("is a PDF");
    expect(r.error).toContain("host-injected parser");
    expect(FA.readPdfNoParser.error).toContain("install the 'docs' extra"); // Python 形态留档对照
  });
  it("File not found / 读白名单拒", async () => {
    const { tools } = makeTools();
    const fs = makeFakeFs({ [`${T}/r.txt`]: "hi" });
    const miss = await execFile(tools, fs, "read_file", { path: `${T}/ghost.txt` });
    expect(miss.error).toBe(`File not found: ${T}/ghost.txt`);
    const { tools: tools2 } = makeTools({ allowedReadPaths: [`${T}/ok`] });
    expectMatch(
      await execFile(tools2, fs, "read_file", { path: `${T}/r.txt` }),
      FA.readWhitelistReject,
    );
  });
});

describe("replace_file", () => {
  const base = () => makeFakeFs({ [`${T}/rep.txt`]: "foo bar foo BAR\n" });
  it("literal 逐字节（含落盘内容）", async () => {
    const { tools } = makeTools();
    const fs = base();
    expectMatch(
      await execFile(tools, fs, "replace_file", { path: `${T}/rep.txt`, old: "foo", new: "BAZ" }),
      FA.replaceLiteral,
    );
    expect(fs.files.get(`${T}/rep.txt`)).toBe(FA.replaceLiteralFile);
  });
  it("大小写不敏感（literal 不展开引用）逐字节", async () => {
    const { tools } = makeTools();
    const fs = makeFakeFs({ [`${T}/rep.txt`]: "foo bar foo BAR\n" });
    expectMatch(
      await execFile(tools, fs, "replace_file", {
        path: `${T}/rep.txt`,
        old: "foo",
        new: "x",
        case_sensitive: false,
      }),
      FA.replaceCaseInsensitive,
    );
    expect(fs.files.get(`${T}/rep.txt`)).toBe(FA.replaceCaseInsensitiveFile);
  });
  it("count 限量逐字节（of N 文案 + 落盘）", async () => {
    const { tools } = makeTools();
    const fs = makeFakeFs({ [`${T}/rep.txt`]: "aa bb aa bb aa\n" });
    expectMatch(
      await execFile(tools, fs, "replace_file", {
        path: `${T}/rep.txt`,
        old: "aa",
        new: "z",
        count: 2,
      }),
      FA.replaceCount,
    );
    expect(fs.files.get(`${T}/rep.txt`)).toBe(FA.replaceCountFile);
  });
  it("expected_count 失配（文件不动）/ 软失败 0 次 / old 空 / 非法 regex", async () => {
    const { tools } = makeTools();
    // 镜像生成器时序：count 用例先跑（aa×3 → z×2 + aa×1），失配断言跑在改后内容上
    const fs = makeFakeFs({ [`${T}/rep.txt`]: "z bb z bb aa\n" });
    expectMatch(
      await execFile(tools, fs, "replace_file", {
        path: `${T}/rep.txt`,
        old: "aa",
        new: "z",
        expected_count: 99,
      }),
      FA.replaceExpectedMismatch,
    );
    expect(fs.files.get(`${T}/rep.txt`)).toBe("z bb z bb aa\n"); // 文件不动
    expectMatch(
      await execFile(tools, fs, "replace_file", { path: `${T}/rep.txt`, old: "nope", new: "z" }),
      FA.replaceSoftMiss,
    );
    expectMatch(
      await execFile(tools, fs, "replace_file", { path: `${T}/rep.txt`, old: "", new: "z" }),
      FA.replaceOldEmpty,
    );
    // 正则引擎错误文案差异（re.error vs V8）：前缀逐字节，引擎细节按包含断言
    const invalidRegex = await execFile(tools, fs, "replace_file", {
      path: `${T}/rep.txt`,
      old: "([unclosed",
      new: "z",
      regex: true,
    });
    expect(invalidRegex.error).toMatch(
      /^Invalid regex pattern '\(\[unclosed': .*Unterminated character/s,
    );
  });
  it("regex 反向引用逐字节（\\1 → TS $1 转换后内容一致）", async () => {
    const { tools } = makeTools();
    const fs = makeFakeFs({ [`${T}/rep.txt`]: "v1 v2 v3\n" });
    expectMatch(
      await execFile(tools, fs, "replace_file", {
        path: `${T}/rep.txt`,
        old: "v(\\d)",
        new: "w\\1",
        regex: true,
      }),
      FA.replaceRegex,
    );
    expect(fs.files.get(`${T}/rep.txt`)).toBe(FA.replaceRegexFile);
    // case-insensitive 下 new 是字面量（\1 不展开）——Python _literal_replacer 同款
    expectMatch(
      await execFile(tools, fs, "replace_file", {
        path: `${T}/rep.txt`,
        old: "w1",
        new: "\\1",
        case_sensitive: false,
      }),
      FA.replaceRegexLiteralNew,
    );
    expect(fs.files.get(`${T}/rep.txt`)).toBe(FA.replaceRegexLiteralNewFile);
  });
  it("backup 逐字节（.bak 原内容）+ not found", async () => {
    const { tools } = makeTools();
    const fs = makeFakeFs({ [`${T}/rep2.txt`]: "keep me\n" });
    expectMatch(
      await execFile(tools, fs, "replace_file", {
        path: `${T}/rep2.txt`,
        old: "keep",
        new: "held",
        backup: true,
      }),
      FA.replaceBackup,
    );
    expect(fs.files.get(`${T}/rep2.txt.bak`)).toBe(FA.replaceBackupFile);
    expectMatch(
      await execFile(tools, fs, "replace_file", { path: `${T}/ghost.txt`, old: "a", new: "b" }),
      FA.replaceNotFound,
    );
  });
  it("count 守卫：bool/浮点拒（pyRepr 形态）", async () => {
    const { tools } = makeTools();
    const fs = base();
    const r = await execFile(tools, fs, "replace_file", {
      path: `${T}/rep.txt`,
      old: "foo",
      new: "x",
      count: true as never,
    });
    expect(r.error).toBe("replace_file 'count' must be a positive integer (got True)");
  });
  it("写白名单拒", async () => {
    const { tools } = makeTools({ allowedWritePaths: [`${T}/ok`] });
    const r = await execFile(tools, base(), "replace_file", {
      path: `${T}/rep.txt`,
      old: "a",
      new: "b",
    });
    expect(r.error).toBe(`File path not in allowed write paths: ${T}/rep.txt`);
  });
  it("regex + count 限量（非全局逐次替换保 $n 语义）+ 写失败 error", async () => {
    const { tools } = makeTools();
    const fs = makeFakeFs({ [`${T}/rep.txt`]: "v1 v2 v3 v4\n" });
    const r = await execFile(tools, fs, "replace_file", {
      path: `${T}/rep.txt`,
      old: "v(\\d)",
      new: "w\\1",
      regex: true,
      count: 2,
    });
    expect(r.extracted_content).toBe(
      "Replaced 2 of 4 occurrences of 'v(\\\\d)' with 'w\\\\1' in /ANCHOR_TMP/rep.txt (12 bytes)",
    );
    expect(fs.files.get(`${T}/rep.txt`)).toBe("w1 w2 v3 v4\n");
    // 写失败：注入只写失败的 fs
    const { tools: t2, ctx } = makeTools();
    ctx.fs = {
      ...makeFakeFs({ [`${T}/rep.txt`]: "aa\n" }),
      writeTextFile: async () => {
        throw new Error("EACCES: denied");
      },
    };
    const r2 = await t2.execute(
      "replace_file",
      { path: `${T}/rep.txt`, old: "aa", new: "b" },
      undefined as never,
    );
    expect(r2.error).toContain("Failed to replace text in /ANCHOR_TMP/rep.txt: EACCES");
  });
  it("docx 嗅探降级（PK+.docx → M5 提示）；count 守卫负数", async () => {
    const { tools } = makeTools();
    const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]);
    const fs = makeFakeFs({ [`${T}/r.docx`]: docx, [`${T}/rep.txt`]: "aa\n" });
    const r = await execFile(tools, fs, "read_file", { path: `${T}/r.docx` });
    expect(r.error).toContain("is a DOCX");
    const bad = await execFile(tools, fs, "replace_file", {
      path: `${T}/rep.txt`,
      old: "aa",
      new: "b",
      count: -1,
    });
    expect(bad.error).toBe("replace_file 'count' must be a positive integer (got -1)");
  });
});
