// policy-bridge 单测（m5/04 §4.3）：requestPermission/confirmSubmit 的侧边栏往返
// ——无端口立即 deny（fail-closed）、有端口挂起 + token resolve、同 token 二次
// resolve 忽略、全断未决 deny、backToRunning 状态回写、卡片 payload 转换（label/
// expiresAt/tabId number）、桥层超时收口（过期删条目+permission-cancelled 广播+
// 迟到 resolve 落空）与 cancelAll（run 停止收口）——fake journal/broadcast、
// 短超时注入。

import type { PermissionRequest } from "@tw/core";
import type { SwToUiMessage } from "@tw/protocol";
import { describe, expect, it } from "vitest";
import { RunJournal } from "../src/runtime/journal.js";
import { SidepanelPolicyBridge, toCardPayload } from "../src/runtime/policy-bridge.js";

const REQ: PermissionRequest = {
  capability: "CLICK",
  host: "a.example",
  actionName: "click",
  params: { index: 3 },
  tabId: "ABCD1234",
  elementIndex: 3,
  elementBbox: { left: 0, top: 0, width: 10, height: 10 },
  elementXpath: "//a[1]",
};

function makeBridge(ports: number, timings?: { promptTimeoutMs: number; expiryGraceMs: number }) {
  const journal = new RunJournal({ now: () => 1 });
  journal.begin({ runId: "r", tabId: 9, task: "t", attachments: [] });
  const sent: SwToUiMessage[] = [];
  const bridge = new SidepanelPolicyBridge({
    journal,
    broadcast: (m) => sent.push(m),
    hasPorts: () => ports > 0,
    runTabId: 9,
    newToken: () => "tok_1",
    ...(timings ?? {}),
  });
  return { journal, sent, bridge };
}

describe("SidepanelPolicyBridge", () => {
  it("无端口 → requestPermission/confirmSubmit 立即 deny/false（fail-closed）", async () => {
    const { bridge, sent } = makeBridge(0);
    expect(await bridge.interaction.requestPermission(REQ)).toBe("deny");
    expect(await bridge.interaction.confirmSubmit(REQ, [{ name: "u", value: "v" }])).toBe(false);
    expect(sent).toEqual([]); // 不广播
  });

  it("有端口 → awaiting + 广播（token）→ 挂起；resolve 放行 + 状态回 running", async () => {
    const { bridge, journal, sent } = makeBridge(1);
    const pending = bridge.interaction.requestPermission(REQ);
    expect(journal.status).toBe("awaiting-permission");
    expect(sent[0]).toMatchObject({
      kind: "permission-request",
      token: "tok_1",
      req: { capability: "CLICK", host: "a.example", tabId: 9, label: "点击" },
    });
    bridge.resolvePermission("tok_1", "allow-once");
    expect(await pending).toBe("allow-once");
    expect(journal.status).toBe("running");
  });

  it("同 token 二次 resolve 忽略（竞态护栏）；未知 token 忽略", async () => {
    const { bridge } = makeBridge(1);
    const pending = bridge.interaction.confirmSubmit(REQ, [{ name: "u", value: "***" }]);
    bridge.resolveSubmit("tok_1", true);
    expect(await pending).toBe(true);
    bridge.resolveSubmit("tok_1", false); // 二次：无 pending，无异常
    bridge.resolveSubmit("tok_ghost", true);
  });

  it("全断 → 未决请求全部 deny/false + submit 卡面字段透传", async () => {
    const { bridge, sent } = makeBridge(1);
    const p1 = bridge.interaction.requestPermission(REQ);
    const p2 = bridge.interaction.confirmSubmit(REQ, [
      { name: "user", value: "alice" },
      { name: "pwd", value: "***" },
    ]);
    const submitMsg = sent.find((m) => m.kind === "submit-request");
    expect(submitMsg).toMatchObject({
      kind: "submit-request",
      fields: [
        { name: "user", value: "alice" },
        { name: "pwd", value: "***" },
      ],
    });
    bridge.onAllPortsDisconnected();
    expect(await p1).toBe("deny");
    expect(await p2).toBe(false);
  });

  it("全断 → backToRunning（deny 是非致命路径——journal 不得停留 awaiting-*）", async () => {
    const { bridge, journal } = makeBridge(1);
    const p = bridge.interaction.requestPermission(REQ);
    expect(journal.status).toBe("awaiting-permission");
    bridge.onAllPortsDisconnected();
    expect(await p).toBe("deny");
    expect(journal.status).toBe("running");
  });

  it("桥层超时收口：过期 → deny + running + permission-cancelled 广播；迟到 resolve 落空", async () => {
    const { bridge, journal, sent } = makeBridge(1, { promptTimeoutMs: 20, expiryGraceMs: 10 });
    const p = bridge.interaction.requestPermission(REQ);
    expect(journal.status).toBe("awaiting-permission");
    expect(await p).toBe("deny"); // gate race 已超时，桥随后清场
    expect(journal.status).toBe("running");
    expect(sent.some((m) => m.kind === "permission-cancelled" && m.token === "tok_1")).toBe(true);
    bridge.resolvePermission("tok_1", "allow-once"); // 迟到：条目已删，忽略
  });

  it("submit 同款超时收口：过期 → false + running（无 cancelled 广播面）", async () => {
    const { bridge, journal, sent } = makeBridge(1, { promptTimeoutMs: 20, expiryGraceMs: 10 });
    const p = bridge.interaction.confirmSubmit(REQ, [{ name: "u", value: "v" }]);
    expect(journal.status).toBe("awaiting-submit");
    expect(await p).toBe(false);
    expect(journal.status).toBe("running");
    expect(sent.some((m) => m.kind === "permission-cancelled")).toBe(false);
  });

  it("按时 resolve → 过期计时器取消（grace 后无 cancelled 广播/状态不翻动）", async () => {
    const { bridge, journal, sent } = makeBridge(1, { promptTimeoutMs: 20, expiryGraceMs: 30 });
    const p = bridge.interaction.requestPermission(REQ);
    bridge.resolvePermission("tok_1", "allow-once");
    expect(await p).toBe("allow-once");
    expect(journal.status).toBe("running");
    await new Promise((r) => setTimeout(r, 80)); // 跨过超时+grace
    expect(sent.some((m) => m.kind === "permission-cancelled")).toBe(false);
    expect(journal.status).toBe("running");
  });

  it("cancelAll（run 停止收口）：未决全 deny + 状态复位", async () => {
    const { bridge, journal } = makeBridge(1);
    const p1 = bridge.interaction.requestPermission(REQ);
    const p2 = bridge.interaction.confirmSubmit(REQ, [{ name: "u", value: "v" }]);
    bridge.cancelAll();
    expect(await p1).toBe("deny");
    expect(await p2).toBe(false);
    expect(journal.status).toBe("running");
  });
});

describe("toCardPayload", () => {
  it("core req → UI 卡：tabId 换 run 绑定 number、label 用 CAPABILITY_LABEL、expiresAt", () => {
    const before = Date.now();
    const card = toCardPayload(REQ, 42);
    expect(card.tabId).toBe(42);
    expect(card.label).toBe("点击");
    expect(card.expiresAt).toBeGreaterThanOrEqual(before + 299_000);
    expect(card.params).toEqual({ index: 3 });
    expect(card.elementBbox).toEqual({ left: 0, top: 0, width: 10, height: 10 });
  });
});
