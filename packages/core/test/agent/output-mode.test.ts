// core 接线测试（examples 方案缺口 A/B）：outputMode 全链（LLMClient 卡片/实例字段
// → Agent 构造快照 → StepCtx → getToolSchema 调用点）+ waitBetweenActionsS 快照
// （agent.py:93 从 browser 实例读取）。registry 级 flash/thinking schema 形态已有
// 表驱动测试（tools/registry.test.ts）——此处只验接线：flash 是否真的流到 LLM
// 每步收到的 tool schema（Python agent.py:218 / step.py:702,759,775）。

import { describe, expect, it } from "vitest";
import type { AgentOptions } from "../../src/agent/agent.js";
import { Agent } from "../../src/agent/agent.js";
import type { AgentSettings } from "../../src/agent/settings.js";
import type { BrowserSession } from "../../src/browser/session.js";
import { LLMClient } from "../../src/llm/client.js";
import { FakeAgentBrowser, FakeAgentLLM, type LlmScriptEntry } from "./fixtures.js";

const ok = (toolInput: Record<string, unknown>): LlmScriptEntry => ({ kind: "ok", toolInput });

const doneOutput = () => ({
  evaluation_previous_goal: "done",
  memory: "m",
  next_goal: "finish",
  action: { name: "done", params: { text: "Task done" } },
  actions: [{ name: "done", params: { text: "Task done" } }],
});

function makeAgent(llm: FakeAgentLLM, overrides: Partial<AgentSettings> = {}): Agent {
  return new Agent({
    task: "Open https://a.example and finish",
    llm: llm.asLLMClient(),
    browser: new FakeAgentBrowser() as unknown as BrowserSession,
    settings: {
      judge: { enabled: false },
      explorationActionabilityCheck: false,
      maxSteps: 10,
      llmTimeout: 30,
      ...overrides,
    } as AgentSettings,
    sleep: () => Promise.resolve(),
    now: () => 0,
    log: () => {},
  });
}

/** tool schema 的 required 列表（flash/standard 形态判别面）。think 层把
 *  input_schema 映射为 ToolDefinition.parameters（think.ts:39），从 parameters 读 */
function requiredOf(call: { tool?: { parameters?: { required?: string[] } } }): string[] {
  return call.tool?.parameters?.required ?? [];
}

/** tool schema 的 properties 键集 */
function propsOf(call: {
  tool?: { parameters?: { properties?: Record<string, unknown> } };
}): string[] {
  return Object.keys(call.tool?.parameters?.properties ?? {});
}

describe("outputMode 全链（缺口 A）", () => {
  it("LLMClient：卡片缺省 standard / 显式 flash（client.py:147 同款实例字段）", () => {
    const card = {
      name: "t",
      protocol: "anthropic-messages" as const,
      baseUrl: "https://llm.example",
      apiKey: "k",
      model: "m",
      maxTokens: 1024,
    };
    expect(new LLMClient(card).outputMode).toBe("standard");
    expect(new LLMClient({ ...card, outputMode: "flash" }).outputMode).toBe("flash");
  });

  it("Agent 构造快照：flash llm → 初始 toolSchema 即 flash 形态（agent.py:218+254）", () => {
    const llm = new FakeAgentLLM([]);
    llm.outputMode = "flash";
    const agent = makeAgent(llm);
    expect(agent.outputMode).toBe("flash");
    const schema = agent.toolSchema as {
      description: string;
      input_schema: { required: string[]; properties: Record<string, unknown> };
    };
    expect(schema.description).toBe("Respond with the action to take.");
    expect(schema.input_schema.required).toEqual(["action"]);
    expect(Object.keys(schema.input_schema.properties)).toEqual(["action"]);
  });

  it("fake llm 无字段 → registry destructuring 缺省兜底 standard（getattr 等价）", () => {
    const agent = makeAgent(new FakeAgentLLM([]));
    expect((agent as unknown as { outputMode: string | undefined }).outputMode).toBeUndefined();
    const schema = agent.toolSchema as { input_schema: { required: string[] } };
    expect(schema.input_schema.required).toContain("evaluation_previous_goal");
  });

  it("run 期每步 schema 跟随：flash 下普通步与 LAST STEP done-only 步同为 flash 形态", async () => {
    const llm = new FakeAgentLLM([
      ok({
        evaluation_previous_goal: "",
        memory: "m",
        next_goal: "go",
        action: { name: "wait", params: { seconds: 1 } },
        actions: [{ name: "wait", params: { seconds: 1 } }],
      }),
      ok({
        evaluation_previous_goal: "",
        memory: "m",
        next_goal: "go",
        action: { name: "wait", params: { seconds: 1 } },
        actions: [{ name: "wait", params: { seconds: 1 } }],
      }),
      ok(doneOutput()),
    ]);
    llm.outputMode = "flash";
    const agent = makeAgent(llm, { maxSteps: 3 });
    await agent.run();
    expect(llm.calls).toHaveLength(3);
    // 前两步：完整动作面 flash schema（updateActionModelsForPage 路径，step.py:702）。
    // maxActionsPerStep 缺省 5 > 1 → action 字段是 multi_act 的 array 包裹形态
    for (let i = 0; i < 2; i += 1) {
      expect(requiredOf(llm.calls[i])).toEqual(["action"]);
      expect(propsOf(llm.calls[i])).toEqual(["action"]);
      const params = (llm.calls[i].tool?.parameters ?? {}) as {
        properties?: Record<string, unknown>;
      };
      const actionProp = params.properties?.action;
      expect((actionProp as { type?: string }).type).toBe("array");
      expect((actionProp as { items?: { type?: string } }).items?.type).toBe("object");
    }
    // 第 3 步 LAST STEP：done-only 仍是 flash 形态（forceDoneOnLastStep，step.py:759）
    expect(requiredOf(llm.calls[2])).toEqual(["action"]);
    expect(propsOf(llm.calls[2])).toEqual(["action"]);
  });

  it("对照组：standard 下 LAST STEP done-only schema 保留四必填字段", async () => {
    const llm = new FakeAgentLLM([
      ok({
        evaluation_previous_goal: "",
        memory: "m",
        next_goal: "go",
        action: { name: "wait", params: { seconds: 1 } },
        actions: [{ name: "wait", params: { seconds: 1 } }],
      }),
      ok(doneOutput()),
    ]);
    const agent = makeAgent(llm, { maxSteps: 2 });
    await agent.run();
    expect(requiredOf(llm.calls[1])).toEqual([
      "evaluation_previous_goal",
      "memory",
      "next_goal",
      "action",
    ]);
  });
});

describe("waitBetweenActionsS 接线（缺口 B，agent.py:93）", () => {
  it("Agent 构造从 browser 实例快照；fake 无字段 → undefined（不等待）", () => {
    const agent = makeAgent(new FakeAgentLLM([]));
    expect(
      (agent as unknown as { waitBetweenActionsS: number | undefined }).waitBetweenActionsS,
    ).toBeUndefined();
    const withWait = new Agent({
      task: "T",
      llm: new FakeAgentLLM([]).asLLMClient(),
      browser: { waitBetweenActionsS: 0.1 } as unknown as BrowserSession,
      settings: { judge: { enabled: false } } as AgentSettings,
      sleep: () => Promise.resolve(),
      now: () => 0,
      log: () => {},
    } as AgentOptions);
    expect(withWait.waitBetweenActionsS).toBe(0.1);
  });
});
