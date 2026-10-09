// E5 真 UI smoke（m5/05 §6）：真侧边栏页面（React 组件全量）经 CDP DOM 驱动——
// 输入任务 → 点「开始」→ 权限卡在 DOM 出现后点「本次允许」（×2）→ 时间线事件
// 渲染 → done 终态 + FinalResult 可见。mock LLM localhost（anthropic 形态剧本三步，
// click 索引从请求状态文本解析——段 D smoke 同款）。与段 D smoke 的差别：本例走
// 真 UI（PortClient/状态机/console-ui 组件），D 例走裸 Port 驱动。
// 用例：先 npx wxt build，然后 node apps/extension/e2e/smoke-ui.mjs。
import { createServer } from "node:http";
import { connectOurServiceWorker, ensureSidepanelPage, launchChrome } from "./lib-harness.mjs";

const CDP_PORT = 9788;
const FIXTURE_PORT = 8817;
const LLM_PORT = 8829;
const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}/fixture.html`;
const TASK = "打开 fixture 页，点击第一个按钮，然后完成";

const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>ui-smoke-fixture</title></head>
<body>
<h1>ui smoke fixture</h1>
<button id="btn-a" type="button" onclick="document.title='CLICKED-A'">Button A</button>
<button id="btn-b" type="button" onclick="document.title='CLICKED-B'">Button B</button>
</body></html>`;

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
    action: { name: "done", params: { text: "ui smoke done", success: true } },
    actions: [{ name: "done", params: { text: "ui smoke done", success: true } }],
  },
];
let toolCallCount = 0;
const buttonIndexOf = (raw) => {
  const m = raw.match(/\[(\d+)\]<button/g);
  if (m === null || m.length === 0) return null;
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
    const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
    let payload;
    if (hasTools && toolCallCount < SCRIPT.length) {
      let input = SCRIPT[toolCallCount];
      if (toolCallCount === 1) {
        const idx = buttonIndexOf(body);
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

let proc = null;
const failures = [];
let allowedCards = 0;
try {
  const { proc: chromeProc, profileDir } = await launchChrome({ port: CDP_PORT });
  proc = chromeProc;
  const { sw } = await connectOurServiceWorker(CDP_PORT, profileDir);
  const page = await ensureSidepanelPage(CDP_PORT, await sw.evaluate("chrome.runtime.id"));

  // ① mock 卡配置 + 开 fixture tab（成为活动 tab）
  await page.evaluate(`(async () => {
    await chrome.storage.local.set({ tc_settings: {
      providerCards: [{ name: "mock", protocol: "anthropic-messages", baseUrl: "http://127.0.0.1:${LLM_PORT}", apiKey: "k", model: "mock-model", maxTokens: 128 }],
      activeCard: "mock",
    } });
    const before = new Set((await chrome.tabs.query({})).map((t) => t.id));
    await chrome.tabs.create({ url: "${FIXTURE_URL}" });
    await new Promise((r) => setTimeout(r, 1500));
    return (await chrome.tabs.query({})).find((t) => !before.has(t.id))?.id ?? null;
  })()`);

  // ② 等 UI 上线（PortClient 连上后任务条可输入）
  const uiReady = await waitFor(
    page,
    "!!document.querySelector('[data-testid=task-bar] textarea')",
    10_000,
  );
  if (!uiReady) throw new Error("sidepanel UI 未挂载（task-bar 不可见）");

  // ③ 输入任务（React 受控组件：native setter + input 事件）→ 点开始
  await page.evaluate(`(() => {
    const ta = document.querySelector("[data-testid=task-bar] textarea");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, ${JSON.stringify(TASK)});
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await page.evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("开始"));
    if (!btn) throw new Error("开始按钮不可见");
    btn.click();
  })()`);

  // ④ 权限卡到达 → 点「本次允许」（守卫链串行：同时至多一张；navigate+click 两张）
  const deadline = Date.now() + 60_000;
  let done = false;
  while (Date.now() < deadline && !done) {
    await new Promise((r) => setTimeout(r, 500));
    const state = await page.evaluate(`(() => {
      const card = document.querySelector("[data-testid=permission-card]");
      if (card !== null) {
        const allow = [...card.querySelectorAll("button")].find((b) => b.textContent.includes("本次允许"));
        if (allow !== null) allow.click();
      }
      const status = [...document.querySelectorAll(".tc-badge")].map((b) => b.textContent).join("|");
      const timeline = document.querySelectorAll("[data-testid=run-timeline] > details").length;
      const final = document.querySelector("[data-testid=final-result]");
      return JSON.stringify({ card: card !== null, status, timeline, final: final !== null, finalText: final?.textContent ?? "" });
    })()`);
    const s = JSON.parse(state);
    if (s.card) allowedCards = Math.max(allowedCards, allowedCards + 1);
    if (s.final !== false && s.finalText.includes("ui smoke done") && s.timeline >= 2) {
      done = true;
      if (s.status.includes("完成")) {
        console.log(
          `[smoke-ui] status=${s.status} timelineGroups=${s.timeline} final=${s.finalText.slice(0, 60)}`,
        );
      } else {
        failures.push(`终态徽章异常：${s.status}`);
      }
    }
  }
  if (!done) failures.push("run 未在预算内完成（FinalResult/时间线未就位）");
  if (allowedCards < 2) failures.push(`权限卡代答 = ${allowedCards} < 2`);
  if (toolCallCount < 3) failures.push(`LLM tool calls = ${toolCallCount} < 3`);
} finally {
  proc?.kill();
  fixtureSrv.close();
  llm.close();
}

if (failures.length > 0) {
  console.error(`SMOKE FAIL:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(
  "SMOKE PASS: ui 全链（task-bar 输入 → 开始 → 权限卡 DOM 代答×2 → 时间线 → done + FinalResult）",
);
process.exit(0);

/** 轮询断言（页内表达式真值） */
async function waitFor(page, expr, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await page.evaluate(`!!(${expr})`)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
