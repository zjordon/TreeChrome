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
// LLM_MAX_TOKENS / LLM_OUTPUT_MODE / CDP_HOST / CDP_PORT / CDP_WS_URL / AGENT_MAX_STEPS /
// AGENT_USE_VISION。第二批（features）追加：FALLBACK_LLM_MODEL / FALLBACK_LLM_API_KEY /
// FALLBACK_LLM_BASE_URL（config.py:588-600）与 DOWNLOADS_PATH（session.py:1882 解析序
// 的 env 半边）。P5.5（skill 面）追加：AGENT_SKILLS_DIR（config.py:191/:516，缺省
// "domain-skills"——CWD 相对解析；**偏离登记：Python 的 repo-root 回退不移植**，link:
// 消费者显式传路径）/ AGENT_ENABLE_SKILL_INJECTION / AGENT_ENABLE_TASK_SKILL_INJECTION
// （config.py:390/:427 评测口径 B/C 开关）。扩展点（随对应 example 移植进入）：
// AGENT_JUDGE_MODEL / AGENT_LLM_SCREENSHOT_SIZE / AGENT_EXTRACT_* / SENSITIVE_DATA 等。

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverWebSocketUrl } from "@tw/cdp-ws";
import { type AgentSettings, DEFAULT_MAX_TOKENS } from "@tw/core";

/** 缺省模型（宿主层自有缺省；Python config.py 为 glm-5.1——方案 §7 偏离 1） */
export const DEFAULT_LLM_MODEL = "glm-5.3";
/** 缺省端点（智谱 Anthropic 兼容端点，与 Python LLMSettings.base_url 同款） */
export const DEFAULT_LLM_BASE_URL = "https://open.bigmodel.cn/api/anthropic";

/** output_mode 合法值集（config.py:602 同款三值） */
const OUTPUT_MODES = new Set(["standard", "flash", "thinking"]);

export interface HostSettings {
  llm: {
    apiKey: string;
    model: string;
    baseUrl: string;
    maxTokens: number;
    /** 输出模式（LLM_OUTPUT_MODE；缺省 "standard"）——LLM 卡片透传，Agent 侧消费 */
    outputMode: string;
    /** fallback 卡（FALLBACK_LLM_MODEL 空 = 无 fallback）：key/baseUrl 可缺省——
     *  env 装载层与 buildProviderCard 双层应用「未设复用主卡」链（config.py:588-600
     *  同款；overrides 只传 model 时同样生效）；maxTokens 恒 DEFAULT_MAX_TOKENS */
    fallback: { model: string; apiKey?: string; baseUrl?: string } | null;
    /** 任务级 skill 匹配器专用卡（AGENT_TASK_SKILL_MODEL 空 = 无，复用主 llm——
     *  config.py:575-583 四键镜像：key 缺省复用主卡 / baseUrl 缺省智谱端点 /
     *  maxTokens 缺省 2048） */
    taskSkill: { model: string; apiKey?: string; baseUrl?: string; maxTokens?: number } | null;
  };
  browser: {
    cdpHost: string;
    cdpPort: number;
    /** CDP_WS_URL 直连覆盖；null = 待 resolveWsUrl 发现 */
    wsUrl: string | null;
    /** 页面稳定等待秒（BrowserSessionSettings.pageSettleTimeout 覆盖；未设 = 核心默认 2.0）。
     *  Python 此两字段无 env——示例经 replace() 程序化设置（fast_agent.py:37-41），
     *  对应形态是 runAgent 的 overrides 而非 env */
    pageSettleTimeout?: number;
    /** 动作间隔秒（同上；未设 = 核心默认 0.0） */
    waitBetweenActions?: number;
    /** 下载落盘目录（DOWNLOADS_PATH；缺省用户 Downloads——Python session.py:1882 解析序
     *  「参数 > env > OS Downloads」的 env/home 半边，host 层合法）。trackDownloads
     *  开启时 runAgent ensureDir 后传 AgentOptions.downloadsPath */
    downloadsPath: string;
  };
  /** AgentSettings 部分覆盖——只含 env 显式设置的键（未设键不出现，核心默认生效） */
  agent: Partial<AgentSettings>;
  /** skill 内容根目录（AGENT_SKILLS_DIR；缺省 "domain-skills" 相对 CWD——config.py:516
   *  同款；null = 显式关闭 skill 注入源装配，仅 overrides 可达） */
  skillsDir: string | null;
}

/** runAgent/mergeHostSettings 的覆盖面（对应 Python replace(settings.x, ...) 形态） */
export interface HostSettingsOverrides {
  llm?: Partial<HostSettings["llm"]>;
  browser?: Partial<HostSettings["browser"]>;
  agent?: Partial<AgentSettings>;
  skillsDir?: string | null;
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

/** LLM_OUTPUT_MODE（config.py:601-604 同款）：非法值告警后回退 standard */
const envOutputMode = (
  env: Record<string, string | undefined>,
  warn: (m: string) => void,
): string => {
  const raw = envStr(env, "LLM_OUTPUT_MODE");
  if (raw === undefined) {
    return "standard";
  }
  if (!OUTPUT_MODES.has(raw)) {
    warn(`LLM_OUTPUT_MODE="${raw}" 非法（需 standard|flash|thinking），已回退 standard`);
    return "standard";
  }
  return raw;
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
  // skill 注入开关（config.py:390/:427 的 env 面——评测口径 B/C 经此翻转）
  const enableSkillInjection = envBool(env, "AGENT_ENABLE_SKILL_INJECTION");
  if (enableSkillInjection !== undefined) {
    agent.enableSkillInjection = enableSkillInjection;
  }
  const enableTaskSkillInjection = envBool(env, "AGENT_ENABLE_TASK_SKILL_INJECTION");
  if (enableTaskSkillInjection !== undefined) {
    agent.enableTaskSkillInjection = enableTaskSkillInjection;
  }

  // fallback 卡（config.py:588-600：FALLBACK_LLM_MODEL 空 = 无；key/baseUrl 缺省链）
  const apiKey = env.ZHIPU_API_KEY ?? "";
  const baseUrl = envStr(env, "LLM_BASE_URL") ?? DEFAULT_LLM_BASE_URL;
  const fallbackModel = envStr(env, "FALLBACK_LLM_MODEL");
  const fallback =
    fallbackModel === undefined
      ? null
      : {
          model: fallbackModel,
          apiKey: envStr(env, "FALLBACK_LLM_API_KEY") ?? apiKey,
          baseUrl: envStr(env, "FALLBACK_LLM_BASE_URL") ?? baseUrl,
        };
  // 任务级 skill 匹配器专用卡（config.py:575-583 四键镜像；空 model = 无）
  const taskSkillModel = envStr(env, "AGENT_TASK_SKILL_MODEL");
  const taskSkill =
    taskSkillModel === undefined
      ? null
      : {
          model: taskSkillModel,
          apiKey: envStr(env, "AGENT_TASK_SKILL_API_KEY") ?? apiKey,
          baseUrl: envStr(env, "AGENT_TASK_SKILL_BASE_URL") ?? DEFAULT_LLM_BASE_URL,
          maxTokens: envInt(env, "AGENT_TASK_SKILL_MAX_TOKENS", warn) ?? 2048,
        };

  return {
    llm: {
      apiKey,
      model: envStr(env, "LLM_MODEL") ?? DEFAULT_LLM_MODEL,
      baseUrl,
      maxTokens: envInt(env, "LLM_MAX_TOKENS", warn) ?? DEFAULT_MAX_TOKENS,
      outputMode: envOutputMode(env, warn),
      fallback,
      taskSkill,
    },
    browser: {
      cdpHost: envStr(env, "CDP_HOST") ?? "localhost",
      cdpPort: envInt(env, "CDP_PORT", warn) ?? 9222,
      wsUrl: envStr(env, "CDP_WS_URL") ?? null,
      downloadsPath: envStr(env, "DOWNLOADS_PATH") ?? join(homedir(), "Downloads"),
    },
    agent,
    // Python config.py:516 缺省 "domain-skills"（CWD 相对，FsSkillSource 读时解析，
    // 目录不存在 = 静默无 skill）；关闭走 overrides.skillsDir = null
    skillsDir: envStr(env, "AGENT_SKILLS_DIR") ?? "domain-skills",
  };
}

/** 值为 undefined 的键丢弃（显式 undefined 不得清掉 base 值） */
function definedOnly<T extends Record<string, unknown>>(partial: T | undefined): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(partial ?? {})) {
    if (v !== undefined) {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/**
 * 覆盖合并（Python replace(settings.llm, output_mode="flash") 的形态等价）：
 * overrides 只覆盖显式给出且非 undefined 的键，其余保留 base。browser 的
 * pageSettleTimeout/waitBetweenActions 未设时保持缺省（undefined = 核心默认）。
 * llm.fallback **二级合并**（轮 2 #2）：overrides 只传 model 时保留 base（env 层
 * FALLBACK_LLM_* 装载）的 apiKey/baseUrl——整对象替换会静默丢专用网关凭证；
 * 显式 null = 关闭 fallback（不与 base 合并）。
 */
export function mergeHostSettings(
  base: HostSettings,
  overrides: HostSettingsOverrides = {},
): HostSettings {
  const llm = { ...base.llm, ...definedOnly(overrides.llm) };
  if (overrides.llm?.fallback != null) {
    const fbOver = definedOnly(overrides.llm.fallback);
    llm.fallback =
      base.llm.fallback === null ? { model: "", ...fbOver } : { ...base.llm.fallback, ...fbOver };
  }
  // taskSkill 二级合并（fallback 同款纪律）：整对象替换会丢 env 层专用网关凭证；
  // 显式 null = 关闭（不与 base 合并）
  if (overrides.llm?.taskSkill != null) {
    const tsOver = definedOnly(overrides.llm.taskSkill);
    llm.taskSkill =
      base.llm.taskSkill === null ? { model: "", ...tsOver } : { ...base.llm.taskSkill, ...tsOver };
  }
  return {
    llm,
    browser: { ...base.browser, ...definedOnly(overrides.browser) },
    agent: { ...base.agent, ...definedOnly(overrides.agent) },
    // 标量：显式给出（含 null=关闭）才覆盖
    skillsDir: overrides.skillsDir !== undefined ? overrides.skillsDir : base.skillsDir,
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
