#!/usr/bin/env node
/**
 * P1.6 真机对拍 smoke（docs/implement-plan/p3/03 §3）：同 Chrome 背靠背——
 * Python gen_fixtures.py 抓一页 → TS（cdp-ws + dom-snapshot）抓同页 → 产物对拍。
 * 手动跑，不入 CI/覆盖率；exitCode 非 0 即失败（llm-smoke.mjs 同款纪律）。
 *
 * 用法：
 *   node tools/page-parity-smoke.mjs --url <u> [--url ...] [--ws-url ws://…]
 *     [--wait 2.5] [--out _tmp/parity] [--chrome <chrome.exe>] [--port 9224]
 *     [--python <venv python.exe>]
 *
 * 无 --ws-url 时自拉 headless Chrome（gen_fixtures.py:180-199 同参数形态），结束即杀。
 * 每 URL 失败自动重抓一轮（动态页面漂移防线，03 §3.3）；两轮皆红才算失败。
 */
// 宿主侧脚本（tools/ 不受核心包边界约束，可读 process.env/spawn）；核心代码经 esbuild
// 打包注入（llm-smoke.mjs 同款方案：stdin 入口 + resolveDir=包根，.js 指向 .ts 的
// 相对导入由 esbuild 的 TS 约定解析）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const CHROME_DEFAULT = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PYTHON_DEFAULT = "D:\\dev\\git\\z_jordon\\evals\\webarena\\.venv\\Scripts\\python.exe";
const GEN_FIXTURES = resolve(here, "../../dom-snapshot/tools/gen_fixtures.py");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 参数 ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    urls: [],
    wait: 2.5,
    out: "_tmp/parity",
    chrome: CHROME_DEFAULT,
    port: 9224,
    python: PYTHON_DEFAULT,
    wsUrl: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} 缺值`);
      return argv[++i];
    };
    if (a === "--url") opts.urls.push(next());
    else if (a === "--ws-url") opts.wsUrl = next();
    else if (a === "--wait") opts.wait = Number(next());
    else if (a === "--out") opts.out = next();
    else if (a === "--chrome") opts.chrome = next();
    else if (a === "--port") opts.port = Number(next());
    else if (a === "--python") opts.python = next();
    else throw new Error(`未知参数：${a}`);
  }
  if (opts.urls.length === 0) throw new Error("至少一个 --url");
  return opts;
}

// ── esbuild 打包（llm-smoke.mjs 同款） ─────────────────────────────────
function resolveEsbuild() {
  try {
    return require.resolve("esbuild");
  } catch (first) {
    try {
      const vitestPkgPath = require.resolve("vitest/package.json");
      return require.resolve("esbuild", { paths: [dirname(vitestPkgPath)] });
    } catch (e) {
      throw new Error(
        `esbuild 解析失败（packages/cdp-ws 需 devDependencies 声明 esbuild 或借道 vitest 闭包）：${e.message}（首发：${first.message}）`,
      );
    }
  }
}

async function loadBundled() {
  const mod = await import(pathToFileURL(resolveEsbuild()).href);
  const build = mod.build ?? mod.default?.build;
  if (typeof build !== "function") throw new Error("esbuild JS API 不可用（build 导出缺失）");
  const tmp = mkdtempSync(join(tmpdir(), "tw-cdp-parity-"));
  try {
    const out = join(tmp, "bundle.mjs");
    await build({
      stdin: {
        contents:
          'export { CdpWsClient, CdpPageSession } from "./src/index.ts";\nexport { buildDomState } from "@tw/dom-snapshot";\n',
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

// ── Chrome 拉起与发现 ──────────────────────────────────────────────────
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
    throw new Error(
      `Chrome 不存在：${chrome}（用 --chrome 指定路径，或改用 --ws-url 附着已运行浏览器）`,
    );
  }
  const profile = mkdtempSync(join(tmpdir(), "tw-parity-profile-"));
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

// ── Python 侧抓取 ─────────────────────────────────────────────────────
function runPythonCapture({ python, url, wsUrl, wait, outDir }) {
  if (!existsSync(python))
    throw new Error(`Python 不存在：${python}（--python 指定 evals venv 路径）`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  execFileSync(
    python,
    [GEN_FIXTURES, "--url", url, "--ws-url", wsUrl, "--out", outDir, "--wait", String(wait)],
    {
      stdio: ["ignore", "inherit", "inherit"],
      encoding: "utf8",
    },
  );
  const files = readdirSync(outDir).filter((f) => f.endsWith(".json"));
  if (files.length !== 1)
    throw new Error(`gen_fixtures 产物数异常（期望 1，实得 ${files.length}）`);
  return JSON.parse(readFileSync(join(outDir, files[0]), "utf8"));
}

// ── TS 侧抓取 ─────────────────────────────────────────────────────────
// 不 navigate：文档归属 Python 侧（gen_fixtures 负责导航），TS 附着同一文档采集。
// selector_map 键 = backendNodeId（P1.2 认知：serializer Step 5 恒等赋值），
// 而 backendNodeId 是 per-document 分配的——TS 再 navigate 会重载文档换全套编号，
// 对拍必然假红（首跑实证：example.com 59 vs 79，python.org 4344 vs 6512）。
async function tsCapture({ CdpWsClient, CdpPageSession, buildDomState }, { wsUrl, wait }) {
  const client = await CdpWsClient.connect({ wsUrl });
  try {
    const page = new CdpPageSession(client);
    const { sessionId } = await page.attachFirstPageTarget();
    // 轻量再稳定：Python 抓取结束后页面可能仍有迟到的定时器改动
    await sleep(wait * 1000);
    const { state, metrics } = await buildDomState(client, sessionId);
    // gen_fixtures.py:110 同口径：elementCount 由调用方按 selector_map 规模记录
    metrics.elementCount = state.selectorMap.size;
    return { state, metrics };
  } finally {
    await client.stop();
  }
}

// ── 对拍 ──────────────────────────────────────────────────────────────
/** 递归键序归一（对象键排序；数组保序）——深比较与差异定位共用 */
function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k]);
    return out;
  }
  return v;
}
const canonStr = (v) => JSON.stringify(canonicalize(v));

function diffWindow(a, b, span = 40) {
  const s1 = typeof a === "string" ? a : canonStr(a);
  const s2 = typeof b === "string" ? b : canonStr(b);
  let i = 0;
  while (i < s1.length && i < s2.length && s1[i] === s2[i]) i += 1;
  return {
    at: i,
    left: s1.slice(Math.max(0, i - span), i + span),
    right: s2.slice(Math.max(0, i - span), i + span),
  };
}

/** TS selectorMap(Map) → gen_fixtures 八字段投影（gen_fixtures.py:112-123） */
function projectSelectorMap(selectorMap) {
  const projected = {};
  for (const [idx, node] of selectorMap) {
    projected[String(idx)] = {
      backend_node_id: node.backendNodeId,
      node_name: node.nodeName,
      node_value: node.nodeValue,
      attributes: node.attributes,
      is_visible: node.isVisible,
      is_scrollable: node.isScrollable,
      has_js_click_listener: node.hasJsClickListener,
      xpath: node.xpath,
    };
  }
  return projected;
}

function compare(url, fixture, ts) {
  const failures = [];
  const out = fixture.output;
  const meta = fixture.meta;
  if (ts.state.elementTreeText !== out.element_tree_text) {
    const d = diffWindow(out.element_tree_text, ts.state.elementTreeText);
    failures.push(
      `element_tree_text 首差异 @${d.at}（Python→TS）：\n    Python: …${JSON.stringify(d.left)}…\n    TS    : …${JSON.stringify(d.right)}…`,
    );
  }
  const tsProj = projectSelectorMap(ts.state.selectorMap);
  if (canonStr(tsProj) !== canonStr(out.selector_map)) {
    const d = diffWindow(out.selector_map, tsProj);
    failures.push(
      `selector_map 八字段投影差异 @${d.at}：\n    Python: …${d.left}…\n    TS    : …${d.right}…`,
    );
  }
  if (canonStr(ts.state.fileInputBackendIds) !== canonStr(out.file_input_backend_ids)) {
    failures.push(
      `file_input_backend_ids 不等：Python=${canonStr(out.file_input_backend_ids)} TS=${canonStr(ts.state.fileInputBackendIds)}`,
    );
  }
  if (canonStr(ts.state.fileInputsMeta) !== canonStr(out.file_inputs_meta)) {
    const d = diffWindow(out.file_inputs_meta, ts.state.fileInputsMeta);
    failures.push(`file_inputs_meta 差异 @${d.at}：Python=…${d.left}… TS=…${d.right}…`);
  }
  if (canonStr(ts.state.pageStats) !== canonStr(out.page_stats)) {
    failures.push(
      `page_stats 不等：Python=${canonStr(out.page_stats)} TS=${canonStr(ts.state.pageStats)}`,
    );
  }
  if (ts.metrics.degradationLevel !== meta.degradation) {
    failures.push(
      `degradationLevel 不等：Python=${meta.degradation} TS=${ts.metrics.degradationLevel}`,
    );
  }
  if (canonStr(ts.metrics.sourceStatuses) !== canonStr(meta.source_statuses)) {
    failures.push(
      `source_statuses 不等：Python=${canonStr(meta.source_statuses)} TS=${canonStr(ts.metrics.sourceStatuses)}`,
    );
  }
  if (ts.metrics.elementCount !== meta.element_count) {
    failures.push(`element_count 不等：Python=${meta.element_count} TS=${ts.metrics.elementCount}`);
  }
  return failures;
}

// ── 主流程 ────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const bundled = await loadBundled();
  const pyDir = isAbsolute(opts.out) ? opts.out : resolve(process.cwd(), opts.out);
  mkdirSync(pyDir, { recursive: true });

  let launched = null;
  let wsUrl = opts.wsUrl;
  if (wsUrl === null) {
    launched = launchChrome(opts);
    console.log(`[smoke] 已拉起 headless Chrome（port=${opts.port}）`);
    const ver = await waitVersion(opts.port);
    wsUrl = ver.webSocketDebuggerUrl;
  }
  console.log(`[smoke] ws_url = ${wsUrl}`);

  let failedCount = 0;
  try {
    for (const url of opts.urls) {
      let failures = null;
      for (let round = 1; round <= 2; round++) {
        try {
          const fixture = runPythonCapture({ ...opts, url, wsUrl, outDir: join(pyDir, "py") });
          const ts = await tsCapture(bundled, { wsUrl, wait: opts.wait });
          failures = compare(url, fixture, ts);
          if (failures.length === 0) {
            console.log(
              `== ${url} PASS（round ${round}，elements=${ts.metrics.elementCount}，degradation=${ts.metrics.degradationLevel}）`,
            );
            break;
          }
          if (round === 1) {
            console.log(`== ${url} round 1 差异 ${failures.length} 项——重抓一轮排除动态漂移`);
          }
        } catch (e) {
          failures = [`抓取/对拍异常：${e.stack ?? e.message}`];
        }
      }
      if (failures !== null && failures.length > 0) {
        failedCount += 1;
        console.error(`== ${url} FAIL：`);
        for (const f of failures) console.error(`   - ${f}`);
      }
    }
  } finally {
    if (launched !== null) {
      launched.child.kill();
      try {
        rmSync(launched.profile, { recursive: true, force: true });
      } catch {
        // kill 后 Chrome 仍持有 profile 文件锁（Windows）：残留临时目录无害，跳过
      }
      console.log("[smoke] 已关闭自拉起的 Chrome");
    }
  }

  if (failedCount > 0) {
    console.error(`[smoke] ${failedCount}/${opts.urls.length} 个页面失败`);
    process.exitCode = 1;
    return;
  }
  console.log(`[smoke] 全部 ${opts.urls.length} 个页面对拍一致`);
}

main().catch((e) => {
  console.error(`[smoke] 致命错误：${e.stack ?? e}`);
  process.exitCode = 1;
});
