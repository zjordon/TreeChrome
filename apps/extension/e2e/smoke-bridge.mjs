// issue #31 M1 e2e 全链 smoke：真桥（tc-bridge serve 子进程）+ headless Chrome +
// 未打包扩展。链路：/admin/pairing 签发邀请 → 扩展经 tabs.onUpdated 从 connect 页
// URL 捕获 t → 扩展 Origin 私线 pair（真实用户路径，无任何 mock 注入）→ MCP
// initialize → run_task（mock LLM 剧本三步，权限卡 Port 代答）→ watch_task 挂起至
// 终态（stream 经 progress 通知）→ 副作用断言 → 场景 2：run 中杀 SW → alarm 唤醒
// 恢复轮询 → get_snapshot 见 interrupted 终态（journal 决策 5 + runtime 自愈）。
// 用例：先 pnpm --filter extension build，然后 node apps/extension/e2e/smoke-bridge.mjs。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

const CDP_PORT = 9788;
const FIXTURE_PORT = 8817;
const LLM_PORT = 8891;
const BRIDGE_PORT = 18730; // 与扩展缺省 endpoint 一致——验证零配置默认路径
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}/fixture.html`;
const BRIDGE_BIN = fileURLToPath(
  new URL("../../../packages/mcp-bridge/bin/tc-bridge.mjs", import.meta.url),
);

const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>bridge-fixture</title></head>
<body onclick="document.title='CLICKED-BODY'">
<h1>bridge smoke fixture</h1>
<button id="btn-a" type="button" onclick="document.title='CLICKED-A'">Button A</button>
<button id="btn-b" type="button" onclick="document.title='CLICKED-B'">Button B</button>
</body></html>`;

// mock LLM 剧本（smoke-sw-runtime 同款：navigate/click/done 三步；click 索引从状态
// 文本解析——selector 序号非 DOM 序，盲填必错）
const SCRIPT = [
  {
    evaluation_previous_goal: "",
    memory: "start",
    next_goal: "navigate",
    action: { name: "navigate", params: { url: FIXTURE_URL } },
    actions: [{ name: "navigate", params: { url: FIXTURE_URL } }],
  },
  {
    evaluation_previous_goal: "navigated",
    memory: "on fixture",
    next_goal: "click",
    action: { name: "click", params: { index: 1 } },
    actions: [{ name: "click", params: { index: 1 } }],
  },
  {
    evaluation_previous_goal: "clicked",
    memory: "done",
    next_goal: "finish",
    action: { name: "done", params: { text: "bridge smoke done", success: true } },
    actions: [{ name: "done", params: { text: "bridge smoke done", success: true } }],
  },
];
let toolCallCount = 0;
let hungRequests = 0;
const llm = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = (() => {
      try {
        return JSON.parse(body);
      } catch {
        return {};
      }
    })();
    const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
    if (hasTools && body.includes("第二个任务")) {
      // 场景 2：run#2 的 agent 请求挂起不答（judge/matcher 调用也带 tools——必须按
      // 任务文本精确判定，勿误伤 run#1 的 judge）——run#2 停在 running，journal
      // 200ms 防抖即落盘，杀 SW 后有可恢复的 running 态
      hungRequests += 1;
      return;
    }
    let payload;
    if (hasTools && toolCallCount < SCRIPT.length) {
      let input = SCRIPT[toolCallCount];
      if (toolCallCount === 1) {
        const m = body.match(/\[(\d+)\]<button/g);
        const idx =
          m === null || m.length === 0 ? null : Number(m[m.length - 1].match(/\[(\d+)\]/)[1]);
        if (idx === null) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "mock LLM: no [N]<button in state text" }));
          return;
        }
        input = {
          ...input,
          action: { name: "click", params: { index: idx } },
          actions: [{ name: "click", params: { index: idx } }],
        };
      }
      toolCallCount += 1;
      payload = {
        content: [{ type: "tool_use", id: `tu_${toolCallCount}`, name: "agent_response", input }],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 20 },
      };
    } else {
      payload = {
        content: [{ type: "text", text: "NONE" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 1 },
      };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
});
await new Promise((r) => llm.listen(LLM_PORT, "127.0.0.1", r));
const fixtureSrv = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(FIXTURE_HTML);
});
await new Promise((r) => fixtureSrv.listen(FIXTURE_PORT, "127.0.0.1", r));

const pairingDir = mkdtempSync(join(tmpdir(), "tc-bridge-e2e-"));
const pairingPath = join(pairingDir, "pairing.json");

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
    notifications: messages.filter((m) => m.id === undefined),
  };
}

function toolText(call) {
  const block = call?.response?.result?.content?.[0];
  if (block?.type !== "text") return null;
  try {
    return JSON.parse(block.text);
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const swConsole = [];
let chromeProc = null;
let bridgeProc = null;
const summary = {};

try {
  // ① 真桥子进程（--pairing-path 临时目录——不污染真实 ~/.tc）
  bridgeProc = spawn(
    process.execPath,
    [BRIDGE_BIN, "serve", "--port", String(BRIDGE_PORT), "--pairing-path", pairingPath],
    { stdio: "ignore" },
  );
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${BRIDGE_URL}/health`)).ok) break;
    } catch {}
    await sleep(500);
    if (i === 39) throw new Error("bridge not up in 20s");
  }

  // ② Chrome + 扩展 + SW（CDP 连接吊住 SW 不休眠）；SW 控制台捕获（诊断挂点用）
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
  const page = await ensureSidepanelPage(CDP_PORT, extensionId);
  summary.swProbe = await sw.evaluate(`(async () => {
    const t = await chrome.tabs.query({ active: true, currentWindow: true });
    return JSON.stringify(t.map((x) => x.url));
  })()`);

  // ③ mock 卡 + fixture tab（活动 tab = run 绑定目标）+ 权限卡 Port 代答器
  await page.evaluate(`(async () => {
    await chrome.storage.local.set({ tc_settings: {
      providerCards: [{ name: "mock", protocol: "anthropic-messages", baseUrl: "http://127.0.0.1:${LLM_PORT}", apiKey: "k", model: "mock-model", maxTokens: 128 }],
      activeCard: "mock",
    } });
  })()`);
  await page.evaluate(`(async () => { await chrome.tabs.create({ url: "${FIXTURE_URL}" }); })()`);
  await sleep(1200);
  await page.evaluate(`(() => {
    const port = chrome.runtime.connect({ name: "e2e-driver" });
    port.onMessage.addListener((m) => {
      if (m.kind === "permission-request") {
        port.postMessage({ kind: "permission-resolve", token: m.token, verdict: "allow-once" });
      }
    });
  })()`);

  // ④ 配对真链路：admin 签发 → 扩展捕获 connect URL 的 t → 私线 pair
  const invite = await (
    await fetch(`${BRIDGE_URL}/admin/pairing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
  ).json();
  if (typeof invite.url !== "string")
    throw new Error(`admin/pairing malformed: ${JSON.stringify(invite)}`);
  await page.evaluate(
    `(async () => { await chrome.tabs.create({ url: ${JSON.stringify(invite.url)} }); })()`,
  );
  let paired = false;
  for (let i = 0; i < 30 && !paired; i++) {
    await sleep(1000);
    const health = await (await fetch(`${BRIDGE_URL}/health`)).json();
    paired = health?.status?.paired === true;
    summary.connected = health?.status?.connected;
  }
  if (!paired) throw new Error("extension did not pair in 30s（tabs 捕获/私线 pair 链路断）");

  console.log("[step] pairing ok");
  // ⑤ MCP：initialize → tools_list 断言
  const init = await rpc(
    "initialize",
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0" },
    },
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
  if (toolNames.join(",") !== "tc_bridge_status,run_task,get_snapshot,watch_task,stop_run") {
    failures.push(`tools/list = ${toolNames.join(",")}`);
  }

  console.log("[step] tools listed");
  // ⑥ run_task → watch_task（stream progress）至终态
  const run1 = await rpc(
    "tools/call",
    { name: "run_task", arguments: { task: "打开 fixture 页，点击第一个按钮，然后完成" } },
    sessionId,
  );
  const run1Result = toolText(run1);
  if (run1?.response?.result?.isError === true || run1Result?.accepted !== true) {
    throw new Error(`run_task failed: ${JSON.stringify(run1Result ?? run1.response)}`);
  }
  const runId1 = run1Result.runId;
  console.log("[step] run1 accepted:", runId1);
  const watch = await rpc(
    "tools/call",
    {
      name: "watch_task",
      arguments: { runId: runId1, waitTimeoutSeconds: 90, stream: true },
      _meta: { progressToken: "w1" },
    },
    sessionId,
  );
  const watched = toolText(watch);
  if (watch?.response?.result?.isError === true || watched?.isDone !== true) {
    failures.push(`watch_task 未到终态: ${JSON.stringify(watched ?? watch.response)}`);
  } else {
    if (watched.status !== "done")
      failures.push(`status=${watched.status} lastError=${watched.stopReason}`);
    if (watched.finalResult !== "bridge smoke done")
      failures.push(`finalResult=${watched.finalResult}`);
    if (watched.nSteps < 2) failures.push(`nSteps=${watched.nSteps} < 2`);
    if (
      (watch.notifications ?? []).filter((n) => n.method === "notifications/progress").length < 1
    ) {
      failures.push("watch progress 通知缺失（stream 链路）");
    }
  }
  const title = await page.evaluate(
    `(async () => { const t = (await chrome.tabs.query({})).find((x) => x.title.startsWith("CLICKED")); return t ? t.title : null; })()`,
  );
  if (title === null) failures.push("fixture 点击副作用未落地（无 CLICKED title）");
  summary.run1 = {
    runId: runId1,
    status: watched?.status,
    finalResult: watched?.finalResult,
    progress: (watch.notifications ?? []).length,
  };

  console.log("[step] watch done:", JSON.stringify(watched));
  // ⑦ 场景 2：run 中杀 SW → alarm 唤醒恢复 → get_snapshot 见 interrupted
  const run2 = await rpc(
    "tools/call",
    { name: "run_task", arguments: { task: "第二个任务，中途会被杀" } },
    sessionId,
  );
  const run2Result = toolText(run2);
  if (run2Result?.accepted !== true)
    throw new Error(`run_task#2 failed: ${JSON.stringify(run2Result)}`);
  // 等 run#2 的首个 LLM 请求挂起（mock 不答）→ journal 200ms 防抖落盘 running 态
  await sleep(5000);
  const diskBefore = await page.evaluate(`(async () => {
    const items = await chrome.storage.local.get(null);
    return JSON.stringify(Object.fromEntries(Object.entries(items).filter(([k]) => k.startsWith("tc_runUi")).map(([k, v]) => [k, { status: v.status, runId: v.runId }])));
  })()`);
  console.log("[diag] disk before kill:", diskBefore);
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

  // 45s 唤醒窗（alarm 0.5min + boot）后取快照——恢复链路：alarm 唤醒 → runtime 恢复
  // 轮询 → journal 恢复 interrupted（决策 5）
  await sleep(45_000);
  const snap2 = await rpc("tools/call", { name: "get_snapshot", arguments: {} }, sessionId, 90_000);
  const snap2Result = toolText(snap2);
  if (snap2?.response?.result?.isError === true || typeof snap2Result?.status !== "string") {
    failures.push(`SW 中杀后快照不可得: ${JSON.stringify(snap2Result ?? snap2.response)}`);
  } else {
    if (snap2Result.status !== "interrupted")
      failures.push(`恢复后 status=${snap2Result.status}（期望 interrupted）`);
    if (snap2Result.runId !== run2Result.runId)
      failures.push(`恢复后 runId=${snap2Result.runId}（期望 ${run2Result.runId}）`);
  }
  summary.recovered = { status: snap2Result?.status, runId: snap2Result?.runId };
} finally {
  chromeProc?.kill();
  bridgeProc?.kill();
  fixtureSrv.close();
  llm.close();
  try {
    rmSync(pairingDir, { recursive: true, force: true });
  } catch {}
}

console.log(
  `[smoke-bridge] ${JSON.stringify(summary)} llm: calls=${toolCallCount} hung=${hungRequests}`,
);
if (failures.length > 0) {
  console.error(`SMOKE FAIL:\n  - ${failures.join("\n  - ")}`);
  if (swConsole.length > 0)
    console.error(`[sw console tail]\n  ${swConsole.slice(-20).join("\n  ")}`);
  process.exit(1);
}
console.log("SMOKE PASS: bridge 全链（配对真链路 → MCP run/watch → 副作用 → SW 中杀恢复）");
process.exit(0);
