// 会话原语单测（docs/implement-plan/p3/03 §2 矩阵，02 文档逐条锚定）。
// FakeWebSocket respond 规则按 method 匹配；出站参数从 sentFrames 断言。
import { describe, expect, it } from "vitest";
import { CdpCommandError, CdpNavigationError } from "../src/errors.js";
import { CdpPageSession } from "../src/session-primitives.js";
import { CdpWsClient } from "../src/transport.js";
import { createFakeSocket, type FakeSocketHandle } from "./fake-websocket.js";

const TARGETS = {
  targetInfos: [
    { targetId: "browser-1", type: "browser" },
    { targetId: "iframe-1", type: "iframe" },
    { targetId: "page-1", type: "page", url: "https://a.test/", title: "A" },
    { targetId: "page-2", type: "page", url: "https://b.test/", title: "B" },
  ],
};

async function setup(
  logs?: string[],
  handle: FakeSocketHandle = createFakeSocket(),
): Promise<{ client: CdpWsClient; session: CdpPageSession; socket: FakeSocketHandle["socket"] }> {
  const client = await CdpWsClient.connect({
    wsUrl: "ws://fake.test",
    socketFactory: handle.factory,
    logger: logs === undefined ? undefined : (m) => logs.push(m),
  });
  const session = new CdpPageSession(
    client,
    logs === undefined ? undefined : { logger: (m) => logs.push(m) },
  );
  return { client, session, socket: handle.socket };
}

function framesOf(
  socket: FakeSocketHandle["socket"],
  method: string,
): Array<Record<string, unknown>> {
  return socket.sentFrames
    .map((f) => JSON.parse(f) as Record<string, unknown>)
    .filter((f) => f.method === method)
    .map((f) => (f.params ?? {}) as Record<string, unknown>);
}

describe("attachFirstPageTarget（02 §2.1）", () => {
  it("选中首个 page target 并 flatten attach（非 page 类型过滤）", async () => {
    const { client, session, socket } = await setup();
    socket.respond("Target.getTargets", TARGETS);
    socket.respond("Target.attachToTarget", { sessionId: "sess-9" });
    const attached = await session.attachFirstPageTarget();
    expect(attached).toEqual({ targetId: "page-1", sessionId: "sess-9" });
    expect(framesOf(socket, "Target.attachToTarget")).toEqual([
      { targetId: "page-1", flatten: true },
    ]);
    await client.stop();
  });

  it("无 page target：错误文案锚定 Python", async () => {
    const { client, session, socket } = await setup();
    socket.respond("Target.getTargets", { targetInfos: [{ targetId: "b", type: "browser" }] });
    await expect(session.attachFirstPageTarget()).rejects.toThrow(
      "No page target found. Is Chrome running with --remote-debugging-port?",
    );
    await client.stop();
  });

  it("attachToTarget 返回缺 sessionId：显式失败", async () => {
    const { client, session, socket } = await setup();
    socket.respond("Target.getTargets", TARGETS);
    socket.respond("Target.attachToTarget", {});
    await expect(session.attachFirstPageTarget()).rejects.toThrow("缺 sessionId");
    await client.stop();
  });
});

describe("navigate（02 §2.2）", () => {
  it("成功：透传 url + transitionType=address_bar", async () => {
    const { client, session, socket } = await setup();
    socket.respond("Page.navigate", {});
    await session.navigate("https://example.com/", "sess-1");
    expect(framesOf(socket, "Page.navigate")).toEqual([
      { url: "https://example.com/", transitionType: "address_bar" },
    ]);
    await client.stop();
  });

  it("errorText → CdpNavigationError（原文透传）", async () => {
    const { client, session, socket } = await setup();
    socket.respond("Page.navigate", { errorText: "net::ERR_NAME_NOT_RESOLVED" });
    const err = await session.navigate("https://nope.test/", "sess-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CdpNavigationError);
    expect((err as CdpNavigationError).errorText).toBe("net::ERR_NAME_NOT_RESOLVED");
    await client.stop();
  });
});

describe("getTabs（02 §2.3）", () => {
  it("page 过滤 + url/title 缺省空串", async () => {
    const { client, session, socket } = await setup();
    socket.respond("Target.getTargets", {
      targetInfos: [
        { targetId: "p1", type: "page", url: "https://x/", title: "X" },
        { targetId: "p2", type: "page" },
        { targetId: "i1", type: "iframe", url: "https://y/" },
      ],
    });
    expect(await session.getTabs()).toEqual([
      { targetId: "p1", url: "https://x/", title: "X" },
      { targetId: "p2", url: "", title: "" },
    ]);
    await client.stop();
  });

  it("错误透传（不吞——02 偏离 1，容错归 P4 BrowserSession）", async () => {
    const { client, session, socket } = await setup();
    socket.fail("Target.getTargets", -32000, "boom");
    const err = await session.getTabs().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CdpCommandError);
    await client.stop();
  });
});

describe("switchTab（02 §2.4）", () => {
  it("activate → attach 两命令序列，返回新会话句柄", async () => {
    const { client, session, socket } = await setup();
    socket.respond("Target.activateTarget", {});
    socket.respond("Target.attachToTarget", { sessionId: "sess-2" });
    const attached = await session.switchTab("page-2");
    expect(attached).toEqual({ targetId: "page-2", sessionId: "sess-2" });
    expect(framesOf(socket, "Target.activateTarget")).toEqual([{ targetId: "page-2" }]);
    expect(framesOf(socket, "Target.attachToTarget")).toEqual([
      { targetId: "page-2", flatten: true },
    ]);
    await client.stop();
  });

  it("缺 sessionId：显式失败", async () => {
    const { client, session, socket } = await setup();
    socket.respond("Target.activateTarget", {});
    socket.respond("Target.attachToTarget", {});
    await expect(session.switchTab("page-2")).rejects.toThrow("缺 sessionId");
    await client.stop();
  });
});

describe("injectCookies（02 §2.5，runner.py:76-156 移植）", () => {
  function cookieSetup(logs: string[]) {
    return setup(logs);
  }

  it("作用域三来源：显式 url / domain 拼 / localhost 兜底", async () => {
    const { client, session, socket } = await cookieSetup([]);
    socket.respond("Network.setCookie", { success: true });
    const n = await session.injectCookies(
      {
        cookies: [
          { name: "a", value: "1", url: "https://explicit.test/login" },
          { name: "b", value: "2", domain: "shop.test", path: "/admin", secure: true },
          { name: "c", value: "3" },
        ],
        origins: [{ origin: "https://ignored.test", localStorage: [] }],
      },
      "sess-1",
    );
    expect(n).toBe(3);
    const params = framesOf(socket, "Network.setCookie");
    expect(params[0]?.url).toBe("https://explicit.test/login");
    expect(params[1]?.url).toBe("https://shop.test/admin");
    expect(params[2]?.url).toBe("http://localhost/");
    // origins（localStorage）被忽略：只发过 3 条 setCookie
    expect(params).toHaveLength(3);
    await client.stop();
  });

  it("字段映射：path/sameSite/expires/httpOnly 缺省与归一", async () => {
    const { client, session, socket } = await cookieSetup([]);
    socket.respond("Network.setCookie", { success: true });
    await session.injectCookies(
      {
        cookies: [
          {
            name: "s",
            value: "v",
            domain: "d.test",
            sameSite: "Strict",
            expires: 1893456000,
            httpOnly: true,
          },
          { name: "t", value: "v", domain: "d.test", sameSite: "weird", expires: -1 },
        ],
      },
      "sess-1",
    );
    const [first, second] = framesOf(socket, "Network.setCookie");
    expect(first).toMatchObject({
      name: "s",
      path: "/",
      secure: false,
      httpOnly: true,
      sameSite: "Strict",
      expires: 1893456000,
    });
    // sameSite 未知值 → Lax；expires ≤0（会话 cookie）不携带该键
    expect(second).toMatchObject({ sameSite: "Lax" });
    expect("expires" in second).toBe(false);
    await client.stop();
  });

  it("success:false 不计数但继续", async () => {
    const logs: string[] = [];
    const { client, session, socket } = await cookieSetup(logs);
    socket.respond("Network.setCookie", { success: false });
    const n = await session.injectCookies(
      {
        cookies: [
          { name: "a", value: "1", domain: "d.test" },
          { name: "b", value: "2" },
        ],
      },
      "sess-1",
    );
    expect(n).toBe(0);
    expect(framesOf(socket, "Network.setCookie")).toHaveLength(2);
    expect(logs.some((m) => m.includes("success:false"))).toBe(true);
    await client.stop();
  });

  it("单条命令失败（错误信封）：log 不中断，返回成功数", async () => {
    const logs: string[] = [];
    const { client, session, socket } = await cookieSetup(logs);
    socket.fail("Network.setCookie", -32000, "Invalid cookie");
    const n = await session.injectCookies(
      {
        cookies: [
          { name: "a", value: "1", domain: "d.test" },
          { name: "b", value: "2" },
        ],
      },
      "sess-1",
    );
    expect(n).toBe(0);
    expect(framesOf(socket, "Network.setCookie")).toHaveLength(2);
    expect(logs.some((m) => m.includes("setCookie 失败"))).toBe(true);
    await client.stop();
  });

  it("缺 name/value 或条目非对象：跳过并计数不含", async () => {
    const logs: string[] = [];
    const { client, session, socket } = await cookieSetup(logs);
    socket.respond("Network.setCookie", { success: true });
    const n = await session.injectCookies(
      { cookies: [{ value: "无名字" }, "not-an-object", { name: "ok", value: "1" }] },
      "sess-1",
    );
    expect(n).toBe(1);
    expect(framesOf(socket, "Network.setCookie")).toHaveLength(1);
    await client.stop();
  });

  it("坏结构（非对象 / 无 cookies 数组）：显式抛错（02 偏离 4）", async () => {
    const { client, session } = await cookieSetup([]);
    await expect(session.injectCookies(null, "sess-1")).rejects.toThrow("storageState");
    await expect(session.injectCookies({ cookies: "nope" }, "sess-1")).rejects.toThrow(
      "storageState",
    );
    await client.stop();
  });
});
