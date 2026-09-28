// 评审轮 1 修复的回归锚定：skills/types 运行时函数 / pause 幂等 / done 门禁
// text-only 关键词通道 / judge tool 映射与 60s 超时 / judgeLlm 注入。
import { describe, expect, it } from "vitest";
import type { AgentOptions } from "../../src/agent/agent.js";
import { Agent } from "../../src/agent/agent.js";
import { JudgeEvaluator } from "../../src/agent/judge.js";
import type { AgentSettings } from "../../src/agent/settings.js";
import { catalogLine, renderTaskCard } from "../../src/agent/skills/types.js";
import { AgentHistoryList } from "../../src/agent/views.js";
import type { BrowserSession } from "../../src/browser/session.js";
import type { ToolDefinition } from "../../src/llm/types.js";
import { FakeAgentBrowser, FakeAgentLLM, type LlmScriptEntry } from "./fixtures.js";

const ok = (toolInput: Record<string, unknown>): LlmScriptEntry => ({ kind: "ok", toolInput });
const doneOutput = () => ({
  evaluation_previous_goal: "done",
  memory: "m",
  next_goal: "finish",
  action: { name: "done", params: { text: "Task done" } },
  actions: [{ name: "done", params: { text: "Task done" } }],
});

function baseOpts(
  script: LlmScriptEntry[],
  browser: FakeAgentBrowser,
  extra: Partial<AgentOptions> = {},
): AgentOptions {
  const llm = new FakeAgentLLM(script);
  return {
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
    ...extra,
  };
}

describe("skills/types 运行时函数（catalogLine/renderTaskCard）", () => {
  it("catalogLine：slug/description/keywords 三段格式（fixture catalogLines 锚定）", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../fixtures/python-anchors/agent.json", import.meta.url)),
        "utf8",
      ),
    ) as { taskMatcher: { catalogLines: string[] } };
    const cards = [
      {
        slug: "disable-product",
        description: "Disable a product in admin",
        keywords: ["product", "disable"],
        distilledAt: "2026-09-01",
      },
      { slug: "orders-report", description: "Generate the orders report" },
    ];
    expect(cards.map(catalogLine)).toEqual(fixture.taskMatcher.catalogLines);
  });
  it("renderTaskCard：三段头固定读序，空段跳过", () => {
    expect(renderTaskCard({ sop: " step1 ", selectors: "", quirks: " note " })).toBe(
      "[SOP]\nstep1\n\n[QUIRKS]\nnote",
    );
    expect(renderTaskCard({ sop: "", selectors: "", quirks: "" })).toBe("");
  });
});

describe("pause 幂等（轮 1 #2）", () => {
  it("重复 pause 不覆盖 gate：pause→pause→resume 后 run 收敛收题", async () => {
    const browser = new FakeAgentBrowser();
    const agent = new Agent(baseOpts([ok(doneOutput())], browser));
    agent.pause();
    agent.pause(); // 重复触发（UI 双击形态）——幂等短路
    const runPromise = agent.run();
    await new Promise((r) => setTimeout(r, 5));
    agent.resume();
    const history = await runPromise;
    expect(history.isDone()).toBe(true);
    expect(browser.stopped).toBe(true);
  });
  it("pause→pause→stop：stop 释放 run 正在等待的同一 gate，finally 生效", async () => {
    const browser = new FakeAgentBrowser();
    const agent = new Agent(baseOpts([ok(doneOutput())], browser));
    agent.pause();
    const runPromise = agent.run();
    await new Promise((r) => setTimeout(r, 5));
    agent.pause(); // run 已挂在 gate 上再触发 pause
    agent.stop();
    await runPromise;
    expect(agent.state.stopped).toBe(true);
    expect(browser.stopped).toBe(true); // finally 的 browser.stop 执行（非 keepAlive）
  });
});

describe("done 门禁 text-only 通道（轮 1 #5）", () => {
  it("自评干净但 done.text 含不确定关键词 → 门禁触发验证重试", async () => {
    const browser = new FakeAgentBrowser();
    const llm = new FakeAgentLLM([
      ok({
        evaluation_previous_goal: "all verified",
        memory: "complete",
        next_goal: "done",
        action: { name: "done", params: { text: "Answer includes not sure items" } },
        actions: [{ name: "done", params: { text: "Answer includes not sure items" } }],
      }),
      ok({
        evaluation_previous_goal: "verified",
        memory: "ok",
        next_goal: "done",
        action: { name: "done", params: { text: "Partial", success: false } },
        actions: [{ name: "done", params: { text: "Partial", success: false } }],
      }),
    ]);
    const agent = new Agent(baseOpts([], browser, { llm: llm.asLLMClient() }));
    const history = await agent.run();
    expect(agent.state.doneGateUses).toBe(1);
    expect(history.isSuccessful()).toBe(false);
    expect(llm.calls).toHaveLength(2);
  });
});

describe("judge tool 映射与超时（轮 1 #4/#7）", () => {
  it("singleShot 收到的 tool 是 ToolDefinition 形态（parameters 非空对象）且带 60s 超时", async () => {
    const seen: Array<{ tool?: ToolDefinition | null; callTimeoutMs?: number | null }> = [];
    const verdict = {
      reasoning: "r",
      verdict: true,
      failure_reason: null,
      impossible_task: false,
      captcha: false,
    };
    const judge = new JudgeEvaluator(
      {
        singleShot: async (req: {
          tool?: ToolDefinition | null;
          callTimeoutMs?: number | null;
        }) => {
          seen.push({ tool: req.tool, callTimeoutMs: req.callTimeoutMs });
          return {
            text: "",
            toolCalls: [{ id: "t", name: "agent_response", args: verdict }],
            stopReason: "tool_call",
            usage: null,
          };
        },
      } as never,
      null,
    );
    const history = new AgentHistoryList({
      history: [
        {
          stepNumber: 0,
          modelOutput: { next_goal: "g", action: { name: "done", params: {} } } as never,
          result: [],
          stateSummary: { url: "https://x", title: "T", duration: 1 },
        } as never,
      ],
    });
    const result = await judge.judge("t", history, "r");
    expect(result?.verdict).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].tool?.parameters).toBeTruthy();
    expect(
      Object.keys((seen[0].tool!.parameters as Record<string, unknown>).properties as object),
    ).toContain("verdict");
    expect((seen[0].tool!.parameters as Record<string, unknown>).type).toBe("object");
    expect(seen[0].callTimeoutMs).toBe(60_000);
  });
});

describe("judgeLlm 注入口（轮 1 #6）", () => {
  it("judgeLlm 传入时 judge 走独立客户端；缺省回落主 llm", async () => {
    const browser = new FakeAgentBrowser();
    const verdict = {
      reasoning: "r",
      verdict: true,
      failure_reason: null,
      impossible_task: false,
      captcha: false,
    };
    const judgeLlm = new FakeAgentLLM([]);
    judgeLlm.singleShot = async () => ({
      text: "",
      toolCalls: [{ id: "j", name: "agent_response", args: verdict }],
      stopReason: "tool_call",
      usage: null,
    });
    const opts = baseOpts([ok(doneOutput())], browser, {
      judgeLlm: judgeLlm.asLLMClient(),
      settings: {
        judge: { enabled: true },
        explorationActionabilityCheck: false,
      } as unknown as AgentSettings,
    });
    const agent = new Agent(opts);
    await agent.run();
    const last = agent.history.history[agent.history.history.length - 1].result[0];
    expect(last.judgement).toMatchObject({ verdict: true });
  });
});
