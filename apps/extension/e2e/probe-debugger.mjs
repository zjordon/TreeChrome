// B1 真机探针（m5/02 §2.2）：在**我们的** SW 上下文实测 chrome.debugger 的握手/路由
// 语义，输出结构化 JSON 供「原生直通/拦截合成」定案。问题面（比方案四问更全——
// tabs.ts 五条 Target.* 都要拦或透）：
//   P1  协议 Target.getTargets 经 debugger 会话是否可用、targetInfos 是否含附着 tab
//   P2  对自身 targetId 发 Target.attachToTarget(flatten) 成否
//   P3a Debuggee {tabId, sessionId} 路由自身会话命令是否生效
//   P3b setAutoAttach 后 OOPIF 子会话事件（onEvent source.sessionId）与命令路由
//   P4  chrome.debugger.getTargets() 的 targetId↔tabId 映射可用性
//   P5  从 A 会话 attachToTarget(其它 tab)：成败 + 哪种 Debuggee 形状能路由 B 会话
//   P6  Target.activateTarget / Target.createTarget / Target.closeTarget 协议命令成否
//   附  根事件 source 形状样本（onEvent 的 source.tabId/sessionId 有无）
// 用法：node apps/extension/e2e/probe-debugger.mjs
import { createServer } from "node:http";
import { connectOurServiceWorker, launchChrome } from "./lib-harness.mjs";

const PORT = 9777;

// OOPIF 试验页：127.0.0.1:8801 主页内嵌 localhost:8802 iframe（跨站点）
const srvA = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    '<!doctype html><html><body><h1>host-A</h1><iframe src="http://localhost:8802/b.html" width="200" height="100"></iframe></body></html>',
  );
});
const srvB = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><html><body><h2>host-B-oopif</h2></body></html>");
});
await new Promise((r) => srvA.listen(8801, "127.0.0.1", r));
await new Promise((r) => srvB.listen(8802, "127.0.0.1", r));

const { proc, profileDir } = await launchChrome({ port: PORT });
const { sw } = await connectOurServiceWorker(PORT, profileDir);

const PROBE = `(async () => {
  const out = {};
  out.preflight = { swUrl: self.location.href, dbgApi: typeof chrome.debugger };
  if (typeof chrome.debugger === "undefined") return JSON.stringify(out, null, 1);
  const dbg = chrome.debugger;
  const tabs = await chrome.tabs.query({});
  const tabA = tabs[0];
  const tabB = await chrome.tabs.create({ url: "about:blank" });
  await new Promise(r => setTimeout(r, 300));
  await dbg.attach({ tabId: tabA.id }, "1.3");

  // P4：API 侧 getTargets 的映射面
  const all1 = await dbg.getTargets();
  out.p4 = {
    total: all1.length,
    pageEntries: all1.filter(t => t.type === "page").map(t => ({ hasTabId: typeof t.tabId === "number", attached: t.attached === true })),
    ownFound: all1.some(t => t.tabId === tabA.id),
  };
  const own = all1.find(t => t.tabId === tabA.id);
  const other = all1.find(t => t.tabId === tabB.id);

  // P1：协议 Target.getTargets 经 debugger 会话
  try {
    const r = await dbg.sendCommand({ tabId: tabA.id }, "Target.getTargets", {});
    const pages = (r.targetInfos || []).filter(t => t.type === "page");
    out.p1 = { ok: true, pageCount: pages.length, containsOwn: pages.some(t => t.targetId === own.targetId), firstIsOwn: pages[0]?.targetId === own.targetId, anyAttached: pages.some(t => t.attached) };
  } catch (e) { out.p1 = { ok: false, err: String(e) }; }

  // P2：attachToTarget(自身 targetId, flatten)
  let p2sid = null;
  try {
    const r = await dbg.sendCommand({ tabId: tabA.id }, "Target.attachToTarget", { targetId: own.targetId, flatten: true });
    p2sid = typeof r.sessionId === "string" ? r.sessionId : null;
    out.p2 = { ok: true, hasSession: p2sid !== null };
    // P3a：Debuggee{tabId,sessionId} 路由自身会话
    if (p2sid !== null) {
      try {
        const ev = await dbg.sendCommand({ tabId: tabA.id, sessionId: p2sid }, "Runtime.evaluate", { expression: "1+1", returnByValue: true });
        out.p3a = { ok: true, value: ev?.result?.value };
      } catch (e) { out.p3a = { ok: false, err: String(e) }; }
    }
  } catch (e) { out.p2 = { ok: false, err: String(e) }; }

  // P5：从 A 会话 attach 其它 tab 的 target
  try {
    const r = await dbg.sendCommand({ tabId: tabA.id }, "Target.attachToTarget", { targetId: other.targetId, flatten: true });
    out.p5 = { ok: true, hasSession: typeof r.sessionId === "string" };
    if (typeof r.sessionId === "string") {
      const shapes = { "tabId=A": { tabId: tabA.id }, "tabId=B": { tabId: tabB.id }, "targetId=B": { targetId: other.targetId } };
      out.p5b = {};
      for (const [k, shape] of Object.entries(shapes)) {
        try {
          const ev = await dbg.sendCommand({ ...shape, sessionId: r.sessionId }, "Runtime.evaluate", { expression: "location.href", returnByValue: true });
          out.p5b[k] = { ok: true, href: (ev?.result?.value || "").slice(0, 30) };
        } catch (e) { out.p5b[k] = { ok: false, err: String(e).slice(0, 90) }; }
      }
    }
  } catch (e) { out.p5 = { ok: false, err: String(e) }; }

  // P6：activateTarget / createTarget / closeTarget 协议命令
  try { await dbg.sendCommand({ tabId: tabA.id }, "Target.activateTarget", { targetId: other.targetId }); out.p6activate = { ok: true }; }
  catch (e) { out.p6activate = { ok: false, err: String(e).slice(0, 90) }; }
  try { const r = await dbg.sendCommand({ tabId: tabA.id }, "Target.createTarget", { url: "about:blank" }); out.p6create = { ok: true, hasTargetId: typeof r.targetId === "string" }; }
  catch (e) { out.p6create = { ok: false, err: String(e).slice(0, 90) }; }
  try { const r = await dbg.sendCommand({ tabId: tabA.id }, "Target.closeTarget", { targetId: other.targetId }); out.p6close = { ok: true, keys: Object.keys(r || {}) }; }
  catch (e) { out.p6close = { ok: false, err: String(e).slice(0, 90) }; }

  // P3b：setAutoAttach + OOPIF 子会话事件
  const seen = [];
  const onEvt = (source, method) => { if (source && source.sessionId) seen.push({ sid: source.sessionId.slice(0, 8), fullSid: source.sessionId, method: String(method).split(".").slice(0, 2).join(".") }); };
  dbg.onEvent.addListener(onEvt);
  try {
    await dbg.sendCommand({ tabId: tabA.id }, "Page.enable", {});
    await dbg.sendCommand({ tabId: tabA.id }, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await chrome.tabs.update(tabA.id, { url: "http://127.0.0.1:8801/" });
    await new Promise(r => setTimeout(r, 3000));
    const sids = [...new Set(seen.map(s => s.sid))];
    out.p3b = { childSessionEvents: seen.length, distinctChildSids: sids.length, sampleMethods: [...new Set(seen.map(s => s.method))].slice(0, 8) };
    // 子会话路由验证：完整的 sid（截断版不能路由）发一条 Runtime.evaluate——成功即证
    // Debuggee {tabId, sessionId} 可路由（评审轮 1 [3]：原死块等待下一事件无超时会挂死）
    if (sids.length > 0) {
      const full = seen.find(s => s.sid !== null);
      const fullSid = (full && full.fullSid) || null;
      if (typeof fullSid === "string") {
        try {
          const ev = await dbg.sendCommand({ tabId: tabA.id, sessionId: fullSid }, "Runtime.evaluate", { expression: "1", returnByValue: true });
          out.p3b.childRoute = { ok: true, value: ev?.result?.value };
        } catch (e) { out.p3b.childRoute = { ok: false, err: String(e).slice(0, 90) }; }
      }
    }
  } catch (e) { out.p3b = { err: String(e).slice(0, 120) }; }

  // 根事件 source 形状样本
  const rootShapes = [];
  const onRoot = (source, method) => { if (rootShapes.length < 3) rootShapes.push({ hasTabId: source && typeof source.tabId === "number", hasSessionId: source && typeof source.sessionId === "string", method: String(method) }); };
  dbg.onEvent.addListener(onRoot);
  await chrome.tabs.update(tabA.id, { url: "about:blank" });
  await new Promise(r => setTimeout(r, 1200));
  dbg.onEvent.removeListener(onRoot);
  out.rootEventShapes = rootShapes;

  await dbg.detach({ tabId: tabA.id });
  const tabsNow = await chrome.tabs.query({});
  for (const t of tabsNow) { if (t.id !== tabA.id) { try { await chrome.tabs.remove(t.id); } catch {} } }
  return JSON.stringify(out, null, 1);
})()`;

const value = await sw.evaluate(PROBE);
console.log(value);

sw.close();
srvA.close();
srvB.close();
proc.kill();
setTimeout(() => process.exit(0), 300);
