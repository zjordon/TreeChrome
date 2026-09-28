#!/usr/bin/env node
/**
 * agent-loop 真机 smoke（4.6，docs/implement-plan/p4/05 §4）：不发真 LLM 请求
 * （ScriptedLLMProvider 驱动真 LLMClient 梯子）端到端验证
 * transport → BrowserSession → get_state → 五阶段 → 动作执行 → history/judge/事件
 * 全链在真实 headless Chrome 上成立（undici 长会话 = 风险 7 覆盖）。
 *
 * 用法：
 *   node tools/agent-loop-smoke.mjs [--policy auto|deny-once] [--chrome <chrome.exe>]
 *     [--port 9333]
 * 默认 --policy deny-once（ScriptedPolicy 首个过门请求拒一次——验证 denied 通道与
 * 「不计失败」）；--policy auto 用 AutoAllowPolicy（记账断言）。
 *
 * 承载四个登记的真机验证点：
 *   #5  getBoxModel 坐标系（browser 评审驳回项）：链接置于折叠线下方，滚动后点击
 *       成功导航 = 坐标在 scrollIntoViewIfNeeded 后直落视口、无需减滚动偏移；
 *   #6  组合键 char 事件（browser 评审驳回项）：Control+a 后全选留痕（sel-log）+
 *       keydown/keypress 携带 modifiers 的到达证据（kbd-log）；
 *   #3  截图 passthrough（agent 段偏离登记）：每步截图真机采集 + PNG 头/尺寸证据；
 *   #4  权限门挂点全链（本段 4.5）。
 *
 * 断言：exitCode 0 当且仅当全部成立——isDone&&isSuccessful；history 步数=剧本；
 * interactedElement 投影命中；URL 漂移截断；事件完整序列 + session_end 收口；
 * judge verdict 写入末步；全程零重连（factory 单次）。手动跑，不入 CI。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const CHROME_DEFAULT = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 参数 ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { policy: "deny-once", chrome: CHROME_DEFAULT, port: 9333 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} 缺值`);
      return argv[++i];
    };
    if (a === "--policy") opts.policy = next();
    else if (a === "--chrome") opts.chrome = next();
    else if (a === "--port") opts.port = Number(next());
    else throw new Error(`未知参数：${a}`);
  }
  if (opts.policy !== "auto" && opts.policy !== "deny-once") {
    throw new Error(`--policy 仅支持 auto | deny-once（收到 ${opts.policy}）`);
  }
  return opts;
}

// ── esbuild 打包（llm-smoke.mjs 同款；cdp-ws 以相对路径入链） ──────────
function resolveEsbuild() {
  try {
    return require.resolve("esbuild");
  } catch (first) {
    try {
      const vitestPkgPath = require.resolve("vitest/package.json");
      return require.resolve("esbuild", { paths: [dirname(vitestPkgPath)] });
    } catch (e) {
      throw new Error(
        `esbuild 解析失败（packages/core devDependencies 声明了 esbuild）：${e.message}（首发：${first.message}）`,
      );
    }
  }
}

async function loadBundled() {
  const mod = await import(pathToFileURL(resolveEsbuild()).href);
  const build = mod.build ?? mod.default?.build;
  if (typeof build !== "function") throw new Error("esbuild JS API 不可用（build 导出缺失）");
  const tmp = mkdtempSync(join(tmpdir(), "tw-agent-smoke-"));
  try {
    const out = join(tmp, "bundle.mjs");
    await build({
      stdin: {
        contents:
          'export { Agent, LLMClient, BrowserSession, EventBus, PolicyGate, AutoAllowPolicy } from "./src/index.ts";\n' +
          'export { CdpWsClient } from "../cdp-ws/src/index.ts";\n' +
          'export { ScriptedLLMProvider } from "./test/helpers/scripted-llm.ts";\n',
        resolveDir: join(here, ".."),
        loader: "ts",
      },
      bundle: true,
      format: "esm",
      platform: "node",
      outfile: out,
    });
    return await import(pathToFileURL(out).href);
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Windows 杀毒/索引器瞬时文件锁：清理失败不影响主流程
    }
  }
}

// ── 本地静态页（05 §4：index 含输入框/链接 + 键盘证据探针） ─────────────
// 折叠线设计：控件置于 1500px 垫层之下——初始不可见（dom 采集按视口过滤，双侧
// Python/TS 同款语义），剧本先 scroll 再解析编号；#5 验证点正需要这一形态。
const INDEX_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Smoke Index</title></head><body>
<h1>Smoke Index</h1>
<div style="height:1500px;background:#f7f7f7">spacer: pushes interactive controls below the fold (getBoxModel observation)</div>
<input id="field" value="hello world" aria-label="smoke field">
<div id="kbd-log" style="width:12px;min-height:12px">KBDLOG:</div>
<div id="sel-log" style="width:12px;min-height:12px">SELLOG:</div>
<a id="about-link" href="about.html">About</a>
<script>
(function () {
  var kbd = document.getElementById("kbd-log");
  var sel = document.getElementById("sel-log");
  ["keydown", "keypress"].forEach(function (t) {
    document.addEventListener(t, function (e) {
      if (e.key === "a" || e.key === "A") {
        kbd.textContent += t + ":" + e.key + (e.ctrlKey ? "+ctrl" : "") + (e.metaKey ? "+meta" : "") + ";";
      }
    });
  });
  document.addEventListener("keyup", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "a") {
      var el = document.activeElement;
      if (el && typeof el.selectionStart === "number") {
        sel.textContent = "SELLOG:" + el.selectionStart + "-" + el.selectionEnd + "/" + el.value.length + "|v=" + el.value;
      }
    }
  });
})();
</script>
</body></html>`;

const ABOUT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>About</title></head><body>
<h1>About Page</h1><p id="ok">about ok</p>
</body></html>`;

function startServer() {
  const http = require("node:http");
  const server = http.createServer((req, res) => {
    const route = (req.url ?? "/").split("?")[0];
    const [body, type] =
      route === "/"
        ? [INDEX_HTML, "text/html"]
        : route === "/about.html"
          ? [ABOUT_HTML, "text/html"]
          : ["not found", "text/plain"];
    res.writeHead(route === "/" || route === "/about.html" ? 200 : 404, {
      "content-type": `${type}; charset=utf-8`,
    });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// ── Chrome 拉起（page-parity-smoke.mjs 同款） ──────────────────────────
async function waitVersion(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://localhost:${port}/json/version`);
      if (resp.ok) return await resp.json();
      lastErr = `HTTP ${resp.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(300);
  }
  throw new Error(`Chrome /json/version 等待超时（localhost:${port}，最后错误：${lastErr}）`);
}

function launchChrome({ chrome, port }) {
  if (!existsSync(chrome)) {
    throw new Error(`Chrome 不存在：${chrome}（用 --chrome 指定路径）`);
  }
  const profile = mkdtempSync(join(tmpdir(), "tw-agent-smoke-profile-"));
  const { spawn } = require("node:child_process");
  const child = spawn(
    chrome,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--headless=new",
      "--no-first-run",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  return { child, profile };
}

// ── state 文本自适应解析（从 element_tree_text 找目标编号——防 brittle 硬编码） ──
function parseDiagnostic(stateText) {
  const domAt = stateText.indexOf("[Page DOM]");
  return `[Page DOM] 段：${domAt < 0 ? "（缺失）" : JSON.stringify(stateText.slice(domAt, domAt + 400))}\n[总长 ${stateText.length}]`;
}

function lastIndexBefore(stateText, lineRe) {
  const lines = stateText.split("\n");
  let found = null;
  for (const line of lines) {
    const m = line.match(lineRe);
    if (m !== null) found = m;
  }
  return found;
}

function elementIndex(stateText, attrMatch) {
  const m = lastIndexBefore(stateText, new RegExp(`^\\*?\\[(\\d+)\\]<[a-z]+[^>\\n]*${attrMatch}`));
  return m === null ? null : Number(m[1]);
}

// 标记文本提取：探针 div 不进元素树（非交互节点只渲染文本行），以唯一前缀标记定位。
// userText 含新旧两份 state（替换保留 1 旧）——取最后匹配（最新 state）
function markerText(stateText, marker) {
  let found = null;
  for (const m of stateText.matchAll(new RegExp(`${marker}[^\\n]*`, "g"))) found = m[0];
  return found;
}

function lineWith(stateText, attrMatch) {
  const lines = stateText.split("\n");
  const re = new RegExp(`^\\*?\\[\\d+\\]<[a-z]+[^>\\n]*${attrMatch}`);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (re.test(lines[i])) return lines[i];
  }
  return null;
}

// ── 主流程 ────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const {
    Agent,
    LLMClient,
    BrowserSession,
    EventBus,
    PolicyGate,
    AutoAllowPolicy,
    CdpWsClient,
    ScriptedLLMProvider,
  } = await loadBundled();

  const { server, baseUrl } = await startServer();
  console.log(`[smoke] 静态页服务：${baseUrl}（policy=${opts.policy}）`);

  const launched = launchChrome(opts);
  console.log(`[smoke] 已拉起 headless Chrome（port=${opts.port}）`);
  const ver = await waitVersion(opts.port);
  const wsUrl = ver.webSocketDebuggerUrl;

  const failures = [];
  const check = (cond, label) => {
    if (cond) console.log(`  ok ${label}`);
    else {
      failures.push(label);
      console.error(`  FAIL ${label}`);
    }
  };

  let bus = null;
  let browser = null;

  try {
    // transport 工厂计数 = 零重连断言的观测面（自愈重连会二次调用工厂）
    let factoryCalls = 0;
    const transportFactory = async () => {
      factoryCalls += 1;
      return CdpWsClient.connect({ wsUrl });
    };
    browser = new BrowserSession(
      transportFactory,
      {},
      { log: (m) => console.log(`    [browser] ${m}`) },
    );

    // 剧本（decide 按最新 state 文本自适应；共享 evidence 在导航离页前采集）
    const evidence = { fieldIdx: null, aboutIdx: null, kbd: null, sel: null, fieldLine: null };
    const focusAndCombo = (stateText) => {
      const idx = elementIndex(stateText, "id=field");
      if (idx === null)
        throw new Error(
          `剧本解析失败：index 页未见 id=field 输入框\n${parseDiagnostic(stateText)}`,
        );
      return {
        evaluation_previous_goal: "",
        memory: "focus field then select-all via ctrl+a",
        next_goal: "focus input and send Control+a then x",
        action: { name: "click", params: { index: idx } },
        actions: [
          { name: "click", params: { index: idx } },
          { name: "send_keys", params: { keys: "Control+a" } },
          { name: "send_keys", params: { keys: "x" } },
        ],
      };
    };
    const scrollDown = () => ({
      evaluation_previous_goal: "",
      memory: "controls below fold; dom capture is viewport-filtered",
      next_goal: "scroll down to bring controls into view",
      action: { name: "scroll", params: { direction: "down", amount: 4 } },
      actions: [{ name: "scroll", params: { direction: "down", amount: 4 } }],
    });
    const clickAbout = (stateText) => {
      // 键盘证据在 index 页——离开前采进 evidence（about 页不再有探针节点）
      evidence.kbd = markerText(stateText, "KBDLOG:");
      evidence.sel = markerText(stateText, "SELLOG:");
      evidence.fieldLine = lineWith(stateText, "id=field");
      const idx = elementIndex(stateText, "id=about-link") ?? elementIndex(stateText, "href=about");
      if (idx === null)
        throw new Error(`剧本解析失败：index 页未见 About 链接\n${parseDiagnostic(stateText)}`);
      evidence.aboutIdx = idx;
      return {
        evaluation_previous_goal: "combo sent",
        memory: "drift-cut observation step",
        next_goal: "click About (drift cuts trailing wait)",
        action: { name: "click", params: { index: idx } },
        actions: [
          { name: "click", params: { index: idx } },
          { name: "wait", params: { seconds: 1 } },
        ],
      };
    };
    const clickFieldOnly = (stateText) => {
      const idx = elementIndex(stateText, "id=field");
      if (idx === null)
        throw new Error(`剧本解析失败：未见 id=field 输入框\n${parseDiagnostic(stateText)}`);
      return {
        evaluation_previous_goal: "",
        memory: "first gated request will be denied",
        next_goal: "click input field",
        action: { name: "click", params: { index: idx } },
        actions: [{ name: "click", params: { index: idx } }],
      };
    };
    const doneWithEvidence = () => ({
      evaluation_previous_goal: "on about page",
      memory: "evidence collected",
      next_goal: "finish",
      action: {
        name: "done",
        params: {
          text: `SMOKE done | kbd=${evidence.kbd} | sel=${evidence.sel} | field=${evidence.fieldLine}`,
          success: true,
        },
      },
      actions: [
        {
          name: "done",
          params: {
            text: `SMOKE done | kbd=${evidence.kbd} | sel=${evidence.sel} | field=${evidence.fieldLine}`,
            success: true,
          },
        },
      ],
    });

    // 剧本（首步 scroll：控件在折叠线下，dom 采集按视口过滤——滚动后编号才可见）
    const script =
      opts.policy === "auto"
        ? [scrollDown, focusAndCombo, clickAbout, doneWithEvidence]
        : [scrollDown, clickFieldOnly, focusAndCombo, clickAbout, doneWithEvidence];

    // ScriptedLLM（模型名 claude- 前缀命中视觉白名单——截图观察点需要 vision 门开）
    const provider = new ScriptedLLMProvider(script, "claude-smoke");
    const llm = new LLMClient(
      {
        name: "scripted",
        protocol: "openai-completions",
        baseUrl: "http://127.0.0.1:1",
        apiKey: "unused",
        model: "claude-smoke",
        maxTokens: 4096,
        capabilities: { supportsTools: true, supportsVision: true, supportsForcedTool: true },
      },
      { log: () => {} },
      provider,
    );

    // deny-once 变体：首个过门请求拒一次（ScriptedPolicy），此后 allow-once
    const scriptPolicy = {
      denied: 0,
      allowed: 0,
      seen: [],
      async requestPermission(req) {
        this.seen.push(req);
        if (this.denied === 0) {
          this.denied += 1;
          return "deny";
        }
        this.allowed += 1;
        return "allow-once";
      },
      async confirmSubmit() {
        return true;
      },
    };
    const autoAllow = new AutoAllowPolicy();
    const gate =
      opts.policy === "auto" ? new PolicyGate(autoAllow, null) : new PolicyGate(scriptPolicy, null);

    // 内存 FS：截图落盘观察（PNG 头 + 尺寸）
    const fsFiles = new Map();
    const memoryFs = {
      resolve: (p) => p,
      isFile: async () => false,
      readTextFile: async () => "",
      ensureDir: async () => {},
      writeTextFile: async () => {},
      writeBytes: async (p, data) => {
        fsFiles.set(p, data);
      },
    };

    bus = new EventBus({ log: () => {} });
    const events = [];
    bus.subscribe("*", (e) => events.push(e));

    const agent = new Agent({
      task: `Open ${baseUrl}/ and click the About link`,
      llm,
      browser,
      policy: gate,
      eventBus: bus,
      fs: memoryFs,
      settings: {
        maxSteps: 8,
        llmTimeout: 120,
        useVision: true, // 截图观察点：vision 门开（模型名已在白名单）
        judge: { enabled: true },
      },
      log: (m) => console.log(`    [agent] ${m}`),
    });

    const history = await agent.run();
    const steps = history.history;
    const expectedSteps = opts.policy === "auto" ? 4 : 5;
    const driftIdx = opts.policy === "auto" ? 2 : 3;

    console.log(`\n[smoke] 断言（${opts.policy} 变体）：`);
    // —— 基线契约（05 §4）——
    check(history.isDone() && history.isSuccessful(), "isDone && isSuccessful");
    check(steps.length === expectedSteps, `history 步数=剧本（${steps.length}/${expectedSteps}）`);
    const lastUrl = String(steps[steps.length - 1]?.stateSummary?.url ?? "");
    check(lastUrl.includes("about.html"), `终态 URL 在 about.html（${lastUrl}）`);

    if (steps.length !== expectedSteps) {
      // 剧本脱轨（解析失败/步数异常）：后续按位断言必然越界——先收口失败清单
      failures.push("剧本脱轨——按位断言跳过（见上方 [agent] 日志）");
    } else {
      // denied 通道（deny-once 变体）
      if (opts.policy === "deny-once") {
        const denied = steps[1].result[0];
        check(denied.denied === true, "步 2 click 被拒：denied 标记");
        check(
          (denied.error ?? "").includes("用户拒绝在 127.0.0.1 上 点击，不要重试，可改道或询问"),
          `拒绝文案逐字（${denied.error}）`,
        );
        check(agent.state.consecutiveFailures === 0, "denied 不计 consecutiveFailures");
        // allow-once 授权缓存：click 的 CLICK 授权命中后，同键 send_keys 组合键与
        // About 点击免问——真实问询 = 拒 1（click）+ 放 2（click 复试 + send_keys x 的 TYPE）
        check(
          scriptPolicy.denied === 1 && scriptPolicy.allowed === 2,
          `门问询：拒 ${scriptPolicy.denied} 次 + 放行 ${scriptPolicy.allowed} 次（授权缓存命中免问）`,
        );
        check(
          steps[2].result.every((r) => r.error === null),
          "步 3 复试执行成功（改道后再点）",
        );
      } else {
        // allow-once 授权缓存：每个 (capability, host) 键只问一次——click /
        // ctrl+a / About 点击共用 CLICK 键，实得 2 次问询（CLICK、TYPE）
        check(
          autoAllow.requests.length === 2,
          `AutoAllow 记账=2（capability 各键一次，实得 ${autoAllow.requests.length}）`,
        );
        const caps = autoAllow.requests.map((r) => r.capability).join(",");
        check(caps === "CLICK,TYPE", `capability 面（${caps}——CLICK 键的后续命中走授权缓存免问）`);
      }

      // 漂移截断：click+wait 步只落 1 个结果
      const driftStep = steps[driftIdx];
      check(
        driftStep.result.length === 1 && driftStep.modelOutput.actions.length === 2,
        `URL 漂移截断（actions 2 → results ${driftStep.result.length}）`,
      );
      // interactedElement 投影：click 位命中链接（投影无 index 字段——以 node_name/
      // attributes 定位）
      const proj = driftStep.interactedElement?.[0];
      check(
        proj !== null &&
          proj !== undefined &&
          proj.node_name === "A" &&
          JSON.stringify(proj.attributes).includes("about"),
        `interactedElement 投影命中（node_name=${proj?.node_name ?? "?"}，attributes 含 about）`,
      );
      // judge verdict 落末步
      const judgement = steps[steps.length - 1].result.find((r) => r.isDone)?.judgement;
      check(judgement != null && judgement.verdict === true, "judge verdict=pass 写入末步 done");

      // 事件完整序列 + session_end 收口
      const expected = [];
      // 漂移截断步：被截动作的 tool_call 也不发（事件在循环体内逐动作发射）
      const actionCounts = opts.policy === "auto" ? [1, 3, 1, 1] : [1, 1, 3, 1, 1];
      for (const n of actionCounts) {
        expected.push("step_start", "skill_active", "model_call", "model_result");
        for (let k = 0; k < n; k++) expected.push("tool_call", "tool_result");
        expected.push("step_end");
      }
      expected.push("session_end");
      const types = events.map((e) => e.eventType);
      const seqOk = JSON.stringify(types) === JSON.stringify(expected);
      check(
        seqOk,
        `EventBus 完整事件序列 + session_end 收口${seqOk ? "" : `\n    期望：${expected.join(",")}\n    实际：${types.join(",")}`}`,
      );
    }

    // 零重连
    check(factoryCalls === 1, `全程零重连（transport factory 调用 ${factoryCalls} 次）`);

    // —— 登记真机验证点 ——
    console.log("\n[smoke] 真机验证点证据：");
    // #5 getBoxModel 坐标：折叠线下链接在滚动 + scrollIntoViewIfNeeded 后点击成功导航
    const clickCall = events.find(
      (e) => e.eventType === "tool_call" && e.params?.index === evidence.aboutIdx,
    );
    console.log(
      `  #5 getBoxModel：about bbox=${JSON.stringify(clickCall?.elementBbox ?? null)} 滚动后点击导航成功（${lastUrl}）——坐标直落视口无需减滚动偏移`,
    );
    check(lastUrl.includes("about.html"), "#5 点击命中（导航成立）");
    // #6 组合键 char/modifiers
    console.log(
      `  #6 send_keys ctrl+a：kbd=${evidence.kbd} sel=${evidence.sel} field=${evidence.fieldLine}`,
    );
    check((evidence.kbd ?? "").includes("keydown:a+ctrl"), "#6 keydown 携带 ctrl 到达页面");
    check(/^SELLOG:\d+-\d+\/\d+\|v=/.test(evidence.sel ?? ""), "#6 全选留痕（SELLOG 格式）");
    // 截图 passthrough
    const pngs = [...fsFiles.entries()].filter(([p]) => p.endsWith(".png"));
    let pngOk = false;
    let pngInfo = "无 PNG";
    if (pngs.length > 0) {
      const [path, bytes] = pngs[0];
      const sig = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
      const width = sig ? (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19] : 0;
      const height = sig ? (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23] : 0;
      pngOk = sig && width > 0 && height > 0;
      pngInfo = `${pngs.length} 张，首张 ${path}：PNG 签名=${sig}，${width}x${height}（passthrough——无降采样）`;
    }
    console.log(`  #3 截图 passthrough：${pngInfo}`);
    check(pngOk, "#3 每步截图真机采集（PNG 头 + IHDR 尺寸可解析）");
    console.log(
      `  #4 权限门挂点全链：${opts.policy === "auto" ? "AutoAllow 记账" : "deny-once 拒绝回流"}已断言（见上）`,
    );
  } finally {
    try {
      bus?.close();
    } catch {
      // close 二次调用/已关闭——清理路径不抛
    }
    try {
      await browser?.stop();
    } catch {
      // 会话已随异常路径拆卸——清理路径不抛
    }
    server.close();
    launched.child.kill();
    try {
      rmSync(launched.profile, { recursive: true, force: true });
    } catch {
      // kill 后 Chrome 仍持有 profile 文件锁（Windows）：残留临时目录无害
    }
    console.log("[smoke] 已关闭本地服务与自拉起的 Chrome");
  }

  if (failures.length > 0) {
    console.error(`\n[smoke] 失败 ${failures.length} 项：`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n[smoke] ${opts.policy} 变体全部断言通过`);
}

main().catch((e) => {
  console.error(`[smoke] 致命错误：${e.stack ?? e}`);
  process.exitCode = 1;
});
