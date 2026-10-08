// e2e 公共 harness（m5/02 §6）：零依赖（Node 原生 fetch/WebSocket）驱动 headless
// chromium + 未打包扩展。核心难点与解法（段 A/B 实证）：
//  1) /json/list 的 service_worker 混有组件扩展（Gemini in Chrome 等）——按
//     manifest.name 或 id 前缀挑，绝不取首个；
//  2) 我们的 SW 装载后无事件急休眠（headless 数秒即死）——唤醒链：从 profile
//     的 Preferences 读未打包扩展 id（Chrome 落盘 path↔id 映射）→ 借任一有
//     chrome.tabs 的组件 SW tabs.create 开我们的页面 → 页面侧 runtime.sendMessage
//     唤醒 SW（MV3 消息唤醒语义）→ 按 id 前缀连 SW；
//     （management.getAll 在组件 SW 是无权限桩、id 哈希推导对不上版——均已实证淘汰）
//  3) CDP 连接本身吊住 SW 不再休眠。
// chrome 可执行路径：优先 TC_E2E_CHROME 环境变量，缺省 playwright 的 chromium-1234。

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 注意层级：本文件在 apps/extension/e2e/ 下，.output 在 apps/extension/（一级上溯）
export const EXT_DIR = fileURLToPath(new URL("../.output/chrome-mv3", import.meta.url));

export function chromeExecutable() {
  if (process.env.TC_E2E_CHROME !== undefined && process.env.TC_E2E_CHROME !== "") {
    return process.env.TC_E2E_CHROME;
  }
  return `${process.env.LOCALAPPDATA}\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function listTargets(port) {
  return (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}

/** 启动 chrome（headless=new，独立临时 profile——旧构建缓存毒化页面加载的段 A 教训） */
export async function launchChrome({ port, headless = true } = {}) {
  const profileDir = `D:/temp/tc-e2e-${Date.now()}`;
  const args = [
    headless ? "--headless=new" : "--no-startup-window",
    `--remote-debugging-port=${port}`,
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ];
  const proc = spawn(chromeExecutable(), args);
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
      return { proc, profileDir };
    } catch {}
  }
  proc.kill();
  throw new Error(`DevTools port ${port} not up in 30s`);
}

/**
 * 从 profile Preferences 读未打包扩展的 id（extensions.settings.<id>.path 匹配）。
 * Preferences 可能延迟落盘——轮询至超时。
 */
export async function readExtensionIdFromProfile(profileDir, timeoutMs = 20000) {
  const want = EXT_DIR.replaceAll("/", "\\").toLowerCase();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const rel of ["Default/Preferences", "Default/Secure Preferences"]) {
      try {
        const prefs = JSON.parse(readFileSync(join(profileDir, rel), "utf8"));
        const settings = prefs?.extensions?.settings;
        if (settings !== null && typeof settings === "object") {
          for (const [id, entry] of Object.entries(settings)) {
            const p =
              typeof entry?.path === "string" ? entry.path.replaceAll("/", "\\").toLowerCase() : "";
            if (p === want) return id;
          }
        }
      } catch {}
    }
    await sleep(500);
  }
  throw new Error(`extension id not found in profile ${profileDir} (path=${want})`);
}

/** CDP WebSocket 连接 + evaluate/send 封装 */
export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params }));
    return new Promise((r) => pending.set(i, r));
  };
  const evaluate = (expression) =>
    send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }).then((m) => {
      if (m.result?.exceptionDetails !== undefined) {
        throw new Error(
          `evaluate failed: ${m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text}`,
        );
      }
      return m.result?.result?.value;
    });
  return { ws, send, evaluate, close: () => ws.close() };
}

/**
 * 确保我们的 sidepanel 页已打开并返回其 CDP 连接（e2e 驱动上下文——
 * runtime.sendMessage 不能从 SW 发给自身监听器，页面是消息发起侧）。
 * 已开则直连；未开则借组件 SW 的 tabs.create 打开。
 */
export async function ensureSidepanelPage(port, extensionId) {
  for (let round = 0; round < 10; round++) {
    const list = await listTargets(port);
    const hit = list.find((t) => t.url === `chrome-extension://${extensionId}/sidepanel.html`);
    if (hit !== undefined) return connect(hit.webSocketDebuggerUrl);
    const opener = list.find(
      (t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"),
    );
    if (opener !== undefined) {
      try {
        const c = await connect(opener.webSocketDebuggerUrl);
        await c.evaluate(
          `(async () => { try { await chrome.tabs.create({ url: "chrome-extension://${extensionId}/sidepanel.html" }); } catch {} })()`,
        );
        c.close();
      } catch {}
      await sleep(800);
    }
  }
  throw new Error("sidepanel page could not be opened");
}

/**
 * 唤醒并连接我们的 SW（返回 {sw, extensionId}）。已活（按 name/id 命中）则直连；
 * 否则走唤醒链（见文件头 ②）。外部导航 chrome-extension:// 被 Chrome 拦——
 * tabs.create 从扩展上下文是唯一合法开页路径。
 */
export async function connectOurServiceWorker(port, profileDir) {
  const extensionId = await readExtensionIdFromProfile(profileDir);
  for (let round = 0; round < 20; round++) {
    const list = await listTargets(port);
    const hit = list.find(
      (t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extensionId}/`),
    );
    if (hit !== undefined) {
      const sw = await connect(hit.webSocketDebuggerUrl);
      return { sw, extensionId };
    }
    if (round % 4 === 0) {
      // 唤醒链：组件 SW 开我们的页 → 页面 sendMessage 唤醒 SW
      try {
        const page = await ensureSidepanelPage(port, extensionId);
        await page
          .evaluate(
            `chrome.runtime.sendMessage({ kind: "diag", command: "echo", payload: { wake: 1 } }).catch(() => {})`,
          )
          .catch(() => {});
        page.close();
      } catch {}
    }
    await sleep(700);
  }
  throw new Error(`TreeChrome SW (id=${extensionId}) not reachable via wake chain`);
}
