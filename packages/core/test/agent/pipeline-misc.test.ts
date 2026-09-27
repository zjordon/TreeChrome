// 覆盖补充组 2：动作超时竞速 / ToolCallEvent 元素几何（bounds 命中）/
// 新标签页 step 0 视觉跳过 / enableMessageTyping=false 回退 append。

import { SerializedDOMState } from "@tw/dom-snapshot";
import { describe, expect, it } from "vitest";
import type { AgentOptions } from "../../src/agent/agent.js";
import { Agent } from "../../src/agent/agent.js";
import type { AgentSettings } from "../../src/agent/settings.js";
import type { BrowserSession } from "../../src/browser/session.js";
import { EventBus } from "../../src/events/event-bus.js";
import type { ToolCallEvent, TwEvent } from "../../src/events/events.js";
import { makeNode } from "../tools/fake-browser.js";
import { FakeAgentBrowser, FakeAgentLLM, type LlmScriptEntry, makeState } from "./fixtures.js";

const ok = (toolInput: Record<string, unknown>): LlmScriptEntry => ({ kind: "ok", toolInput });
const doneOutput = () => ({
  evaluation_previous_goal: "done",
  memory: "m",
  next_goal: "finish",
  action: { name: "done", params: { text: "Task done" } },
  actions: [{ name: "done", params: { text: "Task done" } }],
});

function make(
  script: LlmScriptEntry[],
  browser: FakeAgentBrowser,
  mkOpts: Omit<Partial<AgentOptions>, "settings"> & { settings?: Partial<AgentSettings> } = {},
) {
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

describe("动作超时竞速", () => {
  it("handler 慢于 actionTimeout=0 → 超时 error 结果（序列终止）", async () => {
    const browser = new FakeAgentBrowser();
    browser.navigate = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return null;
    };
    const { agent } = make(
      [
        ok({
          action: { name: "navigate", params: { url: "https://slow.example" } },
          actions: [{ name: "navigate", params: { url: "https://slow.example" } }],
        }),
        ok(doneOutput()),
      ],
      browser,
      { settings: { actionTimeout: 0 } as Partial<AgentSettings> },
    );
    const history = await agent.run();
    expect(history.history[0].result[0].error).toBe("Action timed out after 0s");
    expect(history.isDone()).toBe(true); // 第二步 done 兜底
  });
});

describe("ToolCallEvent 元素几何", () => {
  it("node 带 snapshotNode.bounds → elementBbox 原始坐标 + elementXpath", async () => {
    const browser = new FakeAgentBrowser();
    const node = makeNode({ backendNodeId: 5, nodeName: "BUTTON", nodeValue: "Go" });
    node.snapshotNode = {
      is_clickable: null,
      cursor_style: null,
      bounds: { x: 10, y: 20, width: 100, height: 40, toDict: () => ({}) } as never,
      clientRects: null,
      scrollRects: null,
      computed_styles: null,
      paint_order: null,
      stacking_contexts: null,
    };
    browser.state = makeState({ selectorEntries: new Map([[5, node]]) });
    const bus = new EventBus({ log: () => {} });
    const toolCalls: ToolCallEvent[] = [];
    bus.subscribe("tool_call", (e: TwEvent) => toolCalls.push(e as ToolCallEvent));
    const { agent } = make(
      [
        ok({
          action: { name: "click", params: { index: 5 } },
          actions: [{ name: "click", params: { index: 5 } }],
        }),
        ok(doneOutput()),
      ],
      browser,
      { eventBus: bus },
    );
    await agent.run();
    bus.close();
    expect(toolCalls).toHaveLength(2); // click + done
    expect(toolCalls[0].elementBbox).toEqual({ left: 10, top: 20, width: 100, height: 40 });
    expect(toolCalls[0].elementIndex).toBe(5);
  });
});

describe("新标签页 step 0 视觉跳过", () => {
  it("url=about:blank 且 DOM 空 → 不带图（即便视觉门开且有截图）", async () => {
    const browser = new FakeAgentBrowser();
    const empty = makeState({
      url: "about:blank",
      title: "",
      treeText: "",
      selectorEntries: new Map(),
    });
    browser.state = {
      ...empty,
      domState: new SerializedDOMState(null, new Map(), "", [], []),
      screenshot: new Uint8Array([9]),
    };
    const { agent, llm } = make([ok(doneOutput())], browser, {
      task: "Just finish", // 无 URL → 无初始导航，step 0 停留在 about:blank
      settings: { useVision: true } as Partial<AgentSettings>,
    });
    (llm as unknown as { model: string }).model = "glm-4.5v";
    await agent.run();
    const stateMsg = agent.messages.find((m) => m.kind === "state");
    const blocks = (stateMsg!.message as { blocks: Array<{ kind: string }> }).blocks;
    expect(blocks.every((b) => b.kind === "text")).toBe(true);
  });
});

describe("enableMessageTyping=false 回退", () => {
  it("消息全部 plain 追加（state 不替换、history 不单独维护）", async () => {
    const browser = new FakeAgentBrowser();
    const waitAct = { name: "wait", params: { seconds: 1 } };
    const { agent, llm } = make(
      [ok({ action: waitAct, actions: [waitAct] }), ok(doneOutput())],
      browser,
      { settings: { enableMessageTyping: false } as Partial<AgentSettings> },
    );
    await agent.run();
    expect(agent.messages.every((m) => m.kind === "plain")).toBe(true);
    // state 消息累积（不替换）：两步 ≥ 2 条 user state 文本
    expect(agent.messages.length).toBeGreaterThanOrEqual(4);
    // LLM 侧仍收到纯消息
    expect(llm.calls[1].messages.length).toBeLessThanOrEqual(20);
  });
});

describe("敏感 URL 过滤与 done 字符串 success", () => {
  it("[Available Secrets] 按 urls fnmatch 过滤（命中列名/不命中省段）", async () => {
    const browser = new FakeAgentBrowser();
    const mk = (sensitiveData: Record<string, unknown>) => {
      const llm = new FakeAgentLLM([ok(doneOutput())]);
      const agent = new Agent({
        task: "T",
        llm: llm.asLLMClient(),
        browser: browser as unknown as BrowserSession,
        settings: {
          judge: { enabled: false },
          explorationActionabilityCheck: false,
        } as unknown as AgentSettings,
        sensitiveData: sensitiveData as never,
        sleep: () => Promise.resolve(),
        now: () => 1000,
        log: () => {},
      });
      return { agent, llm };
    };
    const hit = mk({
      password: { value: "x", urls: ["https://a.example*"] },
      token: { value: "y", urls: ["https://other/*"] },
    });
    await hit.agent.run();
    const hitText = hit.llm.calls[0].messages
      .filter((m) => m.role === "user")
      .map((m) => (m as { blocks: Array<{ text: string }> }).blocks.map((b) => b.text).join(""))
      .find((t) => t.includes("[Available Secrets]"));
    expect(hitText ?? "").toContain("password");
    expect(hitText ?? "").not.toContain("token");
    const miss = mk({ token: { value: "y", urls: ["https://other/*"] } });
    await miss.agent.run();
    const missText = miss.llm.calls[0].messages
      .filter((m) => m.role === "user")
      .map((m) => (m as { blocks: Array<{ text: string }> }).blocks.map((b) => b.text).join(""))
      .find((t) => t.includes("[Available Secrets]"));
    expect(missText).toBeUndefined(); // 全被滤掉 → 整段不渲染
  });
  it("done params success='false'（字符串）→ 不进门禁（lax 强转后 not bool）", async () => {
    const browser = new FakeAgentBrowser();
    const llm = new FakeAgentLLM([]);
    llm.script = [
      ok({
        evaluation_previous_goal: "still unknown bits",
        memory: "a gap",
        next_goal: "done",
        action: { name: "done", params: { text: "R", success: "false" } },
        actions: [{ name: "done", params: { text: "R", success: "false" } }],
      }),
    ];
    const agent = new Agent({
      task: "T",
      llm: llm.asLLMClient(),
      browser: browser as unknown as BrowserSession,
      settings: {
        judge: { enabled: false },
        explorationActionabilityCheck: false,
      } as unknown as AgentSettings,
      sleep: () => Promise.resolve(),
      now: () => 1000,
      log: () => {},
    });
    const history = await agent.run();
    expect(agent.state.doneGateUses).toBe(0);
    expect(llm.calls).toHaveLength(1);
    expect(history.isDone()).toBe(true);
  });
});
