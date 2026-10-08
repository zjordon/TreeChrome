// B1 探针 v2：v1 悬念收口——①getTargets() 条目全键倾倒（targetId 是否存在）；
// ②用 createTarget 返回的真 targetId 发 attachToTarget 是否可行；③若可行，
// Debuggee 哪种形状路由该会话（tabId=创建者 vs tabId=新 tab）；④子会话事件流。
// 用法：node apps/extension/e2e/probe-debugger2.mjs
import { createServer } from "node:http";
import { connectOurServiceWorker, launchChrome } from "./lib-harness.mjs";

const PORT = 9777;

// q4 试验页：worker.html（同源 Worker 目标）+ cross.html（127.0.0.1 内嵌 localhost iframe——跨站）
const srvA = createServer((req, res) => {
  res.writeHead(200, {
    "content-type": req.url === "/w.js" ? "text/javascript" : "text/html; charset=utf-8",
  });
  if (req.url === "/w.js") res.end("onmessage = (e) => postMessage(e.data + 1);");
  else if (req.url === "/worker.html")
    res.end(
      '<!doctype html><html><body><h1>worker-host</h1><script>const w = new Worker("/w.js"); w.onmessage = (e) => document.title = "wk:" + e.data; w.postMessage(41);</script></body></html>',
    );
  else
    res.end(
      '<!doctype html><html><body><h1>cross-host</h1><iframe src="http://localhost:8806/b.html" width="200" height="100"></iframe></body></html>',
    );
});
const srvB = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><html><body><h2>cross-oopif</h2></body></html>");
});
await new Promise((r) => srvA.listen(8805, "127.0.0.1", r));
await new Promise((r) => srvB.listen(8806, "127.0.0.1", r));

const { proc, profileDir } = await launchChrome({ port: PORT });
const { sw } = await connectOurServiceWorker(PORT, profileDir);

const PROBE = `(async () => {
  const out = {};
  const dbg = chrome.debugger;
  const tabs = await chrome.tabs.query({});
  const tabA = tabs[0];
  await dbg.attach({ tabId: tabA.id }, "1.3");

  // ① API getTargets() 条目全键倾倒
  const all = await dbg.getTargets();
  out.q1_keys = all.filter(t => t.type === "page").map(t => ({ keys: Object.keys(t).sort().join(","), url: (t.url || "").slice(0, 30) }));

  // ② createTarget 真 targetId → attachToTarget
  const created = await dbg.sendCommand({ tabId: tabA.id }, "Target.createTarget", { url: "about:blank" });
  const newTid = created.targetId;
  out.q2_createTarget = { ok: typeof newTid === "string", tid: typeof newTid === "string" ? newTid.slice(0, 8) + "…" : newTid };
  let sid = null;
  try {
    const r = await dbg.sendCommand({ tabId: tabA.id }, "Target.attachToTarget", { targetId: newTid, flatten: true });
    sid = typeof r.sessionId === "string" ? r.sessionId : null;
    out.q2_attach = { ok: true, hasSession: sid !== null };
  } catch (e) { out.q2_attach = { ok: false, err: String(e) }; }

  // ③ 路由形状矩阵（新 tab 的 tabId 经 tabs.query 找 newest blank）
  if (sid !== null) {
    const tabsNow = await chrome.tabs.query({});
    const newTab = tabsNow.find(t => t.id !== tabA.id) || null;
    out.q3_newTabFound = newTab !== null;
    const shapes = {};
    shapes["tabId=A"] = { tabId: tabA.id };
    if (newTab !== null) shapes["tabId=newTab"] = { tabId: newTab.id };
    shapes["targetId=new"] = { targetId: newTid };
    out.q3 = {};
    for (const [k, shape] of Object.entries(shapes)) {
      try {
        const ev = await dbg.sendCommand({ ...shape, sessionId: sid }, "Runtime.evaluate", { expression: "location.href", returnByValue: true });
        out.q3[k] = { ok: true, href: (ev?.result?.value || "").slice(0, 25) };
      } catch (e) { out.q3[k] = { ok: false, err: String(e).slice(0, 80) }; }
    }
    // 会话级命令（Page.enable via session）
    try {
      await dbg.sendCommand({ tabId: tabA.id, sessionId: sid }, "Page.enable", {});
      out.q3_pageEnableViaSession = { ok: true };
    } catch (e) { out.q3_pageEnableViaSession = { ok: false, err: String(e).slice(0, 80) }; }
  }

  // ④ 子会话事件：**先发 setAutoAttach**（评审轮 1 [2]——原版漏发此命令，q4 恒零事件是
  //    假阴性），经根路由（q2 失败时无会话可用；sid 在则会话路由），再导航两页：
  //    Worker 页（同源 Worker 目标）+ 跨站 iframe 页（127.0.0.1 vs localhost）
  const seen = [];
  let childSid = null; // 首个 autoAttach 子会话的完整 sessionId（命令路由验证用）
  const onEvt = (source, method) => {
    seen.push({ sid: source && source.sessionId ? source.sessionId.slice(0, 8) : null, method: String(method).split(".").slice(0, 2).join(".") });
  };
  const onEvtFull = (source, method) => { if (childSid === null && source && typeof source.sessionId === "string" && method !== "Target.attachedToTarget") childSid = source.sessionId; };
  dbg.onEvent.addListener(onEvt);
  dbg.onEvent.addListener(onEvtFull);
  try {
    // setAutoAttach 固定经根路由（评审轮 2 [1]）：经 sid（q2 产物=新 tab 会话）路由会把
    // autoAttach 作用域限定到新 tab 的子目标，而 worker.html 加载在 tabA——q2 成功的
    // 运行里作用域错位必致 q4/q5 假阴性；会话路由能力已由 q3/p3a 覆盖，无需在此复验
    let setAutoAttachErr = null;
    try { await dbg.sendCommand({ tabId: tabA.id }, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }); }
    catch (e) { setAutoAttachErr = String(e).slice(0, 90); }
    await chrome.tabs.update(tabA.id, { url: "http://127.0.0.1:8805/worker.html" });
    // 捕获即路由（评审轮 1 [2] 复盘教训：worker 短命，导航离开后 Session not found 是时序假象）
    for (let i = 0; i < 30 && childSid === null; i++) await new Promise(r => setTimeout(r, 100));
    if (childSid !== null) {
      try {
        const ev = await dbg.sendCommand({ tabId: tabA.id, sessionId: childSid }, "Runtime.evaluate", { expression: "typeof self", returnByValue: true });
        out.q5_childRoute = { ok: true, value: ev?.result?.value };
      } catch (e) { out.q5_childRoute = { ok: false, err: String(e).slice(0, 90) }; }
    } else {
      out.q5_childRoute = { skipped: "no child session observed" };
    }
    await chrome.tabs.update(tabA.id, { url: "http://127.0.0.1:8805/cross.html" });
    await new Promise(r => setTimeout(r, 2000));
    out.q4 = { setAutoAttachErr, events: seen.length, withSid: seen.filter(s => s.sid !== null).length, sidMethods: [...new Set(seen.filter(s => s.sid !== null).map(s => s.method))].slice(0, 10), rootMethods: [...new Set(seen.filter(s => s.sid === null).map(s => s.method))].slice(0, 10) };
  } catch (e) { out.q4 = { err: String(e).slice(0, 100) }; }
  dbg.onEvent.removeListener(onEvt);
  dbg.onEvent.removeListener(onEvtFull);

  // 清理：detach + 关多余 tab
  try { await dbg.detach({ tabId: tabA.id }); } catch {}
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
