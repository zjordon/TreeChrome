// #37 U2 批 A 验收⑤ e2e 冒烟：排队 3 条中途 stop 的全状态断言。链路：mock LLM
// 剧本化（步进可控——前 2 步 tool_use 后挂起）→ control start 首任务 → 运行中
// queue-add ×3（会话归档应答 turnId）→ control stop → 断言：首 run interrupted、
// 三条排队全 cancelled、无第二条 run 启动。用例：先 npx wxt build，然后
// node apps/extension/e2e/smoke-queue.mjs。
import { createServer } from "node:http";
import { connectOurServiceWorker, ensureSidepanelPage, launchChrome } from "./lib-harness.mjs";

const CDP_PORT = 9779;
const FIXTURE_PORT = 8808;
const LLM_PORT = 8900;
const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}/fixture.html`;

const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>queue-fixture</title></head>
<body><h1>queue smoke fixture</h1><button id="btn-a" type="button">Button A</button></body></html>`;

// mock LLM：首步 navigate tool_use 后挂起（不回包——run 停在 LLM 调用在途），
// stop 由控制面打断。挂起用长计时器 + res 持有（stop 后 finally 收口不依赖回包）。
let holdRes = null;
let toolCallCount = 0;
const llm = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const hasTools = body.includes("agent_response");
    if (!hasTools) {
      // 附属调用：纯文本优雅降级
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          content: [{ type: "text", text: "NONE" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 1 },
        }),
      );
      return;
    }
    toolCallCount += 1;
    if (toolCallCount === 1) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              id: "tu_1",
              name: "agent_response",
              input: {
                evaluation_previous_goal: "",
                memory: "start",
                next_goal: "navigate",
                action: { name: "navigate", params: { url: FIXTURE_URL } },
                actions: [{ name: "navigate", params: { url: FIXTURE_URL } }],
              },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
      );
    } else {
      // 第 2+ 次主循环调用：挂起（stop 打断路径的稳定在途窗口）
      holdRes = res;
    }
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
let sessionState = null;
try {
  const { proc: chromeProc, profileDir } = await launchChrome({ port: CDP_PORT });
  proc = chromeProc;
  const { sw } = await connectOurServiceWorker(CDP_PORT, profileDir);
  const page = await ensureSidepanelPage(CDP_PORT, await sw.evaluate("chrome.runtime.id"));

  await page.evaluate(`(async () => {
    await chrome.storage.local.set({ tc_settings: {
      providerCards: [{ name: "mock", protocol: "anthropic-messages", baseUrl: "http://127.0.0.1:${LLM_PORT}", apiKey: "k", model: "mock-model", maxTokens: 128 }],
      activeCard: "mock",
    } });
  })()`);

  await page.evaluate(`(async () => {
    await chrome.tabs.create({ url: "${FIXTURE_URL}" });
    await new Promise((r) => setTimeout(r, 1500));
  })()`);

  // ① 起跑首任务（停在 mock LLM 第 2 次调用的挂起窗）
  await page.evaluate(`(async () => {
    await chrome.runtime.sendMessage({ kind: "control", action: "start", task: "首任务：打开 fixture 后停下" });
  })()`);
  await new Promise((r) => setTimeout(r, 2500));
  // 确保 run 在跑（journal running）
  const running = await page.evaluate(`(async () => {
    const items = await chrome.storage.local.get(null);
    const key = Object.keys(items).find((k) => k.startsWith("tc_runUi:"));
    return key ? JSON.stringify(items[key]) : null;
  })()`);
  if (running === null || !JSON.parse(running).sessionId) {
    throw new Error(`首任务未起跑或无会话（journal=${running?.slice(0, 120)}）`);
  }
  const sessionId = JSON.parse(running).sessionId;

  // ② 运行中入队 ×3（queue-add 单发面——SW 排队器受理）
  const queued = [];
  for (let i = 1; i <= 3; i += 1) {
    const r = await page.evaluate(`(async () => {
      const res = await chrome.runtime.sendMessage({ kind: "session", op: "queue-add", payload: { sessionId: ${JSON.stringify(sessionId)}, task: "排队任务${i}" } });
      return JSON.stringify(res);
    })()`);
    queued.push(JSON.parse(r));
  }

  // ③ 中途 stop（连播清空 D2）
  await page.evaluate(`(async () => {
    await chrome.runtime.sendMessage({ kind: "control", action: "stop" });
  })()`);

  // ④ 轮询会话归档直到首 run 终态（30s 预算——stop 经 agent 标志位 + LLM 120s
  //    超时兜底；挂起窗的调用会被打断收口）
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const rec = await page.evaluate(`(async () => {
      const res = await chrome.runtime.sendMessage({ kind: "session", op: "session-open", payload: { sessionId: ${JSON.stringify(sessionId)} } });
      return res && res.ok ? JSON.stringify(res.record) : null;
    })()`);
    if (rec !== null) {
      const parsed = JSON.parse(rec);
      const first = parsed.runs[0];
      if (first !== undefined && ["done", "error", "interrupted"].includes(first.status)) {
        sessionState = parsed;
        break;
      }
    }
  }

  // ⑤ 全状态断言
  if (sessionState === null) {
    failures.push("会话归档未在预算内到终态");
  } else {
    const first = sessionState.runs[0];
    if (first?.status !== "interrupted")
      failures.push(`首 run status=${first?.status}（期望 interrupted）`);
    if (sessionState.runs.length !== 1)
      failures.push(`runs=${sessionState.runs.length}（期望 1——排队不应续跑）`);
    const cancelled = sessionState.turns.filter((t) => t.status === "cancelled");
    if (cancelled.length !== 3)
      failures.push(`cancelled turns=${cancelled.length}（期望 3——stop 连播清空 D2）`);
    if (queued.some((q) => q.ok !== true))
      failures.push(`queue-add 有失败：${JSON.stringify(queued)}`);
  }
} finally {
  holdRes?.end(
    JSON.stringify({ content: [{ type: "text", text: "held" }], stop_reason: "end_turn" }),
  );
  proc?.kill();
  fixtureSrv.close();
  llm.close();
}

console.log(
  `[smoke-queue] session: ${
    sessionState === null
      ? "null"
      : JSON.stringify({
          runs: sessionState.runs.length,
          first: sessionState.runs[0]?.status,
          turns: sessionState.turns.map((t) => `${t.task.slice(0, 8)}:${t.status}`),
        })
  }`,
);
console.log(`[smoke-queue] llm: toolCalls=${toolCallCount}`);

if (failures.length > 0) {
  console.error(`SMOKE FAIL:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(
  "SMOKE PASS: queue 全链（start → 挂起窗入队×3 → stop → 首轮 interrupted + 3 排队 cancelled + 零续跑）",
);
process.exit(0);
