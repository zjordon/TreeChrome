// 权限门挂点集成（4.5，04 §2）：deny 回流文案/denied 标记/不计 consecutiveFailures/
// 余下动作截断/ToolResultEvent error 通道 + READ 不过门 + navigate 目标 URL 计费 +
// allow-once 复查免问 + 回合结束清 once + session_end 收口。Agent 全流程驱动
// （FakeAgentLLM + FakeAgentBrowser + 真 PolicyGate）。

import { describe, expect, it } from "vitest";
import type { AgentOptions } from "../../src/agent/agent.js";
import { Agent } from "../../src/agent/agent.js";
import type { AgentSettings } from "../../src/agent/settings.js";
import { postProcess } from "../../src/agent/step/post.js";
import { SUBMIT_PROBE_JS } from "../../src/agent/submit-probe.js";
import { ActionResult } from "../../src/agent/views.js";
import type { BrowserSession } from "../../src/browser/session.js";
import { EventBus } from "../../src/events/event-bus.js";
import type { TwEvent } from "../../src/events/events.js";
import { AutoAllowPolicy } from "../../src/policy/auto-allow.js";
import {
  type PermissionRequest,
  type PermissionVerdict,
  PolicyGate,
  type SubmitFieldSummary,
} from "../../src/policy/policy.js";
import { makeNode } from "../tools/fake-browser.js";
import { FakeAgentBrowser, FakeAgentLLM, type LlmScriptEntry, makeState } from "./fixtures.js";

function makeAgent(
  script: LlmScriptEntry[],
  browser: FakeAgentBrowser,
  options: {
    policy?: AgentOptions["policy"];
    eventBus?: EventBus;
    overrides?: Partial<AgentSettings>;
  } = {},
): Agent {
  const llm = new FakeAgentLLM(script);
  return new Agent({
    task: "Open https://a.example and finish",
    llm: llm.asLLMClient(),
    browser: browser as unknown as BrowserSession,
    settings: {
      judge: { enabled: false },
      explorationActionabilityCheck: false,
      maxSteps: 10,
      llmTimeout: 30,
      ...options.overrides,
    } as AgentSettings,
    sleep: () => Promise.resolve(),
    now: () => 1000,
    log: () => {},
    policy: options.policy ?? null,
    eventBus: options.eventBus ?? null,
  });
}

function recordingInteraction(verdicts: PermissionVerdict[]) {
  const seen: PermissionRequest[] = [];
  const interaction = {
    requestPermission: async (req: PermissionRequest): Promise<PermissionVerdict> => {
      seen.push(req);
      return verdicts[seen.length - 1] ?? "deny";
    },
    confirmSubmit: async () => true,
  };
  return { seen, interaction };
}

const ok = (toolInput: Record<string, unknown>): LlmScriptEntry => ({ kind: "ok", toolInput });
const clickWaitStep = () =>
  ok({
    evaluation_previous_goal: "",
    memory: "m",
    next_goal: "click then wait",
    action: { name: "click", params: { index: 1 } },
    actions: [
      { name: "click", params: { index: 1 } },
      { name: "wait", params: { seconds: 1 } },
    ],
  });
const doneStep = () =>
  ok({
    evaluation_previous_goal: "done",
    memory: "m",
    next_goal: "finish",
    action: { name: "done", params: { text: "Task done", success: true } },
    actions: [{ name: "done", params: { text: "Task done", success: true } }],
  });

describe("act 挂点：deny 通道", () => {
  it("denied 结果：文案逐字 + denied 标记 + 不计失败 + 余下动作截断", async () => {
    const browser = new FakeAgentBrowser();
    const { seen, interaction } = recordingInteraction(["deny", "deny", "deny", "deny"]);
    const agent = makeAgent([clickWaitStep(), doneStep()], browser, {
      policy: new PolicyGate(interaction),
    });
    const history = await agent.run();

    const step1 = history.history[0];
    expect(step1.result).toHaveLength(1); // wait 被 error 守卫截断
    expect(step1.result[0].denied).toBe(true);
    expect(step1.result[0].error).toBe("用户拒绝在 a.example 上 点击，不要重试，可改道或询问");
    expect(step1.result[0].success).toBe(false);
    expect(seen[0]).toMatchObject({ capability: "CLICK", host: "a.example", actionName: "click" });
    // 不计 consecutiveFailures（04 §2）——run 不因权限拒绝耗尽失败预算
    expect(agent.state.consecutiveFailures).toBe(0);
    // done 正常收口（denied 不终止 run）
    expect(history.isDone()).toBe(true);
    expect(history.isSuccessful()).toBe(true);
  });

  it("denied 动作照常发 ToolResultEvent（error 通道）", async () => {
    const browser = new FakeAgentBrowser();
    const bus = new EventBus();
    const events: TwEvent[] = [];
    bus.subscribe("*", (e) => events.push(e));
    const { interaction } = recordingInteraction(["deny", "deny", "deny", "deny"]);
    const agent = makeAgent([clickWaitStep(), doneStep()], browser, {
      policy: new PolicyGate(interaction),
      eventBus: bus,
    });
    await agent.run();

    const toolResults = events.filter((e) => e.eventType === "tool_result");
    const deniedResult = toolResults.find((r) => r.error !== null);
    expect(deniedResult).toBeDefined();
    expect(deniedResult?.error).toContain("用户拒绝在 a.example 上 点击");
    expect(deniedResult?.success).toBe(false);
    // 事件序列收口：session_end 在 close 前发出（04 §4 补齐）
    const types = events.map((e) => e.eventType);
    expect(types[types.length - 1]).toBe("session_end");
    const sessionEnd = events.find((e) => e.eventType === "session_end");
    expect(sessionEnd?.totalSteps).toBe(2);
  });

  it("denied 单动作步不计且清零；非 denied 错误步照计（post.ts 计数面）", async () => {
    const agent = makeAgent([], new FakeAgentBrowser());
    const denied = new ActionResult({
      success: false,
      denied: true,
      error: "用户拒绝在 a.example 上 点击，不要重试，可改道或询问",
    });
    agent.state.consecutiveFailures = 2;
    postProcess(agent, [denied], { action: { name: "click", params: {} }, actions: [] });
    expect(agent.state.consecutiveFailures).toBe(0); // 不计且与成功步同规则清零
    const realErr = new ActionResult({ error: "boom" });
    postProcess(agent, [realErr], { action: { name: "click", params: {} }, actions: [] });
    expect(agent.state.consecutiveFailures).toBe(1); // 真失败照计
  });
});

describe("act 挂点：直过与计费面", () => {
  it("READ 动作不过门（wait/extract 不问交互）", async () => {
    const browser = new FakeAgentBrowser();
    const { seen, interaction } = recordingInteraction(["deny", "deny"]);
    const waitStep = ok({
      evaluation_previous_goal: "",
      memory: "",
      next_goal: "wait",
      action: { name: "wait", params: { seconds: 1 } },
      actions: [{ name: "wait", params: { seconds: 1 } }],
    });
    const agent = makeAgent([waitStep, doneStep()], browser, {
      policy: new PolicyGate(interaction),
    });
    const history = await agent.run();
    expect(seen.length).toBe(0); // 全程无门问询
    expect(history.isDone()).toBe(true);
  });

  it("navigate 按目标 URL 计费（host=b.example 而非当前页）", async () => {
    const browser = new FakeAgentBrowser();
    const { seen, interaction } = recordingInteraction(["allow-once", "deny"]);
    const navStep = ok({
      evaluation_previous_goal: "",
      memory: "",
      next_goal: "nav",
      action: { name: "navigate", params: { url: "https://b.example/x" } },
      actions: [{ name: "navigate", params: { url: "https://b.example/x" } }],
    });
    const agent = makeAgent([navStep, doneStep()], browser, {
      policy: new PolicyGate(interaction),
    });
    await agent.run();
    expect(seen[0]).toMatchObject({ capability: "NAVIGATE", host: "b.example" });
  });

  it("allow-once 后同键复查免问；run 结束清 once（复问）", async () => {
    const browser = new FakeAgentBrowser();
    const { seen, interaction } = recordingInteraction([
      "allow-once", // 步 1 click 首问
      "deny",
      "deny",
      "deny",
    ]);
    const gate = new PolicyGate(interaction);
    const agent = makeAgent([clickWaitStep(), clickWaitStep(), doneStep()], browser, {
      policy: gate,
    });
    await agent.run();
    // 步 1 首问 allow-once；步 2 同键 (CLICK,a.example,TAB1) once 命中免问
    expect(seen).toHaveLength(1);
    // run 结束清 once：门上直查同键 → 重新问（队列下一项 deny）
    const out = await gate.check({
      capability: "CLICK",
      host: "a.example",
      actionName: "click",
      params: {},
      tabId: "ABCD1234",
      elementIndex: null,
      elementBbox: null,
      elementXpath: null,
    });
    expect(out.allowed).toBe(false);
    expect(seen).toHaveLength(2);
  });

  it("policy 未装配（null）直通——不设门", async () => {
    const browser = new FakeAgentBrowser();
    const agent = makeAgent([clickWaitStep(), doneStep()], browser, {});
    const history = await agent.run();
    expect(history.isDone()).toBe(true);
    expect(history.history[0].result[0].denied ?? false).toBe(false);
  });
});

describe("act 挂点：submit 预确认二道门（M5 段 C）", () => {
  const SUMMARY = [
    { name: "user", value: "alice" },
    { name: "pwd", value: "***" },
  ];
  /** 按钮（submit 候选）进 selectorMap 的 state */
  const stateWithNode = (node: ReturnType<typeof makeNode>) =>
    makeState({ selectorEntries: new Map([[1, node]]) });
  const clickDone = () => [clickWaitStep(), doneStep()] as LlmScriptEntry[];

  /** interaction：requestPermission 恒 allow-once；confirmSubmit 可编程 */
  const submitInteraction = (confirm: boolean | Error) => {
    const confirmSeen: Array<{ req: PermissionRequest; summary: unknown }> = [];
    return {
      confirmSeen,
      interaction: {
        requestPermission: async () => "allow-once" as PermissionVerdict,
        confirmSubmit: async (req: PermissionRequest, summary: SubmitFieldSummary[]) => {
          confirmSeen.push({ req, summary });
          if (confirm instanceof Error) throw confirm;
          return confirm;
        },
      },
    };
  };

  it("enabled + submit 候选 + probe 摘要 → confirmSubmit 被调一次；deny → 提交表单文案 + 不计失败", async () => {
    const browser = new FakeAgentBrowser(
      stateWithNode(makeNode({ nodeName: "BUTTON", backendNodeId: 9 })),
    );
    browser.evalFunctionResult = SUMMARY;
    const { confirmSeen, interaction } = submitInteraction(false);
    const agent = makeAgent(clickDone(), browser, {
      policy: new PolicyGate(interaction),
      overrides: { submitConfirmEnabled: true },
    });
    const history = await agent.run();
    expect(confirmSeen).toHaveLength(1);
    expect(confirmSeen[0]?.summary).toEqual(SUMMARY);
    expect(browser.evalFunctionCalls).toEqual([{ backendNodeId: 9, fn: SUBMIT_PROBE_JS }]);
    const step1 = history.history[0];
    expect(step1.result[0].denied).toBe(true);
    expect(step1.result[0].error).toBe("用户拒绝在 a.example 上提交表单，不要重试，可改道或询问");
    expect(step1.result[0].success).toBe(false);
    expect(agent.state.consecutiveFailures).toBe(0); // 与权限 deny 同款记账
    expect(history.isDone()).toBe(true); // denied 不终止 run
  });

  it("enabled + confirmSubmit 放行 → 点击照常执行", async () => {
    const browser = new FakeAgentBrowser(
      stateWithNode(makeNode({ nodeName: "BUTTON", backendNodeId: 9 })),
    );
    browser.evalFunctionResult = SUMMARY;
    const { confirmSeen, interaction } = submitInteraction(true);
    const agent = makeAgent(clickDone(), browser, {
      policy: new PolicyGate(interaction),
      overrides: { submitConfirmEnabled: true },
    });
    const history = await agent.run();
    expect(confirmSeen).toHaveLength(1);
    expect(history.history[0].result[0].denied ?? false).toBe(false);
    expect(history.history[0].result[0].error).toBeNull();
  });

  it("enabled + 非 submit 候选（DIV）→ 预筛短路：零 probe 零 confirmSubmit", async () => {
    const browser = new FakeAgentBrowser(
      stateWithNode(makeNode({ nodeName: "DIV", backendNodeId: 9 })),
    );
    const { confirmSeen, interaction } = submitInteraction(false);
    const agent = makeAgent(clickDone(), browser, {
      policy: new PolicyGate(interaction),
      overrides: { submitConfirmEnabled: true },
    });
    const history = await agent.run();
    expect(browser.evalFunctionCalls).toHaveLength(0);
    expect(confirmSeen).toHaveLength(0);
    expect(history.history[0].result[0].denied ?? false).toBe(false);
  });

  it("enabled + probe 无变更字段（null）→ 不确认，点击直过", async () => {
    const browser = new FakeAgentBrowser(
      stateWithNode(makeNode({ nodeName: "BUTTON", backendNodeId: 9 })),
    );
    browser.evalFunctionResult = null;
    const { confirmSeen, interaction } = submitInteraction(false);
    const agent = makeAgent(clickDone(), browser, {
      policy: new PolicyGate(interaction),
      overrides: { submitConfirmEnabled: true },
    });
    const history = await agent.run();
    expect(browser.evalFunctionCalls).toHaveLength(1); // probe 跑了
    expect(confirmSeen).toHaveLength(0); // 但无摘要不确认
    expect(history.history[0].result[0].denied ?? false).toBe(false);
  });

  it("红向保真：缺省（不设 submitConfirmEnabled）→ 全链零调用零 probe", async () => {
    const browser = new FakeAgentBrowser(
      stateWithNode(makeNode({ nodeName: "BUTTON", backendNodeId: 9 })),
    );
    browser.evalFunctionResult = SUMMARY;
    const { confirmSeen, interaction } = submitInteraction(false);
    const agent = makeAgent(clickDone(), browser, { policy: new PolicyGate(interaction) });
    const history = await agent.run();
    expect(browser.evalFunctionCalls).toHaveLength(0);
    expect(confirmSeen).toHaveLength(0);
    expect(history.history[0].result[0].denied ?? false).toBe(false);
  });

  it("enabled + AutoAllowPolicy → confirmSubmit=true 恒过（评测形态零阻塞）", async () => {
    const browser = new FakeAgentBrowser(
      stateWithNode(makeNode({ nodeName: "BUTTON", backendNodeId: 9 })),
    );
    browser.evalFunctionResult = SUMMARY;
    const auto = new AutoAllowPolicy();
    const agent = makeAgent(clickDone(), browser, {
      policy: new PolicyGate(auto),
      overrides: { submitConfirmEnabled: true },
    });
    const history = await agent.run();
    expect(history.history[0].result[0].denied ?? false).toBe(false);
    expect(history.history[0].result[0].error).toBeNull();
  });
});
