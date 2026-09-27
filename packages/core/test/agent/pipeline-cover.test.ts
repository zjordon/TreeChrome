// 4.4 定向覆盖补块：actionability 探索等待真路径 / interacted 投影命中 /
// 站点级 skill 注入 / reconnect 耗尽 / 决策日志脱敏 / 内梯 fallback（参数连败）。
import { describe, expect, it } from "vitest";
import type { AgentOptions } from "../../src/agent/agent.js";
import { Agent } from "../../src/agent/agent.js";
import type { AgentSettings } from "../../src/agent/settings.js";
import { redactParamsForLog } from "../../src/agent/step/think.js";
import type { BrowserSession } from "../../src/browser/session.js";
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

describe("actionability 探索等待真路径", () => {
  it("click 白名单 + selectorMap 节点就绪 → 等待通过后执行（无 file-input 短路）", async () => {
    const browser = new FakeAgentBrowser();
    browser.state = makeState({
      selectorEntries: new Map([
        [5, makeNode({ backendNodeId: 5, nodeName: "BUTTON", nodeValue: "Go" })],
      ]),
    });
    const { agent, llm } = make(
      [
        ok({
          action: { name: "click", params: { index: 5 } },
          actions: [{ name: "click", params: { index: 5 } }],
        }),
        ok(doneOutput()),
      ],
      browser,
      { settings: { explorationActionabilityCheck: true } as Partial<AgentSettings> },
    );
    const history = await agent.run();
    // 等待路径通过（节点 actionable 立即返回）；click 执行成功回显
    expect(history.history[0].result[0].extractedContent).toContain("Clicked");
    // 站点 skill 未配置 → state 无 [Domain Skill]
    const stateText = llm.calls[0].messages
      .filter((m) => m.role === "user")
      .map((m) => (m as { blocks: Array<{ text: string }> }).blocks.map((b) => b.text).join(""))
      .join("");
    expect(stateText).not.toContain("[Domain Skill]");
  });
});

describe("interacted 投影命中", () => {
  it("click 带 index 且 selectorMap 命中 → 投影 dict（x_path/element_hash 字段）", async () => {
    const browser = new FakeAgentBrowser();
    browser.state = makeState({
      selectorEntries: new Map([
        [5, makeNode({ backendNodeId: 5, nodeName: "BUTTON", nodeValue: "Go" })],
      ]),
    });
    const { agent } = make(
      [
        ok({
          action: { name: "click", params: { index: 5 } },
          actions: [{ name: "click", params: { index: 5 } }],
        }),
        ok(doneOutput()),
      ],
      browser,
      { settings: { explorationActionabilityCheck: true } as Partial<AgentSettings> },
    );
    const history = await agent.run();
    const projected = history.history[0].interactedElement?.[0];
    expect(projected).not.toBeNull();
    expect(projected).toMatchObject({ backend_node_id: 5 });
    expect(Object.hasOwn(projected as object, "element_hash")).toBe(true);
  });
});

describe("站点级 skill 注入", () => {
  it("enableSkillInjection + loadHostSkill 命中 → [Domain Skill] 渲染（三段头）", async () => {
    const browser = new FakeAgentBrowser();
    const { agent, llm } = make([ok(doneOutput())], browser, {
      skillSource: {
        loadHostSkill: async () => ({ sop: "open grid first", selectors: "", quirks: "" }),
        taskCatalog: async () => [],
        taskCardText: async () => "",
      },
    });
    await agent.run();
    const stateText = llm.calls[0].messages
      .filter((m) => m.role === "user")
      .map((m) => (m as { blocks: Array<{ text: string }> }).blocks.map((b) => b.text).join(""))
      .find((t) => t.includes("[Domain Skill]"));
    expect(stateText).toContain("[SOP]\nopen grid first");
    // [SELECTORS]/[QUIRKS] 空段跳过
    expect(stateText).not.toContain("[SELECTORS]");
  });
});

describe("reconnect 耗尽", () => {
  it("连接错误且 reconnect 恒失败 → stopped=true 终止", async () => {
    const browser = new FakeAgentBrowser();
    browser.reconnectResult = false;
    const { agent } = make([{ throw: new Error("WebSocket connection closed") }], browser, {
      settings: { reconnectTimeout: 0 },
    });
    const history = await agent.run();
    expect(agent.state.stopped).toBe(true);
    expect(history.history).toHaveLength(0);
  });
});

describe("决策日志脱敏", () => {
  it("敏感字段替换（input_text.text）；非敏感动作原样", () => {
    const map = { password: "hunter2" };
    expect(redactParamsForLog("input_text", { index: 1, text: "use hunter2 now" }, map)).toEqual({
      index: 1,
      text: "use <secret>password</secret> now",
    });
    expect(redactParamsForLog("click", { index: 1 }, map)).toEqual({ index: 1 });
    expect(redactParamsForLog("navigate", { url: "https://x" }, null)).toEqual({
      url: "https://x",
    });
  });
});

describe("内梯参数连败 → fallback done", () => {
  it("参数恒无效（3 次重试耗尽后仍无效）→ proceeding anyway / fallback", async () => {
    const browser = new FakeAgentBrowser();
    const bad = ok({
      action: { name: "click", params: { foo: 1 } }, // 未知字段（extra forbid）
      actions: [{ name: "click", params: { foo: 1 } }],
    });
    const { agent, llm } = make([bad, bad, bad, bad, ok(doneOutput())], browser);
    const history = await agent.run();
    // 首调 + 3 次参数重试后仍无效 → proceeding anyway（valid shape 但参数错）→ 执行报 Unknown action 不算 done
    expect(llm.calls.length).toBeGreaterThanOrEqual(4);
    expect(history.isDone()).toBe(true); // 末条 done 兜底
  });
});
