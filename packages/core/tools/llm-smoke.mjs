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

/** 从 vitest 的依赖闭包里解析 esbuild（pnpm 严格 node_modules，直连 "esbuild" 解析不到） */
function resolveEsbuild() {
  const vitestPkgPath = require.resolve("vitest/package.json");
  return require.resolve("esbuild", { paths: [dirname(vitestPkgPath)] });
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
    rmSync(tmp, { recursive: true, force: true });
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

async function main() {
  const apiKey = process.env.GLM_API_KEY;
  if (!apiKey) {
    console.error(
      "GLM_API_KEY 未设置（智谱开放平台 key）。用法：GLM_API_KEY=xxx node tools/llm-smoke.mjs",
    );
    process.exit(1);
  }
  const { createLLMClient, DEFAULT_MAX_TOKENS } = await loadCore();

  const cards = [
    {
      label: "zhipu-openai",
      name: "zhipu-openai",
      protocol: "openai-completions",
      baseUrl: process.env.SMOKE_OPENAI_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
      apiKey,
      model: process.env.SMOKE_OPENAI_MODEL ?? "glm-4.7",
      // 16384（非 4096）：glm 系思考模型的 reasoning 计入输出额度，4096 会被思考
      // 写满 → getAction 落 empty → smoke 产生与端点无关的假失败（TreeWalker 教训）
      maxTokens: DEFAULT_MAX_TOKENS,
    },
    {
      label: "zhipu-anthropic",
      name: "zhipu-anthropic",
      protocol: "anthropic-messages",
      baseUrl: process.env.SMOKE_ANTHROPIC_BASE_URL ?? "https://open.bigmodel.cn/api/anthropic",
      apiKey,
      model: process.env.SMOKE_ANTHROPIC_MODEL ?? "glm-5.1",
      maxTokens: DEFAULT_MAX_TOKENS,
    },
  ];

  let failed = false;
  for (const card of cards) {
    // 统一脱敏：任何输出面（URL/body/headers/异常消息）里的 apiKey 一律替换——
    // http 层的超时/网络错误消息内嵌完整 URL，网关 URL 的 query/path 也可能带令牌
    const redact = (s) => String(s).replaceAll(apiKey, "<REDACTED>");
    // 注入打点 fetch：请求体摘要（key 脱敏）——顺便验证 LlmDeps 注入口。
    // header 脱敏双保险：已知敏感头名（大小写不敏感）+ 值包含 apiKey 即整体替换
    //（extraHeaders 可注入任意名字的网关认证头，按名字拦不住）
    const loggingFetch = async (url, init) => {
      const headers = { ...(init?.headers ?? {}) };
      const SENSITIVE_HEADERS = ["authorization", "x-api-key", "x-goog-api-key"];
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
        { timeoutMs: 60_000 },
      );
      const ms = Date.now() - t0;
      console.log(
        `\n== ${card.label} (${card.protocol}, model=${card.model}) → kind=${result.kind} (${ms}ms)`,
      );
      if (result.kind === "ok") {
        console.log("toolInput:");
        console.log(JSON.stringify(result.toolInput, null, 2));
        console.log(`usage: ${JSON.stringify(result.usage)}`);
      } else {
        // empty = 解析梯子耗尽仍未产出 agent_response 调用——对 smoke 就是失败，
        // 不能静默 exitCode 0 造成假通过
        failed = true;
        console.error(`   ${card.label} 返回 empty：解析梯子耗尽仍未产出 ${TOOL.name} 工具调用`);
      }
    } catch (e) {
      failed = true;
      // 异常消息可能内嵌完整 URL / 网关回显的错误体——同样过 redact
      console.error(
        `\n== ${card.label} FAILED (${Date.now() - t0}ms): ${e?.name}: ${redact(e?.message ?? "")}`,
      );
    }
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
