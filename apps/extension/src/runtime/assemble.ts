// Agent 装配（m5/04 §2）：node-host agent-boot 的扩展同构体（storage→配置；env
// 面不进扩展）。「配置是显式传入的类型化对象」铁律不变。扩展覆盖面（架构 §6.1
// TreeChrome 默认开启）：submitConfirmEnabled/enableSkillInjection/
// enableTaskSkillInjection 恒 true；agent.useVision/maxSteps 走 tc_settings 覆盖。
// 附件缝消费：opfs-fs + attachment 注册表装饰 readAttachment（段 C §1.3 二态的
// 扩展侧装配形态）。downloadsPath=null——扩展不开 trackDownloads（Chrome 自管
// 落盘；登记偏离）。

import {
  Agent,
  BrowserSession as BrowserSessionClass,
  type CdpTransport,
  EventBus,
  type FileSystemProvider,
  type GrantStore,
  LLMClient,
  PolicyGate,
  type PolicyInteraction,
  type ProviderConfig,
  resolveAgentSettings,
  type SkillSource,
} from "@tw/core";
import type { AttachmentRegistry } from "../host/attachment-registry.js";
import type { OpfsFs } from "../host/opfs-fs.js";
import type { ExtensionSettings } from "../host/settings-store.js";
import { findCard, sensitiveSpecsOf } from "../host/settings-store.js";
import { attachTaskText } from "./task-text.js";

export interface AssembleDeps {
  /** cdp-chrome 工厂（绑 run tabId——host/debugger-api 构造） */
  transportFactory: () => Promise<CdpTransport>;
  fs: OpfsFs;
  attachments: AttachmentRegistry;
  skillSource: SkillSource;
  /** 确认卡桥（sidepanel PolicyInteraction）；null = 无门直通（diag 形态） */
  policyInteraction: PolicyInteraction | null;
  /** always 授权持久（chrome GrantStore）；null = 不持久 */
  grantStore: GrantStore | null;
  /** LLM 构造面（测试注入 mock；缺省 LLMClient(card)） */
  llmFactory?: (card: ProviderConfig) => LLMClient;
  log?: (message: string) => void;
}

export interface AssembleInput {
  task: string;
  tabId: number;
  settings: ExtensionSettings;
}

export interface AssembledRun {
  /** Agent 的 run-manager 消费子集（结构满足——真 Agent 与状态机单测 stub 皆可） */
  agent: {
    run: () => Promise<import("@tw/core").AgentHistoryList>;
    stop: () => void;
    pause: () => void;
    resume: () => void;
  };
  browser: { stop: () => Promise<void> };
  bus: EventBus;
  /** 拼接附件清单后的最终任务文本（journal.task 用） */
  taskText: string;
}

/** activeCard 解析（无可用卡片 → null；run-manager 报用户可见错误） */
export function activeProviderCard(settings: ExtensionSettings): ProviderConfig | null {
  return findCard(settings, settings.activeCard);
}

/** 附件清单任务文本（段 C §1.4 宿主装配形态；无附件原样返回） */
export { attachTaskText };

/** opfs + 注册表装饰（段 C 缝的扩展侧单注：本体 opfs 无 readAttachment） */
export function decoratedFs(fs: OpfsFs, attachments: AttachmentRegistry): FileSystemProvider {
  return {
    resolve: (p) => fs.resolve(p),
    isFile: (p) => fs.isFile(p),
    readTextFile: (p, maxChars) => fs.readTextFile(p, maxChars),
    ensureDir: (p) => fs.ensureDir(p),
    writeTextFile: (p, c) => fs.writeTextFile(p, c),
    appendTextFile: (p, c) => fs.appendTextFile(p, c),
    writeBytes: (p, d) => fs.writeBytes(p, d),
    stat: (p) => fs.stat(p),
    readHead: (p, n) => fs.readHead(p, n),
    readAttachment: (ref) => Promise.resolve(attachments.resolve(ref)),
  };
}

export function assembleRun(input: AssembleInput, deps: AssembleDeps): AssembledRun {
  const card = activeProviderCard(input.settings);
  if (card === null) {
    throw new Error("No active provider card — 请先在设置页配置 LLM 卡片");
  }
  const log = deps.log ?? (() => {});
  const llmFactory =
    deps.llmFactory ?? ((c: ProviderConfig) => new LLMClient(c, { log: (m) => log(`[llm] ${m}`) }));
  const llm = llmFactory(card);
  // 附属卡（卡名未设/未命中 = 复用主 llm——null 直传 Agent 即复用语义）
  const taskSkillCard = findCard(input.settings, input.settings.taskSkillCard);
  const judgeCard = findCard(input.settings, input.settings.judgeCard);
  const extractCard = findCard(input.settings, input.settings.extractCard);
  const taskSkillLlm = taskSkillCard !== null ? llmFactory(taskSkillCard) : null;
  const judgeLlm = judgeCard !== null ? llmFactory(judgeCard) : null;
  const extractLlm = extractCard !== null ? llmFactory(extractCard) : null;

  const browser = new BrowserSessionClass(
    deps.transportFactory,
    {},
    {
      log: (m) => log(`[browser] ${m}`),
    },
  );
  const bus = new EventBus({ log: () => {} });
  const policy =
    deps.policyInteraction !== null
      ? new PolicyGate(deps.policyInteraction, deps.grantStore ?? null)
      : null;

  const agentSettings = resolveAgentSettings({
    // 架构 §6.1：TreeChrome 默认开启（扩展是交互形态）
    submitConfirmEnabled: true,
    enableSkillInjection: true,
    enableTaskSkillInjection: true,
    ...(input.settings.agent?.useVision !== undefined
      ? { useVision: input.settings.agent.useVision }
      : {}),
    ...(input.settings.agent?.maxSteps !== undefined
      ? { maxSteps: input.settings.agent.maxSteps }
      : {}),
  });

  const taskText = attachTaskText(input.task, deps.attachments.list());

  const agent = new Agent({
    task: taskText,
    llm,
    browser,
    settings: agentSettings,
    policy,
    eventBus: bus,
    fs: decoratedFs(deps.fs, deps.attachments),
    skillSource: deps.skillSource,
    judgeLlm,
    extractLlm,
    taskSkillLlm,
    sensitiveData: sensitiveSpecsOf(input.settings),
    // downloadsPath 不设——扩展不开 trackDownloads（Chrome 自管落盘；登记偏离）
    log: (m) => log(`[agent] ${m}`),
  });
  return { agent, browser, bus, taskText };
}
