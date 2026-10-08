// B4 golden 对拍 smoke（m5/02 §6）：同一 headless chrome、同一 fixture 页，
// 两通道各跑一次 core BrowserSession 全链（连接序列 + get_state 九步）——
//   通道 A：扩展 SW 内 chrome.debugger → ChromeDebuggerTransport（diag:smoke:attach）
//   通道 B：Node 进程 cdp-ws → CdpWsClient（浏览器 ws 端点）
// 断言两通道 element_tree_text 逐字节一致（golden 方法的跨通道实证——比 fixture
// 重放更强：活页对拍）。用例：node apps/extension/e2e/smoke-cdp-chrome.mjs
import { createServer } from "node:http";
import { connectOurServiceWorker, ensureSidepanelPage, launchChrome } from "./lib-harness.mjs";

const PORT = 9777;

// fixture 页：确定性静态 DOM（标题/按钮/输入框/链接/列表——足够进 element_tree_text）
const FIXTURE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>cdp-chrome-smoke-fixture</title>
</head>
<body>
<h1>cdp-chrome smoke fixture</h1>
<p id="intro">static page for cross-channel parity</p>
<button id="btn-a" type="button">Button A</button>
<button id="btn-b" type="button">Button B</button>
<input id="name-input" type="text" placeholder="enter name">
<input id="check-1" type="checkbox">
<a id="link-docs" href="https://example.com/docs">docs</a>
<ul id="list">
  <li>alpha</li>
  <li>beta</li>
  <li>gamma</li>
</ul>
</body>
</html>`;

const srv = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(FIXTURE_HTML);
});
await new Promise((r) => srv.listen(8803, "127.0.0.1", r));
const FIXTURE_URL = "http://127.0.0.1:8803/fixture.html";

const { proc, profileDir } = await launchChrome({ port: PORT });
const { sw, extensionId } = await connectOurServiceWorker(PORT, profileDir);

// ① 唤醒链已开 sidepanel 页——扩页上下文做驱动（chrome.runtime.sendMessage 不能
//    从 SW 发给自身监听器——「不回投发送者」语义，段 A/B 双实证）
const page = await ensureSidepanelPage(PORT, extensionId);

// ② 开 fixture tab 并拿 tabId
const tabId = await page.evaluate(
  `(async () => { const before = new Set((await chrome.tabs.query({})).map(t => t.id)); await chrome.tabs.create({ url: "${FIXTURE_URL}" }); await new Promise(r => setTimeout(r, 1200)); const t = (await chrome.tabs.query({})).find(t => !before.has(t.id)); return t ? t.id : null; })()`,
);
if (typeof tabId !== "number") throw new Error("fixture tab not created");

// ③ 通道 A：SW 内 chrome.debugger → ChromeDebuggerTransport → core BrowserSession 全链
const channelA = await page.evaluate(
  `(async () => { const res = await chrome.runtime.sendMessage({ kind: "diag", command: "smoke:attach", payload: { tabId: ${tabId} } }); return JSON.stringify(res); })()`,
);
const a = JSON.parse(channelA);
if (a.ok !== true) throw new Error(`channel A failed: ${JSON.stringify(a).slice(0, 300)}`);
console.log(
  `channel A (chrome.debugger): url=${a.url} interactive=${a.interactiveCount} len=${a.elementTreeText.length}`,
);

// ④ 通道 B：Node cdp-ws 全链采集（同页 switchTab 后 get_state）
const { loadKit } = await import("../../../packages/node-host/boot.mjs");
const kit = await loadKit();
const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const session = new kit.BrowserSession(
  () => kit.CdpWsClient.connect({ wsUrl: version.webSocketDebuggerUrl, logger: () => {} }),
  {},
  { log: () => {} },
);
await session.start();
try {
  const tabs = await session.getTabs();
  const fixture = tabs.find((t) => t.url === FIXTURE_URL);
  if (fixture === undefined)
    throw new Error(`fixture tab not visible via cdp-ws: ${JSON.stringify(tabs)}`);
  await session.switchTab(fixture.targetId);
  const state = await session.getState({ includeScreenshot: false });
  const textB = state.domState?.elementTreeText ?? "";
  console.log(`channel B (cdp-ws):        url=${state.url} len=${textB.length}`);

  // ④ 逐字节比对
  if (a.elementTreeText === textB) {
    console.log(
      `PARITY PASS: element_tree_text identical (${textB.length} chars, ${a.interactiveCount} interactive)`,
    );
    console.log("--- sample ---");
    console.log(textB.slice(0, 300));
  } else {
    console.log("PARITY FAIL — texts differ");
    const arrA = a.elementTreeText.split("\n");
    const arrB = textB.split("\n");
    for (let i = 0; i < Math.max(arrA.length, arrB.length); i++) {
      if (arrA[i] !== arrB[i]) {
        console.log(
          `first diff @line ${i}:\n  A: ${JSON.stringify(arrA[i])}\n  B: ${JSON.stringify(arrB[i])}`,
        );
        break;
      }
    }
    process.exitCode = 1;
  }
} finally {
  await session.stop().catch(() => {});
}

sw.close();
srv.close();
proc.kill();
setTimeout(() => process.exit(process.exitCode ?? 0), 300);
