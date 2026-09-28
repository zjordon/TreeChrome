// 4.4 纯件锚定测试：loop-detector（哈希/nudge/streak）·uncertainty 扫描·invalid
// feedback·prompts（system 4 变体/state 全段/blocks）·agent_history 滑窗·
// task-matcher（prompts/注入头/匹配语义）·judge（序列化/组装）——逐字节对拍
// fixtures/python-anchors/agent.json（gen-agent-anchors.py 实跑产物）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SerializedDOMState } from "@tw/dom-snapshot";
import { describe, expect, it } from "vitest";
import { summarizeStepResult } from "../../src/agent/agent.js";
import {
  fallbackDoneOutput,
  invalidActionFeedback,
  scanUncertaintyKeywords,
  scanUncertaintyMarkers,
} from "../../src/agent/constants.js";
import { JudgeEvaluator } from "../../src/agent/judge.js";
import {
  ActionLoopDetector,
  computeActionHash,
  FailureStreakTracker,
  ZeroResultStreakTracker,
} from "../../src/agent/loop-detector.js";
import {
  buildStateBlocks,
  buildStateMessage,
  buildSystemPrompt,
} from "../../src/agent/prompts/system-prompt.js";
import { buildTaskSkillText, matchTaskSkill } from "../../src/agent/skills/task-matcher.js";
import { ActionResult, AgentHistory, AgentHistoryList } from "../../src/agent/views.js";
import type { BrowserStateSummary } from "../../src/browser/views.js";
import { ACTION_DEFINITIONS } from "../../src/tools/models.js";
import { ActionRegistry } from "../../src/tools/registry.js";
import { makeState } from "./fixtures.js";

/** fixture 元组的形态自适应取值（[k, msg] 数组或 {key, message} 对象两态） */
function strField(v: unknown, selectors: Array<number | string>): string {
  if (Array.isArray(v)) {
    const i = selectors.find((s) => typeof s === "number") as number;
    return String(v[i]);
  }
  if (typeof v === "object" && v !== null) {
    const k = selectors.find((s) => typeof s === "string") as string;
    return String((v as Record<string, unknown>)[k]);
  }
  return String(v);
}

const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/python-anchors/agent.json", import.meta.url)),
    "utf8",
  ),
  // biome-ignore lint/suspicious/noExplicitAny: fixture 是外部 JSON 的弱形态读取面
) as Record<string, any>;

/** batch1 registry descriptions（Python fixture 同源——子集注册，P4b 段 1 起默认面为 20 动作） */
function batch1Descriptions(): string {
  const registry = new ActionRegistry();
  for (const name of [
    "navigate",
    "click",
    "input_text",
    "scroll",
    "extract",
    "wait",
    "go_back",
    "switch_tab",
    "send_keys",
    "done",
  ]) {
    const def = ACTION_DEFINITIONS[name];
    registry.register({
      name,
      description: def.description,
      params: def.params,
      handler: async () => null,
      terminatesSequence: def.terminatesSequence,
    });
  }
  return registry.getActionDescriptionsText();
}

/** 全量 25 动作 descriptions（dummy handler 注册——Python fixture all 变体同源） */
function allDescriptions(): string {
  const registry = new ActionRegistry();
  for (const [name, def] of Object.entries(ACTION_DEFINITIONS)) {
    registry.register({
      name,
      description: def.description,
      params: def.params,
      handler: async () => null,
      terminatesSequence: def.terminatesSequence,
    });
  }
  return registry.getActionDescriptionsText();
}

describe("buildSystemPrompt（字节锚定 4 变体）", () => {
  it("batch1 / maxActions 3 / 全量 25（upload+dropdown 条件段）/ decision 段", () => {
    const desc = batch1Descriptions();
    expect(buildSystemPrompt(desc, "Count the orders", false, 5)).toBe(FIXTURE.systemPrompt.batch1);
    expect(buildSystemPrompt(desc, "T", false, 3)).toBe(FIXTURE.systemPrompt.batch1MaxActions3);
    expect(buildSystemPrompt(allDescriptions(), "Upload a file", false, 5)).toBe(
      FIXTURE.systemPrompt.all,
    );
    expect(buildSystemPrompt(desc, "T", true)).toBe(FIXTURE.systemPrompt.decision);
  });
});

describe("buildStateMessage（17 段字节锚定）", () => {
  const gridMeta = {
    namespace: "sales_order_grid",
    total_records: 123,
    rows_loaded: 20,
    page: 1,
    page_size: 20,
    sorting: { field: "created_at", direction: "desc" },
    first_sorted_value: "2026-09-01",
    active_filters: { status: "complete" },
    active_search: "WH12",
  };
  function fullState(): BrowserStateSummary {
    const base = makeState({
      url: "https://shop.example/admin/orders",
      title: "Orders",
      treeText: "[1] button 'Go'\n[2] input 'Name'",
      tabs: [
        { targetId: "AAA1111", title: "Orders", url: "https://shop.example/admin/orders" },
        { targetId: "BBB2222", title: "Settings", url: "https://shop.example/admin/settings" },
      ],
    });
    return {
      ...base,
      recentEvents: [{ type: "dialog" as const, message: "alert: hello", timestamp: 1 }],
      gridMeta,
      domState: new SerializedDOMState(
        base.domState!.root,
        base.domState!.selectorMap,
        "[1] button 'Go'\n[2] input 'Name'",
        [],
        [
          {
            backend_node_id: 11,
            accept: "image/*",
            visible: true,
            upload_ancestor: true,
            class_name: "cover-input",
          },
          {
            backend_node_id: 12,
            accept: "",
            visible: false,
            upload_ancestor: false,
            class_name: "",
          },
        ],
      ),
    };
  }
  const fullOpts = {
    task: "Ship order #42",
    previousResult: [
      new ActionResult({ extractedContent: "Clicked [BUTTON] 'Go' at index 1" }),
      new ActionResult({ error: "Element 9 not found in DOM state" }),
    ],
    previousEvaluation: "Goal achieved",
    previousMemory: "order id=42",
    previousGoal: "Open orders grid",
    currentTargetId: "AAA1111",
    nudgeMessage: "Heads up: you have repeated a similar action 5 times in the last 8 actions.",
    planDescription: "[x] 0: open grid\n[>] 1: ship order",
    planningNudge: "Consider revising the plan.",
    downloadNotice: "New files available: invoice.pdf",
    pageStats: { links: 30, interactive: 12, iframes: 1, skeleton: false },
    sensitiveDescription:
      "Available secrets (use as <secret>key</secret> in input_text params): password, token",
    skillDescription: "[SOP]\nopen the admin grid",
    taskSkillDescription:
      "A recorded task matching your current goal was found (slug: ship-order).",
  };

  it("全段触发形态逐字节对拍", () => {
    const out = buildStateMessage(fullState(), fullOpts);
    expect(out).toBe(FIXTURE.stateMessage.full);
  });
  it("空状态最小形态", () => {
    const empty = makeState({
      url: "about:blank",
      title: "",
      treeText: undefined,
      selectorEntries: new Map(),
    });
    const state = {
      ...empty,
      domState: new SerializedDOMState(null, new Map(), "", [], []),
      recentEvents: [],
      tabs: [],
      gridMeta: null,
    };
    expect(buildStateMessage(state as BrowserStateSummary, { task: "T" })).toBe(
      FIXTURE.stateMessage.minimal,
    );
  });
  it("可选段全关形态", () => {
    expect(buildStateMessage(fullState(), { task: "T" })).toBe(FIXTURE.stateMessage.noOptional);
  });
  it("blocks 版（text + image；无图单 text）", () => {
    const blocks = buildStateBlocks(fullState(), "aGVsbG8=", fullOpts);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ kind: "text", text: FIXTURE.stateMessage.full });
    expect(blocks[1]).toEqual({ kind: "image", mimeType: "image/png", base64: "aGVsbG8=" });
    // fixture 的 blocks 是 Python anthropic wire 形态——TS 规范块字段已逐项断言
    expect(FIXTURE.stateMessage.blocks).toBeTruthy();
  });
});

describe("loop-detector（哈希与 nudge 字节锚定）", () => {
  it("computeActionHash 七形态对拍", () => {
    for (const [key, expected] of Object.entries(FIXTURE.loopDetector.hashes)) {
      const params: Record<string, unknown> = {
        click: { index: 7 },
        clickElem: { element_id: 7 },
        search: { query: "Red Shoes, red shoes!", engine: "baidu" },
        input: { index: 3, text: "  Hello World " },
        navigate: { url: "https://x.com", new_tab: true },
        scroll: { direction: "up", amount: 2 },
        default: { selector: "a", max_results: 5, offset: null },
      }[key]!;
      const name =
        { clickElem: "click", input: "input_text", default: "find_elements" }[key] ?? key;
      expect(computeActionHash(String(name), params)).toBe(expected);
    }
  });
  it("空窗口 nudge=null / 5 次重复+页面停滞组合 / 12 次升级档", () => {
    expect(new ActionLoopDetector().getNudgeMessage()).toBe(FIXTURE.loopDetector.nudge5);
    const det = new ActionLoopDetector();
    for (let i = 0; i < 6; i++) det.recordAction("click", { index: 7 });
    for (let i = 0; i < 5; i++) det.recordPageState("https://x.example", "dom text", 5);
    expect(det.getNudgeMessage()).toBe(FIXTURE.loopDetector.nudgeCombined);
    const det12 = new ActionLoopDetector();
    for (let i = 0; i < 12; i++) det12.recordAction("click", { index: 1 });
    expect(det12.getNudgeMessage()).toBe(FIXTURE.loopDetector.nudge12);
  });
  it("FailureStreak：3 连失败首报 / 4 连失败升级报（文案对拍）+ peek 不消费", () => {
    const fs = new FailureStreakTracker();
    for (let i = 0; i < 3; i++) fs.record("screenshot", true);
    const peeked = fs.peekNudge()!;
    expect(peeked.message).toBe(strField(FIXTURE.failureStreak.peek3, [2, "message"]));
    expect(fs.peekNudge()).not.toBeNull(); // 查询不消费
    fs.ackNudge(peeked.name, peeked.streak);
    const fs2 = new FailureStreakTracker();
    for (let i = 0; i < 4; i++) fs2.record("click", true);
    expect(fs2.nudge()).toBe(strField(FIXTURE.failureStreak.peek4, ["message", 2]));
  });
  it("ZeroResult：查询键（sort_keys filters）与降级 nudge 文案对拍", () => {
    const zr = new ZeroResultStreakTracker();
    const params = { namespace: "ns", search: "abc", filters: { b: 2, a: 1 } };
    const result = new ActionResult({ extractedContent: "none", metadata: { query_total: 0 } });
    zr.record("read_grid", params, result);
    zr.record("read_grid", params, result);
    const peek = zr.peekNudge()!;
    expect(peek.key).toBe(strField(FIXTURE.zeroResult.peek, [0, "key"]));
    expect(peek.message).toBe(strField(FIXTURE.zeroResult.peek, [1, "message"]));
  });
});

describe("uncertainty 扫描（锚定样本）", () => {
  it("token?/关键词/否定窗口/URL 剥离/not-sure 豁免", () => {
    expect(scanUncertaintyMarkers("Emma Davis=1? and (=2?) but (???) ok")).toEqual(
      FIXTURE.uncertainty.tokenQ,
    );
    expect(scanUncertaintyMarkers("some values unknown, one gap remains")).toEqual(
      FIXTURE.uncertainty.keywords,
    );
    expect(scanUncertaintyMarkers("nothing missing, no gap remains, all verified")).toEqual(
      FIXTURE.uncertainty.negated,
    );
    expect(scanUncertaintyMarkers("see https://x.example/a?b=1 and unknown state")).toEqual(
      FIXTURE.uncertainty.url,
    );
    expect(scanUncertaintyMarkers("No gap found, but not sure about totals")).toEqual(
      FIXTURE.uncertainty.notSure,
    );
    expect(scanUncertaintyKeywords("answer with Q? and unknown parts")).toEqual(
      FIXTURE.uncertainty.textKeywords,
    );
  });
  it("invalidActionFeedback 四形态 + fallbackDone（锚定）", () => {
    expect(invalidActionFeedback("oops")).toBe(FIXTURE.invalidFeedback.nonDict);
    expect(invalidActionFeedback({ memory: "m" })).toBe(FIXTURE.invalidFeedback.noAction);
    expect(invalidActionFeedback({ action: { params: { index: 5 } } })).toBe(
      FIXTURE.invalidFeedback.missingName,
    );
    expect(invalidActionFeedback({ action: { name: "  " } })).toBe(
      FIXTURE.invalidFeedback.emptyName,
    );
    const fb = fallbackDoneOutput();
    const anchor = FIXTURE.invalidFeedback.fallbackDone;
    expect(fb.action).toEqual(anchor.action);
    expect(fb.next_goal).toBe(anchor.next_goal);
  });
});

import { MATCH_PROMPT_TEMPLATE, MATCH_SYSTEM_PROMPT } from "../../src/agent/prompt-consts.js";
import { MATCH_OUTPUT_SCHEMA } from "../../src/agent/skills/task-matcher.js";

describe("task-matcher（prompts/注入头字节锚定 + 匹配语义）", () => {
  it("system/user prompt 与 schema 对拍", () => {
    expect(MATCH_SYSTEM_PROMPT).toBe(FIXTURE.taskMatcher.systemPrompt);
    const cards = [
      {
        slug: "disable-product",
        description: "Disable a product in admin",
        keywords: ["product", "disable"],
        distilledAt: "2026-09-01",
      },
      { slug: "orders-report", description: "Generate the orders report" },
    ];
    const catalog = cards
      .map(
        (c) =>
          `- \`${c.slug}\` — ${c.description}${c.keywords ? ` | keywords: ${c.keywords.join(", ")}` : ""}`,
      )
      .join("\n");
    const user = MATCH_PROMPT_TEMPLATE.split("{task}")
      .join("Disable product XY-9")
      .split("{catalog}")
      .join(catalog);
    expect(user).toBe(FIXTURE.taskMatcher.userPrompt);
    expect(JSON.stringify(MATCH_OUTPUT_SCHEMA)).toBe(JSON.stringify(FIXTURE.taskMatcher.schema));
  });
  it("三档注入头 + 空卡形态对拍", () => {
    expect(buildTaskSkillText("ship-order", "Step 1: open grid\nStep 2: click ship")).toBe(
      FIXTURE.taskMatcher.headerSameTask,
    );
    expect(buildTaskSkillText("ship-order", "CARD", { matchKind: "same_template" })).toBe(
      FIXTURE.taskMatcher.headerSameTemplate,
    );
    expect(buildTaskSkillText("ship-order", "CARD", { taskKind: "read" })).toBe(
      FIXTURE.taskMatcher.headerRead,
    );
    expect(buildTaskSkillText("ship-order", "")).toBe(FIXTURE.taskMatcher.headerEmptyCard);
  });
  it("匹配语义：high/medium 过、low 降档、null 字面量、未知 slug、调用失败", async () => {
    const catalog = [{ slug: "card-a", description: "d" }];
    const mk = (ret: Record<string, unknown> | null, throwErr = false) => ({
      structuredCall: async () => {
        if (throwErr) throw new Error("boom");
        return ret;
      },
    });
    expect(
      (await matchTaskSkill("t", catalog, mk({ match: "card-a", confidence: "high", reason: "r" })))
        .slug,
    ).toBe("card-a");
    expect(
      (
        await matchTaskSkill(
          "t",
          catalog,
          mk({ match: "card-a", confidence: "medium", reason: "r" }),
        )
      ).slug,
    ).toBe("card-a");
    const low = await matchTaskSkill(
      "t",
      catalog,
      mk({ match: "card-a", confidence: "low", reason: "r" }),
    );
    expect(low.slug).toBeNull();
    expect(low.downgraded).toBe(true);
    const nullSlug = await matchTaskSkill(
      "t",
      catalog,
      mk({ match: "none", confidence: "high", reason: "r" }),
    );
    expect(nullSlug.slug).toBeNull();
    const unknown = await matchTaskSkill(
      "t",
      catalog,
      mk({ match: "card-b", confidence: "high", reason: "r" }),
    );
    expect(unknown.slug).toBeNull();
    const failed = await matchTaskSkill("t", catalog, mk(null, true));
    expect(failed.slug).toBeNull();
    expect(failed.callFailed).toBe(true);
  });
});

describe("judge（序列化与组装字节锚定）", () => {
  function buildHistory(): AgentHistoryList {
    return new AgentHistoryList({
      history: [
        new AgentHistory({
          stepNumber: 0,
          modelOutput: {
            next_goal: "open site",
            action: { name: "navigate", params: { url: "https://x.example" } },
          } as never,
          result: [new ActionResult({ extractedContent: "Navigated to https://x.example" })],
          stateSummary: { url: "https://x.example", title: "Home", duration: 1.2 },
        }),
        new AgentHistory({
          stepNumber: 1,
          modelOutput: {
            next_goal: "report count",
            action: { name: "done", params: { text: "3 orders", success: true } },
          } as never,
          result: [new ActionResult({ isDone: true, success: true, extractedContent: "3 orders" })],
          stateSummary: {
            url: "https://x.example",
            title: "Home",
            duration: 2.0,
            domExcerpt: "[1] row 3 orders",
          },
        }),
      ],
    });
  }
  it("serializeHistory 逐字节对拍", () => {
    const judge = new JudgeEvaluator(null as never, null);
    expect(judge.serializeHistory(buildHistory())).toBe(FIXTURE.judge.serialized);
  });
  it("buildJudgePrompt 逐字节对拍", () => {
    const judge = new JudgeEvaluator(null as never, null);
    expect(judge.buildJudgePrompt("How many orders?", buildHistory(), "3 orders")).toBe(
      FIXTURE.judge.prompt,
    );
  });
  it("judge 流：toolCall 命中 / 空响应 nudge 重试 / 异常返 null", async () => {
    const verdict = {
      reasoning: "ok",
      verdict: true,
      failure_reason: null,
      impossible_task: false,
      captcha: false,
    };
    const ok = new JudgeEvaluator(
      {
        singleShot: async () => ({
          text: "",
          toolCalls: [{ id: "t", name: "agent_response", args: verdict }],
          stopReason: "tool_call",
          usage: null,
        }),
      } as never,
      null,
    );
    const result = await ok.judge("t", buildHistory(), "r");
    expect(result?.verdict).toBe(true);
    let calls = 0;
    const emptyThenOk = new JudgeEvaluator(
      {
        singleShot: async () => {
          calls += 1;
          return calls === 1
            ? { text: "no tool", toolCalls: [], stopReason: "stop", usage: null }
            : {
                text: "",
                toolCalls: [
                  { id: "t2", name: "agent_response", args: { ...verdict, verdict: false } },
                ],
                stopReason: "tool_call",
                usage: null,
              };
        },
      } as never,
      null,
    );
    const retried = await emptyThenOk.judge("t", buildHistory(), "r");
    expect(retried?.verdict).toBe(false);
    expect(calls).toBe(2);
    const failing = new JudgeEvaluator(
      { singleShot: async () => Promise.reject(new Error("api down")) } as never,
      null,
    );
    expect(await failing.judge("t", buildHistory(), "r")).toBeNull();
  });
});

describe("summarizeStepResult", () => {
  it("四形态（fixture summarize 锚定）", () => {
    const s = FIXTURE.agentHistory.summarize;
    expect(summarizeStepResult([new ActionResult({ extractedContent: "fine" })])).toBe(s.ok);
    expect(
      summarizeStepResult([new ActionResult({ error: "Element 1 not found in DOM state" })]),
    ).toBe(s.err);
    expect(summarizeStepResult([new ActionResult({ isDone: true, success: true })])).toBe(s.done);
    expect(summarizeStepResult([])).toBe(s.empty);
  });
});
