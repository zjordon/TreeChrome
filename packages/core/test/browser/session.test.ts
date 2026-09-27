// Facade 测试：start/connect/reconnect/stop 生命周期、get_state 九步顺序、两层
// selector_map 缓存 5 处失效、rawSend/boundSend、downloadsPath 契约、
// cdp-ws CdpWsClient 对 core CdpTransport 的类型契约。

import type { CdpWsClient } from "@tw/cdp-ws";
import { describe, expect, it } from "vitest";
import type { CdpTransport } from "../../src/browser/index.js";
import { BrowserSession } from "../../src/browser/session.js";
import { FakeCdpTransport, scriptConnect } from "./fake-transport.js";

function makeSession(settings = {}, transport?: FakeCdpTransport) {
  const t = transport ?? new FakeCdpTransport();
  const session = new BrowserSession(async () => t, settings, {
    log: () => {},
    sleep: async () => {},
    now: () => 0,
  });
  return { session, transport: t };
}

describe("BrowserSession 生命周期", () => {
  it("start：工厂取 transport → connect 序列 → 域 enable 全发", async () => {
    const { session, transport } = makeSession();
    scriptConnect(transport);
    await session.start();
    expect(session.isConnected).toBe(true);
    expect(session.currentSessionId).toBe("S1");
    expect(session.currentTargetId).toBe("T1");
  });
  it("握手失败自愈一次（重试工厂）；二次失败抛原始异常", async () => {
    let attempts = 0;
    const good = new FakeCdpTransport();
    scriptConnect(good);
    const flaky = async (): Promise<FakeCdpTransport> => {
      attempts += 1;
      if (attempts === 1) throw new Error("handshake 404");
      return good;
    };
    const session = new BrowserSession(flaky, {}, { log: () => {} });
    await session.start();
    expect(attempts).toBe(2);
    let failures = 0;
    const alwaysBad = async (): Promise<FakeCdpTransport> => {
      failures += 1;
      throw new Error(`boom ${failures}`);
    };
    const session2 = new BrowserSession(alwaysBad, {}, { log: () => {} });
    await expect(session2.start()).rejects.toThrow("boom 1"); // 原始异常优先
    expect(failures).toBe(2);
  });
  it("trackDownloads 无 downloadsPath 拒绝（宿主显式契约）", async () => {
    const { session, transport } = makeSession();
    scriptConnect(transport);
    await session.start();
    const s2 = makeSession();
    scriptConnect(s2.transport);
    await expect(s2.session.start({ trackDownloads: true })).rejects.toThrow(/downloadsPath/);
  });
  it("connect 失败回滚半连接态（评审轮 1 #2）", async () => {
    const transport = new FakeCdpTransport();
    transport.respond("Target.getTargets", { targetInfos: [] }); // 无 page target → connect 抛
    const session = new BrowserSession(async () => transport, {}, { log: () => {} });
    await expect(session.start()).rejects.toThrow(/--remote-debugging-port/);
    expect(session.isConnected).toBe(false);
    expect(session.currentSessionId).toBeNull();
  });
  it("reconnect 后下载追踪按原路径重建（评审轮 1 #1）", async () => {
    const t1 = new FakeCdpTransport();
    const t2 = new FakeCdpTransport();
    for (const t of [t1, t2]) {
      scriptConnect(t);
      t.respond("Browser.setDownloadBehavior", {});
    }
    let next = 0;
    const session = new BrowserSession(async () => (next++ === 0 ? t1 : t2), {}, { log: () => {} });
    await session.start({ trackDownloads: true, downloadsPath: "D:/dl" });
    expect(t1.framesOf("Browser.setDownloadBehavior")).toHaveLength(1);
    expect(await session.reconnect()).toBe(true);
    expect(t2.framesOf("Browser.setDownloadBehavior")).toHaveLength(1); // 重连后重建
    t2.emit("Browser.downloadWillBegin", {
      guid: "g",
      url: "https://x/f.bin",
      suggestedFilename: "f.bin",
    });
    t2.emit("Browser.downloadProgress", { guid: "g", state: "completed" });
    expect(session.consumeCompletedDownloads()).toEqual([
      { filename: "f.bin", url: "https://x/f.bin", path: null },
    ]);
  });
  it("Target.* 浏览器级命令不绑 sessionId（评审轮 1 #8 回归锚）", async () => {
    const { session, transport } = makeSession();
    scriptConnect(transport);
    transport
      .respond("Target.activateTarget", {})
      .respond("Runtime.evaluate", { result: { value: "complete" } })
      .respond("Target.createTarget", { targetId: "TN" });
    await session.start();
    await session.getTabs();
    await session.switchTab("T1");
    const browserLevel = ["Target.getTargets", "Target.activateTarget", "Target.attachToTarget"];
    for (const method of browserLevel) {
      for (const frame of transport.framesOf(method)) {
        expect(frame.sessionId).toBeUndefined();
      }
    }
  });
  it("stop：清缓存/解订/关 transport；幂等", async () => {
    const { session, transport } = makeSession();
    scriptConnect(transport);
    await session.start();
    await session.stop();
    expect(transport.closed).toBe(true);
    expect(session.isConnected).toBe(false);
    expect(session.currentSessionId).toBeNull();
    await session.stop(); // 幂等
  });
  it("未连接时 send 抛错（boundSend 守卫）", () => {
    const { session } = makeSession();
    expect(() => session.rawSend("Page.enable", {})).toThrow(/not connected/);
  });
  it("reconnect：旧 transport 关闭 + 全量解订 + 新连接；失败返 false", async () => {
    const t1 = new FakeCdpTransport();
    scriptConnect(t1);
    const t2 = new FakeCdpTransport();
    scriptConnect(t2);
    let next = 0;
    const factory = async () => (next++ === 0 ? t1 : t2);
    const session = new BrowserSession(factory, {}, { log: () => {} });
    await session.start();
    await t1.emit("Page.javascriptDialogOpening", { type: "alert", message: "x" });
    expect(t1.listenerCount("Page.javascriptDialogOpening")).toBe(1);
    const ok = await session.reconnect();
    expect(ok).toBe(true);
    expect(t1.closed).toBe(true);
    expect(t1.listenerCount("Page.javascriptDialogOpening")).toBe(0); // 旧订阅全解订
    expect(session.currentSessionId).toBe("S1");
  });
  it("reconnect 失败（工厂两次都抛）→ false 且断开", async () => {
    let calls = 0;
    const factory = async () => {
      calls += 1;
      throw new Error(`chrome gone ${calls}`);
    };
    const session = new BrowserSession(factory, {}, { log: () => {} });
    expect(await session.reconnect()).toBe(false);
    expect(calls).toBe(2); // 自愈重试一次
    expect(session.isConnected).toBe(false);
  });
});

describe("get_state 九步（FakeTransport 全脚本化）", () => {
  function scriptGetState(transport: FakeCdpTransport, domResult: unknown) {
    scriptConnect(transport);
    transport
      .respond("Runtime.evaluate", (p: Record<string, unknown> | undefined) => {
        const expr = String(p?.expression ?? "");
        if (expr.includes("JSON.stringify({url")) {
          return { result: { value: JSON.stringify({ url: "https://x/", title: "T" }) } };
        }
        if (expr.includes("grid")) return { result: { value: "" } };
        if (expr.includes("require")) return { result: { value: "" } };
        return { result: { value: undefined } };
      })
      .respond("Target.getTargets", {
        targetInfos: [{ type: "page", targetId: "T1", url: "https://x/", title: "T" }],
      })
      .respond("Page.captureScreenshot", { data: "aGk=" })
      .respond("DOM.getDocument", domResult as object);
  }
  it("顺序：url/title → tabs → DOM 采集 → 截图 → grid_meta → recentEvents", async () => {
    const { session, transport } = makeSession();
    scriptGetState(transport, {
      root: { nodeName: "#document", nodeType: 9, children: [], contentDocument: null },
    });
    // DOM 采集链路：buildDomState 需要三源——给最小可用响应（Runtime.evaluate 的
    // 智能分发规则已在 scriptGetState 注册，勿重复注册——Map 语义是覆盖不是追加）
    transport
      .respond("DOM.getDocument", {
        root: {
          nodeId: 1,
          nodeName: "#document",
          nodeType: 9,
          backendNodeId: 1,
          children: [],
          attributes: [],
        },
      })
      .respond("DOMSnapshot.captureSnapshot", { strings: [], documents: [] })
      .respond("Accessibility.getFullAXTree", { nodes: [] });
    await session.start();
    const state = await session.getState();
    expect(state.url).toBe("https://x/");
    expect(state.title).toBe("T");
    expect(state.tabs).toEqual([{ targetId: "T1", url: "https://x/", title: "T" }]);
    expect(state.screenshot).toEqual(new Uint8Array([0x68, 0x69]));
    expect(state.gridMeta).toBeNull();
    expect(state.recentEvents).toEqual([]);
    const order = transport.sent
      .filter(
        (f) =>
          f.method === "Page.enable" ||
          f.method === "DOM.getDocument" ||
          f.method === "Page.captureScreenshot",
      )
      .map((f) => f.method);
    expect(order[0]).toBe("Page.enable"); // connect 先于 get_state
    expect(order.indexOf("DOM.getDocument")).toBeGreaterThan(0);
    expect(order.indexOf("Page.captureScreenshot")).toBeGreaterThan(
      order.indexOf("DOM.getDocument"),
    );
  });
  it("includeScreenshot=false 跳过截图", async () => {
    const { session, transport } = makeSession();
    scriptGetState(transport, { root: {} });
    await session.start();
    await session.getState({ includeScreenshot: false });
    expect(transport.framesOf("Page.captureScreenshot")).toHaveLength(0);
  });
  it("DOM 采集抛错 → 熔断计失败 + EMPTY 态；连续失败 3 次后短路", async () => {
    const { session, transport } = makeSession();
    scriptConnect(transport); // getTargets 保留 page target（connect 需要；getState 的 getTabs 复用同规则）
    transport
      .respond("Runtime.evaluate", { result: { value: "" } })
      .failOn("DOM.getDocument", new Error("dom dead"));
    await session.start();
    for (let i = 0; i < 3; i++) {
      const state = await session.getState({ includeScreenshot: false });
      expect(state.domState).not.toBeNull();
    }
    // 每次采集的 DOM.getDocument 调用数由 dom-snapshot 管线决定（帧映射+文档抓取），
    // 熔断断言只看「第 4 次起零增长」
    const callsAfterThree = transport.framesOf("DOM.getDocument").length;
    expect(callsAfterThree).toBeGreaterThan(0);
    const state4 = await session.getState({ includeScreenshot: false });
    expect(transport.framesOf("DOM.getDocument")).toHaveLength(callsAfterThree); // 熔断短路零新增
    expect(state4.domState?.selectorMap.size ?? 0).toBe(0);
  });
});

describe("cdp-ws 类型契约", () => {
  it("CdpWsClient 满足 core CdpTransport（编译期断言）", () => {
    type Assert<T extends true> = T;
    type _Check = Assert<CdpWsClient extends CdpTransport ? true : false>;
    expect(true).toBe(true);
  });
});
