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
  EventBus,
  type EventBus as EventBusType,
  type FileSystemProvider,
  LLMClient,
  PolicyGate,
  type PolicyGate as PolicyGateType,
  resolveAgentSettings,
} from "@tw/core";
import { attachConsole } from "./console.js";
import { NodeFs } from "./node-fs.js";
import {
  applyDotEnv,
  checkReady,
  type HostSettings,
  loadHostSettings,
  resolveWsUrl,
} from "./settings.js";

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
  log?: (message: string) => void;
}

export interface AssembledAgent {
  agent: Agent;
  browser: BrowserSession;
  bus: EventBusType | null;
  /** 缺省门装配时非 null（runAgent 收尾打记账汇总）；注入自定义 policy 时为 null */
  autoAllow: AutoAllowPolicy | null;
}

export function assembleAgent(options: AssembleAgentOptions): AssembledAgent {
  const useConsole = options.console !== false;
  const log = options.log ?? ((m: string) => console.log(m));
  const sink = useConsole ? log : () => {};

  const llm =
    options.llm ??
    new LLMClient(
      {
        name: "zhipu-anthropic",
        protocol: "anthropic-messages",
        baseUrl: options.settings.llm.baseUrl,
        apiKey: options.settings.llm.apiKey,
        model: options.settings.llm.model,
        maxTokens: options.settings.llm.maxTokens,
      },
      { log: (m) => sink(`[llm] ${m}`) },
    );

  const transportFactory =
    options.transportFactory ??
    (() => CdpWsClient.connect({ wsUrl: options.wsUrl, logger: (m) => sink(`[cdp-ws] ${m}`) }));
  const browser = new BrowserSessionClass(
    transportFactory,
    {},
    {
      log: (m) => sink(`[browser] ${m}`),
    },
  );

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
  const agent = new Agent({
    task: options.task,
    llm,
    browser,
    policy,
    eventBus: bus,
    fs,
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
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentHistoryList> {
  let settings = options.settings;
  if (settings === undefined || settings === null) {
    applyDotEnv();
    settings = loadHostSettings();
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
