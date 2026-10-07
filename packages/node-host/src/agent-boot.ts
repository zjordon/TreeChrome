// Agent 装配与 one-shot 运行（node-host 方案 §4）：LLMClient + transportFactory +
// BrowserSession + PolicyGate(AutoAllow) + EventBus + NodeFs + Agent 的共享组装。
// 从 examples/basic-agent.mjs 厚版收编——两级 API：
//   assembleAgent：拿零件（debug 探针类 example 裸驱 BrowserSession 用）
//   runAgent：one-shot（装载配置 → checkReady → resolveWsUrl → run → finally 收口含记账汇总）

import { CdpWsClient } from "@tw/cdp-ws";
import {
  Agent,
  type AgentHistoryList,
  AutoAllowPolicy,
  type BrowserSession,
  BrowserSession as BrowserSessionClass,
  type CdpTransport,
  DEFAULT_MAX_TOKENS,
  EventBus,
  type EventBus as EventBusType,
  type FileSystemProvider,
  LLMClient,
  PolicyGate,
  type PolicyGate as PolicyGateType,
  type ProviderConfig,
  resolveAgentSettings,
  type SensitiveDataSpec,
  type SkillSource,
  type Tools,
} from "@tw/core";
import { attachConsole } from "./console.js";
import { NodeFs } from "./node-fs.js";
import {
  applyDotEnv,
  checkReady,
  DEFAULT_LLM_BASE_URL,
  type HostSettings,
  type HostSettingsOverrides,
  loadHostSettings,
  mergeHostSettings,
  resolveWsUrl,
} from "./settings.js";
import { FsSkillSource } from "./skill-source.js";

/** transport 工厂（core connection.ts 同形；核心未导出该类型，此处本地声明） */
export type TransportFactory = () => Promise<CdpTransport>;

export interface AssembleAgentOptions {
  task: string;
  settings: HostSettings;
  /** 已解析的 ws_url（runAgent 缺省自动解析；直连装配必传） */
  wsUrl: string;
  /** 控制台观测（缺省 true：[agent]/[browser]/[llm]/[cdp-ws]/[event] 前缀行 + 记账汇总） */
  console?: boolean;
  /** 权限门（缺省 PolicyGate(AutoAllowPolicy) 无人值守放行+记账；宿主可注入自己的门） */
  policy?: PolicyGateType | null;
  /** 观测总线（缺省自建；宿主可注入自己的 bus） */
  eventBus?: EventBusType | null;
  /** 文件系统（undefined = 缺省 NodeFs；null = 跳过落盘能力） */
  fs?: FileSystemProvider | null;
  /** 预构 LLM 客户端（缺省按 settings.llm 卡片构造 anthropic-messages 协议） */
  llm?: LLMClient | null;
  /** transport 工厂（缺省 wsUrl→CdpWsClient；测试/自定义宿主注入） */
  transportFactory?: TransportFactory | null;
  /** extract 工具专用 LLM（缺省复用主 llm——Python extract_llm=None 同语义） */
  extractLlm?: LLMClient | null;
  /** 任务级 skill 匹配器专用 LLM：显式给出（含 null=强制复用主 llm）时优先；缺省按
   *  settings.llm.taskSkill 构造（无则复用主 llm——Python task_skill_llm 镜像） */
  taskSkillLlm?: LLMClient | null;
  /** 敏感数据 {占位符: 真值|{value,urls}}（sensitive_data.py 形态；直传 Agent） */
  sensitiveData?: Record<string, SensitiveDataSpec> | null;
  /** 自定义动作注册表载体（custom_action.py 形态）：缺省自建默认 25 动作面 Tools；
   *  注入时 Agent 不自建（extractClient 接线/applyPageFilters 对注入实例照常执行） */
  tools?: Tools | null;
  /** skill 注入源（评测/扩展自定义源注入位）：显式给出（含 null=关闭）时优先；
   *  缺省按 settings.skillsDir 构造 FsSkillSource（null = 不装配） */
  skillSource?: SkillSource | null;
  log?: (message: string) => void;
}

export interface AssembledAgent {
  agent: Agent;
  browser: BrowserSession;
  bus: EventBusType | null;
  /** 缺省门装配时非 null（runAgent 收尾打记账汇总）；注入自定义 policy 时为 null */
  autoAllow: AutoAllowPolicy | null;
}

/**
 * 主卡组装（独立导出便于单测）：settings.llm → ProviderConfig。fallback 存在时组
 * 完整独立卡（config.py FallbackLLMSettings；maxTokens 恒 DEFAULT_MAX_TOKENS——
 * FALLBACK_LLM_MAX_TOKENS 缺省 16384 同值，宿主面不再暴露该键）。fallback 的
 * key/baseUrl 未设（含空串）时复用主卡——env 装载层同款缺省链，overrides 只传
 * model 也能得到完整卡（两层幂等）。
 */
export function buildProviderCard(llm: HostSettings["llm"]): ProviderConfig {
  return {
    name: "zhipu-anthropic",
    protocol: "anthropic-messages",
    baseUrl: llm.baseUrl,
    apiKey: llm.apiKey,
    model: llm.model,
    maxTokens: llm.maxTokens,
    outputMode: llm.outputMode,
    ...(llm.thinkingEffort !== undefined ? { thinkingEffort: llm.thinkingEffort } : {}),
    fallback:
      llm.fallback === null
        ? null
        : {
            name: "zhipu-anthropic-fallback",
            protocol: "anthropic-messages",
            baseUrl: llm.fallback.baseUrl || llm.baseUrl,
            apiKey: llm.fallback.apiKey || llm.apiKey,
            model: llm.fallback.model,
            maxTokens: DEFAULT_MAX_TOKENS,
          },
  };
}

/**
 * 匹配器专用卡组装（独立导出便于单测与离线 harness 复用）：settings.llm.taskSkill →
 * ProviderConfig（null = 无专用卡）。key/baseUrl 未设（含空串）时复用主卡 key / 智谱
 * 端点——env 装载层同款缺省链（config.py:575-583），两层幂等；maxTokens 缺省 2048。
 * thinkingEffort 缺省 low（p5/02 R9：匹配器时延敏感，网关默认 max 档思考偶发超
 * 15s 超时；AGENT_TASK_SKILL_EFFORT 可覆盖）。
 */
export function buildTaskSkillCard(llm: HostSettings["llm"]): ProviderConfig | null {
  if (llm.taskSkill === null) {
    return null;
  }
  return {
    name: "zhipu-anthropic-task-skill",
    protocol: "anthropic-messages",
    baseUrl: llm.taskSkill.baseUrl || DEFAULT_LLM_BASE_URL,
    apiKey: llm.taskSkill.apiKey || llm.apiKey,
    model: llm.taskSkill.model,
    maxTokens: llm.taskSkill.maxTokens ?? 2048,
    thinkingEffort: llm.taskSkill.effort ?? "low",
  };
}

export function assembleAgent(options: AssembleAgentOptions): AssembledAgent {
  const useConsole = options.console !== false;
  const log = options.log ?? ((m: string) => console.log(m));
  const sink = useConsole ? log : () => {};

  const llm =
    options.llm ??
    new LLMClient(buildProviderCard(options.settings.llm), {
      log: (m) => sink(`[llm] ${m}`),
    });

  const transportFactory =
    options.transportFactory ??
    (() => CdpWsClient.connect({ wsUrl: options.wsUrl, logger: (m) => sink(`[cdp-ws] ${m}`) }));
  // 浏览器覆盖透传（fast_agent.py:37-41 的 replace 形态）：未设键不传——
  // BrowserSession 构造按缺省合并（pageSettleTimeout 2.0 / waitBetweenActions 0.0）
  const browserOverrides: { pageSettleTimeout?: number; waitBetweenActions?: number } = {};
  if (options.settings.browser.pageSettleTimeout !== undefined) {
    browserOverrides.pageSettleTimeout = options.settings.browser.pageSettleTimeout;
  }
  if (options.settings.browser.waitBetweenActions !== undefined) {
    browserOverrides.waitBetweenActions = options.settings.browser.waitBetweenActions;
  }
  const browser = new BrowserSessionClass(transportFactory, browserOverrides, {
    log: (m) => sink(`[browser] ${m}`),
  });

  let policy: PolicyGateType;
  let autoAllow: AutoAllowPolicy | null = null;
  if (options.policy !== undefined && options.policy !== null) {
    policy = options.policy;
  } else {
    autoAllow = new AutoAllowPolicy();
    policy = new PolicyGate(autoAllow);
  }

  const bus = options.eventBus ?? new EventBus({ log: () => {} });
  if (useConsole) {
    attachConsole(bus, { print: log });
  }

  const fs = options.fs !== undefined ? options.fs : new NodeFs();
  // 匹配器专用 LLM：显式注入位优先（null=强制复用主 llm）；缺省按 settings.llm.taskSkill
  // 构独立卡（buildTaskSkillCard——key/baseUrl 缺省链 env 装载层已应用，两层幂等）
  let taskSkillLlm: LLMClient | null;
  if (options.taskSkillLlm !== undefined) {
    taskSkillLlm = options.taskSkillLlm;
  } else {
    const taskSkillCard = buildTaskSkillCard(options.settings.llm);
    taskSkillLlm = taskSkillCard !== null ? new LLMClient(taskSkillCard) : null;
  }
  // skill 注入源：显式注入位优先（null = 关闭）；缺省 settings.skillsDir 驱动构造
  // （目录不存在时 FsSkillSource 读时静默 miss——loader.py 构造零 IO 同款）
  const skillSource =
    options.skillSource !== undefined && options.skillSource !== null
      ? options.skillSource
      : options.settings.skillsDir !== null
        ? new FsSkillSource(options.settings.skillsDir, (m) => sink(`[skill] ${m}`))
        : null;
  const agent = new Agent({
    task: options.task,
    llm,
    browser,
    policy,
    eventBus: bus,
    fs,
    extractLlm: options.extractLlm ?? null,
    taskSkillLlm,
    sensitiveData: options.sensitiveData ?? null,
    tools: options.tools ?? null,
    skillSource,
    downloadsPath: options.settings.browser.downloadsPath,
    // Partial 覆盖先合成全量（AgentOptions 的类型面是全量；运行时同为 resolve 合并）
    settings: resolveAgentSettings(options.settings.agent),
    log: (m) => sink(`[agent] ${m}`),
  });

  return { agent, browser, bus, autoAllow };
}

/** AutoAllow 记账汇总行（独立导出便于单测）；零请求返回 null */
export function autoAllowSummaryLine(
  requests: Array<{ capability: string; host: string }>,
): string | null {
  if (requests.length === 0) {
    return null;
  }
  const keys = [...new Set(requests.map((r) => `${r.capability}@${r.host}`))];
  return `[权限门] AutoAllow 放行 ${requests.length} 次：${keys.join("、")}`;
}

export interface RunAgentOptions extends Omit<AssembleAgentOptions, "settings" | "wsUrl"> {
  /** 缺省 applyDotEnv(process.env) + loadHostSettings()；显式传入则跳过 env 装载 */
  settings?: HostSettings | null;
  /** 缺省 resolveWsUrl（CDP_WS_URL ‖ 发现）；解析失败抛 Python 同款文案 */
  wsUrl?: string;
  /** env 装载后在 settings 上做程序化覆盖（Python replace(settings.x, ...) 形态；
   *  fast_agent 的 flash/时延收紧走此口） */
  overrides?: HostSettingsOverrides;
}

/**
 * runAgent 收口（独立导出便于单测）：AutoAllow 记账汇总打印 + bus/browser 关停。
 * 清理路径一律不抛（close 二次调用 / stop 异常等）。
 */
export async function finalizeAssembled(
  assembled: AssembledAgent,
  options: Pick<RunAgentOptions, "console" | "log"> = {},
): Promise<void> {
  const summary =
    options.console !== false && assembled.autoAllow !== null
      ? autoAllowSummaryLine(assembled.autoAllow.requests)
      : null;
  if (summary !== null) {
    (options.log ?? ((m: string) => console.log(m)))(summary);
  }
  try {
    assembled.bus?.close();
  } catch {
    // 清理路径不抛（close 二次调用等）
  }
  try {
    await assembled.browser.stop();
  } catch {
    // 清理路径不抛（run 正常收尾后的二次 stop）
  }
}

/**
 * one-shot：装载配置 → checkReady → 解析 ws_url → 装配 → agent.run() → finally 收口
 * （AutoAllow 记账汇总 / bus.close / browser.stop）。缺 key / 连不上 Chrome 时抛的即
 * Python 示例原文案（basic_agent.py:26-32），由调用方 catch 打印后 exit 1。
 * trackDownloads 开启时先 ensureDir(settings.browser.downloadsPath)（核心要求宿主
 * 保证目录存在；fs 注入 null = 跳过——自定义宿主自管）。
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentHistoryList> {
  let settings = options.settings;
  if (settings === undefined || settings === null) {
    applyDotEnv();
    settings = loadHostSettings();
  }
  if (options.overrides !== undefined) {
    settings = mergeHostSettings(settings, options.overrides);
  }
  if (settings.agent.trackDownloads === true && options.fs !== null) {
    await (options.fs ?? new NodeFs()).ensureDir(settings.browser.downloadsPath);
  }

  const ready = checkReady(settings);
  if (!ready.ok) {
    throw new Error(ready.message ?? "precondition failed");
  }

  let wsUrl: string | null = options.wsUrl ?? null;
  if (wsUrl === null) {
    try {
      wsUrl = await resolveWsUrl(settings.browser);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Error: Cannot connect to Chrome. Is it running with --remote-debugging-port=9222?\n  （发现失败详情：${detail}）`,
      );
    }
  }

  const assembled = assembleAgent({ ...options, settings, wsUrl });
  try {
    return await assembled.agent.run();
  } finally {
    await finalizeAssembled(assembled, options);
  }
}
