// Agent 五阶段 pipeline 集成测试（FakeAgentLLM 脚本化 + FakeAgentBrowser——零真
// CDP/零真 LLM）：run 外层、双梯、done 门禁、infra/连接分罪、守卫链、消息管理、
// sensitive/下载接线、预算警告与强制 done。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentOptions } from "../../src/agent/agent.js";
import { Agent } from "../../src/agent/agent.js";
import type { AgentSettings } from "../../src/agent/settings.js";
import type { BrowserSession } from "../../src/browser/session.js";
import { LLMRateLimitError } from "../../src/llm/errors.js";
import { FakeAgentBrowser, FakeAgentLLM, type LlmScriptEntry } from "./fixtures.js";

const _FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/python-anchors/agent.json", import.meta.url)),
    "utf8",
  ),
  // biome-ignore lint/suspicious/noExplicitAny: fixture 是外部 JSON 的弱形态读取面
) as Record<string, any>;

function makeAgent(
  script: LlmScriptEntry[],
  browser: FakeAgentBrowser,
  overrides: Partial<AgentSettings> = {},
  options: Partial<AgentOptions> = {},
): { agent: Agent; llm: FakeAgentLLM; sleeps: number[] } {
  const llm = new FakeAgentLLM(script);
  const sleeps: number[] = [];
  let clock = 1000;
  const agent = new Agent({
    task: options.task ?? "Open https://a.example and finish",
    llm: llm.asLLMClient(),
    browser: browser as unknown as BrowserSession,
    settings: {
      judge: { enabled: false },
      explorationActionabilityCheck: false,
      maxSteps: 10,
      llmTimeout: 30,
      ...overrides,
    } as AgentSettings,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms / 1000;
      return Promise.resolve();
    },
    now: () => (clock += 0.001),
    log: () => {},
    ...options,
  });
  return { agent, llm, sleeps };
}

const ok = (toolInput: Record<string, unknown>): LlmScriptEntry => ({ kind: "ok", toolInput });
const doneOutput = (extra: Record<string, unknown> = {}) => ({
  evaluation_previous_goal: "done",
  memory: "m",
  next_goal: "finish",
  action: { name: "done", params: { text: "Task done", ...extra } },
  actions: [{ name: "done", params: { text: "Task done", ...extra } }],
});

describe("run 外层与公共 API", () => {
  it("初始导航（任务 URL 提取）→ 两步 done → history/finalResult；非 keepAlive 停浏览器", async () => {
    const browser = new FakeAgentBrowser();
    const { agent } = makeAgent(
      [
        ok({
          evaluation_previous_goal: "",
          memory: "",
          next_goal: "go",
          action: { name: "navigate", params: { url: "https://a.example" } },
          actions: [{ name: "navigate", params: { url: "https://a.example" } }],
        }),
        ok(doneOutput()),
      ],
      browser,
    );
    const history = await agent.run();
    expect(browser.navigations).toEqual(["https://a.example", "https://a.example"]); // 初始 + 动作
    expect(history.isDone()).toBe(true);
    expect(history.isSuccessful()).toBe(true);
    expect(history.finalResult()).toBe("Task done");
    expect(history.history).toHaveLength(2);
    expect(history.history[0].stateSummary?.url).toBe("https://a.example");
    expect(history.history[1].stateSummary?.domExcerpt).toBe("[1] button 'Go'"); // done 步带摘录
    expect(browser.stopped).toBe(true);
  });
  it("keepAlive=true 不停浏览器", async () => {
    const browser = new FakeAgentBrowser();
    const { agent } = makeAgent([ok(doneOutput())], browser);
    await agent.run(true);
    expect(browser.stopped).toBe(false);
  });
  it("maxSteps 耗尽退出（无 done）", async () => {
    const browser = new FakeAgentBrowser();
    const { agent } = makeAgent(
      [
        ok({
          ...doneOutput(),
          action: { name: "wait", params: { seconds: 1 } },
          actions: [{ name: "wait", params: { seconds: 1 } }],
        }),
      ],
      browser,
      { maxSteps: 2 },
    );
    const history = await agent.run();
    expect(history.isDone()).toBe(false);
    expect(history.history.length).toBeGreaterThanOrEqual(2);
  });
  it("连败达 maxFailures → run 顶部破环", async () => {
    const browser = new FakeAgentBrowser();
    const { agent } = makeAgent(
      [
        ok({
          action: { name: "click", params: { index: 999 } },
          actions: [{ name: "click", params: { index: 999 } }],
        }),
      ],
      browser,
      { maxFailures: 2 },
    );
    const history = await agent.run();
    expect(agent.state.consecutiveFailures).toBe(2);
    expect(history.isDone()).toBe(false);
  });
  it("stop() 公共 API：LLM 调用中停止 → 丢弃输出、无历史写入", async () => {
    const browser = new FakeAgentBrowser();
    const llm = new FakeAgentLLM([ok(doneOutput())]);
    llm.onCall = () => agent.stop(); // LLM 调用入口即停止（post-LLM 检查 #1 场景）
    const agent = new Agent({
      task: "T",
      llm: llm.asLLMClient(),
      browser: browser as unknown as BrowserSession,
      settings: {
        judge: { enabled: false },
        explorationActionabilityCheck: false,
      } as unknown as AgentSettings,
      sleep: () => Promise.resolve(),
      now: () => 0,
      log: () => {},
    });
    const history = await agent.run();
    expect(agent.state.stopped).toBe(true);
    expect(history.history).toHaveLength(0);
  });
});

describe("Think 双梯与门禁", () => {
  it("外梯：畸形（无 name）→ 形状定向澄清 → 有效动作执行", async () => {
    const browser = new FakeAgentBrowser();
    const { agent, llm } = makeAgent(
      [
        ok({ action: { params: { index: 1 } }, actions: [{ params: { index: 1 } }] }), // 缺 name
        ok({
          evaluation_previous_goal: "",
          memory: "",
          next_goal: "g",
          action: { name: "navigate", params: { url: "https://b.example" } },
          actions: [{ name: "navigate", params: { url: "https://b.example" } }],
        }),
        ok(doneOutput()),
      ],
      browser,
    );
    await agent.run();
    expect(llm.calls).toHaveLength(3);
    // 第二次调用追加澄清消息（外梯 #197 形状定向）
    const retryMsg = llm.calls[1].messages.at(-1);
    expect(retryMsg?.role).toBe("user");
    expect((retryMsg as { blocks: Array<{ text: string }> }).blocks[0].text).toContain(
      "missing the required 'name' key",
    );
    expect(browser.navigations).toContain("https://b.example");
  });
  it("外梯耗尽（1+2 次）→ fallback done 终止", async () => {
    const browser = new FakeAgentBrowser();
    const { agent, llm } = makeAgent([{ kind: "empty", reason: "text-exhausted" }], browser);
    const history = await agent.run();
    expect(llm.calls.length).toBe(3); // 首调 + 2 澄清
    expect(history.isDone()).toBe(true);
    expect(history.finalResult()).toBe("No action returned by LLM");
  });
  it("内梯：参数无效 → 参数反馈重试 → 有效", async () => {
    const browser = new FakeAgentBrowser();
    const { agent, llm } = makeAgent(
      [
        ok({
          action: { name: "click", params: {} }, // 缺 index/element_id
          actions: [{ name: "click", params: {} }],
        }),
        ok({
          evaluation_previous_goal: "",
          memory: "",
          next_goal: "g",
          action: { name: "navigate", params: { url: "https://c.example" } },
          actions: [{ name: "navigate", params: { url: "https://c.example" } }],
        }),
        ok(doneOutput()),
      ],
      browser,
    );
    await agent.run();
    const retryMsg = llm.calls[1].messages.at(-1) as { blocks: Array<{ text: string }> };
    expect(retryMsg.blocks[0].text).toContain("Your action parameters are invalid: ");
    expect(browser.navigations).toContain("https://c.example");
  });
  it("done 门禁：自评含未消解标记 → 验证重试 → 诚实降级收题", async () => {
    const browser = new FakeAgentBrowser();
    const { agent } = makeAgent(
      [
        ok({
          evaluation_previous_goal: "found Emma Davis=1?",
          memory: "still a gap",
          next_goal: "done",
          action: { name: "done", params: { text: "Result" } },
          actions: [{ name: "done", params: { text: "Result" } }],
        }),
        ok({
          evaluation_previous_goal: "verified",
          memory: "all clear",
          next_goal: "done",
          action: { name: "done", params: { text: "Partial result", success: false } },
          actions: [{ name: "done", params: { text: "Partial result", success: false } }],
        }),
      ],
      browser,
    );
    const history = await agent.run();
    expect(agent.state.doneGateUses).toBe(1);
    expect(history.isDone()).toBe(true);
    expect(history.isSuccessful()).toBe(false); // 诚实降级
  });
  it("done 门禁：success=false 畅通（不触发重试）", async () => {
    const browser = new FakeAgentBrowser();
    const { agent, llm } = makeAgent(
      [
        ok({
          evaluation_previous_goal: "x? unknown",
          memory: "",
          next_goal: "done",
          action: { name: "done", params: { text: "R", success: false } },
          actions: [{ name: "done", params: { text: "R", success: false } }],
        }),
      ],
      browser,
    );
    await agent.run();
    expect(agent.state.doneGateUses).toBe(0);
    expect(llm.calls).toHaveLength(1);
  });
});

describe("错误分罪（Branch 2.5 / 2 / 3）", () => {
  it("infra（RateLimit）：首档退避 5s、不烧步数、达预算终止（终局档不再退避）", async () => {
    const browser = new FakeAgentBrowser();
    const { agent, sleeps } = makeAgent(
      [{ throw: new LLMRateLimitError("limited", { provider: "p" }) }],
      browser,
      { maxInfraFailures: 2 },
    );
    const history = await agent.run();
    expect(agent.state.infraFailures).toBe(2);
    expect(agent.state.nSteps).toBe(0); // #194 豁免步数
    expect(sleeps).toEqual([5000]); // 首档退避 5s；第 2 次达预算不再退避
    expect(agent.state.lastResult?.[0]?.error).toContain("LLM API LLMRateLimitError");
    expect(history.history).toHaveLength(0); // modelOutput null → 无历史步
  });
  it("连接类错误：reconnect 成功即继续", async () => {
    const browser = new FakeAgentBrowser();
    browser.reconnectResult = true;
    const { agent } = makeAgent(
      [{ throw: new Error("WebSocket connection closed") }, ok(doneOutput())],
      browser,
    );
    const history = await agent.run();
    expect(browser.reconnectCalls).toBe(1);
    expect(history.isDone()).toBe(true);
  });
  it("能力失败（Branch 3）：计连败 + truthful lastResult（循环到 maxFailures 破环）", async () => {
    const browser = new FakeAgentBrowser();
    const { agent } = makeAgent([{ throw: new Error("boom") }], browser, { maxFailures: 3 });
    await agent.run();
    expect(agent.state.consecutiveFailures).toBe(3);
    expect(agent.state.lastResult?.[0]?.error).toBe("boom");
  });
});

describe("Act 守卫链", () => {
  it("Guard#1：done 中段出现 → 序列截断（done 与后续均不执行）", async () => {
    const browser = new FakeAgentBrowser();
    const { agent } = makeAgent(
      [
        ok({
          action: { name: "wait", params: { seconds: 1 } },
          actions: [
            { name: "wait", params: { seconds: 1 } },
            { name: "done", params: { text: "mid" } },
            { name: "wait", params: { seconds: 1 } },
          ],
        }),
        ok(doneOutput()),
      ],
      browser,
    );
    const history = await agent.run();
    // 首步：中段 done 截断——只执行首个 wait（done 本身也跳过，Python i>0 分支 break）
    expect(history.history[0].result).toHaveLength(1);
    // 循环继续：第二步单 done 正常收题
    expect(history.isDone()).toBe(true);
    expect(history.finalResult()).toBe("Task done");
  });
  it("Guard#4/#5：terminatesSequence 后续跳过；URL 漂移截断", async () => {
    const browser = new FakeAgentBrowser();
    browser.urlAfterAction = "https://drift.example";
    const { agent } = makeAgent(
      [
        ok({
          action: { name: "navigate", params: { url: "https://a.example" } },
          actions: [
            // click 在前（触发漂移模拟）——用 wait 代替 click 避免元素查找失败
            { name: "wait", params: { seconds: 1 } },
            { name: "wait", params: { seconds: 1 } },
          ],
        }),
        ok(doneOutput()),
      ],
      browser,
    );
    const history = await agent.run();
    // 首个 wait 后 URL 漂移 → 第二个 wait 跳过（Guard#5）
    expect(history.history[0].result).toHaveLength(1);
    expect(history.isDone()).toBe(true);
  });
});

describe("Sense 与消息管理", () => {
  it("state 替换式保留 2 份；history 滑窗每步替换；上下文注入不累积", async () => {
    const browser = new FakeAgentBrowser();
    const { agent } = makeAgent(
      [
        ok({
          action: { name: "wait", params: { seconds: 1 } },
          actions: [{ name: "wait", params: { seconds: 1 } }],
        }),
        ok({
          action: { name: "wait", params: { seconds: 1 } },
          actions: [{ name: "wait", params: { seconds: 1 } }],
        }),
        ok(doneOutput()),
      ],
      browser,
    );
    await agent.run();
    const stateMsgs = agent.messages.filter((m) => m.kind === "state");
    const historyMsgs = agent.messages.filter((m) => m.kind === "history");
    expect(stateMsgs).toHaveLength(2); // 上一份 + 当前（保留 2）
    expect(historyMsgs).toHaveLength(1); // 每步替换唯一
    const historyText = (historyMsgs[0].message as { blocks: Array<{ text: string }> }).blocks[0]
      .text;
    expect(historyText).toContain("<agent_history>");
    expect(historyText).toContain("Step 0:");
    expect(historyText).toContain("Step 1:");
  });
  it("步数预算警告（≥75% 步内可见）与最后一步强制 done-only schema", async () => {
    const browser = new FakeAgentBrowser();
    const waitAction = { name: "wait", params: { seconds: 1 } };
    const { agent, llm } = makeAgent(
      [
        ok({ action: waitAction, actions: [waitAction] }),
        ok({ action: waitAction, actions: [waitAction] }),
        ok({ action: waitAction, actions: [waitAction] }),
        ok(doneOutput()),
      ],
      browser,
      { maxSteps: 4 },
    );
    await agent.run();
    // context 注入每步清后重灌——断言落在 LLM 实际收到的消息上（第 3 步 3/4 警告、
    // 第 4 步 LAST STEP + done-only schema）
    const textsOf = (i: number) =>
      llm.calls[i].messages
        .filter((m) => m.role === "user")
        .map((m) =>
          (m as { blocks: Array<{ text: string }> }).blocks.map((b) => b.text).join("\n"),
        );
    expect(textsOf(2).some((t) => t.startsWith("BUDGET WARNING: You have used 3/4 steps"))).toBe(
      true,
    );
    expect(textsOf(3).some((t) => t.startsWith("LAST STEP:"))).toBe(true);
    // run 结束后残留 context = 末步注入
    const contextMsgs = agent.messages
      .filter((m) => m.kind === "context")
      .map((m) => (m.message as { blocks: Array<{ text: string }> }).blocks[0].text);
    expect(contextMsgs.some((t) => t.startsWith("LAST STEP:"))).toBe(true);
  });
  it("sensitive：safeTask 占位替换 + getAction 透传 sensitiveMap + [Available Secrets] 段", async () => {
    const browser = new FakeAgentBrowser();
    const llm = new FakeAgentLLM([ok(doneOutput())]);
    const agent = new Agent({
      task: "Log in with hunter2 secret",
      llm: llm.asLLMClient(),
      browser: browser as unknown as BrowserSession,
      settings: {
        judge: { enabled: false },
        explorationActionabilityCheck: false,
      } as unknown as AgentSettings,
      sensitiveData: { password: "hunter2" },
      sleep: () => Promise.resolve(),
      now: () => 0,
      log: () => {},
    });
    await agent.run();
    // Python 语义：safeTask 替换为裸占位名（<secret> 语法是给 LLM 的用法提示，不进任务文本）
    expect(agent.safeTask).toBe("Log in with password secret");
    expect(llm.calls[0].systemPrompt).toContain("Log in with password secret");
    expect(llm.calls[0].sensitiveMap).toEqual({ hunter2: "password" });
    const stateText = llm.calls[0].messages
      .filter((m) => m.role === "user")
      .map((m) => (m as { blocks: Array<{ text: string }> }).blocks.map((b) => b.text).join(""))
      .find((t) => t.includes("[Available Secrets]"));
    expect(stateText).toContain("[Available Secrets]");
  });
  it("trackDownloads：下载并入 done attachments + 下一步通知", async () => {
    const browser = new FakeAgentBrowser();
    browser.downloads.push({
      filename: "invoice.pdf",
      url: "https://a.example/f",
      path: "C:/dl/invoice.pdf",
    });
    const { agent } = makeAgent([ok(doneOutput())], browser, { trackDownloads: true });
    const history = await agent.run();
    expect(history.history[0].result[0].attachments).toContain("C:/dl/invoice.pdf");
  });
});
