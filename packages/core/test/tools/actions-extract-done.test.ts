// extract / done 两个重 handler 的行为测试：extract 的 LLM 分页/降级/超时/落盘，
// done 的变体 A/B、success 推导、附件白名单与内联（fs 注入 mock）。
import { describe, expect, it } from "vitest";
import { LLMCallTimeoutError } from "../../src/llm/errors.js";
import type { Tools } from "../../src/tools/actions/index.js";
import type { FileSystemProvider } from "../../src/tools/fs.js";
import { paramJsonSchema } from "../../src/tools/models.js";
import { FakeBrowser, makeTools } from "./fake-browser.js";

async function exec(
  tools: Tools,
  browser: FakeBrowser,
  name: string,
  params: Record<string, unknown>,
) {
  return tools.execute(name, params, browser);
}

const LONG_TEXT = "word ".repeat(4000); // 20k chars——够大结果阈值（10000）

describe("extract", () => {
  it("空页面 → (empty page)", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    browser.html = "";
    const r = await exec(tools, browser, "extract", { query: "q" });
    expect(r.extractedContent).toBe("(empty page)");
  });
  it("getPageHtml 返回空 → 降级 outerHTML 仍空 → empty page；异常 → error 透传", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    browser.html = "";
    browser.js = [{ code: "document.documentElement.outerHTML", result: "" }];
    const r = await exec(tools, browser, "extract", { query: "q" });
    expect(r.extractedContent).toBe("(empty page)");
    const browser2 = new FakeBrowser();
    browser2.htmlError = new Error("dom gone");
    const r2 = await exec(tools, browser2, "extract", { query: "q" });
    expect(r2.error).toBe("dom gone"); // 异常走 execute 包装（Python get_page_html 异常同路径）
  });
  it("未接 LLM → 截断片段降级（2000 字上限 + offset）", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    browser.html = `<p>${LONG_TEXT}</p>`;
    const r = await exec(tools, browser, "extract", { query: "q" });
    expect(r.extractedContent).not.toBeNull();
    expect(r.extractedContent!.length).toBeLessThanOrEqual(2000);
    const r2 = await exec(tools, browser, "extract", { query: "q", start_from_char: 10_000_000 });
    expect(r2.extractedContent).toBe("(no content at offset)");
  });
  it("接 LLM：正常抽取 + 分页 hint；offset 超尾 → complete", async () => {
    const { tools, ctx } = makeTools();
    const browser = new FakeBrowser();
    browser.html = `<p>${LONG_TEXT}</p>`; // md ≈ 20k → 3 chunks（8000/块）
    const calls: Array<{
      content: string;
      schema: unknown;
      collected: string[] | null;
      timeout: number | null;
    }> = [];
    ctx.extractClient = {
      extract: async (prompt, content, opts) => {
        calls.push({
          content,
          schema: opts?.outputSchema ?? null,
          collected: opts?.alreadyCollected ?? null,
          timeout: opts?.callTimeoutMs ?? null,
        });
        return `RESULT for ${prompt}`;
      },
    };
    const r = await exec(tools, browser, "extract", { query: "find prices" });
    expect(r.extractedContent).toMatch(
      /^\[chunk 1\/3; ~\d+ chars remain; call extract again with start_from_char=8000 to continue\]\nRESULT for find prices$/,
    );
    expect(calls[0].content.length).toBeLessThanOrEqual(8000);
    expect(calls[0].schema).toBeNull();
    const rTail = await exec(tools, browser, "extract", { query: "q", start_from_char: 1_000_000 });
    expect(rTail.extractedContent).toBe("(no more content at this offset; extraction complete)");
  });
  it("already_collected 透传（去重列表）", async () => {
    const { tools, ctx } = makeTools();
    const browser = new FakeBrowser();
    let collected: string[] | null = null;
    ctx.extractClient = {
      extract: async (_p, _c, opts) => {
        collected = opts?.alreadyCollected ?? null;
        return "r";
      },
    };
    await exec(tools, browser, "extract", { query: "q", already_collected: ["a", "b"] });
    expect(collected).toEqual(["a", "b"]);
  });
  it("LLM 超时 → Extract timed out；其他异常 → Extract failed", async () => {
    const { tools, ctx } = makeTools();
    const browser = new FakeBrowser();
    ctx.extractClient = {
      extract: async () => {
        throw new LLMCallTimeoutError("单次调用超时（3000ms）");
      },
    };
    const r = await exec(tools, browser, "extract", { query: "q" });
    expect(r.error).toBe("Extract timed out: 单次调用超时（3000ms）");
    ctx.extractClient = {
      extract: async () => {
        throw new Error("500 boom");
      },
    };
    const r2 = await exec(tools, browser, "extract", { query: "q" });
    expect(r2.error).toBe("Extract failed: 500 boom");
  });
  it("大结果落盘（fs 注入）：free-text 可见摘要 + long_term_memory 记路径", async () => {
    const { tools, ctx } = makeTools();
    const browser = new FakeBrowser();
    browser.html = `<p>${LONG_TEXT}</p>`;
    ctx.extractClient = { extract: async () => LONG_TEXT };
    const writes: Array<[string, string]> = [];
    const dirs: string[] = [];
    const fs: FileSystemProvider = {
      resolve: (p) => p,
      isFile: async () => false,
      readTextFile: async () => "",
      ensureDir: async (p) => {
        dirs.push(p);
      },
      writeTextFile: async (p, content) => {
        writes.push([p, content]);
      },
    };
    ctx.fs = fs;
    const r = await exec(tools, browser, "extract", { query: "q", start_from_char: 16_000 });
    expect(dirs).toEqual(["extract_output"]);
    expect(writes.length).toBe(1);
    expect(writes[0][0]).toMatch(/^extract_output\/extract_\d+\.md$/);
    // free-text 大结果：原文直出（saved-summary 只在 schema 路径），save 记入 long_term_memory
    expect(r.extractedContent).toBe(LONG_TEXT);
    expect(r.longTermMemory).toContain("extract result saved: extract_output/extract_");
  });
  it("大结果无 fs → 跳过落盘 + metadata 标注（偏离 6）", async () => {
    const { tools, ctx } = makeTools();
    const browser = new FakeBrowser();
    browser.html = `<p>${LONG_TEXT}</p>`;
    ctx.extractClient = { extract: async () => LONG_TEXT };
    const r = await exec(tools, browser, "extract", { query: "q", start_from_char: 16_000 });
    expect(r.metadata).toEqual({ extract_save_skipped: "no filesystem provider" });
    expect(r.extractedContent).toContain(LONG_TEXT.slice(0, 5));
  });
  it("结构化 schema：结果 JSON 纯净直出（hint 走 long_term_memory）", async () => {
    const { tools, ctx } = makeTools();
    const browser = new FakeBrowser();
    browser.html = "<p>small page</p>"; // 单块无 hint
    ctx.extractionSchema = { type: "object", properties: { items: { type: "array" } } };
    ctx.extractClient = { extract: async () => '{"items": ["a"]}' };
    const r = await exec(tools, browser, "extract", { query: "q" });
    expect(r.extractedContent).toBe('{"items": ["a"]}');
    expect(r.metadata).toBeNull();
    let schemaSeen: unknown = null;
    ctx.extractClient = {
      extract: async (_p, _c, opts) => {
        schemaSeen = opts?.outputSchema ?? null;
        return "{}";
      },
    };
    await exec(tools, browser, "extract", { query: "q" });
    expect(schemaSeen).toEqual(ctx.extractionSchema);
  });
});

describe("done（变体 A）", () => {
  it("text 存在 → success=True 默认；回显与 memory（Python 字面量）", async () => {
    const { tools } = makeTools();
    const r = await exec(tools, new FakeBrowser(), "done", { text: "All done" });
    expect(r.isDone).toBe(true);
    expect(r.success).toBe(true);
    expect(r.extractedContent).toBe("All done");
    expect(r.longTermMemory).toBe("Task completed: True - All done");
  });
  it("无 text 无 data → success=False 诚实失败；空 text 兜底默认串", async () => {
    const { tools } = makeTools();
    const r = await exec(tools, new FakeBrowser(), "done", {});
    expect(r.success).toBe(false);
    expect(r.extractedContent).toBe("(no summary provided)");
    expect(r.longTermMemory).toBe("Task completed: False - (no summary provided)");
  });
  it("长文本截断 + more characters 后缀", async () => {
    const { tools } = makeTools();
    const text = "y".repeat(150);
    const r = await exec(tools, new FakeBrowser(), "done", { text });
    expect(r.longTermMemory).toBe(`Task completed: True - ${"y".repeat(100)} - 50 more characters`);
  });
  it("显式 success=False 畅通", async () => {
    const { tools } = makeTools();
    const r = await exec(tools, new FakeBrowser(), "done", { text: "partial", success: false });
    expect(r.success).toBe(false);
    expect(r.isDone).toBe(true);
  });
  it("附件白名单 + 存在性过滤 + 清单回显（fs 注入）", async () => {
    const files: Record<string, string> = { "C:/out/report.md": "R" };
    const fs: FileSystemProvider = {
      resolve: (p) => p,
      isFile: async (p) => Object.hasOwn(files, p),
      readTextFile: async (p) => files[p] ?? "",
      ensureDir: async () => {},
      writeTextFile: async () => {},
    };
    const { tools, ctx } = makeTools({ allowedReadPaths: ["C:/out"] });
    ctx.fs = fs;
    const r = await exec(tools, new FakeBrowser(), "done", {
      text: "saved",
      files_to_display: ["C:/out/report.md", "C:/out/missing.txt", "C:/secret.txt"],
    });
    expect(r.attachments).toEqual(["C:/out/report.md"]);
    expect(r.extractedContent).toBe("saved\n\nAttachments: report.md");
  });
  it("displayFilesInDoneText：内联文件内容（cap 截断）", async () => {
    const files: Record<string, string> = { "C:/out/a.txt": "AAA".repeat(1000) };
    const fs: FileSystemProvider = {
      resolve: (p) => p,
      isFile: async (p) => Object.hasOwn(files, p),
      readTextFile: async (p, maxChars) =>
        (files[p] ?? "").slice(0, maxChars ?? Number.POSITIVE_INFINITY),
      ensureDir: async () => {},
      writeTextFile: async () => {},
    };
    const { tools } = makeTools({ fs, displayFilesInDoneText: true });
    const r = await exec(tools, new FakeBrowser(), "done", {
      text: "saved",
      files_to_display: ["C:/out/a.txt"],
    });
    expect(r.extractedContent).toContain("--- C:/out/a.txt ---");
    expect(r.extractedContent!.length).toBeLessThan(2000 + 300);
  });
});

describe("done（变体 B：outputModel）", () => {
  const outputModel = {
    name: "ReportOutput",
    fields: [
      { name: "total", type: "integer" as const, required: true },
      { name: "note", type: "string" as const, default: "" },
    ],
  };
  it("合法 data → 结构化 JSON 纯净（含缺省字段，model_dump 语义）+ metadata.structured_output", async () => {
    const { tools } = makeTools({ outputModel });
    const r = await exec(tools, new FakeBrowser(), "done", { data: { total: 3 } });
    expect(r.isDone).toBe(true);
    expect(r.success).toBe(true);
    expect(r.extractedContent).toBe('{\n  "total": 3,\n  "note": ""\n}');
    expect(r.metadata).toEqual({ structured_output: { total: 3, note: "" } });
    expect(r.longTermMemory).toBe("Task completed (structured): True");
  });
  it("非法 data → success=False 但仍 is_done=True（Python 对 data 直校验 output_model，loc 不带 data. 前缀）", async () => {
    const { tools } = makeTools({ outputModel });
    const r = await exec(tools, new FakeBrowser(), "done", { data: { total: "x" } });
    expect(r.isDone).toBe(true);
    expect(r.success).toBe(false);
    expect(r.extractedContent).toBe(
      "(invalid structured output: total: Input should be a valid integer, unable to parse string as an integer)",
    );
    expect(r.longTermMemory).toBe("Task completed: False - invalid structured output");
  });
  it("变体 B 参数模型 schema 含三字段（tool schema 不按动作嵌 schema；LLM 侧隐藏只发生在 descriptionsText）", () => {
    const { tools } = makeTools({ outputModel });
    const done = tools.registry.actions.get("done");
    expect(done).toBeTruthy();
    const schema = JSON.stringify(paramJsonSchema(done!.params));
    expect(schema).toContain('"data"');
    expect(schema).toContain('"success"');
    expect(schema).toContain('"files_to_display"');
    // LLM 实际看到的动作描述文本只暴露 data（_hide_fields_from_schema）
    const doneLine = tools.registry
      .getActionDescriptionsText()
      .split("\n")
      .find((l) => l.startsWith("- **done**"));
    expect(doneLine).toContain("data: Structured final output.");
    expect(doneLine).not.toContain("success:");
    expect(doneLine).not.toContain("files_to_display");
  });
});
