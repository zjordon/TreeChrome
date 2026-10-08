// B1 探针 v2：v1 悬念收口——①getTargets() 条目全键倾倒（targetId 是否存在）；
// ②用 createTarget 返回的真 targetId 发 attachToTarget 是否可行；③若可行，
// Debuggee 哪种形状路由该会话（tabId=创建者 vs tabId=新 tab）；④子会话事件流。
// 用法：node apps/extension/e2e/probe-debugger2.mjs
import { connectOurServiceWorker, launchChrome } from "./lib-harness.mjs";

const PORT = 9777;
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

  // ④ 子会话事件：对既有 attach 的会话发 setAutoAttach（经会话路由），导航新 tab 到
  //    带 Worker 的本地页（Worker 目标会触发 autoAttach 子会话——不依赖 OOPIF 判定）
  const seen = [];
  const onEvt = (source, method) => { seen.push({ sid: source && source.sessionId ? source.sessionId.slice(0, 8) : null, method: String(method).split(".").slice(0, 2).join(".") }); };
  dbg.onEvent.addListener(onEvt);
  try {
    const html = '<script>new Worker(URL.createObjectURL(new Blob(["onmessage=e=>postMessage(1)"],{type:"text/javascript"})));</script>worker-page';
    const url = "data:text/html;charset=utf-8," + encodeURIComponent(html);
    await chrome.tabs.update(tabA.id, { url });
    await new Promise(r => setTimeout(r, 1500));
    out.q4 = { events: seen.length, withSid: seen.filter(s => s.sid !== null).length, methods: [...new Set(seen.map(s => s.method))].slice(0, 10) };
  } catch (e) { out.q4 = { err: String(e).slice(0, 100) }; }
  dbg.onEvent.removeListener(onEvt);

  // 清理：detach + 关多余 tab
  try { await dbg.detach({ tabId: tabA.id }); } catch {}
  const tabsNow = await chrome.tabs.query({});
  for (const t of tabsNow) { if (t.id !== tabA.id) { try { await chrome.tabs.remove(t.id); } catch {} } }
  return JSON.stringify(out, null, 1);
})()`;

const value = await sw.evaluate(PROBE);
console.log(value);
sw.close();
proc.kill();
setTimeout(() => process.exit(0), 300);
