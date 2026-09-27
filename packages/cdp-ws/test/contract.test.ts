// 契约测试（docs/implement-plan/p3/03 §2 contract 组）：
// ① CdpWsClient 结构满足 CdpLikeClient（P1 已冻结的接口，devDep 类型层锁定）；
// ② 出站信封 wire 快照——键集精确（键序无关）。
import type { CdpLikeClient } from "@tw/dom-snapshot";
import { expect, it } from "vitest";
import { CdpWsClient } from "../src/index.js";
import { createFakeSocket } from "./fake-websocket.js";

it("CdpWsClient 结构满足 CdpLikeClient（编译期契约锁定）", async () => {
  const handle = createFakeSocket();
  const client = await CdpWsClient.connect({
    wsUrl: "ws://fake.test",
    socketFactory: handle.factory,
  });
  // 经数组消费避免未使用变量告警；赋值本身就是断言——不满足 CdpLikeClient 即编译失败
  const clients: CdpLikeClient[] = [client];
  expect(clients).toHaveLength(1);
  await client.stop();
});

it("出站信封 wire 快照：键集精确（无 sessionId 时不含该键）", async () => {
  const handle = createFakeSocket();
  const client = await CdpWsClient.connect({
    wsUrl: "ws://fake.test",
    socketFactory: handle.factory,
  });
  handle.socket.respond("DOM.getDocument", {});
  await client.send("DOM.getDocument", { depth: -1 });
  expect(JSON.parse(handle.socket.sentFrames[0] ?? "")).toEqual({
    id: 1,
    method: "DOM.getDocument",
    params: { depth: -1 },
  });
  await client.stop();
});

it("出站信封 wire 快照：带 sessionId", async () => {
  const handle = createFakeSocket();
  const client = await CdpWsClient.connect({
    wsUrl: "ws://fake.test",
    socketFactory: handle.factory,
  });
  handle.socket.respond("Page.enable", {});
  await client.send("Page.enable", undefined, "sess-1");
  expect(JSON.parse(handle.socket.sentFrames[0] ?? "")).toEqual({
    id: 1,
    method: "Page.enable",
    params: {},
    sessionId: "sess-1",
  });
  await client.stop();
});
