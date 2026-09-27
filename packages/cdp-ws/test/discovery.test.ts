// discovery 单测：mock fetch 四形态（docs/implement-plan/p3/03 §2）。
import { describe, expect, it } from "vitest";
import { discoverWebSocketUrl } from "../src/discovery.js";

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("discoverWebSocketUrl", () => {
  it("成功提取 webSocketDebuggerUrl", async () => {
    const url = await discoverWebSocketUrl("localhost", 9222, {
      fetch: fetchReturning({ webSocketDebuggerUrl: "ws://localhost:9222/devtools/browser/abc" }),
    });
    expect(url).toBe("ws://localhost:9222/devtools/browser/abc");
  });

  it("非 200：错误文案含 host:port", async () => {
    const err = await discoverWebSocketUrl("localhost", 9224, {
      fetch: fetchReturning({}, 404),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("localhost:9224");
    expect((err as Error).message).toContain("404");
  });

  it("缺 webSocketDebuggerUrl 字段", async () => {
    const err = await discoverWebSocketUrl("localhost", 9222, {
      fetch: fetchReturning({ Browser: "Chrome/1" }),
    }).catch((e: unknown) => e);
    expect((err as Error).message).toContain("webSocketDebuggerUrl");
  });

  it("字段为空串同样拒绝", async () => {
    const err = await discoverWebSocketUrl("localhost", 9222, {
      fetch: fetchReturning({ webSocketDebuggerUrl: "" }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
  });

  it("fetch 网络错误：文案含端口与排查引导", async () => {
    const failing = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    const err = await discoverWebSocketUrl("localhost", 9222, {
      fetch: failing,
    }).catch((e: unknown) => e);
    expect((err as Error).message).toContain("--remote-debugging-port=9222");
    expect((err as Error).message).toContain("fetch failed");
  });

  it("响应体非 JSON", async () => {
    const badJson = (async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected token < in JSON");
      },
    })) as unknown as typeof fetch;
    const err = await discoverWebSocketUrl("localhost", 9222, {
      fetch: badJson,
    }).catch((e: unknown) => e);
    expect((err as Error).message).toContain("非 JSON");
  });
});
