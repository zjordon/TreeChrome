// 文件三动作 handler 锚定（batch2.json fileActions——venv 实跑 Python handler 的
// 全输出：路径已稳定化为 /ANCHOR_TMP 占位）。TS 侧用内存 fs 复现同一输入形态，
// 期望值按占位替换后逐字节比对；已知偏离（encoding 收窄/pdf-docx 降级文案）按
// 各自断言面处理。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ActionResult } from "../../src/agent/views.js";
import { pythonTemplateToJs } from "../../src/tools/actions/file-actions.js";
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
  it("append 走 appendTextFile：既有二进制零接触、缺失创建（open(path,'a') 语义）", async () => {
    const { tools } = makeTools();
    const fs = makeFakeFs({ [`${T}/bin.png`]: new Uint8Array([0x89, 0x50]) });
    const r = await execFile(tools, fs, "write_file", {
      path: `${T}/bin.png`,
      content: "abc",
      append: true,
    });
    expect(r.error).toBeNull();
    // 字节级追加——不读旧解码重写（评审轮 1 [7]：读旧拼新会腐蚀既有字节）
    expect(fs.files.get(`${T}/bin.png`)).toEqual(new Uint8Array([0x89, 0x50, 97, 98, 99, 10]));
    expect(fs.appends).toEqual([[`${T}/bin.png`, "abc\n"]]);
    await execFile(tools, fs, "write_file", { path: `${T}/new.txt`, content: "n", append: true });
    expect(fs.files.get(`${T}/new.txt`)).toBe("n\n");
  });
  it("白名单穿越拒（resolve 归一化后比对——Python 裸 startswith 收严，评审轮 1 [6]）", async () => {
    const { tools } = makeTools({ allowedWritePaths: ["/data/allowed"] });
    const fs = makeFakeFs();
    fs.resolve = (p) => {
      const out: string[] = [];
      for (const seg of p.split("/")) {
        if (seg === "" || seg === ".") continue;
        if (seg === "..") out.pop();
        else out.push(seg);
      }
      return `/${out.join("/")}`;
    };
    const r = await execFile(tools, fs, "write_file", {
      path: "/data/allowed/../../etc/cron.d/x",
      content: "pwn",
    });
    expect(r.error).toBe("File path not in allowed write paths: /etc/cron.d/x");
    expect(fs.files.has("/etc/cron.d/x")).toBe(false);
    const ok = await execFile(tools, fs, "write_file", {
      path: "/data/allowed/./sub/../f.txt",
      content: "ok",
    });
    expect(ok.error).toBeNull();
    expect(fs.files.get("/data/allowed/f.txt")).toBe("ok\n");
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
  it("count 单遍替换：new ⊇ old 不重扫产物（Python str.replace/subn 语义，venv 锚定；评审轮 1 [8]）", async () => {
    const { tools } = makeTools();
    // 'a\nb\n'.replace('\n','\n\n',2) → 'a\n\nb\n\n'（原文两个匹配都改，非重扫产物）
    const fs = makeFakeFs({ [`${T}/rep.txt`]: "a\nb\n" });
    const r = await execFile(tools, fs, "replace_file", {
      path: `${T}/rep.txt`,
      old: "\n",
      new: "\n\n",
      count: 2,
    });
    expect(fs.files.get(`${T}/rep.txt`)).toBe("a\n\nb\n\n");
    expect(r.extracted_content).toBe(
      "Replaced 2 occurrences of '\\n' with '\\n\\n' in /ANCHOR_TMP/rep.txt (6 bytes)",
    );
    // 'aaaa'.replace('aa','aab',3) → 非重叠仅 2 处 → 'aabaab'
    const fs2 = makeFakeFs({ [`${T}/rep.txt`]: "aaaa" });
    const r2 = await execFile(tools, fs2, "replace_file", {
      path: `${T}/rep.txt`,
      old: "aa",
      new: "aab",
      count: 3,
    });
    expect(fs2.files.get(`${T}/rep.txt`)).toBe("aabaab");
    expect(r2.extracted_content).toContain("Replaced 2 occurrences");
    // re.subn('a','aa','aaa',count=2) → 'aaaaa'（venv 实跑）
    const fs3 = makeFakeFs({ [`${T}/rep.txt`]: "aaa" });
    const r3 = await execFile(tools, fs3, "replace_file", {
      path: `${T}/rep.txt`,
      old: "a",
      new: "aa",
      regex: true,
      count: 2,
    });
    expect(fs3.files.get(`${T}/rep.txt`)).toBe("aaaaa");
    expect(r3.extracted_content).toContain("Replaced 2 of 3 occurrences");
    // replaced < rawTotal 文案（count 1 of 3）
    const fs4 = makeFakeFs({ [`${T}/rep.txt`]: "a\nb\nc\n" });
    const r4 = await execFile(tools, fs4, "replace_file", {
      path: `${T}/rep.txt`,
      old: "\n",
      new: "\n\n",
      count: 1,
    });
    expect(r4.extracted_content).toContain("Replaced 1 of 3 occurrences");
    expect(fs4.files.get(`${T}/rep.txt`)).toBe("a\n\nb\nc\n");
  });
  it("替换模板 = CPython parse_template 语义（venv 锚定；评审轮 1 [11]）", async () => {
    const { tools } = makeTools();
    // \1 但模式无捕获组 → re.error（前缀形态）+ 文件不动 + backup 同序先生成 .bak
    const fs = makeFakeFs({ [`${T}/rep.txt`]: "v1 v2\n" });
    const bad = await execFile(tools, fs, "replace_file", {
      path: `${T}/rep.txt`,
      old: "v\\d",
      new: "w\\1",
      regex: true,
      backup: true,
    });
    expect(bad.error).toBe(
      "Regex substitution failed for 'v\\\\d': invalid group reference 1 at position 2",
    );
    expect(fs.files.get(`${T}/rep.txt`)).toBe("v1 v2\n");
    expect(fs.files.get(`${T}/rep.txt.bak`)).toBe("v1 v2\n");
    // 未知组名 → IndexError 形态（Python 落通用 catch，error=str(e) 原样无前缀）
    const fs2 = makeFakeFs({ [`${T}/rep.txt`]: "v1\n" });
    const unk = await execFile(tools, fs2, "replace_file", {
      path: `${T}/rep.txt`,
      old: "v(\\d)",
      new: "w\\g<y>",
      regex: true,
    });
    expect(unk.error).toBe("unknown group name 'y'");
    expect(fs2.files.get(`${T}/rep.txt`)).toBe("v1\n");
    // \g<0> = 整匹配引用
    const fs3 = makeFakeFs({ [`${T}/rep.txt`]: "v1 v2\n" });
    await execFile(tools, fs3, "replace_file", {
      path: `${T}/rep.txt`,
      old: "v(\\d)",
      new: "w\\g<0>",
      regex: true,
    });
    expect(fs3.files.get(`${T}/rep.txt`)).toBe("wv1 wv2\n");
    // \t 控制字符 / \\ 字面反斜杠（后随 1 不再当引用）/ bad escape
    const fs4 = makeFakeFs({ [`${T}/a.txt`]: "a\n" });
    await execFile(tools, fs4, "replace_file", {
      path: `${T}/a.txt`,
      old: "a",
      new: "x\\ty",
      regex: true,
    });
    expect(fs4.files.get(`${T}/a.txt`)).toBe("x\ty\n");
    const fs5 = makeFakeFs({ [`${T}/a.txt`]: "ab" });
    await execFile(tools, fs5, "replace_file", {
      path: `${T}/a.txt`,
      old: "(a)",
      new: "x\\\\1y",
      regex: true,
    });
    expect(fs5.files.get(`${T}/a.txt`)).toBe("x\\1yb");
    const fs6 = makeFakeFs({ [`${T}/a.txt`]: "a\n" });
    const badEsc = await execFile(tools, fs6, "replace_file", {
      path: `${T}/a.txt`,
      old: "a",
      new: "w\\q",
      regex: true,
    });
    expect(badEsc.error).toBe("Regex substitution failed for 'a': bad escape \\q at position 1");
  });
});

describe("pythonTemplateToJs（CPython 3.12 parse_template 等价，venv 锚定）", () => {
  const g = (count: number, names: string[] = []) => ({ count, names: new Set(names) });
  it("组引用与转义形态", () => {
    expect(pythonTemplateToJs("w\\1", g(1))).toBe("w$1");
    expect(pythonTemplateToJs("\\g<0>", g(0))).toBe("$&"); // 整匹配
    expect(pythonTemplateToJs("\\g<x>", g(1, ["x"]))).toBe("$<x>");
    expect(pythonTemplateToJs("x$y", g(0))).toBe("x$$y"); // 字面 $ 转义
    expect(pythonTemplateToJs("\\t-\\0", g(0))).toBe("\t-\x00"); // \0=NUL 非组引用
    expect(pythonTemplateToJs("\\123", g(3))).toBe("S"); // 三连八进制 = chr(0o123)
    expect(pythonTemplateToJs("\\10", g(10))).toBe("$10"); // \10=组 10（两位非全八进制）
    expect(pythonTemplateToJs("\\-", g(0))).toBe("\\-"); // 非字母保留字面反斜杠
  });
  it("错误形态（消息+位置口径 venv 实跑锚定）", () => {
    expect(() => pythonTemplateToJs("\\1", g(0))).toThrow(
      "invalid group reference 1 at position 1",
    );
    expect(() => pythonTemplateToJs("\\10", g(1))).toThrow(
      "invalid group reference 10 at position 1",
    );
    expect(() => pythonTemplateToJs("\\400", g(0))).toThrow(
      "octal escape value \\400 outside of range 0-0o377 at position 0",
    );
    expect(() => pythonTemplateToJs("\\g", g(0))).toThrow("missing < at position 2");
    expect(() => pythonTemplateToJs("\\g<ab", g(0))).toThrow(
      "missing >, unterminated name at position 3",
    );
    expect(() => pythonTemplateToJs("\\g<>", g(0))).toThrow("missing group name at position 3");
    expect(() => pythonTemplateToJs("\\g<1x>", g(0))).toThrow(
      "bad character in group name '1x' at position 3",
    );
    expect(() => pythonTemplateToJs("\\q", g(0))).toThrow("bad escape \\q at position 0");
    expect(() => pythonTemplateToJs("\\", g(0))).toThrow(
      "bad escape (end of pattern) at position 0",
    );
    expect(() => pythonTemplateToJs("\\g<y>", g(0))).toThrow("unknown group name 'y'");
  });
});
