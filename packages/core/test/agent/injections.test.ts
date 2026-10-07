// Agent 注入口测试（examples 方案 F2）：extractLlm（Python extract_llm 的 judgeLlm
// 同款注入口）与 downloadsPath（trackDownloads 的宿主解析路径透传）+
// list[Model] 嵌套模型支持（paramJsonSchema $defs 收集 / validateParams 逐项深校验——
// structured_output.py 的 Posts.posts: list[Post] 形态）。

import { describe, expect, it } from "vitest";
import type { AgentOptions } from "../../src/agent/agent.js";
import { Agent } from "../../src/agent/agent.js";
import type { AgentSettings } from "../../src/agent/settings.js";
import type { BrowserSession } from "../../src/browser/session.js";
import { type ParamModel, paramJsonSchema, validateParams } from "../../src/tools/models.js";
import { FakeAgentBrowser, FakeAgentLLM, type LlmScriptEntry } from "./fixtures.js";

const ok = (toolInput: Record<string, unknown>): LlmScriptEntry => ({ kind: "ok", toolInput });

const doneOutput = () => ({
  evaluation_previous_goal: "done",
  memory: "m",
  next_goal: "finish",
  action: { name: "done", params: { text: "done" } },
  actions: [{ name: "done", params: { text: "done" } }],
});

function makeAgent(overrides: Partial<AgentOptions> = {}): {
  agent: Agent;
  llm: FakeAgentLLM;
  browser: FakeAgentBrowser;
} {
  const llm = new FakeAgentLLM([ok(doneOutput())]);
  const browser = new FakeAgentBrowser();
  const agent = new Agent({
    task: "Open https://a.example and finish",
    llm: llm.asLLMClient(),
    browser: browser as unknown as BrowserSession,
    settings: {
      judge: { enabled: false },
      explorationActionabilityCheck: false,
      maxSteps: 10,
      llmTimeout: 30,
    } as AgentSettings,
    sleep: () => Promise.resolve(),
    now: () => 0,
    log: () => {},
    ...overrides,
  });
  return { agent, llm, browser };
}

describe("AgentOptions.extractLlm（F2-b，config.py:562-570）", () => {
  it("注入实例落到 tools.ctx.extractClient；缺省复用主 llm", () => {
    const base = makeAgent();
    expect(base.agent.tools.ctx.extractClient).toBe(base.llm.asLLMClient());

    const extract = new FakeAgentLLM([]);
    const withExtract = makeAgent({ extractLlm: extract.asLLMClient() });
    expect(withExtract.agent.tools.ctx.extractClient).toBe(extract.asLLMClient());
    expect(withExtract.agent.tools.ctx.extractClient).not.toBe(withExtract.llm.asLLMClient());
  });
});

describe("AgentOptions.downloadsPath（F2-a）", () => {
  it("run() 把 downloadsPath 传入 browser.start；未设为 undefined", async () => {
    const withPath = makeAgent({
      settings: {
        judge: { enabled: false },
        trackDownloads: true,
      } as AgentSettings,
      downloadsPath: "D:/tmp/dl",
    });
    await withPath.agent.run();
    expect(withPath.browser.startCalls[0]).toEqual({
      trackDownloads: true,
      enableRecentEvents: expect.any(Boolean),
      downloadsPath: "D:/tmp/dl",
    });

    const withoutPath = makeAgent();
    await withoutPath.agent.run();
    expect(withoutPath.browser.startCalls[0]).toMatchObject({ downloadsPath: undefined });
    expect(withoutPath.agent.downloadsPath).toBeUndefined();
  });
});

describe("list[Model] 嵌套模型（structured_output 的 Posts 形态）", () => {
  const Post: ParamModel = {
    name: "Post",
    fields: [
      { name: "post_title", type: "string", required: true },
      { name: "post_url", type: "string", required: true },
      { name: "num_comments", type: "integer", required: true },
      { name: "hours_since_post", type: "integer", required: true },
    ],
  };
  const Posts: ParamModel = {
    name: "Posts",
    fields: [{ name: "posts", type: "array", required: true, refModel: Post }],
  };

  it("paramJsonSchema：$defs 注册 Post + items 直接 $ref", () => {
    const schema = paramJsonSchema(Posts);
    const defs = schema.$defs as Record<string, unknown>;
    expect(defs.Post).toBeDefined();
    const items = (
      (schema.properties as Record<string, unknown>).posts as { items: Record<string, unknown> }
    ).items;
    expect(items).toEqual({ $ref: "#/$defs/Post" });
  });

  it("validateParams：逐项深校验（合法通过 / 缺字段错误 loc `0.post_title` / 非对象项）", () => {
    const good = validateParams(Posts, {
      posts: [
        {
          post_title: "t",
          post_url: "https://x/",
          num_comments: 3,
          hours_since_post: 5,
        },
      ],
    });
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect((good.value.posts as Array<Record<string, unknown>>)[0].post_title).toBe("t");
    }

    const missing = validateParams(Posts, {
      posts: [{ post_title: "t", post_url: "https://x/", num_comments: 3 }],
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errors.some((e) => e.startsWith("posts.0.hours_since_post"))).toBe(true);
    }

    const nonDict = validateParams(Posts, { posts: ["oops"] });
    expect(nonDict.ok).toBe(false);
    if (!nonDict.ok) {
      expect(nonDict.errors[0].startsWith("posts.0")).toBe(true);
    }
  });
});

describe("下载→done 附件链（二.C，downloadProgress.filePath 修复的下游验证）", () => {
  it("非空 path 并入 done attachments（对既有附件去重）；null path 跳过；非 done 不动", async () => {
    const { attachDownloadsToDoneResults } = await import("../../src/agent/step/post.js");
    const { ActionResult } = await import("../../src/agent/views.js");
    const done = new ActionResult({
      isDone: true,
      extractedContent: "ok",
      attachments: ["D:/tmp/model-given.pdf"], // 模型 files_to_display 已解析出的附件
    });
    const notDone = new ActionResult({ extractedContent: "mid" });
    attachDownloadsToDoneResults(
      [notDone, done],
      [
        { path: "C:/Users/u/Downloads/dummy.pdf" },
        { path: null }, // 无 filePath 的 completed（协议文档形态）——跳过
        { path: "D:/tmp/model-given.pdf" }, // 与既有附件重复——去重（Python :139-141 同语义：
        // 只对 attachments 既有集去重，不对传入列表内部去重）
      ],
    );
    expect(notDone.attachments).toBeNull(); // 非 done 结果不动
    expect(done.attachments).toEqual(["D:/tmp/model-given.pdf", "C:/Users/u/Downloads/dummy.pdf"]);
  });
});
