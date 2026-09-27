// LLMClient 扩面单测（p4/02 §6）：extract / structuredCall 的双底座——
// schema 校验与降级、forced tool 承重墙（含 supportsForcedTool=false / supportsTools=false）、
// alreadyCollected 去重块、pyJsonDumps 出参形态、fallback 切换重入、内层超时
// LLMCallTimeoutError（非 LLMError 家族不进分罪轴）。
import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "../../src/index.js";
import { createLLMClient, LLMCallTimeoutError, LLMError } from "../../src/index.js";
import { MockFetch, type MockResponseSpec } from "./mock-fetch.js";

const CARD: ProviderConfig = {
  name: "primary",
  protocol: "anthropic-messages",
  baseUrl: "https://primary.example",
  apiKey: "k1",
  model: "glm-4.7",
  maxTokens: 4096,
};
const FALLBACK: ProviderConfig = {
  name: "fallback",
  protocol: "anthropic-messages",
  baseUrl: "https://fallback.example",
  apiKey: "k2",
  model: "glm-5.1",
  maxTokens: 2048,
};

const SCHEMA = {
  type: "object",
  properties: { items: { type: "array", items: { type: "string" } } },
};

const toolUse = (name: string, input: Record<string, unknown>): MockResponseSpec => ({
  status: 200,
  body: {
    content: [{ type: "tool_use", id: "t1", name, input }],
    stop_reason: "tool_use",
  },
});
const textResp = (t: string): MockResponseSpec => ({
  status: 200,
  body: { content: [{ type: "text", text: t }], stop_reason: "end_turn" },
});
const r429 = (): MockResponseSpec => ({ status: 429, body: { error: { message: "limited" } } });

function setup(over: Partial<ProviderConfig> = {}, specs: MockResponseSpec[] = []) {
  const mock = new MockFetch();
  for (const s of specs) mock.queueMany(s);
  const logs: string[] = [];
  const client = createLLMClient(
    { ...CARD, ...over },
    {
      fetch: mock.fetch as typeof fetch,
      log: (m) => logs.push(m),
    },
  );
  return { mock, client, logs };
}

describe("extract（client.py :635-730 等价）", () => {
  it("free-text：无 tools/system，user = prompt\\n\\n---\\ncontent，maxTokens=2048", async () => {
    const { mock, client } = setup({}, [textResp("answer text")]);
    const out = await client.extract("find prices", "PAGE CONTENT");
    expect(out).toBe("answer text");
    const body = mock.lastBody() as Record<string, unknown>;
    expect(body.system).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(body.max_tokens).toBe(2048);
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "find prices\n\n---\nPAGE CONTENT" }] },
    ]);
  });

  it("content 截断 maxContentChars；alreadyCollected 拼去重块（≤200 条）", async () => {
    const { mock, client } = setup({}, [textResp("r")]);
    const collected = Array.from({ length: 205 }, (_, i) => `item ${i}`);
    await client.extract("q", "0123456789", {
      maxContentChars: 5,
      alreadyCollected: collected,
    });
    const content = (mock.lastBody() as { messages: Array<{ content: Array<{ text: string }> }> })
      .messages[0].content[0].text;
    expect(content).toBe(
      "q\n\nItems already collected (DO NOT re-extract these, skip exact duplicates):\n" +
        collected
          .slice(0, 200)
          .map((c) => `- ${c}`)
          .join("\n") +
        "\n\n---\n01234",
    );
  });

  it("schema 路径：system 文案字节照搬 + forced extract_result + pyJsonDumps 出参", async () => {
    const { mock, client } = setup({}, [toolUse("extract_result", { items: ["a", 1] })]);
    const out = await client.extract("find", "content", { outputSchema: SCHEMA });
    expect(out).toBe('{"items": ["a", 1]}'); // json.dumps 分隔符（非 JSON.stringify 紧凑态）
    const body = mock.lastBody() as Record<string, unknown>;
    expect(body.system).toBe(
      "You are an expert at extracting structured data from a webpage. " +
        "Extract exactly what the query asks for and return it via the " +
        "extract_result tool, conforming strictly to the provided JSON Schema. " +
        "Omit fields you cannot find rather than guessing.",
    );
    expect(body.tools).toEqual([
      {
        name: "extract_result",
        description: "Structured extraction result conforming to the given schema.",
        input_schema: SCHEMA,
      },
    ]);
    expect(body.tool_choice).toEqual({ type: "tool", name: "extract_result" });
  });

  it("schema 不可用 → 降级 free-text + warning", async () => {
    const { mock, client, logs } = setup({}, [textResp("plain")]);
    const out = await client.extract("q", "c", { outputSchema: { type: "string" } });
    expect(out).toBe("plain");
    const body = mock.lastBody() as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
    expect(
      logs.some((l) => l.includes("Invalid output_schema, falling back to free-text extraction")),
    ).toBe(true);
  });

  it("模型未用工具 → 同响应 text 兜底 + warning", async () => {
    const { client, logs } = setup({}, [textResp("fallback text")]);
    const out = await client.extract("q", "c", { outputSchema: SCHEMA });
    expect(out).toBe("fallback text");
    expect(logs.some((l) => l.includes("LLM did not use extract_result tool"))).toBe(true);
  });

  it("RateLimit → fallback 单向切换后重入自身成功", async () => {
    const mock = new MockFetch();
    mock.queueMany(r429());
    mock.queueMany(textResp("from fallback"));
    const logs: string[] = [];
    const client = createLLMClient(
      { ...CARD, fallback: FALLBACK },
      {
        fetch: mock.fetch as typeof fetch,
        log: (m) => logs.push(m),
      },
    );
    const out = await client.extract("q", "c");
    expect(out).toBe("from fallback");
    expect(mock.calls.length).toBe(2);
    expect(mock.calls[1].url.startsWith("https://fallback.example")).toBe(true);
    expect(logs.some((l) => l.includes("Switched to fallback LLM"))).toBe(true);
  });

  it("callTimeoutMs 到点 → LLMCallTimeoutError（非 LLMError，不触发 fallback）", async () => {
    const mock = new MockFetch();
    mock.queueMany({ hangUntilAbort: true });
    const logs: string[] = [];
    const client = createLLMClient(
      { ...CARD, fallback: FALLBACK },
      {
        fetch: mock.fetch as typeof fetch,
        sleep: (ms, signal) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, ms);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          }),
        log: (m) => logs.push(m),
      },
    );
    await expect(client.extract("q", "c", { callTimeoutMs: 30 })).rejects.toBeInstanceOf(
      LLMCallTimeoutError,
    );
    expect(mock.calls.length).toBe(1); // 超时不切换卡（Python TimeoutError 不进 fallback 分支）
  });

  it("supportsForcedTool:false → prompt 约束段（承重墙复用）", async () => {
    const { mock, client } = setup({ capabilities: { supportsForcedTool: false } }, [
      toolUse("extract_result", { items: [] }),
    ]);
    await client.extract("q", "c", { outputSchema: SCHEMA });
    const body = mock.lastBody() as Record<string, unknown>;
    expect(body.tool_choice).toBeUndefined();
    expect(body.system).toContain(
      'IMPORTANT: You must respond by calling the tool "extract_result" with your complete answer as the tool arguments. Do not reply with plain text.',
    );
  });

  it("supportsTools:false → schema 进 system + JSON 兜底链", async () => {
    const { mock, client } = setup(
      { capabilities: { supportsTools: false, supportsForcedTool: false } },
      [textResp('{"items": ["x"]}')],
    );
    // 无 tools 能力：extract 的 toolUse 解析不适用——text 命中即返回
    const out = await client.extract("q", "c", { outputSchema: SCHEMA });
    expect(out).toBe('{"items": ["x"]}');
    const body = mock.lastBody() as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
    expect(body.system).toContain("IMPORTANT: You must respond with only a JSON object");
  });
});

describe("structuredCall（client.py :732-780 等价）", () => {
  it("forced structured_result → args 对象直返", async () => {
    const { mock, client } = setup({}, [toolUse("structured_result", { kind: "yes" })]);
    const out = await client.structuredCall("sys prompt", "user prompt", SCHEMA);
    expect(out).toEqual({ kind: "yes" });
    const body = mock.lastBody() as Record<string, unknown>;
    expect(body.system).toBe("sys prompt");
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "user prompt" }] },
    ]);
    expect(body.tool_choice).toEqual({ type: "tool", name: "structured_result" });
    expect(body.max_tokens).toBe(4096); // 缺省回落 ProviderConfig.maxTokens
  });

  it("maxTokens 显式覆盖", async () => {
    const { mock, client } = setup({}, [toolUse("structured_result", { a: 1 })]);
    await client.structuredCall("s", "u", SCHEMA, { maxTokens: 64 });
    expect((mock.lastBody() as Record<string, unknown>).max_tokens).toBe(64);
  });

  it("text 兜底 tryParseJson：fence JSON 解析 / 不可解析 → null", async () => {
    const { client } = setup({}, [textResp('```json\n{"kind": "maybe"}\n```')]);
    const out = await client.structuredCall("s", "u", SCHEMA);
    expect(out).toEqual({ kind: "maybe" });
    const { client: c2 } = setup({}, [textResp("no json here")]);
    const out2 = await c2.structuredCall("s", "u", SCHEMA);
    expect(out2).toBeNull();
  });

  it("失败先 fallback 切换再抛（非 infra 4xx 切一次仍失败 → 原样上抛）", async () => {
    const mock = new MockFetch();
    mock.queueMany({ status: 400, body: { error: { message: "bad schema" } } });
    mock.queueMany({ status: 400, body: { error: { message: "bad schema again" } } });
    const client = createLLMClient(
      { ...CARD, fallback: FALLBACK },
      {
        fetch: mock.fetch as typeof fetch,
        log: () => {},
      },
    );
    await expect(client.structuredCall("s", "u", SCHEMA)).rejects.toBeInstanceOf(LLMError);
    expect(mock.calls.length).toBe(2);
    expect(mock.calls[1].url.startsWith("https://fallback.example")).toBe(true);
  });
});
