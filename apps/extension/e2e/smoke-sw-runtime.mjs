// D5 SW 运行时全链 smoke（m5/04 §10）：mock LLM localhost 端点（anthropic-messages
// 形态剧本化——navigate/click/done 三步）→ 扩展内真装配跑 run：control start →
// 权限卡经测试脚本自动应答（allow-once）→ journal 落盘（chrome.storage
// tc_runUi:<tabId>）→ done + 点击副作用（fixture 按钮 onclick 改 title）断言。
// 用例：先 npx wxt build，然后 node apps/extension/e2e/smoke-sw-runtime.mjs。
import { createServer } from "node:http";
import { connectOurServiceWorker, ensureSidepanelPage, launchChrome } from "./lib-harness.mjs";

const CDP_PORT = 9778;
const FIXTURE_PORT = 8807;
const LLM_PORT = 8899;
const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}/fixture.html`;

// ── fixture 页：按钮点击改 title（点击副作用断言用）──
const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>sw-runtime-fixture</title></head>
<body onclick="document.title='CLICKED-BODY'">
<h1>sw runtime smoke fixture</h1>
<button id="btn-a" type="button" onclick="document.title='CLICKED-A'">Button A</button>
<button id="btn-b" type="button" onclick="document.title='CLICKED-B'">Button B</button>
<input id="name-input" type="text" placeholder="enter name">
</body></html>`;

// ── mock LLM（anthropic-messages 形态）：有 tools 的请求按剧本出 tool_use，
// 其余（task-skill 匹配器/judge 等附属调用）出纯文本（skill/judge 优雅降级）──
const SCRIPT = [
  {
    evaluation_previous_goal: "",
    memory: "start",
    next_goal: "navigate to fixture",
    action: { name: "navigate", params: { url: FIXTURE_URL } },
    actions: [{ name: "navigate", params: { url: FIXTURE_URL } }],
  },
  {
    evaluation_previous_goal: "navigated",
    memory: "on fixture",
    next_goal: "click button",
    action: { name: "click", params: { index: 1 } },
    actions: [{ name: "click", params: { index: 1 } }],
  },
  {
    evaluation_previous_goal: "clicked",
    memory: "button clicked",
    next_goal: "finish",
    action: { name: "done", params: { text: "smoke done", success: true } },
    actions: [{ name: "done", params: { text: "smoke done", success: true } }],
  },
];
let toolCallCount = 0;
const llmRequests = [];
// 从请求对话文本里提取首个 button 的 selector 索引（真模型同款行为：读状态选
// 元素——selector 序号非 DOM 序，盲填固定 index 必错）
const buttonIndexOf = (raw) => {
  const m = raw.match(/\[(\d+)\]<button/g);
  if (m === null || m.length === 0) return null;
  // 取最后一次出现（对话含历史状态——最新状态在末尾；re-navigate 后序号会变）
  return Number(m[m.length - 1].match(/\[(\d+)\]/)[1]);
};
const llm = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = {};
    }
    llmRequests.push({ hasTools: Array.isArray(parsed.tools) && parsed.tools.length > 0 });
    const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
    let payload;
    if (hasTools && toolCallCount < SCRIPT.length) {
      let input = SCRIPT[toolCallCount];
      if (toolCallCount === 1) {
        // click 步：按当前状态解析按钮索引（状态在本次请求的对话文本里）
        const idx = buttonIndexOf(body);
        if (idx === null) throw new Error("mock LLM: 状态文本中无 [N]<button 可点");
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
      // 附属调用（匹配器/judge）：纯文本——消费侧优雅降级（skill/judge 可选增强）
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

const { proc, profileDir } = await launchChrome({ port: CDP_PORT });
const { sw } = await connectOurServiceWorker(CDP_PORT, profileDir);
const page = await ensureSidepanelPage(CDP_PORT, await sw.evaluate("chrome.runtime.id"));

// ① 写入 mock 卡配置
await page.evaluate(`(async () => {
  await chrome.storage.local.set({ tc_settings: {
    providerCards: [{ name: "mock", protocol: "anthropic-messages", baseUrl: "http://127.0.0.1:${LLM_PORT}", apiKey: "k", model: "mock-model", maxTokens: 128 }],
    activeCard: "mock",
  } });
})()`);

// ② 开 fixture tab（成为活动 tab——run 绑定目标）+ 装 Port 自动应答器
const tabId = await page.evaluate(`(async () => {
  const before = new Set((await chrome.tabs.query({})).map((t) => t.id));
  await chrome.tabs.create({ url: "${FIXTURE_URL}" });
  await new Promise((r) => setTimeout(r, 1500));
  const t = (await chrome.tabs.query({})).find((t) => !before.has(t.id));
  return t ? t.id : null;
})()`);
if (typeof tabId !== "number") throw new Error("fixture tab not created");

await page.evaluate(`(() => {
  window.__e2e = { permissions: 0, snapshots: [], events: 0, errors: [] };
  const port = chrome.runtime.connect({ name: "e2e-driver" });
  port.onMessage.addListener((m) => {
    if (m.kind === "permission-request") {
      window.__e2e.permissions += 1;
      port.postMessage({ kind: "permission-resolve", token: m.token, verdict: "allow-once" });
    } else if (m.kind === "journal-snapshot") {
      window.__e2e.snapshots.push({ status: m.snapshot.status, isDone: m.snapshot.isDone,
        stepCount: m.snapshot.stepCount, lastError: m.snapshot.lastError, runId: m.snapshot.runId });
    } else if (m.kind === "event") {
      window.__e2e.events += 1;
    }
  });
})()`);

// ③ 起跑
const startAck = await page.evaluate(`(async () => {
  await chrome.runtime.sendMessage({ kind: "control", action: "start", task: "打开 fixture 页，点击第一个按钮，然后完成" });
  return "sent";
})()`);
void startAck;

// ④ 轮询 journal 落盘直到终态（60s 预算）
const deadline = Date.now() + 60_000;
let final = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000));
  final = await page.evaluate(`(async () => {
    const items = await chrome.storage.local.get(null);
    const key = Object.keys(items).find((k) => k.startsWith("tc_runUi:"));
    return key ? JSON.stringify(items[key]) : null;
  })()`);
  if (final !== null) {
    const snap = JSON.parse(final);
    if (["done", "error", "interrupted"].includes(snap.status)) {
      final = snap;
      break;
    }
  }
}

// ⑤ 断言
const driver = await page.evaluate("JSON.stringify(window.__e2e)");
const d = JSON.parse(driver);
const failures = [];
if (final === null || typeof final === "string") {
  failures.push(`run 未在预算内到终态（last=${JSON.stringify(final)?.slice(0, 200)}）`);
} else {
  if (final.status !== "done") failures.push(`status=${final.status} lastError=${final.lastError}`);
  if (final.isDone !== true) failures.push("isDone !== true");
  // done 步不发 step_end（journal 计步只数 step_end）——navigate/click 两步落账，
  // 第 3 步 LLM 调用由 toolCalls 断言覆盖
  if (final.stepCount < 2) failures.push(`stepCount=${final.stepCount} < 2`);
  if ((final.finalResult ?? "") !== "smoke done") failures.push(`finalResult=${final.finalResult}`);
}
if (d.permissions < 2) failures.push(`permission cards = ${d.permissions} < 2`);
if (d.events < 3) failures.push(`port events = ${d.events} < 3`);
if (toolCallCount < 3) failures.push(`LLM tool calls = ${toolCallCount} < 3`);
const title = await page.evaluate(
  `(async () => { const t = (await chrome.tabs.query({})).find((x) => x.id === ${tabId}); return t ? t.title : null; })()`,
);
if (title !== "CLICKED-A" && title !== "CLICKED-B" && title !== "CLICKED-BODY") {
  failures.push(`fixture title = ${title}（点击副作用未落地）`);
}

console.log(
  `[smoke-sw-runtime] journal: ${JSON.stringify(final && typeof final === "object" ? { status: final.status, steps: final.stepCount, isDone: final.isDone, lastError: final.lastError } : final)}`,
);
console.log(
  `[smoke-sw-runtime] driver: permissions=${d.permissions} events=${d.events} snapshots=${d.snapshots.length}`,
);
console.log(`[smoke-sw-runtime] llm: toolCalls=${toolCallCount} total=${llmRequests.length}`);

proc.kill();
fixtureSrv.close();
llm.close();
if (failures.length > 0) {
  console.error(`SMOKE FAIL:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("SMOKE PASS: sw-runtime 全链（start → 权限卡代答 → 3 步 → journal done → 点击副作用）");
process.exit(0);
