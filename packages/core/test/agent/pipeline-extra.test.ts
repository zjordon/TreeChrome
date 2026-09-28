// 4.4 pipeline 补充覆盖：Guard#4 terminatesSequence / interacted 投影 / 下载通知 /
// obs 事件流 / 视觉门与截图落盘 / judge 接线 / 任务级 skill 注入 / 消息压缩集成。
import { describe, expect, it } from "vitest";
import type { AgentOptions } from "../../src/agent/agent.js";
import { Agent } from "../../src/agent/agent.js";
import type { AgentSettings } from "../../src/agent/settings.js";
import type { BrowserSession } from "../../src/browser/session.js";
import { EventBus } from "../../src/events/event-bus.js";
import type { TwEvent } from "../../src/events/events.js";
import { FakeAgentBrowser, FakeAgentLLM, type LlmScriptEntry, makeState } from "./fixtures.js";

const ok = (toolInput: Record<string, unknown>): LlmScriptEntry => ({ kind: "ok", toolInput });
const doneOutput = () => ({
  evaluation_previous_goal: "done",
  memory: "m",
  next_goal: "finish",
  action: { name: "done", params: { text: "Task done" } },
  actions: [{ name: "done", params: { text: "Task done" } }],
});
const waitAct = { name: "wait", params: { seconds: 1 } };

type MkOpts = Omit<Partial<AgentOptions>, "settings"> & { settings?: Partial<AgentSettings> };

function make(script: LlmScriptEntry[], browser: FakeAgentBrowser, mkOpts: MkOpts = {}) {
  const { settings, ...rest } = mkOpts;
  const llm = new FakeAgentLLM(script);
  const agent = new Agent({
    task: "Open https://a.example and finish",
    llm: llm.asLLMClient(),
    browser: browser as unknown as BrowserSession,
    settings: {
      judge: { enabled: false },
      explorationActionabilityCheck: false,
      maxSteps: 10,
      llmTimeout: 30,
      ...settings,
    } as unknown as AgentSettings,
    sleep: () => Promise.resolve(),
    now: () => 1000,
    log: () => {},
    ...rest,
  });
  return { agent, llm };
}

describe("Act 守卫与投影补充", () => {
  it("Guard#4：terminatesSequence（navigate）后剩余动作跳过", async () => {
    const browser = new FakeAgentBrowser();
    const { agent } = make(
      [
        ok({
          action: { name: "navigate", params: { url: "https://a.example/x" } },
          actions: [
            { name: "navigate", params: { url: "https://a.example/x" } },
            { name: "wait", params: { seconds: 1 } },
          ],
        }),
        ok(doneOutput()),
      ],
      browser,
    );
    const history = await agent.run();
    expect(history.history[0].result).toHaveLength(1); // navigate 终止序列
    expect(history.isDone()).toBe(true);
  });
  it("interactedElement 投影：等长按位（有 index 命中 dict / 无 index null）", async () => {
    const browser = new FakeAgentBrowser();
    browser.state = makeState({
      selectorEntries: new Map([[5, { backendNodeId: 5, xpath: "//button" }]]),
    });
    const { agent } = make(
      [
        ok({
          action: { name: "wait", params: { seconds: 1 } },
          actions: [
            { name: "navigate", params: { url: "https://a.example" } }, // 无 index → null
          ],
        }),
        ok(doneOutput()),
      ],
      browser,
    );
    const history = await agent.run();
    // navigate 无 index；投影等长且 null（节点投影路径经 selectorMap 命中分支在另一用例）
    expect(history.history[0].interactedElement).toEqual([null]);
  });
  it("下载通知进下一步 state 消息", async () => {
    const browser = new FakeAgentBrowser();
    const { agent, llm } = make(
      [ok({ action: waitAct, actions: [waitAct] }), ok(doneOutput())],
      browser,
      { settings: { trackDownloads: true } },
    );
    browser.downloads.push({
      filename: "a.pdf",
      url: "https://a.example/a.pdf",
      path: "C:/dl/a.pdf",
    });
    await agent.run();
    const secondCallText = llm.calls[1].messages
      .filter((m) => m.role === "user")
      .map((m) => (m as { blocks: Array<{ text: string }> }).blocks.map((b) => b.text).join(""))
      .find((t) => t.includes("[Downloads]"));
    expect(secondCallText).toContain("[Downloads] New files available: a.pdf");
  });
});

describe("obs 事件流", () => {
  it("EventBus 全链事件（step_start→model_call→model_result→skill_active→tool_call→tool_result→step_end→session_end）", async () => {
    const browser = new FakeAgentBrowser();
    const bus = new EventBus({ log: () => {} });
    const events: string[] = [];
    bus.subscribe("*", (e: TwEvent) => events.push(e.eventType));
    const { agent } = make([ok(doneOutput())], browser, { eventBus: bus });
    await agent.run();
    // 事件序：Sense 的 skill_active 先于 Think 的 model_call；session_end 由 run
    // finally 收口（4.5 补齐，close 前最后一声）
    expect(events).toEqual([
      "step_start",
      "skill_active",
      "model_call",
      "model_result",
      "tool_call",
      "tool_result",
      "step_end",
      "session_end",
    ]);
    bus.close();
  });
});

describe("视觉门与截图", () => {
  it("视觉开（视觉名单模型）→ blocks 消息 + 截图落盘（fs writeBytes）", async () => {
    const browser = new FakeAgentBrowser();
    const withShot = makeState({ selectorEntries: new Map() });
    browser.state = { ...withShot, screenshot: new Uint8Array([1, 2, 3]) };
    const writes: string[] = [];
    const { agent, llm } = make([ok(doneOutput())], browser, {
      settings: { useVision: true },
      fs: {
        resolve: (p) => p,
        appendTextFile: async () => {},
        isFile: async () => true,
        readTextFile: async () => "",
        ensureDir: async () => {},
        writeTextFile: async () => {},
        writeBytes: async (p) => {
          writes.push(p);
        },
        stat: async () => null,
        readHead: async () => null,
      },
      rerunHistoryDir: "rh",
    });
    (llm as unknown as { model: string }).model = "glm-4.5v"; // 视觉名单形态
    await agent.run();
    // state 消息升级为 [text, image] blocks
    const stateMsg = agent.messages.find((m) => m.kind === "state");
    const blocks = (stateMsg!.message as { blocks: Array<{ kind: string }> }).blocks;
    expect(blocks.some((b) => b.kind === "image")).toBe(true);
    expect(writes).toEqual(["rh/screenshots/step_000.png"]);
    // LLM 收到的是剥离信封的纯消息（含 image block）
    const llmState = llm.calls[0].messages.find(
      (m) =>
        m.role === "user" &&
        (m as { blocks: Array<{ kind: string }> }).blocks.some((b) => b.kind === "image"),
    );
    expect(llmState).toBeTruthy();
  });
  it("视觉关 → 纯文本 state（无 image block）", async () => {
    const browser = new FakeAgentBrowser();
    browser.state = {
      ...makeState({ selectorEntries: new Map() }),
      screenshot: new Uint8Array([1]),
    };
    const { agent } = make([ok(doneOutput())], browser);
    await agent.run();
    const stateMsg = agent.messages.find((m) => m.kind === "state");
    const blocks = (stateMsg!.message as { blocks: Array<{ kind: string }> }).blocks;
    expect(blocks.every((b) => b.kind === "text")).toBe(true);
  });
});

describe("judge 接线", () => {
  it("done(success) 后跑 judge → verdict 写入最后 done result.judgement", async () => {
    const browser = new FakeAgentBrowser();
    const llm = new FakeAgentLLM([ok(doneOutput())]);
    llm.singleShot = async () => ({
      text: "",
      toolCalls: [
        {
          id: "j1",
          name: "agent_response",
          args: {
            reasoning: "r",
            verdict: false,
            failure_reason: "wrong page",
            impossible_task: false,
            captcha: false,
          },
        },
      ],
      stopReason: "tool_call",
      usage: null,
    });
    const agent = new Agent({
      task: "T",
      llm: llm.asLLMClient(),
      browser: browser as unknown as BrowserSession,
      settings: {
        judge: { enabled: true },
        explorationActionabilityCheck: false,
      } as unknown as AgentSettings,
      sleep: () => Promise.resolve(),
      now: () => 1000,
      log: () => {},
    });
    const history = await agent.run();
    const last = history.history[history.history.length - 1].result[0];
    expect(last.judgement).toMatchObject({ verdict: false, failureReason: "wrong page" });
  });
});

describe("任务级 skill 注入", () => {
  it("匹配命中 → [Task Skill] 进 state 消息；未命中 → 不注入", async () => {
    const browser = new FakeAgentBrowser();
    const llm = new FakeAgentLLM([ok(doneOutput())]);
    llm.structuredCall = async () => ({
      match: "card-a",
      confidence: "high",
      reason: "same template",
      match_kind: "same_template",
      task_kind: "read",
    });
    const skillSource = {
      loadHostSkill: async () => null,
      taskCatalog: async () => [{ slug: "card-a", description: "Do the thing" }],
      taskCardText: async () => "Step 1: do it",
    };
    const agent = new Agent({
      task: "Do the equivalent thing",
      llm: llm.asLLMClient(),
      browser: browser as unknown as BrowserSession,
      settings: {
        enableTaskSkillInjection: true,
        judge: { enabled: false },
        explorationActionabilityCheck: false,
      } as unknown as AgentSettings,
      skillSource,
      sleep: () => Promise.resolve(),
      now: () => 1000,
      log: () => {},
    });
    await agent.run();
    const stateText = llm.calls[0].messages
      .filter((m) => m.role === "user")
      .map((m) => (m as { blocks: Array<{ text: string }> }).blocks.map((b) => b.text).join(""))
      .find((t) => t.includes("[Task Skill]"));
    expect(stateText).toContain("[Task Skill]");
    expect(stateText).toContain("SAME operation template");
    expect(stateText).toContain("Step 1: do it");
    expect(agent.taskSkillSlug).toBe("card-a");
  });
});

describe("MessageCompactor 集成", () => {
  it("步数+字符双门过 → 消息列压成 [first, summary, tail]", async () => {
    const browser = new FakeAgentBrowser();
    const llm = new FakeAgentLLM([]);
    llm.singleShot = async () => ({
      text: "COMPACTED",
      toolCalls: [],
      stopReason: "stop",
      usage: null,
    });
    const waitEntry = ok({ action: waitAct, actions: [waitAct] });
    const agent = new Agent({
      task: "T https://a.example",
      llm: llm.asLLMClient(),
      browser: browser as unknown as BrowserSession,
      settings: {
        judge: { enabled: false },
        explorationActionabilityCheck: false,
        messageCompaction: {
          enabled: true,
          compactEveryNSteps: 1,
          triggerCharCount: 5,
          keepLastItems: 2,
          summaryMaxChars: null,
        },
      } as unknown as AgentSettings,
      sleep: () => Promise.resolve(),
      now: () => 1000,
      log: () => {},
    });
    void llm;
    void waitEntry;
    // 三步脚本：step2 的 maybeCompact（nSteps=1，间隔 1 达标 + 字符量超阈值）触发压缩
    llm.script = [
      ok({ action: waitAct, actions: [waitAct] }),
      ok({ action: waitAct, actions: [waitAct] }),
      ok(doneOutput()),
    ];
    await agent.run();
    const texts = agent.messages.map((m) =>
      m.message.role === "user" || m.message.role === "assistant"
        ? ((m.message as { blocks?: Array<{ text: string }> }).blocks
            ?.map((b) => (b as { text: string }).text)
            .join("") ?? "")
        : "",
    );
    expect(texts.some((t) => t.includes("[Conversation Summary]\nCOMPACTED"))).toBe(true);
    expect(agent.messages.length).toBeLessThan(10); // 压缩发生
  });
});
