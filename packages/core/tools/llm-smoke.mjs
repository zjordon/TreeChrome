// P2 真机 smoke（docs/implement-plan/p2/04 §7）：对智谱 OpenAI 端点 + Anthropic 端点
// 各发一次最小 agent_response 强制调用，打印请求体摘要（key 脱敏）/响应 toolInput/usage/耗时。
// 手动跑，不入 CI（费用与密钥纪律）：GLM_API_KEY=xxx node tools/llm-smoke.mjs
// 模型/端点可用 SMOKE_OPENAI_MODEL / SMOKE_ANTHROPIC_MODEL / SMOKE_OPENAI_BASE_URL /
// SMOKE_ANTHROPIC_BASE_URL 覆盖（模型以账号可用为准；baseUrl 供代理/网关验收）；
// 梯子墙钟预算可用 SMOKE_TIMEOUT_MS 覆盖（正数毫秒，缺省 60s；含重试退避，慢网络可调大）。
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
    // 兜底也失败时错误须指向 esbuild/依赖安装（轮 37 #5）：最先抛出的
    // "Cannot find module 'vitest/package.json'" 会把排障引向 vitest
    try {
      const vitestPkgPath = require.resolve("vitest/package.json");
      return require.resolve("esbuild", { paths: [dirname(vitestPkgPath)] });
    } catch (fallbackError) {
      throw new Error(
        `esbuild 解析失败（请先 pnpm install——packages/core devDependencies 显式声明了 esbuild）：${
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        }`,
      );
    }
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

// —— 缺省值集中声明（与文件头 SMOKE_* 变量清单对照；轮 17 #1/#7：字面量散落
// 4 处会让端点/型号变更漏改，文案与实际回退值失配）——
// 同源字面量另见 test/llm/openai.test.ts（openai 卡片）/ test/llm/anthropic.test.ts
// （anthropic 卡片）——端点/型号变更时两处需同步（核心 src 无缺省端点，无第三源，
// 轮 42 #2 登记；tools/ 不在 vitest include，交叉引用只能靠注释维系）
const DEFAULT_OPENAI_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_ANTHROPIC_BASE_URL = "https://open.bigmodel.cn/api/anthropic";
const DEFAULT_OPENAI_MODEL = "glm-4.7";
const DEFAULT_ANTHROPIC_MODEL = "glm-5.1";
const DEFAULT_SMOKE_TIMEOUT_MS = 60_000;

// 截断展示单源（轮 42 #3）：请求体与响应体两处共用——800 字面量散落会漏改致
// 两侧证据口径不一致
const truncate = (s, n = 800) => s.slice(0, n) + (s.length > n ? " …" : "");

// —— 脱敏与错误格式化（主循环与兜底 catch 共用同一份实现，防两处口径漂移）——

// URL query 掩码：SMOKE_*_BASE_URL 携带 ?token=… 时不能明文出现在任何输出面。
// 键名收非分隔符字符（[^&=]+）——网关常见 ?api.key= / ?auth/token= 形态的键含 ./，
// 字符集过窄会让整条匹配失败、token 明文漏出。
// 引导集含 #（轮 38 #14）：fragment 形态凭据（#access_token=…，OAuth 网关常见）
// 同款掩码；纯锚点（#section，不含 =）不受影响，可观测性无损。
// userInfo 掩码（轮 30 #7）：https://user:pass@host 形态的代理凭据与 GLM_API_KEY
// 无关，replaceAll(apiKey) 拦不住。残留风险：路径内嵌 token（https://proxy/<key>/v1
// 形态）难以枚举，未掩码——排障留档前自查这类网关形态
const MASK_USERINFO_RE = /(:\/\/)[^/@\s]+:[^/@\s]+@/g;
const MASK_QUERY_RE = /([?&#][^&#=]+=)[^&"'\s]+/g;
// 已知安全头名（大小写不敏感）——白名单外一律脱敏（轮 24 #1）：extraHeaders 可
// 注入任意名字的网关认证头（独立 token 值与 apiKey 无关，按名字/按值都拦不住），
// 本脚本预期 2>&1 | tee 留档排障，凭据可能持久化进日志——诊断脚本宁多脱敏不漏脱敏
const SAFE_HEADERS = new Set([
  "content-type",
  "anthropic-version",
  "anthropic-dangerous-direct-browser-access",
]);
const makeRedact = (apiKey) => (s) => {
  let out = String(s)
    .replaceAll(MASK_QUERY_RE, "$1<MASKED>")
    .replaceAll(MASK_USERINFO_RE, "$1<MASKED>@");
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
      baseUrl: process.env.SMOKE_OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL,
      apiKey,
      model: process.env.SMOKE_OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
      // 16384（非 4096）：glm 系思考模型的 reasoning 计入输出额度，4096 会被思考
      // 写满 → getAction 落 empty → smoke 产生与端点无关的假失败（TreeWalker 教训）
      maxTokens: DEFAULT_MAX_TOKENS,
    },
    {
      name: "zhipu-anthropic",
      protocol: "anthropic-messages",
      baseUrl: process.env.SMOKE_ANTHROPIC_BASE_URL || DEFAULT_ANTHROPIC_BASE_URL,
      apiKey,
      model: process.env.SMOKE_ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
      maxTokens: DEFAULT_MAX_TOKENS,
    },
  ];

  // 梯子墙钟预算（解析梯子含 R4/R1 重试与退避，慢网络/慢模型 60s 可能不够）。
  // 非法值显式告警后回退：静默回退会让「配置未生效」在 60s 超时处被误导向端点问题。
  // 用解析有效性标志（非值比较）判定回退——显式合法值恰等于缺省值不该误告警
  // || 归一空串为 unset（轮 28 #2，与上方 baseUrl/model 的 `VAR= node` 口径一致），
  // 避免变量空置形态被误报为「非法值」
  const rawTimeoutEnv = process.env.SMOKE_TIMEOUT_MS || undefined;
  const rawTimeoutMs = Number(rawTimeoutEnv);
  const isValidTimeout = Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0;
  const timeoutMs = isValidTimeout ? rawTimeoutMs : DEFAULT_SMOKE_TIMEOUT_MS;
  if (rawTimeoutEnv !== undefined && !isValidTimeout) {
    console.warn(
      `SMOKE_TIMEOUT_MS="${rawTimeoutEnv}" 非法（需正数毫秒），已回退缺省 ${DEFAULT_SMOKE_TIMEOUT_MS}ms`,
    );
  }

  let failed = false;
  // 两端点独立但刻意串行：请求/响应日志逐卡成段输出，并行会交错打乱；
  // 最坏 2×timeoutMs（各卡独立预算），手工 smoke 可接受
  const redact = makeRedact(apiKey);
  // 纵深防御（轮 39 #14）：deps.log 键名若与核心 LLMDeps 漂移（tools/ 不在
  // vitest include、esbuild 只剥离类型不检查，CI 无护栏），resolveDeps 会静默
  // 回落缺省 console.warn——含 baseUrl 原文（?token=/user:pass@）与响应体片段
  // 的核心 WARNING 将绕过 log 钩子直落 2>&1 | tee 留档。包装后兜底路径同样过
  // redact（fetch/getAction 等键名漂移会在运行时立即抛错，无需额外防护）
  const rawWarn = console.warn.bind(console);
  console.warn = (...args) => {
    rawWarn(...args.map((a) => (typeof a === "string" ? redact(a) : a)));
  };
  for (const card of cards) {
    // 注入打点 fetch：请求体摘要（key 脱敏）——顺便验证 LLMDeps 注入口。
    // header 白名单脱敏（轮 24 #1）：网关独立 token 与 GLM_API_KEY 无关，
    // 黑名单 + 值匹配拦不住 extraHeaders 注入的任意名字认证头。
    // 调用计数（轮 42 #1）：resolveDeps 对 fetch 键是静默回落全局 fetch——键名
    // 漂移时注入不报错也不被调用，请求/响应证据无声消失还可能 exitCode 0 假
    // 通过；getAction 全路径结束后断言计数 >0
    let fetchCalls = 0;
    const loggingFetch = async (url, init) => {
      fetchCalls += 1;
      const headers = { ...(init?.headers ?? {}) };
      for (const k of Object.keys(headers)) {
        headers[k] = SAFE_HEADERS.has(k.toLowerCase()) ? headers[k] : "<REDACTED>";
      }
      const body = redact(init?.body ?? "");
      console.log(`\n>> POST ${redact(url)}`);
      console.log(`   headers: ${JSON.stringify(headers)}`);
      console.log(`   body: ${truncate(body)}`);
      // 响应侧证据（轮 35 #1）：直接可见 tool_calls 形态，与 ok 分支的
      // result.toolCall 结构化判定（轮 37 #1）互为印证；clone 必须在 body 被
      // 核心层消费前完成，读取失败不影响主流程
      const resp = await fetch(url, init);
      try {
        const text = await resp.clone().text();
        const r = redact(text);
        console.log(`<< ${resp.status} ${truncate(r)}`);
      } catch {
        // clone/读取失败（流式或空体形态）不影响主流程
      }
      return resp;
    };

    const client = createLLMClient(card, {
      fetch: loggingFetch,
      // 核心 WARNING 同样过 redact（轮 35 #8）：baseUrl 误配告警内嵌 baseUrl 原文
      //（SMOKE_*_BASE_URL 的 ?token= 形态会明文打进 tee 留档）、丢弃类日志含响应体
      // 片段（模型可能回显输入）——缺省 console.warn 是绕过脱敏的输出面
      log: (message) => console.warn(redact(message)),
    });
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
        // ok 有两条路径：toolCalls 命中（携带 result.toolCall——wire id 与 gemini
        // thoughtSignature）或模型返回纯文本恰为非空 JSON（text-JSON 兜底，不携带
        // toolCall）。smoke 的验收目的是真工具调用：兜底命中直接判失败（轮 37 #1
        // 闭合「合规兜底 JSON 恰符合 schema 会被漏判为通过」的缺口，不再依赖人工
        // 复核请求日志）
        if (result.toolCall === undefined) {
          failed = true;
          console.error(
            `   ${card.name} ok 但走 text-JSON 兜底（result.toolCall 缺失，非真工具调用）`,
          );
        }
        const action = result.toolInput?.action;
        if (typeof action !== "object" || action === null || typeof action.name !== "string") {
          failed = true;
          // 按 toolCall 有无区分归因（轮 42 #15）：真工具调用下参数不符 schema 的
          // 故障方向在模型侧——笼统标「兜底」与请求日志可见的 tool_calls 证据矛盾
          console.error(
            `   ${card.name} ok 但 toolInput 缺 action.name（${
              result.toolCall === undefined ? "text-JSON 兜底路径" : "真工具调用但参数不符 schema"
            }）`,
          );
        }
        console.log("toolInput:");
        // 模型产物同样过 redact（轮 23 #3）：模型可能回显输入片段，与文件其余
        // 输出面（URL/headers/请求体/错误链）的脱敏纪律对齐
        console.log(redact(JSON.stringify(result.toolInput, null, 2)));
        console.log(`usage: ${JSON.stringify(result.usage)}`);
      } else {
        // empty = 解析梯子耗尽仍未产出 agent_response 调用——对 smoke 就是失败，
        // 不能静默 exitCode 0 造成假通过；reason/lastUsage（轮 35 #11）区分「模型
        // 持续回文本拒绝工具调用」与「端点响应不可解析」两类故障方向（轮 37 #2）
        failed = true;
        console.error(
          `   ${card.name} 返回 empty（reason=${result.reason}，lastUsage=${JSON.stringify(result.lastUsage)}）：解析梯子耗尽仍未产出 ${TOOL.name} 工具调用`,
        );
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
    // deps.fetch 注入生效断言（轮 42 #1）：ok/empty/异常全路径结束后检查——
    // resolveDeps 对 fetch 键是静默回落，键名漂移时唯一请求/响应证据无声消失
    if (fetchCalls === 0) {
      failed = true;
      console.error(
        `   ${card.name} 的 loggingFetch 全程未被调用——deps.fetch 注入未生效（LLMDeps 键名漂移？），本次缺请求/响应证据`,
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
