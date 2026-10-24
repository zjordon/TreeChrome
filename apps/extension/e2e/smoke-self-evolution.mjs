// issue #5 自进化闭环 e2e smoke（S6，M7 验收句）：mock LLM 成功 run（judge verdict
// true 过门控）→ 队列 → worker 蒸馏（mock 卡）→ IDB 草稿 + skill-drafts 广播 →
// options op 采纳 → 二跑 matcher 命中注入 → skill_active 事件含 taskSlug。
// mock LLM 按请求体路由四种面：蒸馏（task_slug schema）/ matcher（match schema）/
// judge（failure_reason schema + agent_response）/ 主循环步（agent_response）。
// 用例：先 npx wxt build，然后 node apps/extension/e2e/smoke-self-evolution.mjs。
import { createServer } from "node:http";
import { connectOurServiceWorker, ensureSidepanelPage, launchChrome } from "./lib-harness.mjs";

const CDP_PORT = 9779;
const FIXTURE_PORT = 8808;
const LLM_PORT = 8900;
const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}/fixture.html`;

const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>self-evo-fixture</title></head>
<body><h1>self evolution smoke fixture</h1>
<button id="btn-a" type="button" onclick="document.title='CLICKED-A'">Button A</button>
</body></html>`;

// ── 蒸馏产物（mock 卡——host 由轨迹 URL 多数票决定 = 127.0.0.1:PORT）──
const DISTILL_CARD = {
  task_slug: "click-fixture-button",
  task_description: "打开 fixture 页并点击按钮",
  task_keywords: ["fixture", "按钮"],
  sop_md: "# 打开 fixture 点按钮\nstep 1: navigate 后直接 done",
  selectors_md: "",
  quirks_md: "无特殊坑点",
};

// 主循环步剧本（两轮同款：navigate → done(success)——judge 由 schema 路由另行应答）
const runStep = (i, url) =>
  [
    {
      evaluation_previous_goal: "",
      memory: "start",
      next_goal: "navigate to fixture",
      action: { name: "navigate", params: { url } },
      actions: [{ name: "navigate", params: { url } }],
    },
    {
      evaluation_previous_goal: "navigated",
      memory: "on fixture",
      next_goal: "finish",
      action: { name: "done", params: { text: "self-evo done", success: true } },
      actions: [{ name: "done", params: { text: "self-evo done", success: true } }],
    },
  ][i];

let stepIdx = 0;
const counts = { runSteps: 0, judge: 0, distill: 0, matcher: 0 };
const llm = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let toolName = null;
    let input = null;
    try {
      const parsed = JSON.parse(body);
      const tool = (parsed.tools ?? []).find((t) =>
        ["agent_response", "structured_result"].includes(t.name),
      );
      toolName = tool?.name ?? null;
    } catch {}
    const mk = (name, args) => ({
      content: [{ type: "tool_use", id: `tu_${Date.now()}_${Math.random()}`, name, input: args }],
      stop_reason: "tool_use",
      usage: { input_tokens: 50, output_tokens: 10 },
    });
    // —— 路由：schema 键区分四种面（judge 与主循环同用 agent_response——按
    //    judge schema 独有键 failure_reason 分流）——
    if (toolName === "structured_result" && body.includes('"task_slug"')) {
      counts.distill += 1;
      input = mk("structured_result", DISTILL_CARD);
    } else if (toolName === "structured_result" && body.includes('"match"')) {
      counts.matcher += 1;
      input = mk("structured_result", {
        match: "click-fixture-button",
        confidence: "high",
        reason: "same task",
      });
    } else if (toolName === "agent_response" && body.includes('"failure_reason"')) {
      counts.judge += 1;
      input = mk("agent_response", {
        reasoning: "任务完成且结果正确",
        verdict: true,
        failure_reason: null,
        impossible_task: false,
        captcha: false,
      });
    } else if (toolName === "agent_response") {
      // 两轮同剧本：stepIdx 0/1 = run1（navigate/done），2/3 = run2
      const step = runStep(stepIdx % 2, FIXTURE_URL);
      stepIdx += 1;
      counts.runSteps += 1;
      input = mk("agent_response", step);
    } else {
      input = {
        content: [{ type: "text", text: "NONE" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 1 },
      };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(input));
  });
});
await new Promise((r) => llm.listen(LLM_PORT, "127.0.0.1", r));
const fixtureSrv = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(FIXTURE_HTML);
});
await new Promise((r) => fixtureSrv.listen(FIXTURE_PORT, "127.0.0.1", r));

// ── 主链 ──
let proc = null;
const failures = [];
const d = { run1: null, run2: null, drafts1: null, adopt: null, skillsAfter: null };
let page = null;
const waitTerminal = async (budgetMs) => {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 800));
    const raw = await page.evaluate(`(async () => {
      const items = await chrome.storage.local.get(null);
      const key = Object.keys(items).find((k) => k.startsWith("tc_runUi:"));
      return key ? JSON.stringify(items[key]) : null;
    })()`);
    if (raw === null) continue;
    const snap = JSON.parse(raw);
    if (["done", "error", "interrupted"].includes(snap.status)) return snap;
  }
  return null;
};
const optionsOp = (op, payload) =>
  page.evaluate(
    `(async () => chrome.runtime.sendMessage({ kind: "options", op: "${op}", payload: ${JSON.stringify(
      payload === undefined ? null : payload,
    )} }))()`,
  );

try {
  const { proc: chromeProc, profileDir } = await launchChrome({ port: CDP_PORT });
  proc = chromeProc;
  const { sw } = await connectOurServiceWorker(CDP_PORT, profileDir);
  page = await ensureSidepanelPage(CDP_PORT, await sw.evaluate("chrome.runtime.id"));

  // mock 卡配置（selfEvolution 缺省 enabled——不设即开）
  await page.evaluate(`(async () => {
    await chrome.storage.local.set({ tc_settings: {
      providerCards: [{ name: "mock", protocol: "anthropic-messages", baseUrl: "http://127.0.0.1:${LLM_PORT}", apiKey: "k", model: "mock-model", maxTokens: 256 }],
      activeCard: "mock",
    } });
  })()`);

  // 驱动面：权限代答 + 广播捕获（skill-drafts / skill_active）
  await page.evaluate(`(() => {
    window.__e2e = { permissions: 0, draftNotices: [], skillActive: [] };
    const port = chrome.runtime.connect({ name: "e2e-driver" });
    port.onMessage.addListener((m) => {
      if (m.kind === "permission-request") {
        window.__e2e.permissions += 1;
        port.postMessage({ kind: "permission-resolve", token: m.token, verdict: "allow-once" });
      } else if (m.kind === "skill-drafts") {
        window.__e2e.draftNotices.push(m.count);
      } else if (m.kind === "event" && m.event?.eventType === "skill_active") {
        window.__e2e.skillActive.push({ taskSlug: m.event.taskSlug, chars: m.event.taskSkillChars });
      }
    });
  })()`);

  // fixture tab 成为活动 tab
  const tabOk = await page.evaluate(`(async () => {
    const before = new Set((await chrome.tabs.query({})).map((t) => t.id));
    await chrome.tabs.create({ url: "${FIXTURE_URL}" });
    await new Promise((r) => setTimeout(r, 1200));
    return (await chrome.tabs.query({})).some((t) => !before.has(t.id));
  })()`);
  if (tabOk !== true) throw new Error("fixture tab not created");

  // ── run 1：成功 + judge pass → 异步蒸馏 ──
  await page.evaluate(
    `(async () => chrome.runtime.sendMessage({ kind: "control", action: "start", task: "打开 fixture 页然后完成" }))()`,
  );
  d.run1 = await waitTerminal(60_000);
  // worker drain 是 run 终态后的异步链——轮询草稿（30s 预算）
  let drafts = [];
  const draftDeadline = Date.now() + 30_000;
  while (Date.now() < draftDeadline) {
    await new Promise((r) => setTimeout(r, 800));
    const res = await optionsOp("list-skill-drafts", null);
    if (res?.ok === true && Array.isArray(res.drafts) && res.drafts.length > 0) {
      drafts = res.drafts;
      break;
    }
  }
  d.drafts1 = drafts;

  // ── 采纳（options op，宿主真实面）──
  if (drafts.length > 0) {
    const { host, slug } = drafts[0];
    d.adopt = await optionsOp("adopt-skill-draft", { host, slug });
    d.skillsAfter = await optionsOp("list-skills", null);
  }

  // ── run 2：matcher 命中注入 → skill_active(taskSlug) ──
  await page.evaluate(
    `(async () => chrome.runtime.sendMessage({ kind: "control", action: "start", task: "打开 fixture 页然后完成" }))()`,
  );
  d.run2 = await waitTerminal(60_000);
  const driver = await page.evaluate("JSON.stringify(window.__e2e)");
  d.driver = JSON.parse(driver);
  const queueLeft = await page.evaluate(
    `(async () => (await chrome.storage.local.get("tc_distillQueue")).tc_distillQueue ?? null)()`,
  );
  d.queueLeft = Array.isArray(queueLeft) ? queueLeft.length : queueLeft;

  // ── 断言 ──
  if (d.run1?.status !== "done" || d.run1?.isDone !== true)
    failures.push(`run1 未成功: ${JSON.stringify(d.run1?.status)} err=${d.run1?.lastError}`);
  if (d.drafts1?.length !== 1) failures.push(`蒸馏草稿数 = ${d.drafts1?.length ?? 0}（期望 1）`);
  else {
    const draft = d.drafts1[0];
    if (draft.slug !== "click-fixture-button")
      failures.push(`draft.slug = ${draft.slug}（mock 卡 slug 不符）`);
    if (draft.host !== `127.0.0.1_${FIXTURE_PORT}`)
      failures.push(
        `draft.host = ${draft.host}（期望 127.0.0.1_${FIXTURE_PORT}——skill 目录键形态，_ 分隔端口）`,
      );
  }
  if (d.adopt?.ok !== true) failures.push(`adopt 失败: ${JSON.stringify(d.adopt)}`);
  if (d.driver?.draftNotices?.length < 1)
    failures.push("未收到 skill-drafts 广播（sidepanel 轻提示面）");
  if (d.run2?.status !== "done" || d.run2?.isDone !== true)
    failures.push(`run2 未成功: ${JSON.stringify(d.run2?.status)} err=${d.run2?.lastError}`);
  const active = (d.driver?.skillActive ?? []).find((s) => s.taskSlug === "click-fixture-button");
  if (active === undefined)
    failures.push(
      `run2 未捕获 skill_active(taskSlug)：${JSON.stringify(d.driver?.skillActive ?? [])}`,
    );
  if (counts.matcher < 1) failures.push("run2 matcher 调用未发生（注入链未走到）");
  if (counts.judge < 1) failures.push("judge 调用未发生（门控依赖 verdict）");
} finally {
  proc?.kill();
  fixtureSrv.close();
  llm.close();
}

console.log(
  `[smoke-self-evolution] run1=${d.run1?.status} run2=${d.run2?.status} drafts=${d.drafts1?.length ?? 0} adopt=${JSON.stringify(d.adopt?.ok)}`,
);
console.log(
  `[smoke-self-evolution] llm: steps=${counts.runSteps} judge=${counts.judge} distill=${counts.distill} matcher=${counts.matcher}`,
);
console.log(
  `[smoke-self-evolution] driver: draftNotices=${JSON.stringify(d.driver?.draftNotices ?? [])} skillActive=${JSON.stringify(d.driver?.skillActive ?? [])} queueLeft=${d.queueLeft}`,
);

if (failures.length > 0) {
  console.error(`SMOKE FAIL:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(
  "SMOKE PASS: self-evolution 全链（run 成功+judge pass → 门控蒸馏入队 → IDB 草稿+广播 → options 采纳 → 二跑 matcher 命中注入 → skill_active 含 taskSlug）",
);
process.exit(0);
