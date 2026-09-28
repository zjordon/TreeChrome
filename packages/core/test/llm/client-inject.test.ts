// LLMClient provider 构造注入（4.5 为 4.6 smoke 开的口）：注入面短路 createProvider
// （零 HTTP），model 读取面跟随注入实例；fallback 重建仍走 createProvider（承诺面注释）。

import { describe, expect, it, vi } from "vitest";
import { LLMClient } from "../../src/llm/client.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import type { ChatRequest, ChatResponse } from "../../src/llm/types.js";

const CARD = {
  name: "inject-test",
  protocol: "openai-completions",
  baseUrl: "https://invalid.invalid",
  apiKey: "k",
  model: "card-model",
  maxTokens: 64,
} as const;

function scriptedProvider(model: string, resp?: Partial<ChatResponse>) {
  const chat = vi.fn(
    async (_req: ChatRequest): Promise<ChatResponse> => ({
      text: "ok",
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
      ...resp,
    }),
  );
  const provider: LLMProvider = {
    protocol: "openai-completions",
    model,
    capabilities: { supportsTools: true, supportsVision: false, supportsForcedTool: true },
    chat,
    testConnection: async () => ({ ok: true, model }),
  };
  return { provider, chat };
}

describe("LLMClient provider 注入", () => {
  it("注入实例直用（不走 createProvider/HTTP）——chat 恰被调用一次", async () => {
    const { provider, chat } = scriptedProvider("scripted-model");
    const fetch = vi.fn();
    const client = new LLMClient({ ...CARD }, { fetch }, provider);
    expect(client.model).toBe("scripted-model");
    const resp = await client.singleShot({ systemPrompt: "s", userPrompt: "u" });
    expect(resp.text).toBe("ok");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("缺省不注入 → createProvider 生效（原路径不受影响）", async () => {
    // invalid.invalid 不可达——用 mock fetch 返回 500 避免真网络：仅证明走了
    // provider 适配器（fetch 被调用），注入面默认关闭
    const fetch = vi.fn(async () => new Response("err", { status: 500 }));
    const client = new LLMClient({ ...CARD }, { fetch: fetch as unknown as typeof fetch });
    expect(client.model).toBe("card-model");
    await expect(
      client.singleShot({ systemPrompt: "s", userPrompt: "u", callTimeoutMs: 1000 }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalled();
  });
});
