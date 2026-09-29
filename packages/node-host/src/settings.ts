// env→类型化配置（node-host 方案 §4/§5；tree_walker/config.py load_settings 的宿主侧
// 移植——架构铁律 2：核心包禁 ambient env，env→配置的合法归宿在宿主件）。
//
// 缺省口径（方案 §5.1「默认值单源纪律」）：
// - agent 覆盖只携带 env 里**显式设置**的键，未设置的键不传——核心 DEFAULT_AGENT_SETTINGS
//   生效（其值 = Python load_settings() 无 env 产出，由 core 的 venv fixture 对拍测试锚定）；
// - 数值缺省引用 core 常量单源派生（DEFAULT_MAX_TOKENS）；
// - 宿主层自有缺省仅两处：model 名（glm-5.3，偏离 Python 的 glm-5.1——沿用 llm-smoke
//   已验证卡片，LLM_MODEL 可覆盖）与 baseUrl（智谱 Anthropic 兼容端点，Python 同款）。
//
// 首批 env 面（名字逐字对齐 config.py）：ZHIPU_API_KEY / LLM_MODEL / LLM_BASE_URL /
// LLM_MAX_TOKENS / CDP_HOST / CDP_PORT / CDP_WS_URL / AGENT_MAX_STEPS / AGENT_USE_VISION。
// 扩展点（随对应 example 移植进入）：FALLBACK_LLM_* / AGENT_JUDGE_MODEL /
// AGENT_LLM_SCREENSHOT_SIZE / SENSITIVE_DATA 等。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverWebSocketUrl } from "@tw/cdp-ws";
import { type AgentSettings, DEFAULT_MAX_TOKENS } from "@tw/core";

/** 缺省模型（宿主层自有缺省；Python config.py 为 glm-5.1——方案 §7 偏离 1） */
export const DEFAULT_LLM_MODEL = "glm-5.3";
/** 缺省端点（智谱 Anthropic 兼容端点，与 Python LLMSettings.base_url 同款） */
export const DEFAULT_LLM_BASE_URL = "https://open.bigmodel.cn/api/anthropic";

export interface HostSettings {
  llm: {
    apiKey: string;
    model: string;
    baseUrl: string;
    maxTokens: number;
  };
  browser: {
    cdpHost: string;
    cdpPort: number;
    /** CDP_WS_URL 直连覆盖；null = 待 resolveWsUrl 发现 */
    wsUrl: string | null;
  };
  /** AgentSettings 部分覆盖——只含 env 显式设置的键（未设键不出现，核心默认生效） */
  agent: Partial<AgentSettings>;
}

export interface LoadSettingsOptions {
  /** 告警通道（非法整数等；缺省 console.warn） */
  log?: (message: string) => void;
}

/** 空串按未设置处理（shell 变量空置形态 `VAR= node` 的常见坑） */
const envStr = (env: Record<string, string | undefined>, name: string): string | undefined =>
  env[name] || undefined;

const envInt = (
  env: Record<string, string | undefined>,
  name: string,
  warn: (m: string) => void,
): number | undefined => {
  const raw = envStr(env, name);
  if (raw === undefined) {
    return undefined;
  }
  const v = Number(raw);
  if (!Number.isInteger(v) || v <= 0) {
    warn(`${name}="${raw}" 非法（需正整数），已忽略`);
    return undefined;
  }
  return v;
};

const envBool = (env: Record<string, string | undefined>, name: string): boolean | undefined => {
  const raw = envStr(env, name);
  if (raw === undefined) {
    return undefined;
  }
  return raw.toLowerCase() === "true";
};

/**
 * env → HostSettings（同步，不 fetch、不触网）。缺省 applyDotEnv 先行（runAgent 侧调用）。
 */
export function loadHostSettings(
  env: Record<string, string | undefined> = process.env,
  options: LoadSettingsOptions = {},
): HostSettings {
  const warn = options.log ?? ((m: string) => console.warn(m));

  const agent: Partial<AgentSettings> = {};
  const maxSteps = envInt(env, "AGENT_MAX_STEPS", warn);
  if (maxSteps !== undefined) {
    agent.maxSteps = maxSteps;
  }
  const useVision = envBool(env, "AGENT_USE_VISION");
  if (useVision !== undefined) {
    agent.useVision = useVision;
  }

  return {
    llm: {
      apiKey: env.ZHIPU_API_KEY ?? "",
      model: envStr(env, "LLM_MODEL") ?? DEFAULT_LLM_MODEL,
      baseUrl: envStr(env, "LLM_BASE_URL") ?? DEFAULT_LLM_BASE_URL,
      maxTokens: envInt(env, "LLM_MAX_TOKENS", warn) ?? DEFAULT_MAX_TOKENS,
    },
    browser: {
      cdpHost: envStr(env, "CDP_HOST") ?? "localhost",
      cdpPort: envInt(env, "CDP_PORT", warn) ?? 9222,
      wsUrl: envStr(env, "CDP_WS_URL") ?? null,
    },
    agent,
  };
}

/**
 * 加载 .env 到 env 对象（override=false：已存在的键不覆盖——Python load_dotenv 同款）。
 * 缺省只查 `cwd/.env`（偏离：Python 查模块根 + cwd 两处——库包内「项目根」不可判定，
 * 方案 §7 偏离 2）。文件不存在/不可读 = 静默 no-op；格式宽容（空行/注释/无 = 的行跳过，
 * 值两侧配对引号剥除）。
 */
export function applyDotEnv(
  env: Record<string, string | undefined> = process.env,
  paths: string[] = [join(process.cwd(), ".env")],
): void {
  for (const p of paths) {
    if (!existsSync(p)) {
      continue;
    }
    let content: string;
    try {
      content = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) {
        continue;
      }
      const eq = trimmed.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      ) {
        value = value.slice(1, -1);
      }
      if (env[key] === undefined || env[key] === "") {
        env[key] = value;
      }
    }
    return; // 首个存在的文件生效（Python 同款：找到即停）
  }
}

export interface ReadyCheck {
  ok: boolean;
  message: string | null;
}

/**
 * 前置检查（basic_agent.py:26-28 同款文案）。Chrome 可达性检查在 resolveWsUrl 侧——
 * 两者合计等价 Python 示例的两个 sys.exit(1) 分支。
 */
export function checkReady(settings: HostSettings): ReadyCheck {
  if (!settings.llm.apiKey) {
    return { ok: false, message: "Error: Set ZHIPU_API_KEY environment variable" };
  }
  return { ok: true, message: null };
}

export interface ResolveWsUrlDeps {
  /** 发现函数注入（测试）；缺省 cdp-ws discoverWebSocketUrl */
  discover?: (host: string, port: number) => Promise<string>;
}

/**
 * ws_url 解析：CDP_WS_URL 直连优先，否则 GET /json/version 发现（Python
 * config._fetch_ws_url 同款语义）。发现失败原样抛出（含 --remote-debugging-port
 * 提示的详细错误），由调用方决定包装文案。
 */
export async function resolveWsUrl(
  browser: HostSettings["browser"],
  deps: ResolveWsUrlDeps = {},
): Promise<string> {
  if (browser.wsUrl !== null) {
    return browser.wsUrl;
  }
  const discover = deps.discover ?? discoverWebSocketUrl;
  return discover(browser.cdpHost, browser.cdpPort);
}
