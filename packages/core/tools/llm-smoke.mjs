// P2 真机 smoke（docs/implement-plan/p2/04 §7）：对智谱 OpenAI 端点 + Anthropic 端点
// 各发一次最小 agent_response 强制调用，打印请求体摘要（key 脱敏）/响应 toolInput/usage/耗时。
// 手动跑，不入 CI（费用与密钥纪律）：GLM_API_KEY=xxx node tools/llm-smoke.mjs
// 模型/端点可用 SMOKE_OPENAI_MODEL / SMOKE_ANTHROPIC_MODEL / SMOKE_OPENAI_BASE_URL /
// SMOKE_ANTHROPIC_BASE_URL 覆盖（模型以账号可用为准；baseUrl 供代理/网关验收）。
// gemini 不在本次 smoke（无 key；2.4 验收以 mock 为准，README 风险 3 顺延）。
//
// 宿主侧脚本（tools/ 不受核心包边界约束，可读 process.env）；核心代码经 esbuild
// （vitest 自带依赖）把 src/index.ts 打成临时 ESM 再 import——源码 import 用 .js
// 扩展名指向 .ts 文件，Node 原生 type stripping 解析不了。

import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * 解析 esbuild：首选本包 devDependencies 显式声明的实例；借道 vitest 依赖闭包
 * 仅作旧布局兜底（esbuild 是 vitest 的传递依赖，vitest rolldown 化后会从闭包
 * 消失——显式声明才是长期稳定来源）
 */
function resolveEsbuild() {
  try {
    return require.resolve("esbuild");
  } catch {
    const vitestPkgPath = require.resolve("vitest/package.json");
    return require.resolve("esbuild", { paths: [dirname(vitestPkgPath)] });
  }
}

async function loadCore() {
  const mod = await import(pathToFileURL(resolveEsbuild()).href);
  const build = mod.build ?? mod.default?.build;
  if (typeof build !== "function") {
    throw new Error("esbuild JS API 不可用（build 导出缺失）");
  }
  const tmp = mkdtempSync(join(tmpdir(), "tw-llm-smoke-"));
  try {
    const out = join(tmp, "bundle.mjs");
    // stdin 入口 + resolveDir=包根：entry 内联字符串、相对路径解析，
    // 不在仓库或临时目录留入口文件
    await build({
      stdin: {
        contents: 'export { createLLMClient, DEFAULT_MAX_TOKENS } from "./src/index.ts";',
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
      // 清理失败不影响主流程/真实错误（Windows 杀毒/索引器的瞬时文件锁 EBUSY/EPERM）
    }
  }
}

const TOOL = {
  name: "agent_response",
  description: "Respond with your evaluation, memory, next goal and action in one call.",
  parameters: {
    type: "object",
    properties: {
      evaluation_previous_goal: { type: "string" },
      memory: { type: "string" },
      next_goal: { type: "string" },
      action: {
        type: "object",
        properties: { name: { type: "string" }, params: { type: "object" } },
        required: ["name"],
      },
    },
    required: ["next_goal", "action"],
  },
};

/** 两三步消息：user → assistant(纯工具调用) → toolResult → user，覆盖 toolResult wire 路径 */
const MESSAGES = [
  {
    role: "user",
    blocks: [
      {
        kind: "text",
        text: "You are controlling a browser. Current page: a search page with an empty search box and a submit button.",
      },
    ],
  },
  {
    role: "assistant",
    blocks: [],
    toolCalls: [
      {
        id: "t1",
        name: "agent_response",
        args: {
          evaluation_previous_goal: "n/a",
          memory: "search page loaded",
          next_goal: "focus the search box",
          action: { name: "click_element_by_index", params: { index: 1 } },
        },
      },
    ],
  },
  {
    role: "toolResult",
    toolCallId: "t1",
    toolName: "agent_response",
    text: "clicked index=1 (search box focused)",
  },
  {
    role: "user",
    blocks: [
      {
        kind: "text",
        text: "The search box now has focus. Decide the next action to search for 'tree walker'.",
      },
    ],
  },
];

// —— 脱敏与错误格式化（主循环与兜底 catch 共用同一份实现，防两处口径漂移）——

// URL query 掩码：SMOKE_*_BASE_URL 携带 ?token=… 时不能明文出现在任何输出面。
// 键名收非分隔符字符（[^&=]+）——网关常见 ?api.key= / ?auth/token= 形态的键含 ./，
// 字符集过窄会让整条匹配失败、token 明文漏出
const MASK_QUERY_RE = /([?&][^&=]+=)[^&"'\s]+/g;
// 已知敏感头名（大小写不敏感）；extraHeaders 可注入任意名字的网关认证头，
// 按名字拦不住——值包含 apiKey 即整体替换（双保险在 loggingFetch 内）
const SENSITIVE_HEADERS = ["authorization", "x-api-key", "x-goog-api-key"];

const makeRedact = (apiKey) => (s) => {
  let out = String(s).replaceAll(MASK_QUERY_RE, "$1<MASKED>");
  if (apiKey) {
    out = out.replaceAll(apiKey, "<REDACTED>");
  }
  return out;
};

// 异常链格式化：LLMTimeoutError/LLMConnectionError 的底层网络错误挂在 cause 上，
// 只打 e.message 会丢最关键的排障信息（上限 5 层防 cause 环）；formatEntry 供
// 兜底 catch 换用 stack（主循环用紧凑的 name: message）
const formatErrorChain = (e, redact, formatEntry = (cur) => `${cur.name}: ${cur.message}`) => {
  const parts = [];
  for (let cur = e; cur instanceof Error && parts.length < 5; cur = cur.cause) {
    parts.push(formatEntry(cur));
  }
  if (parts.length === 0) {
    parts.push(String(e));
  }
  return redact(parts.join("\n[cause] "));
};

async function main() {
  const apiKey = process.env.GLM_API_KEY;
  if (!apiKey) {
    console.error(
      "GLM_API_KEY 未设置（智谱开放平台 key）。用法：GLM_API_KEY=xxx node tools/llm-smoke.mjs",
    );
    // exitCode 模式（与文件其余失败路径一致，轮 15 #15）：process.exit 立即终止
    // 时 stderr 管道重定向（2>&1 | tee）下的异步写入可能未刷出而丢失
    process.exitCode = 1;
    return;
  }
  const { createLLMClient, DEFAULT_MAX_TOKENS } = await loadCore();

  const cards = [
    {
      name: "zhipu-openai",
      protocol: "openai-completions",
      // || 而非 ??：`VAR= node`（shell 变量未设的常见形态）会把空串带进来，
      // baseUrl="" 会让 fetch 抛与端点无关的 "Failed to parse URL"
      baseUrl: process.env.SMOKE_OPENAI_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
      apiKey,
      model: process.env.SMOKE_OPENAI_MODEL || "glm-4.7",
      // 16384（非 4096）：glm 系思考模型的 reasoning 计入输出额度，4096 会被思考
      // 写满 → getAction 落 empty → smoke 产生与端点无关的假失败（TreeWalker 教训）
      maxTokens: DEFAULT_MAX_TOKENS,
    },
    {
      name: "zhipu-anthropic",
      protocol: "anthropic-messages",
      baseUrl: process.env.SMOKE_ANTHROPIC_BASE_URL || "https://open.bigmodel.cn/api/anthropic",
      apiKey,
      model: process.env.SMOKE_ANTHROPIC_MODEL || "glm-5.1",
      maxTokens: DEFAULT_MAX_TOKENS,
    },
  ];

  // 梯子墙钟预算（解析梯子含 R4/R1 重试与退避，慢网络/慢模型 60s 可能不够）。
  // 非法值显式告警后回退：静默回退会让「配置未生效」在 60s 超时处被误导向端点问题。
  // 用解析有效性标志（非值比较）判定回退——显式合法值恰等于缺省值不该误告警
  const rawTimeoutEnv = process.env.SMOKE_TIMEOUT_MS;
  const rawTimeoutMs = Number(rawTimeoutEnv);
  const isValidTimeout = Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0;
  const timeoutMs = isValidTimeout ? rawTimeoutMs : 60_000;
  if (rawTimeoutEnv !== undefined && !isValidTimeout) {
    console.warn(`SMOKE_TIMEOUT_MS="${rawTimeoutEnv}" 非法（需正数毫秒），已回退缺省 60000ms`);
  }

  let failed = false;
  // 两端点独立但刻意串行：请求/响应日志逐卡成段输出，并行会交错打乱；
  // 最坏 2×timeoutMs（各卡独立预算），手工 smoke 可接受
  const redact = makeRedact(apiKey);
  for (const card of cards) {
    // 注入打点 fetch：请求体摘要（key 脱敏）——顺便验证 LlmDeps 注入口。
    // header 脱敏双保险：已知敏感头名（大小写不敏感）+ 值包含 apiKey 即整体替换
    //（extraHeaders 可注入任意名字的网关认证头，按名字拦不住）
    const loggingFetch = async (url, init) => {
      const headers = { ...(init?.headers ?? {}) };
      for (const k of Object.keys(headers)) {
        if (SENSITIVE_HEADERS.includes(k.toLowerCase()) || String(headers[k]).includes(apiKey)) {
          headers[k] = "<REDACTED>";
        }
      }
      const body = redact(init?.body ?? "");
      console.log(`\n>> POST ${redact(url)}`);
      console.log(`   headers: ${JSON.stringify(headers)}`);
      console.log(`   body: ${body.slice(0, 800)}${body.length > 800 ? " …" : ""}`);
      return fetch(url, init);
    };

    const client = createLLMClient(card, { fetch: loggingFetch });
    const t0 = Date.now();
    try {
      const result = await client.getAction(
        "You are a web agent. Always respond via the agent_response tool with a single next action.",
        MESSAGES,
        TOOL,
        { timeoutMs },
      );
      const ms = Date.now() - t0;
      console.log(
        `\n== ${card.name} (${card.protocol}, model=${card.model}) → kind=${result.kind} (${ms}ms)`,
      );
      if (result.kind === "ok") {
        // ok 有两条路径：toolCalls 命中，或模型返回纯文本恰为非空 JSON（text-JSON
        // 兜底）。GetActionResult 不携带路径信息，此处仅能做形状校验：兜底 JSON
        // 缺 action.name 判失败；兜底 JSON 恰符合 schema（端点忽略强制
        // tool_choice）会被漏判为通过，人工验收时需结合请求日志复核 tool_calls 形态
        const action = result.toolInput?.action;
        if (typeof action !== "object" || action === null || typeof action.name !== "string") {
          failed = true;
          console.error(
            `   ${card.name} ok 但 toolInput 缺 action.name（疑似 text-JSON 兜底，非工具调用）`,
          );
        }
        console.log("toolInput:");
        console.log(JSON.stringify(result.toolInput, null, 2));
        console.log(`usage: ${JSON.stringify(result.usage)}`);
      } else {
        // empty = 解析梯子耗尽仍未产出 agent_response 调用——对 smoke 就是失败，
        // 不能静默 exitCode 0 造成假通过
        failed = true;
        console.error(`   ${card.name} 返回 empty：解析梯子耗尽仍未产出 ${TOOL.name} 工具调用`);
      }
    } catch (e) {
      failed = true;
      // 与文件末尾兜底同口径：遍历 cause 链（LLMTimeoutError/LLMConnectionError 的
      // 底层网络错误挂在 cause 上，丢消息即丢最关键排障信息）；消息内嵌完整 URL /
      // 网关回显的错误体——同样过 redact
      console.error(
        `\n== ${card.name} FAILED (${Date.now() - t0}ms): ${formatErrorChain(e, redact)}`,
      );
    }
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  // 兜底输出同样过脱敏，并显式遍历 cause 链（Error.stack 不含 cause——核心层
  // LLMTimeoutError/LLMConnectionError 都以 cause 挂底层网络错误，丢失即丢失最
  // 关键的排障信息）；链上 stack/cause 可能内嵌 URL 或网关回显的错误详情
  console.error(
    formatErrorChain(e, makeRedact(process.env.GLM_API_KEY), (cur) => cur.stack ?? cur.message),
  );
  process.exitCode = 1;
});
