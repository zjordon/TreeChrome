// connection 层测试：connect 序列（顺序保真）、自愈、dialog 事件态、下载追踪、
// file-chooser 拦截、recent_events、getCurrentUrl、injectStorageState（localhost 坑）。

import { describe, expect, it } from "vitest";
import {
  connectSession,
  consumeRecentEvents,
  enableFileChooserIntercept,
  getCurrentUrl,
  injectStorageState,
  recordEvent,
  setupDownloadTracking,
  setupEventTracking,
} from "../../src/browser/connection.js";
import { makeInternals, scriptConnect } from "./fake-transport.js";

describe("connectSession（enable 序列顺序保真）", () => {
  it("顺序：getTargets → attach → Page.enable → DOM.enable → dialog → Network+register → setAutoAttach → fileChooser", async () => {
    const h = makeInternals();
    scriptConnect(h.transport);
    h.s.currentTargetId = null;
    h.s.currentSessionId = null;
    await connectSession(h.s);
    const order = h.transport.sent.map((f) => f.method);
    expect(order).toEqual([
      "Target.getTargets",
      "Target.attachToTarget",
      "Page.enable",
      "DOM.enable",
      "Network.enable",
      "Target.setAutoAttach",
      "Page.setInterceptFileChooserDialog",
    ]);
    expect(h.s.currentSessionId).toBe("S1");
    expect(h.s.currentTargetId).toBe("T1");
    expect(h.s.fileChooserInterceptEnabled).toBe(true);
  });
  it("无 page target → 抛 RuntimeError 引导 --remote-debugging-port", async () => {
    const h = makeInternals();
    h.s.currentSessionId = null; // 清掉假件 preset，走真实「未发现 target」分支
    h.transport.respond("Target.getTargets", { targetInfos: [] });
    await expect(connectSession(h.s)).rejects.toThrow(/--remote-debugging-port/);
  });
  it("Network.enable 失败降级（tracker disabled，不阻断连接）", async () => {
    const h = makeInternals();
    scriptConnect(h.transport);
    h.transport.failOn("Network.enable", new Error("net down"));
    h.s.currentTargetId = null;
    h.s.currentSessionId = null;
    await connectSession(h.s);
    expect(h.s.networkIdle.isEnabled).toBe(false);
    expect(h.logs.some((m) => m.includes("degrading"))).toBe(true);
  });
  it("dialog 注册失败降级；setAutoAttach 失败吞掉", async () => {
    const h = makeInternals();
    scriptConnect(h.transport);
    h.transport.failOn("Target.setAutoAttach", new Error("old chrome"));
    h.s.currentTargetId = null;
    h.s.currentSessionId = null;
    await connectSession(h.s); // 不抛
  });
});

describe("dialog 事件态（自动处理 + 无条件记录）", () => {
  it("alert → dismiss + 记录；beforeunload → accept", async () => {
    const h = makeInternals();
    scriptConnect(h.transport);
    h.transport.respond("Page.handleJavaScriptDialog", {});
    setupEventTracking(h.s);
    h.transport.emit("Page.javascriptDialogOpening", { type: "alert", message: "hello" }, "S1");
    await new Promise((r) => setTimeout(r, 0)); // 微任务调度
    const handled = h.transport.framesOf("Page.handleJavaScriptDialog");
    expect(handled).toHaveLength(1);
    expect(handled[0].params).toEqual({ accept: false, promptText: "" });
    const events = consumeRecentEvents(h.s);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("dialog");
    expect(events[0].message).toBe("[alert] hello (auto-dismissed)");
    h.transport.emit(
      "Page.javascriptDialogOpening",
      { type: "beforeunload", url: "https://x/" },
      "S1",
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(h.transport.framesOf("Page.handleJavaScriptDialog")[1].params).toEqual({
      accept: true,
      promptText: "",
    });
  });
  it("autoDialogEnabled=false 只记录不处理；handleJavaScriptDialog 失败静默", async () => {
    const h = makeInternals({ autoHandleJsDialog: false });
    h.transport.respond("Page.handleJavaScriptDialog", {});
    setupEventTracking(h.s);
    h.transport.emit("Page.javascriptDialogOpening", { type: "confirm", message: "m" });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.transport.framesOf("Page.handleJavaScriptDialog")).toHaveLength(0);
    expect(consumeRecentEvents(h.s)).toHaveLength(1);
  });
  it("recordEvent 溢出丢最老（maxlen=20）", () => {
    const h = makeInternals();
    for (let i = 0; i < 25; i++) {
      recordEvent(h.s, { type: "dialog", message: `m${i}`, timestamp: i });
    }
    const events = consumeRecentEvents(h.s);
    expect(events).toHaveLength(20);
    expect(events[0].message).toBe("m5");
    expect(events[19].message).toBe("m24");
    expect(consumeRecentEvents(h.s)).toHaveLength(0);
  });
});

describe("file-chooser 拦截（per-session）", () => {
  it("开启后记录 Page.fileChooserOpened；失败 best-effort 不置位", async () => {
    const h = makeInternals();
    h.transport.respond("Page.setInterceptFileChooserDialog", {});
    await enableFileChooserIntercept(h.s);
    expect(h.s.fileChooserInterceptEnabled).toBe(true);
    h.transport.emit(
      "Page.fileChooserOpened",
      { mode: "selectSingle", backendNodeId: 7, frameId: "f1" },
      "S1",
    );
    expect(h.s.lastFileChooser).toMatchObject({
      backendNodeId: 7,
      mode: "selectSingle",
      frameId: "f1",
    });
    const h2 = makeInternals();
    h2.transport.failOn("Page.setInterceptFileChooserDialog", new Error("old chrome"));
    await enableFileChooserIntercept(h2.s);
    expect(h2.s.fileChooserInterceptEnabled).toBe(false);
  });
});

describe("下载追踪", () => {
  it("begin 记 pending；completed 移入缓冲并 consume 清空", async () => {
    const h = makeInternals();
    h.transport.respond("Browser.setDownloadBehavior", {});
    await setupDownloadTracking(h.s, "D:/dl");
    expect(h.transport.framesOf("Browser.setDownloadBehavior")[0].params).toEqual({
      behavior: "allow",
      eventsEnabled: true,
      downloadPath: "D:/dl",
    });
    h.transport.emit("Browser.downloadWillBegin", { guid: "g1", suggestedFilename: "a.zip" });
    h.transport.emit("Browser.downloadProgress", { guid: "g1", state: "inProgress" });
    expect(h.s.completedDownloads).toHaveLength(0);
    h.transport.emit("Browser.downloadProgress", {
      guid: "g1",
      state: "completed",
      url: "https://x/a.zip",
      filePath: "D:/dl/a.zip",
    });
    expect(h.s.completedDownloads).toEqual([
      { filename: "a.zip", url: "https://x/a.zip", path: "D:/dl/a.zip" },
    ]);
    const consumed = h.s.completedDownloads.splice(0);
    expect(consumed).toHaveLength(1);
  });
});

describe("getCurrentUrl", () => {
  it("正常返回 value；异常返空串", async () => {
    const h = makeInternals();
    h.transport.respond("Runtime.evaluate", {
      result: { value: "https://example.com/" },
    });
    expect(await getCurrentUrl(h.s)).toBe("https://example.com/");
    h.transport.failOn("Runtime.evaluate", new Error("cdp down"));
    expect(await getCurrentUrl(h.s)).toBe("");
  });
});

describe("injectStorageState（runner.py 契约）", () => {
  it("显式 url 优先；domain=localhost 必须 url 绑定（坑）；未知 sameSite → Lax", async () => {
    const h = makeInternals();
    h.transport.respond("Network.setCookie", (p: Record<string, unknown> | undefined) => ({
      success: true,
      ...p,
    }));
    const { injected, failed } = await injectStorageState(h.s, {
      cookies: [
        { name: "a", value: "1", url: "https://x/path" },
        { name: "b", value: "2", domain: "localhost", path: "/app" },
        { name: "c", value: "3", domain: ".example.com", sameSite: "Bogus" },
        { name: "d", value: "4", expires: 0 },
        // 非法条目跳过不计数
        { name: 5, value: "x" },
      ],
    });
    expect(injected).toBe(4);
    expect(failed).toBe(0);
    const frames = h.transport.framesOf("Network.setCookie");
    expect(frames[0].params).toMatchObject({
      name: "a",
      value: "1",
      url: "https://x/path",
      path: "/",
    });
    expect(frames[1].params).toMatchObject({
      name: "b",
      url: "http://localhost/app",
      path: "/app",
    });
    expect(frames[1].params).not.toHaveProperty("domain");
    expect(frames[2].params).toMatchObject({ name: "c", domain: "example.com", sameSite: "Lax" });
    expect(frames[3].params).not.toHaveProperty("expires");
  });
  it("success=false 计失败并继续；抛错计失败；非数组 cookies 抛", async () => {
    const h = makeInternals();
    h.transport.respond("Network.setCookie", { success: false });
    const r1 = await injectStorageState(h.s, {
      cookies: [{ name: "a", value: "1", url: "https://x/" }],
    });
    expect(r1).toEqual({ injected: 0, failed: 1 });
    h.transport.failOn("Network.setCookie", new Error("boom"));
    const r2 = await injectStorageState(h.s, {
      cookies: [{ name: "a", value: "1", url: "https://x/" }],
    });
    expect(r2).toEqual({ injected: 0, failed: 1 });
    await expect(injectStorageState(h.s, {})).rejects.toThrow(/cookies/);
  });
});
