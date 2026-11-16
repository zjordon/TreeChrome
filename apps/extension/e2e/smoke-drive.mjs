// issue #32 M2 e2e 全链 smoke：真桥（tc-bridge serve 子进程）+ headless Chrome +
// 未打包扩展。链路：配对真链路（tabs 捕获 t）→ MCP initialize → tools/list 21 件
// → 在场门反例（无 sidepanel 的写动词 → SIDEPANEL_REQUIRED）→ 开 sidepanel 后
// navigate/get_state/click（真实索引）/upload_file（路径模式——Chrome 读盘）→
// 杀 SW → locator 动作 EPOCH_STALE → 重 get_state 恢复 → session_stop。直驱无
// LLM——本 smoke 不起 mock 服务端。用例：先 pnpm --filter extension build，然后
// node apps/extension/e2e/smoke-drive.mjs。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  connect,
  connectOurServiceWorker,
  ensureSidepanelPage,
  launchChrome,
  listTargets,
} from "./lib-harness.mjs";

const CDP_PORT = 9789;
const FIXTURE_PORT = 8818;
const BRIDGE_PORT = 18730;
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
const FIXTURE_BASE = `http://127.0.0.1:${FIXTURE_PORT}`;
const BRIDGE_BIN = fileURLToPath(
  new URL("../../../packages/mcp-bridge/bin/tc-bridge.mjs", import.meta.url),
);

// 文件输入侧副作用用轮询（DOM.setFileInputFiles 不保证派发 change 事件——不依赖
// 事件只看 files 状态）；按钮点击计数递增（杀 SW 恢复后的第二次点击以 -2 区分）。
const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>drive-fixture</title></head>
<body>
<h1>drive smoke fixture</h1>
<button id="btn-a" type="button" onclick="document.title='CLICKED-A-'+(++window.n)">Button A</button>
<input id="file-in" type="file">
<script>
window.n = 0;
setInterval(() => {
  const f = document.querySelector('#file-in').files[0];
  if (f && !window.up) { window.up = true; document.title = 'UP:' + f.name; }
}, 200);
</script>
</body></html>`;

const fixtureSrv = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(FIXTURE_HTML);
});
await new Promise((r) => fixtureSrv.listen(FIXTURE_PORT, "127.0.0.1", r));

const workDir = mkdtempSync(join(tmpdir(), "tc-drive-e2e-"));
const uploadPath = join(workDir, "drive-upload.txt").replaceAll("\\", "/");
writeFileSync(uploadPath, "drive upload payload\n", "utf8");

let rpcSeq = 0;
async function rpc(method, params, sessionId, timeoutMs = 120_000) {
  const id = ++rpcSeq;
  const res = await fetch(`${BRIDGE_URL}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((error) => {
    throw new Error(`rpc ${method}#${id} 失败: ${error?.message ?? error}`);
  });
  const messages = [];
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const line of (await res.text()).split("\n")) {
      if (line.startsWith("data:")) messages.push(JSON.parse(line.slice(5)));
    }
  } else {
    messages.push(await res.json());
  }
  return {
    sessionId: res.headers.get("mcp-session-id"),
    response: messages.find((m) => m.id === id) ?? null,
  };
}

async function callTool(sessionId, name, args) {
  return await rpc("tools/call", { name, arguments: args }, sessionId);
}

/** tools/call 结果（桥已解 drive 信封）→ { isError, code?, message?, data? } */
function toolPayload(call) {
  const block = call?.response?.result?.content?.[0];
  if (block?.type !== "text") return { isError: true, code: "(no text)" };
  const parsed = JSON.parse(block.text);
  return {
    isError: call.response?.result?.isError === true,
    code: typeof parsed.code === "string" ? parsed.code : null,
    message: typeof parsed.message === "string" ? parsed.message : null,
    data: parsed.code === undefined ? parsed : null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const swConsole = [];
let chromeProc = null;
let bridgeProc = null;
const summary = {};

const titleOfFixtureTab = async (sw) =>
  JSON.parse(
    await sw.evaluate(
      `(async () => { const t = (await chrome.tabs.query({url: "${FIXTURE_BASE}/*"}))[0]; return JSON.stringify(t ? t.title : null); })()`,
    ),
  );

const activateFixtureTab = async (sw) => {
  await sw.evaluate(
    `(async () => { const t = (await chrome.tabs.query({url: "${FIXTURE_BASE}/*"}))[0]; await chrome.tabs.update(t.id, {active: true}); return "ok"; })()`,
  );
};

try {
  // ① 真桥子进程 + Chrome + 扩展 SW
  bridgeProc = spawn(
    process.execPath,
    [
      BRIDGE_BIN,
      "serve",
      "--port",
      String(BRIDGE_PORT),
      "--pairing-path",
      join(workDir, "pairing.json"),
    ],
    { stdio: "ignore" },
  );
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${BRIDGE_URL}/health`)).ok) break;
    } catch {}
    await sleep(500);
    if (i === 39) throw new Error("bridge not up in 20s");
  }
  const launched = await launchChrome({ port: CDP_PORT });
  chromeProc = launched.proc;
  const { sw, extensionId } = await connectOurServiceWorker(CDP_PORT, launched.profileDir);
  sw.ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.consoleAPICalled") {
      swConsole.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    } else if (m.method === "Runtime.exceptionThrown") {
      swConsole.push(`EXC: ${JSON.stringify(m.params.exceptionDetails).slice(0, 400)}`);
    }
  });
  await sw.send("Runtime.enable");

  // ② 配对真链路：admin 签发 → SW 内开 connect URL → 扩展捕获 t → 私线 pair
  const invite = await (
    await fetch(`${BRIDGE_URL}/admin/pairing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
  ).json();
  await sw.evaluate(
    `(async () => { await chrome.tabs.create({ url: ${JSON.stringify(invite.url)} }); return "ok"; })()`,
  );
  let paired = false;
  for (let i = 0; i < 30 && !paired; i++) {
    await sleep(1000);
    const health = await (await fetch(`${BRIDGE_URL}/health`)).json();
    paired = health?.status?.paired === true;
  }
  if (!paired) throw new Error("extension did not pair in 30s");
  console.log("[step] pairing ok");

  // ③ MCP：initialize → tools/list 21 件
  const init = await rpc(
    "initialize",
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } },
    null,
  );
  const sessionId = init.sessionId;
  if (init.response?.result?.serverInfo?.name !== "tc-bridge")
    throw new Error(`initialize failed: ${JSON.stringify(init.response)}`);
  await fetch(`${BRIDGE_URL}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  const tools = await rpc("tools/list", {}, sessionId);
  const toolNames = (tools.response?.result?.tools ?? []).map((t) => t.name);
  if (
    toolNames.length !== 21 ||
    toolNames.slice(0, 5).join(",") !==
      "tc_bridge_status,run_task,get_snapshot,watch_task,stop_run" ||
    !toolNames.includes("session_stop")
  ) {
    failures.push(`tools/list 形态不符：${toolNames.join(",")}`);
  }
  console.log("[step] tools listed:", toolNames.length);

  // ④ 在场门反例：无 sidepanel 连接的写动词 → SIDEPANEL_REQUIRED（不建会话）
  const denied = toolPayload(
    await callTool(sessionId, "navigate", { url: `${FIXTURE_BASE}/start` }),
  );
  if (denied.code !== "SIDEPANEL_REQUIRED") {
    failures.push(`在场门反例：expected SIDEPANEL_REQUIRED, got ${JSON.stringify(denied)}`);
  }

  // ⑤ 开 sidepanel（Port 在场）→ 开 fixture tab（后开保活动）→ 等 Port 连接
  await ensureSidepanelPage(CDP_PORT, extensionId);
  await sw.evaluate(
    `(async () => { await chrome.tabs.create({ url: "${FIXTURE_BASE}/start" }); return "ok"; })()`,
  );
  await sleep(2500);
  await activateFixtureTab(sw);

  // ⑥ navigate（写动词在场放行）→ get_state 取索引 → click 副作用
  const nav = toolPayload(await callTool(sessionId, "navigate", { url: `${FIXTURE_BASE}/main` }));
  if (nav.isError) failures.push(`navigate 失败: ${JSON.stringify(nav)}`);
  const state = toolPayload(await callTool(sessionId, "get_state", {}));
  if (state.isError) {
    failures.push(`get_state 失败: ${JSON.stringify(state)}`);
  } else {
    if (!String(state.data.elementTreeText ?? "").includes("<button"))
      failures.push("elementTreeText 缺 <button");
    summary.stateUrl = state.data.url;
  }
  const tree = String(state.data?.elementTreeText ?? "");
  const btnIdx = (tree.match(/\[(\d+)\]<button/g) ?? []).at(-1)?.match(/\[(\d+)\]/)?.[1];
  const inputIdx = (tree.match(/\[(\d+)\]<input/g) ?? []).at(-1)?.match(/\[(\d+)\]/)?.[1];
  if (btnIdx === undefined || inputIdx === undefined) {
    failures.push(`索引解析失败 btn=${btnIdx} input=${inputIdx}\ntree:\n${tree.slice(0, 800)}`);
  }
  const clicked = toolPayload(await callTool(sessionId, "click", { index: Number(btnIdx) }));
  if (clicked.isError) failures.push(`click 失败: ${JSON.stringify(clicked)}`);
  const title1 = await titleOfFixtureTab(sw);
  if (title1 !== "CLICKED-A-1") failures.push(`click 副作用 title=${title1}（期望 CLICKED-A-1）`);
  console.log("[step] navigate/get_state/click ok");

  // ⑦ upload 路径态：Chrome 读盘注入 → onchange 副作用
  const uploaded = toolPayload(
    await callTool(sessionId, "upload_file", { index: Number(inputIdx), path: uploadPath }),
  );
  if (uploaded.isError || uploaded.data?.error != null || uploaded.data?.success === false) {
    failures.push(`upload_file 失败: ${JSON.stringify(uploaded)}（index=${inputIdx}）`);
  }
  const title2 = await titleOfFixtureTab(sw);
  if (title2 !== "UP:drive-upload.txt")
    failures.push(
      `upload 副作用 title=${title2}（期望 UP:drive-upload.txt；payload=${JSON.stringify(uploaded.data)}）`,
    );
  summary.upload = title2;
  await sleep(600); // 轮询周期内 title 已置——给 click 计数断言一个干净基线
  console.log("[step] upload path-mode ok");

  // ⑧ 杀 SW → 唤醒 → EPOCH_STALE → 重 get_state 恢复
  await callTool(sessionId, "get_state", {}); // 桥侧簿记取最新代次
  const targets = await listTargets(CDP_PORT);
  const swTarget = targets.find(
    (t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extensionId}/`),
  );
  if (swTarget === undefined) throw new Error("SW target not found for kill");
  const browserWs = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json())
    .webSocketDebuggerUrl;
  const browserCdp = await connect(browserWs);
  await browserCdp.send("Target.closeTarget", { targetId: swTarget.id });
  browserCdp.close();
  summary.killed = true;

  // 45s 唤醒窗（bridge alarm 0.5min 兜底）+ Port 重连（backoff 1s）+ 活动页归位
  await sleep(45_000);
  const revived = await connectOurServiceWorker(CDP_PORT, launched.profileDir);
  const sw2 = revived.sw;
  sw2.ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.consoleAPICalled") {
      swConsole.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    } else if (m.method === "Runtime.exceptionThrown") {
      swConsole.push(`EXC: ${JSON.stringify(m.params.exceptionDetails).slice(0, 400)}`);
    }
  });
  await sw2.send("Runtime.enable");
  await sleep(4_000);
  await activateFixtureTab(sw2);

  const stale = toolPayload(await callTool(sessionId, "click", { index: Number(btnIdx) }));
  if (stale.code !== "EPOCH_STALE") {
    failures.push(`杀 SW 后 expected EPOCH_STALE, got ${JSON.stringify(stale)}`);
  }
  summary.staleCode = stale.code;
  const restate = toolPayload(await callTool(sessionId, "get_state", {}));
  if (restate.isError) failures.push(`恢复 get_state 失败: ${JSON.stringify(restate)}`);
  const reclicked = toolPayload(await callTool(sessionId, "click", { index: Number(btnIdx) }));
  if (reclicked.isError) failures.push(`恢复 click 失败: ${JSON.stringify(reclicked)}`);
  const title3 = await titleOfFixtureTab(sw2);
  if (title3 !== "CLICKED-A-2") failures.push(`恢复后 title=${title3}（期望 CLICKED-A-2）`);
  summary.recovered = title3;
  console.log("[step] epoch stale + recover ok");

  // ⑨ session_stop
  const stopped = toolPayload(await callTool(sessionId, "session_stop", {}));
  if (stopped.isError || stopped.data?.stopped !== true) {
    failures.push(`session_stop: ${JSON.stringify(stopped)}`);
  }
} finally {
  chromeProc?.kill();
  bridgeProc?.kill();
  fixtureSrv.close();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {}
}

console.log(`[smoke-drive] ${JSON.stringify(summary)}`);
if (failures.length > 0) {
  console.error(`SMOKE FAIL:\n  - ${failures.join("\n  - ")}`);
  if (swConsole.length > 0)
    console.error(`[sw console tail]\n  ${swConsole.slice(-20).join("\n  ")}`);
  process.exit(1);
}
console.log(
  "SMOKE PASS: 直驱全链（在场门 → navigate/get_state/click → upload 路径态 → 杀 SW EPOCH_STALE 恢复 → session_stop）",
);
process.exit(0);
