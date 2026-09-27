// 4.4 配套纯件测试：plan-manager / actionability（判定矩阵+等待降级）/
// message-compactor（双门+丢图留文） / url-utils / agent_history 滑窗 fixture 锚定。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACTIONABILITY_ACTIONS,
  isActionable,
  isFileInput,
  waitForActionability,
} from "../../src/agent/actionability.js";
import { Agent } from "../../src/agent/agent.js";
import type { EnvelopedMessage } from "../../src/agent/message-compactor.js";
import { MessageCompactor } from "../../src/agent/message-compactor.js";
import { PlanManager } from "../../src/agent/plan-manager.js";
import type { AgentSettings } from "../../src/agent/settings.js";
import { extractHost, extractHostWithPort } from "../../src/agent/url-utils.js";
import { ActionResult, AgentHistory, AgentState } from "../../src/agent/views.js";
import type { BrowserSession } from "../../src/browser/session.js";
import { FakeAgentBrowser, FakeAgentLLM } from "./fixtures.js";

const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/python-anchors/agent.json", import.meta.url)),
    "utf8",
  ),
  // biome-ignore lint/suspicious/noExplicitAny: fixture 是外部 JSON 的弱形态读取面
) as Record<string, any>;

describe("PlanManager", () => {
  const pm = new PlanManager();
  it("render：四状态标记", () => {
    expect(
      pm.renderPlanDescription([
        { text: "a", status: "done" },
        { text: "b", status: "current" },
        { text: "c", status: "pending" },
        { text: "d", status: "skipped" },
      ]),
    ).toBe("[x] 0: a\n[>] 1: b\n[ ] 2: c\n[-] 3: d");
    expect(pm.renderPlanDescription(null)).toBeNull();
    expect(pm.renderPlanDescription([])).toBeNull();
  });
  it("update A：plan_update 整替 + 首步 current", () => {
    const state = new AgentState();
    state.nSteps = 3;
    pm.updateFromModelOutput(state, { plan_update: ["x", "y"] });
    expect(state.plan?.map((p) => p.text)).toEqual(["x", "y"]);
    expect(state.plan?.[0].status).toBe("current");
    expect(state.planGenerationStep).toBe(3);
  });
  it("update B：current_plan_item 前进（区间置 done、新位 current、越界钳制）", () => {
    const state = new AgentState();
    pm.updateFromModelOutput(state, { plan_update: ["a", "b", "c"] });
    pm.updateFromModelOutput(state, { current_plan_item: 2 });
    expect(state.plan?.map((p) => p.status)).toEqual(["done", "done", "current"]);
    pm.updateFromModelOutput(state, { current_plan_item: 99 });
    expect(state.currentPlanItemIndex).toBe(2); // 钳制到末位
  });
  it("nudge：replan 达阈值 / 探索无计划；反向条件 null", () => {
    expect(pm.buildReplanNudge(3, 3, [{ text: "a", status: "pending" }])).toContain("plan_update");
    expect(pm.buildReplanNudge(2, 3, [{ text: "a", status: "pending" }])).toBeNull();
    expect(pm.buildExplorationNudge(5, 5, null)).toContain("structured plan");
    expect(pm.buildExplorationNudge(5, 5, [{ text: "a", status: "pending" }])).toBeNull();
    expect(pm.buildExplorationNudge(2, 5, null)).toBeNull();
  });
});

describe("actionability", () => {
  it("白名单三动作", () => {
    expect(ACTIONABILITY_ACTIONS.has("click")).toBe(true);
    expect(ACTIONABILITY_ACTIONS.has("input_text")).toBe(true);
    expect(ACTIONABILITY_ACTIONS.has("select_dropdown")).toBe(true);
    expect(ACTIONABILITY_ACTIONS.has("navigate")).toBe(false);
  });
  it("isActionable：visible/enabled/receives-events 矩阵（None 保守放过）", () => {
    expect(isActionable({ isVisible: true })).toBe(true);
    expect(isActionable({ isVisible: false })).toBe(false);
    expect(isActionable({ isVisible: null })).toBe(true); // 未知放过
    expect(isActionable({ isVisible: true, axDisabled: true })).toBe(false);
    expect(isActionable({ isVisible: true, attributes: { disabled: "" } })).toBe(false);
    expect(isActionable({ isVisible: true, attributes: { "aria-disabled": "true" } })).toBe(false);
    expect(isActionable({ isVisible: true, pointerEvents: "none" }, true)).toBe(false);
    expect(isActionable({ isVisible: true, pointerEvents: "auto" }, true)).toBe(true);
    expect(isActionable({ isVisible: true, ignoredByPaintOrder: true }, true)).toBe(false);
  });
  it("isFileInput：INPUT[type=file] 短路", () => {
    expect(isFileInput({ nodeName: "INPUT", attributes: { type: "file" } } as never)).toBe(true);
    expect(isFileInput({ nodeName: "INPUT", attributes: { type: "text" } } as never)).toBe(false);
    expect(isFileInput({ nodeName: "BUTTON", attributes: {} } as never)).toBe(false);
  });
  it("waitForActionability：可见可交互即返；不可见 → poll 后超时降级返回（不抛）", async () => {
    const mkBrowser = (node: unknown) => ({
      getState: async () =>
        ({ domState: { selectorMap: new Map(node ? [[7, node]] : []) } }) as never,
      getElementCoordinates: async () => ({ x: 1, y: 2, width: 10, height: 10 }),
      isElementOccluded: async () => false,
    });
    const sleeps: number[] = [];
    let clock = 0;
    const opts = {
      timeout: 0.5,
      poll: 0.2,
      receivesEvents: false,
      runtimeOcclusion: false,
      stable: false,
      stableInterval: 0.1,
      stableTolerance: 1,
      sleep: (ms: number) => {
        sleeps.push(ms);
        clock += ms / 1000;
        return Promise.resolve();
      },
      now: () => clock,
    };
    const state = {
      domState: { selectorMap: new Map([[7, { backendNodeId: 7, isVisible: true }]]) },
    } as never;
    // 可交互：立即返回 node
    const [, node] = await waitForActionability(
      mkBrowser({ backendNodeId: 7, isVisible: true }),
      state,
      7,
      opts,
    );
    expect(node).toEqual({ backendNodeId: 7, isVisible: true });
    // 不可见：poll 到超时降级（初始 state 即挂不可见 node——刷新发生在 poll 之后）
    const stateHidden = {
      domState: { selectorMap: new Map([[7, { backendNodeId: 7, isVisible: false }]]) },
    } as never;
    const [state2, node2] = await waitForActionability(
      mkBrowser({ backendNodeId: 7, isVisible: false }),
      stateHidden,
      7,
      opts,
    );
    expect(node2).not.toBeNull();
    expect(sleeps.length).toBeGreaterThan(0);
    void state2;
  });
});

describe("MessageCompactor", () => {
  const mkMessages = (n: number): EnvelopedMessage[] =>
    Array.from({ length: n }, (_, i) => ({
      kind: "plain" as const,
      message: {
        role: "user" as const,
        blocks: [{ kind: "text" as const, text: `msg ${i} ${"x".repeat(50)}` }],
      },
    }));
  it("双门未过（步数间隔 / 字符量）不压缩", async () => {
    const compactor = new MessageCompactor(
      {
        enabled: true,
        compactEveryNSteps: 10,
        triggerCharCount: 40000,
        keepLastItems: 4,
        summaryMaxChars: null,
      },
      { singleShot: async () => ({ text: "S" }) },
    );
    const messages = mkMessages(5);
    await compactor.maybeCompact(messages, 5); // 间隔不足
    expect(messages).toHaveLength(5);
    await compactor.maybeCompact(messages, 12); // 字符量不足
    expect(messages).toHaveLength(5);
  });
  it("双门过 → [first, summary, tail 4]；失败 LLM 跳过", async () => {
    let fail = false;
    const compactor = new MessageCompactor(
      {
        enabled: true,
        compactEveryNSteps: 1,
        triggerCharCount: 10,
        keepLastItems: 4,
        summaryMaxChars: 3,
      },
      {
        singleShot: async () => {
          if (fail) throw new Error("llm down");
          return { text: "SUMMARY-TEXT-LONG" };
        },
      },
    );
    const messages = mkMessages(10);
    await compactor.maybeCompact(messages, 5);
    expect(messages).toHaveLength(6); // first + summary + tail 4
    expect((messages[1].message as { blocks: Array<{ text: string }> }).blocks[0].text).toBe(
      "[Conversation Summary]\nSUM",
    ); // maxChars=3 截断
    const retry = mkMessages(10);
    fail = true;
    await compactor.maybeCompact(retry, 10);
    expect(retry).toHaveLength(10); // LLM 失败跳过
  });
});

describe("url-utils", () => {
  it("extractHost：常规/schemeless/垃圾", () => {
    expect(extractHost("https://www.bilibili.com/video/BV1")).toBe("www.bilibili.com");
    expect(extractHost("www.bilibili.com/x")).toBe("www.bilibili.com");
    expect(extractHost("not a url")).toBeNull();
    expect(extractHost("")).toBeNull();
    expect(extractHost(null)).toBeNull();
  });
  it("extractHostWithPort：显式端口 host_port 形态", () => {
    expect(extractHostWithPort("http://localhost:7780/admin")).toBe("localhost_7780");
    expect(extractHostWithPort("https://a.example/x")).toBe("a.example");
    expect(extractHostWithPort("about:blank")).toBeNull();
  });
});

describe("<agent_history> 滑窗（fixture window3 字节对拍）", () => {
  function buildAgent(): Agent {
    const browser = new FakeAgentBrowser();
    const llm = new FakeAgentLLM([]);
    return new Agent({
      task: "T",
      llm: llm.asLLMClient(),
      browser: browser as unknown as BrowserSession,
      settings: {
        maxHistoryItems: 3,
        judge: { enabled: false },
      } as Partial<AgentSettings> as unknown as AgentSettings,
      sleep: () => Promise.resolve(),
      now: () => 0,
      log: () => {},
    });
  }
  it("首条 + 省略行 + 最近 2 条；✓/✗/done 状态摘要；Memory 行", () => {
    const agent = buildAgent();
    const mk = (
      n: number,
      goal: string,
      eval_: string,
      memory: string,
      name: string,
      result: ActionResult[],
    ) =>
      new AgentHistory({
        stepNumber: n,
        modelOutput: {
          evaluation_previous_goal: eval_,
          memory,
          next_goal: goal,
          action: { name, params: { index: n } },
          actions: [{ name, params: { index: n } }],
        } as never,
        result,
      });
    agent.historyAppend(
      mk(1, "open site", "start", "first page", "navigate", [
        new ActionResult({ extractedContent: "Navigated to https://x.example" }),
      ]),
    );
    agent.historyAppend(
      mk(2, "find form", "ok", "form at [7]", "click", [new ActionResult({ error: "timeout" })]),
    );
    agent.historyAppend(
      mk(3, "fill", "ok", "", "input_text", [new ActionResult({ extractedContent: "Typed 'a'" })]),
    );
    agent.historyAppend(
      mk(4, "done", "ok", "all set", "done", [
        new ActionResult({ isDone: true, success: true, extractedContent: "Task finished" }),
      ]),
    );
    expect(agent.buildAgentHistoryDescription()).toBe(FIXTURE.agentHistory.window3);
    // 空历史 → null（fixture empty）
    const empty = buildAgent();
    expect(empty.buildAgentHistoryDescription()).toBeNull();
  });
});
