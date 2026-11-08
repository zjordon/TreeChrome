// daemon 侧会话持有（issue #27 M2）：wsUrl 解析序（CDP_WS_URL > 发现 > #26 auto-chrome
// 拉起）→ BrowserSession + Tools 常驻（两层 selector map / element index 活在进程内——
// daemon 化的根因）。动作直驱 core 注册表（无 LLM、无权限门——#27 拍板：会话式调用方
// agent 即信任边界）。自拉 Chrome 随会话关停按 PID 树回收（绝不按映像名杀）。

import { CdpWsClient, discoverWebSocketUrl } from "@tw/cdp-ws";
import {
  type ActionResult,
  BrowserSession as BrowserSessionClass,
  type BrowserStateSummary,
  type TabInfo,
  Tools,
} from "@tw/core";
import { type LaunchedChrome, launchAutoChrome } from "../auto-chrome.js";
import { NodeFs } from "../node-fs.js";
import { loadHostSettings } from "../settings.js";

/** ActionResult → JSON 投影（camelCase；daemon 信封 data 的动作形态） */
export interface ActionResultOut {
  isDone: boolean;
  success: boolean | null;
  error: string | null;
  extractedContent: string | null;
  longTermMemory: string | null;
  judgement: unknown;
  metadata: Record<string, unknown> | null;
  attachments: string[] | null;
  denied: boolean;
}

export function projectActionResult(r: ActionResult): ActionResultOut {
  return {
    isDone: r.isDone,
    success: r.success,
    error: r.error,
    extractedContent: r.extractedContent,
    longTermMemory: r.longTermMemory,
    judgement: r.judgement,
    metadata: r.metadata,
    attachments: r.attachments,
    denied: r.denied,
  };
}

/** get_state 投影：element_tree_text 是核心供给物；截图走 screenshot 动词（不掺入） */
export interface StateOut {
  url: string;
  title: string;
  tabs: TabInfo[];
  currentTargetId: string | null;
  elementTreeText: string;
  gridMeta: Record<string, unknown> | null;
}

export interface TabsOut {
  tabs: TabInfo[];
  currentTargetId: string | null;
}

/** 会话级错误：kind 决定 CLI 退出码（env→2：连不上/会话断；exec→1：动作执行失败） */
export class SessionError extends Error {
  readonly kind: "env" | "exec";

  constructor(message: string, kind: "env" | "exec") {
    super(message);
    this.kind = kind;
  }
}

export interface DaemonSession {
  /** 实际解析出的 wsUrl（首个请求前 null） */
  readonly wsUrl: string | null;
  /** daemon 自拉的 Chrome（attach 既有实例时 null） */
  readonly spawnedChrome: { pid: number } | null;
  runAction(action: string, params: Record<string, unknown>): Promise<ActionResultOut>;
  getState(): Promise<StateOut>;
  tabs(): Promise<TabsOut>;
  /** 幂等；browser.stop + 自拉 Chrome PID 树回收；清理失败只记日志不抛 */
  shutdown(): Promise<void>;
}

export interface SessionDeps {
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
  discover?: (host: string, port: number) => Promise<string>;
  launch?: typeof launchAutoChrome;
  /** BrowserSession+Tools 装配工厂（缺省真装配；测试注入假件） */
  makeCore?: (
    wsUrl: string,
    log: (message: string) => void,
  ) => {
    browser: BrowserSessionClass;
    tools: Tools;
  };
}

const defaultMakeCore = (
  wsUrl: string,
  log: (message: string) => void,
): { browser: BrowserSessionClass; tools: Tools } => {
  const browser = new BrowserSessionClass(
    () => CdpWsClient.connect({ wsUrl, logger: (m) => log(`[cdp-ws] ${m}`) }),
    {},
    { log: (m: string) => log(`[browser] ${m}`) },
  );
  // 会话式拍板：upload/write/read 白名单全不设（core null = 默认放行）——调用方 agent
  // 即信任边界；run 子命令面的 --allow-* 护栏不受影响
  const tools = new Tools({ fs: new NodeFs(), log: (m) => log(`[action] ${m}`) });
  return { browser, tools };
};

/**
 * 惰性单例会话：首个请求才解析 wsUrl 并 start；连接死亡（isConnected=false）后
 * 下一次调用自动重建（daemon 存活、会话自愈）。显式 CDP_WS_URL 时绝不自拉 Chrome
 *（与 run --auto-chrome 同语义：调用方自管连接）。
 */
export function createDaemonSession(deps: SessionDeps = {}): DaemonSession {
  const env = deps.env ?? process.env;
  const log = deps.log ?? (() => {});
  const discover = deps.discover ?? discoverWebSocketUrl;
  const launch = deps.launch ?? launchAutoChrome;
  const makeCore = deps.makeCore ?? defaultMakeCore;

  let core: ReturnType<NonNullable<SessionDeps["makeCore"]>> | null = null;
  let wsUrl: string | null = null;
  let chrome: LaunchedChrome | null = null;
  let lastState: BrowserStateSummary | null = null;

  const resolveWsUrl = async (): Promise<string> => {
    const browser = loadHostSettings(env).browser;
    if (browser.wsUrl !== null) {
      return browser.wsUrl;
    }
    try {
      return await discover(browser.cdpHost, browser.cdpPort);
    } catch {
      // CDP 不通 → 自动拉起（复用 #26 基建；daemon 拥有并负责回收）
    }
    try {
      chrome = await launch({ port: browser.cdpPort, log });
    } catch (e) {
      throw new SessionError(
        `Chrome 不可达且自动拉起失败：${e instanceof Error ? e.message : String(e)}`,
        "env",
      );
    }
    try {
      return await discover(browser.cdpHost, browser.cdpPort);
    } catch (e) {
      await chrome.stop((m) => log(m));
      chrome = null;
      throw new SessionError(
        `Chrome 拉起后 CDP 仍不可达：${e instanceof Error ? e.message : String(e)}`,
        "env",
      );
    }
  };

  const ensure = async () => {
    if (core?.browser.isConnected) {
      return core;
    }
    if (core !== null) {
      // 死会话：尽力收口后重建（stop 二次调用/异常不抛）
      try {
        await core.browser.stop();
      } catch {
        // 清理路径不抛
      }
      core = null;
    }
    try {
      wsUrl = await resolveWsUrl();
    } catch (e) {
      throw e instanceof SessionError
        ? e
        : new SessionError(`CDP 发现失败：${e instanceof Error ? e.message : String(e)}`, "env");
    }
    core = makeCore(wsUrl, log);
    try {
      await core.browser.start();
    } catch (e) {
      core = null;
      throw new SessionError(
        `BrowserSession 启动失败：${e instanceof Error ? e.message : String(e)}`,
        "env",
      );
    }
    lastState = null;
    log(`[daemon-session] 会话就绪（wsUrl=${wsUrl}）`);
    return core;
  };

  return {
    get wsUrl() {
      return wsUrl;
    },
    get spawnedChrome() {
      return chrome === null ? null : { pid: chrome.pid };
    },
    async runAction(action, params) {
      const c = await ensure();
      try {
        const r = await c.tools.execute(action, params, c.browser, lastState);
        return projectActionResult(r);
      } catch (e) {
        // 传输中断不自作主张置空 core——下一次 ensure 检测 isConnected 做「优雅 stop +
        // 重建」（本调用按 env 收口，调用方重试即自愈）
        if (!c.browser.isConnected) {
          throw new SessionError(
            `会话中断：${e instanceof Error ? e.message : String(e)}（重试将自动重建会话）`,
            "env",
          );
        }
        throw new SessionError(e instanceof Error ? e.message : String(e), "exec");
      }
    },
    async getState() {
      const c = await ensure();
      try {
        const st = await c.browser.getState({ includeScreenshot: false });
        lastState = st;
        return {
          url: st.url,
          title: st.title,
          tabs: st.tabs,
          currentTargetId: c.browser.currentTargetId,
          elementTreeText: st.domState === null ? "" : st.domState.elementTreeText,
          gridMeta: st.gridMeta,
        };
      } catch (e) {
        throw new SessionError(
          `get_state 失败：${e instanceof Error ? e.message : String(e)}`,
          c.browser.isConnected ? "exec" : "env",
        );
      }
    },
    async tabs() {
      const c = await ensure();
      try {
        return { tabs: await c.browser.getTabs(), currentTargetId: c.browser.currentTargetId };
      } catch (e) {
        throw new SessionError(
          `tabs 失败：${e instanceof Error ? e.message : String(e)}`,
          c.browser.isConnected ? "exec" : "env",
        );
      }
    },
    async shutdown() {
      if (core !== null) {
        try {
          await core.browser.stop();
        } catch {
          // 清理路径不抛
        }
        core = null;
      }
      if (chrome !== null) {
        const owned = chrome;
        chrome = null;
        await owned.stop((m) => log(m));
      }
    },
  };
}
