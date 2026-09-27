// 纯子件测试：CircuitBreaker / NetworkIdleTracker / html-source / HighlightManager。
// 行为移植自 Python @640d52a（无字节锚点——时钟与几何为语义对齐断言）。

import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../../src/browser/circuit-breaker.js";
import { HighlightManager } from "../../src/browser/highlight.js";
import { documentBodyToHtml } from "../../src/browser/html-source.js";
import { NetworkIdleTracker } from "../../src/browser/network-idle.js";
import { DEFAULT_HIGHLIGHT_SETTINGS } from "../../src/browser/views.js";
import { FakeCdpTransport } from "./fake-transport.js";

describe("CircuitBreaker（closed → open → half_open）", () => {
  it("阈值内不跳闸；连续失败达阈值 open", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeout: 30 });
    expect(cb.isOpen).toBe(false);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen).toBe(false);
    cb.recordFailure();
    expect(cb.isOpen).toBe(true);
  });
  it("成功复位计数；恢复期后 open 自动转 half_open 放行一次探测", () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 1, recoveryTimeout: 10, now: () => t });
    cb.recordFailure();
    expect(cb.isOpen).toBe(true);
    t = 5;
    expect(cb.isOpen).toBe(true); // 恢复期未到
    t = 10;
    expect(cb.isOpen).toBe(false); // half_open 放探测
    cb.recordFailure(); // 探测失败 → reopen
    expect(cb.isOpen).toBe(true);
    t = 100;
    expect(cb.isOpen).toBe(false);
    cb.recordSuccess(); // 探测成功 → closed，计数清零
    expect(cb.isOpen).toBe(false);
    cb.recordFailure(); // 阈值 1：closed 后单次失败再次 open
    expect(cb.isOpen).toBe(true);
  });
  it("reset 强制 closed（reconnect 路径）", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure();
    cb.reset();
    expect(cb.isOpen).toBe(false);
  });
});

describe("NetworkIdleTracker", () => {
  function make() {
    let t = 0;
    const sleeps: number[] = [];
    const tracker = new NetworkIdleTracker({
      timeout: 1,
      stabilityWindow: 0.5,
      pollInterval: 0.1,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms / 1000;
      },
    });
    return { tracker, advance: (dt: number) => (t += dt), sleeps };
  }
  it("未注册即降级：isIdle 恒真，waitUntilIdle 即时 true", async () => {
    const { tracker } = make();
    expect(tracker.isIdle()).toBe(true);
    expect(await tracker.waitUntilIdle()).toBe(true);
  });
  it("inflight 归零 + 稳定窗口后判 idle；长连接从 pending 剔除", () => {
    const transport = new FakeCdpTransport();
    const { tracker, advance } = make();
    tracker.register(transport);
    transport.emit("Network.requestWillBeSent", { requestId: "r1" });
    transport.emit("Network.requestWillBeSent", { requestId: "ws1" });
    expect(tracker.isIdle()).toBe(false);
    transport.emit("Network.responseReceived", { requestId: "ws1", type: "WebSocket" });
    transport.emit("Network.loadingFinished", { requestId: "r1" });
    expect(tracker.isIdle()).toBe(false); // 稳定窗口未过
    advance(0.5);
    expect(tracker.isIdle()).toBe(true); // ws1 是长连接不占 pending
  });
  it("loadingFailed 也退役；redirect 复用 requestId 不双计", () => {
    const transport = new FakeCdpTransport();
    const { tracker, advance } = make();
    tracker.register(transport);
    transport.emit("Network.requestWillBeSent", { requestId: "r1" });
    transport.emit("Network.requestWillBeSent", { requestId: "r1" }); // 重定向复用
    transport.emit("Network.loadingFailed", { requestId: "r1" });
    advance(0.5);
    expect(tracker.isIdle()).toBe(true);
  });
  it("reset 清残留（reconnect 语义）；register 幂等（先解订旧订阅，不双订阅）", () => {
    const transport = new FakeCdpTransport();
    const { tracker, advance } = make();
    tracker.register(transport);
    expect(transport.listenerCount("Network.requestWillBeSent")).toBe(1);
    tracker.register(transport); // 二次注册：多播下若不解订会双份
    expect(transport.listenerCount("Network.requestWillBeSent")).toBe(1);
    transport.emit("Network.requestWillBeSent", { requestId: "r1" });
    expect(tracker.isIdle()).toBe(false);
    tracker.reset();
    advance(0.5); // 稳定窗口
    expect(tracker.isIdle()).toBe(true); // inflight 已清
  });
  it("waitUntilIdle 轮询至 idle 或超时返 false", async () => {
    const transport = new FakeCdpTransport();
    const { tracker, advance } = make();
    tracker.register(transport);
    transport.emit("Network.requestWillBeSent", { requestId: "stuck" });
    const pending = tracker.waitUntilIdle();
    advance(2); // 时钟在 sleep 中被推进（假 sleep 推进）——此处在 wait 外推进模拟
    const result = await pending;
    expect(result).toBe(false);
    transport.emit("Network.loadingFinished", { requestId: "stuck" });
    expect(await tracker.waitUntilIdle()).toBe(true);
  });
});

describe("html-source", () => {
  it("剥噪声标签、void 标签不闭合、属性/文本 HTML 转义", () => {
    const root = {
      nodeName: "#document",
      nodeType: 9,
      children: [
        {
          nodeName: "HEAD",
          nodeType: 1,
          children: [{ nodeName: "META", nodeType: 1, attributes: ["charset", "utf-8"] }],
        },
        {
          nodeName: "BODY",
          nodeType: 1,
          children: [
            { nodeType: 3, nodeValue: 'a<b & "c"' },
            {
              nodeName: "SCRIPT",
              nodeType: 1,
              children: [{ nodeType: 3, nodeValue: "evil()" }],
            },
            {
              nodeName: "A",
              nodeType: 1,
              attributes: ["href", 'https://x/?q=1&"', "title", "t"],
              children: [{ nodeType: 3, nodeValue: "link" }],
            },
            { nodeName: "IMG", nodeType: 1, attributes: ["src", "i.png"] },
          ],
        },
      ],
    };
    expect(documentBodyToHtml(root)).toBe(
      '<body>a&lt;b &amp; &quot;c&quot;<a href="https://x/?q=1&amp;&quot;" title="t">link</a><img src="i.png"></body>',
    );
  });
  it("shadow DOM 与同源 iframe contentDocument 递归带出；跨源 iframe 丢标签", () => {
    const root = {
      nodeName: "body",
      nodeType: 1,
      children: [
        {
          nodeName: "DIV",
          nodeType: 1,
          shadowRoots: [
            { nodeName: "SPAN", nodeType: 1, children: [{ nodeType: 3, nodeValue: "shadow" }] },
          ],
        },
        {
          nodeName: "IFRAME",
          nodeType: 1,
          contentDocument: {
            nodeName: "html",
            nodeType: 1,
            children: [
              { nodeName: "P", nodeType: 1, children: [{ nodeType: 3, nodeValue: "inner" }] },
            ],
          },
        },
        { nodeName: "IFRAME", nodeType: 1 }, // 跨源：contentDocument 缺失
      ],
    };
    expect(documentBodyToHtml(root)).toBe(
      "<body><div><span>shadow</span></div><html><p>inner</p></html></body>",
    );
  });
  it('extractLinks/extractImages=false 去掉 href/src；root 空返 ""', () => {
    const root = {
      nodeName: "body",
      nodeType: 1,
      children: [
        { nodeName: "A", nodeType: 1, attributes: ["href", "u"], children: [] },
        { nodeName: "IMG", nodeType: 1, attributes: ["src", "s"] },
      ],
    };
    expect(documentBodyToHtml(root, { extractLinks: false, extractImages: false })).toBe(
      "<body><a></a><img></body>",
    );
    expect(documentBodyToHtml(null)).toBe("");
  });
  it("无 body 时从根重建；属性值截断 200 字符", () => {
    const root = {
      nodeName: "DIV",
      nodeType: 1,
      attributes: ["data-x", "v".repeat(300)],
      children: [],
    };
    const html = documentBodyToHtml(root);
    expect(html.startsWith('<div data-x="')).toBe(true);
    expect(html).not.toContain("v".repeat(201));
    expect(html.endsWith('"></div>')).toBe(true);
  });
});

describe("HighlightManager", () => {
  function make(settings = DEFAULT_HIGHLIGHT_SETTINGS) {
    const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const jsCodes: string[] = [];
    const send: import("../../src/browser/transport.js").BoundSend = async <T>(
      method: string,
      params?: object,
    ) => {
      sent.push({ method, params: params as Record<string, unknown> });
      return {} as T;
    };
    const manager = new HighlightManager(settings, {
      executeJs: async (code) => {
        jsCodes.push(code);
        return undefined;
      },
      send,
    });
    manager.attach(send);
    return { manager, sent, jsCodes };
  }
  it("highlightElement 发 Overlay.highlightNode（contentColor a=0.125×）", async () => {
    const { manager, sent } = make();
    await manager.highlightElement(42);
    const frame = sent.find((f) => f.method === "Overlay.highlightNode");
    expect(frame?.params?.backendNodeId).toBe(42);
    const config = frame?.params?.highlightConfig as Record<string, unknown>;
    const content = config.contentColor as Record<string, number>;
    expect(content.a).toBe(0.1); // 0.8 * 0.125 = 0.1
  });
  it("enabled=false 或 interactionEnabled=false 时零调用", async () => {
    const { manager, sent } = make({ ...DEFAULT_HIGHLIGHT_SETTINGS, enabled: false });
    await manager.highlightElement(1);
    await manager.highlightClickPoint(1, 2);
    expect(sent.length).toBe(0);
  });
  it("highlightClickPoint 的 JS 含坐标与 duration（×1000 取整）", async () => {
    const { manager, jsCodes } = make();
    await manager.highlightClickPoint(10.5, 20);
    expect(jsCodes[0]).toContain("const x = 10.5 + window.pageXOffset");
    expect(jsCodes[0]).toContain("}, 300);");
  });
  it("addDebugHighlights：正几何入 JS、零几何跳过；selectorMap 空直过", async () => {
    const { manager, jsCodes } = make();
    const selectorMap = new Map([
      [1, { absolutePosition: { x: 1.23, y: 4.56, width: 10, height: 5 } } as never],
      [2, { absolutePosition: { x: 0, y: 0, width: 0, height: 5 } } as never],
      [3, { absolutePosition: null } as never],
    ]);
    await manager.addDebugHighlights(selectorMap);
    expect(jsCodes.length).toBe(1);
    expect(jsCodes[0]).toContain("{idx:1, x:1.2, y:4.6, w:10.0, h:5.0}");
    await manager.addDebugHighlights(new Map());
    expect(jsCodes.length).toBe(1);
  });
});
