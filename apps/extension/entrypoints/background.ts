// SW 壳（m5/01 §1.4 → m5/04 段 D 全量接线）：消息路由先注册（headless 无
// sidePanel API 时 setPanelBehavior 同步抛错拖死路由的教训——任何重活/异步初始化
// 都不得前置于路由注册）；随后 boot 装配 host/runtime 全部件（settings/grant/
// skills/attachments/journal/keepalive/run-manager/port-server）。
// 本目录（entrypoints/）与 src/host/ 是扩展内合法使用 chrome.*/browser 的区域。

import {
  type ChromeDebuggerTransport,
  chromeDebuggerApi,
  chromeTabsApi,
  createChromeDebuggerTransport,
} from "@tw/cdp-chrome";
import { BrowserSession as BrowserSessionClass, LLMClient, Tools } from "@tw/core";
import type { RunJournalSnapshot, SwToUiMessage, UiDiagMessage } from "@tw/protocol";
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { AttachmentRegistry } from "../src/host/attachment-registry.js";
import {
  chromeAlarms,
  chromeNotifications,
  chromeOnConnect,
  chromeOnInstalled,
  chromeRuntimeId,
  chromeSidePanel,
  chromeStorageLocal,
  chromeStorageOnChanged,
  chromeTabsOnRemoved,
  chromeTabsOnUpdated,
  chromeTabsQuery,
  chromeTabsUpdate,
} from "../src/host/chrome-apis.js";
import { makeDebuggerTransportFactory } from "../src/host/debugger-api.js";
import { ChromeGrantStore } from "../src/host/grant-store.js";
import { KeepaliveController } from "../src/host/keepalive.js";
import { OpfsFs } from "../src/host/opfs-fs.js";
import { RunNotifier } from "../src/host/run-notifier.js";
import { notifyOnRunDoneOf, SettingsStore } from "../src/host/settings-store.js";
import { ExtensionSkillSource } from "../src/host/skill-source.js";
import {
  type BuiltinsManifest,
  openSkillDb,
  type SkillDb,
  SkillStore,
} from "../src/host/skill-store.js";
import { activeProviderCard } from "../src/runtime/assemble.js";
import { createBridgeGateway } from "../src/runtime/bridge-gateway.js";
import { BridgeRuntime } from "../src/runtime/bridge-runtime.js";
import { createMutatingDispatchChain } from "../src/runtime/dispatch-chain.js";
import { DISTILL_ALARM_NAME, DistillQueue } from "../src/runtime/distill-queue.js";
import { DistillWorker } from "../src/runtime/distill-worker.js";
import {
  createDriveAuditWriter,
  createDriveGateway,
  driveUploadFs,
} from "../src/runtime/drive-gateway.js";
import { DriveSession } from "../src/runtime/drive-session.js";
import { DebounceScheduler, RunJournal } from "../src/runtime/journal.js";
import { registerMessageRouter } from "../src/runtime/message-router.js";
import { handleOptionsRequest, type OptionsFace } from "../src/runtime/options-handler.js";
import { PortServer } from "../src/runtime/port-server.js";
import { RunManager } from "../src/runtime/run-manager.js";
import { handleSessionRequest, type SessionFace } from "../src/runtime/session-handler.js";
import { SessionRepository } from "../src/runtime/session-repo.js";

function _isDiagMessage(v: unknown): v is UiDiagMessage {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { kind?: unknown }).kind === "diag" &&
    typeof (v as { command?: unknown }).command === "string"
  );
}

/**
 * diag:smoke:attach——e2e 对拍通道（m5/02 §6）：对指定 tab 走真实装配
 * （chrome.debugger 适配 → ChromeDebuggerTransport → core BrowserSession 连接序列
 * 与 get_state 九步），返回 element_tree_text 供与 cdp-ws 通道逐字节比对。
 * payload: { tabId: number }
 */
async function runSmokeAttach(payload: unknown): Promise<unknown> {
  const tabId = (payload as { tabId?: unknown } | null)?.tabId;
  if (typeof tabId !== "number") return { ok: false, error: "smoke:attach requires payload.tabId" };
  // ref 对象持有闭包内赋值的 transport（TS CFA 对 let+闭包赋值会在 finally 处
  // 收窄成 never——属性访问不受窄化影响）
  const transportRef: { current: ChromeDebuggerTransport | null } = { current: null };
  const factory = async (): Promise<ChromeDebuggerTransport> => {
    if (transportRef.current !== null) await transportRef.current.stop().catch(() => {});
    transportRef.current = await createChromeDebuggerTransport({
      api: chromeDebuggerApi(),
      tabs: chromeTabsApi(),
      tabId,
      log: (m) => console.log(`[cdp-chrome] ${m}`),
    });
    return transportRef.current;
  };
  const session = new (await import("@tw/core")).BrowserSession(
    factory,
    {},
    {
      log: (m) => console.log(`[smoke] ${m}`),
    },
  );
  try {
    await session.start();
    const state = await session.getState({ includeScreenshot: false });
    return {
      ok: true,
      url: state.url,
      title: state.title,
      elementTreeText: state.domState?.elementTreeText ?? null,
      interactiveCount: state.domState?.selectorMap?.size ?? 0,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await session.stop().catch(() => {});
    // 兜底（段 B 评审轮 1 [1]）：connectSession 失败路径 core 只置 transportRef=null
    // 不级联 stop——闭包 transport 直接 stop 回收附着与全局监听（幂等）
    await transportRef.current?.stop().catch(() => {});
  }
}

const log = (m: string): void => {
  console.log(`[tc] ${m}`);
};

export default defineBackground(() => {
  // ── 路由先注册（纪律：任何初始化失败不得拖死消息面）──
  registerMessageRouter(browser.runtime.onMessage, {
    onUiMessage: (message) => {
      void bootPromise
        .then(({ runManager }) => runManager.handleUiMessage(message))
        .catch((e: unknown) => {
          console.error(
            `[tc] handleUiMessage failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
    },
    onDiag: (command, payload, sendResponse) => {
      if (command === "echo") {
        sendResponse({ ok: true, command: "echo", payload: payload ?? null });
        return false;
      }
      if (command === "smoke:attach") {
        void runSmokeAttach(payload)
          .then((result) => sendResponse(result))
          .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
        return true;
      }
      return false;
    },
    // options 请求-应答（段 E）：单发 + sendResponse；经 bootPromise 排队到部件就绪
    onOptions: (op, payload, sendResponse) => {
      void bootPromise
        .then((booted) => handleOptionsRequest(op, payload, booted.options))
        .then((result) => sendResponse(result))
        .catch((e: unknown) =>
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
      return true;
    },
    // session 请求-应答（issue #35 U1a）：同 options 模式经 bootPromise 排队
    onSession: (op, payload, sendResponse) => {
      void bootPromise
        .then((booted) => handleSessionRequest(op, payload, booted.session))
        .then((result) => sendResponse(result))
        .catch((e: unknown) =>
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
      return true;
    },
  });

  // 点扩展图标 = 开侧边栏（sidepanel entrypoint 由 WXT 注册 default_path）。
  // headless/旧内核无 sidePanel API——特性探测，失败只降级不抛
  try {
    void browser.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((e: unknown) => console.warn(`[tc] setPanelBehavior failed: ${String(e)}`));
  } catch (e) {
    console.warn(`[tc] sidePanel API unavailable: ${String(e)}`);
  }

  // chrome.commands（#37 批 C）：Ctrl+Shift=K=_execute_action（浏览器原生路由到
  // action → 开面板）；Ctrl+Shift+M=模型快速切换——先开面板再广播 switch-request
  // （D5：命令回调是合法用户手势，sidePanel.open 需手势上下文）。广播经模块级
  // 晚绑定 ref（portServer 在 boot 内构造——监听器须在首个 await 前同步注册）
  try {
    browser.commands?.onCommand.addListener((command: string) => {
      if (command !== "open-model-switcher") return;
      void (async () => {
        try {
          const tabs = await chromeTabsQuery().query({ active: true, currentWindow: true });
          const tabId = tabs[0]?.id;
          if (tabId !== undefined) await browser.sidePanel.open({ tabId });
        } catch {
          /* 面板开不了（无手势上下文/旧内核）——广播照发，已开的面板也能切 */
        }
        uiBroadcastRef?.({ kind: "model-switch-request" });
      })();
    });
  } catch (e) {
    console.warn(`[tc] commands API unavailable: ${String(e)}`);
  }

  const bootPromise = boot();
  bootPromise.catch((e: unknown) => {
    console.error(`[tc] boot failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  });
});

/** UI 广播晚绑定 ref（#37 批 C：commands 监听器在 boot 前注册，portServer 在
 *  boot 内构造——模块级 ref 桥接时序） */
let uiBroadcastRef: ((message: SwToUiMessage) => void) | null = null;

interface Booted {
  runManager: RunManager;
  skillStore: SkillStore;
  /** options 请求-应答面（段 E） */
  options: OptionsFace;
  /** session 请求-应答面（issue #35 U1a） */
  session: SessionFace;
}

/** IDB 打不开时的降级空库（评审轮 1 [13]：skill 是可选增强，存储故障不得
 *  拖垮 run 主链——get 恒 null/写 noop，全部 miss） */
function memorySkillDb(): SkillDb {
  return {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    getAllKeys: async () => [],
  };
}

/** SW 重活装配（消息路由已先行注册——boot 期间到达的消息经 bootPromise 排队）。
 *  MV3 时序纪律（评审轮 1 [15]）：全部事件监听器（PortServer onConnect/
 *  onInstalled）必须在首个 await 前同步注册——Chrome 唤醒 SW 后在顶层求值完成
 *  即派发排队事件，晚于 await 点注册的监听器会丢事件（connect 丢失=sidepanel
 *  永远收不到 hello，无自愈）。故 openSkillDb（boot 唯一 await 点）置于尾部。 */
async function boot(): Promise<Booted> {
  const storage = chromeStorageLocal();
  const settingsStore = new SettingsStore(storage);
  const grantStore = new ChromeGrantStore(storage);
  const attachments = new AttachmentRegistry();
  // 会话存储层（issue #35 U1a）：生产必注入 runManager（漏注入即会话面静默禁用——
  // boot 日志确认，D4）
  const sessionRepo = new SessionRepository(storage, { log });
  log("session repository ready");
  const journal = new RunJournal({
    scheduler: new DebounceScheduler(async (runKey, snapshot) => {
      await storage.set({ [runKey]: snapshot });
    }),
  });
  const fs = new OpfsFs();
  const keepalive = new KeepaliveController(chromeAlarms());

  // skills 晚绑定 holder（store 在尾部 await openSkillDb 后就位；makeSkillSource
  // 只在 run 启动时调用——bootPromise 已把关，届时必已就绪）
  const skillRefs: { store: SkillStore | null; ready: Promise<unknown> } = {
    store: null,
    ready: Promise.resolve(),
  };
  const refreshSkills = (): Promise<void> =>
    skillRefs.store !== null ? refreshBuiltins(skillRefs.store) : Promise.resolve();

  // —— 蒸馏队列/worker（issue #5 S4，D9）：worker 晚绑定（skill store 就位后构造）；
  //    alarm 队列非空时建 1min 周期、清空即除；boot 兜底 drain（SW 被杀后重启续跑）——
  const distillQueue = new DistillQueue(storage, log);
  let distillWorkerRef: DistillWorker | null = null;
  const alarmsApi = chromeAlarms();
  const syncDistillAlarm = (): void => {
    void distillQueue
      .size()
      .then((n) =>
        n > 0
          ? alarmsApi.create(DISTILL_ALARM_NAME, { periodInMinutes: 1 })
          : void alarmsApi.clear(DISTILL_ALARM_NAME),
      )
      .catch(() => {});
  };
  const kickDistill = (): void => {
    const worker = distillWorkerRef;
    if (worker === null) return;
    void worker
      .drainAll()
      .catch((e: unknown) =>
        log(`distill: drain 异常——${e instanceof Error ? e.message : String(e)}`),
      )
      .finally(syncDistillAlarm);
  };
  alarmsApi.onAlarm?.addListener((alarm) => {
    if (alarm.name === DISTILL_ALARM_NAME) kickDistill();
  });

  // 广播/端口态闭包晚绑定（portServer 在 runManager 之后构造——双向引用经 holder 收口）
  let portServerRef: PortServer | null = null;
  // 终态通知回流（issue #41 批 C，验收②）：onClicked 在构造时同步注册（MV3 纪律）；
  // 设置门 hot-read（save-settings 立即生效，不发不泄漏）
  const runNotifier = new RunNotifier({
    notifications: chromeNotifications(),
    tabsUpdate: chromeTabsUpdate(),
    sidePanelOpen: (options) => chromeSidePanel().open(options),
    enabled: () => settingsStore.load().then(notifyOnRunDoneOf),
    log,
  });
  const runManager = new RunManager({
    settingsStore,
    attachments,
    journal,
    fs,
    keepalive,
    tabsQuery: chromeTabsQuery(),
    tabsOnRemoved: chromeTabsOnRemoved(),
    transportFactoryFor: (tabId) => makeDebuggerTransportFactory(tabId, {}, log),
    makeSkillSource: () => {
      const store = skillRefs.store;
      if (store === null) throw new Error("skill store not ready");
      // 每 run 新实例（缓存不跨 run——刷新后的数据下一 run 可见）+ ready gate
      //（首装窗口期空库不固化负缓存，评审轮 1 [1][12]）
      return new ExtensionSkillSource(store, log, skillRefs.ready);
    },
    grantStore,
    broadcast: (m) => portServerRef?.broadcast(m),
    hasPorts: () => portServerRef?.hasPorts ?? false,
    notifyTerminal: (input) => runNotifier.notifyTerminal(input),
    distill: {
      enqueue: (job) => distillQueue.enqueue(job),
      kick: kickDistill,
    },
    sessions: sessionRepo,
    log,
  });
  portServerRef = new PortServer(chromeOnConnect(), {
    hello: () => runManager.hello(),
    onUiMessage: (message) => runManager.handleUiMessage(message),
    onAllPortsDisconnected: () => runManager.onAllPortsDisconnected(),
    pendingCards: () => runManager.pendingCards(),
  });
  // commands 广播桥（#37 批 C）：模块级晚绑定 ref 指向 portServer.broadcast
  uiBroadcastRef = (message) => portServerRef?.broadcast(message);
  chromeOnInstalled().addListener((details: unknown) => {
    const reason = (details as { reason?: unknown } | null)?.reason;
    if (reason === "install" || reason === "update") void refreshSkills();
  });

  // —— 桥 runtime（issue #31 M1 + #32 M2）：与本地 tc-bridge 的长轮询连接。构造与
  //    start() 全同步——tabs/storage/alarms 监听器在 boot 首个 await 前注册（MV3
  //    纪律，SW 被杀唤醒后不丢事件）；dispatch 按 method 分流——任务级三件走
  //    bridge-gateway（RunManager 同一单飞互斥），drive/session_stop 走
  //    drive-gateway（直驱会话；run ↔ drive 双向互斥）——
  const driveSession = new DriveSession({
    tabsQuery: chromeTabsQuery(),
    makeTransportFactory: (tabId) => makeDebuggerTransportFactory(tabId, {}, log),
    makeCore: (transportFactory, coreLog) => ({
      browser: new BrowserSessionClass(
        transportFactory,
        {},
        {
          log: (m: string) => coreLog(`[browser] ${m}`),
        },
      ),
      // 会话式拍板（#32 决策点 ④）：upload 路径模式、白名单全不设（调用方即信任
      // 边界，与 #27 daemon 同款）；fs=driveUploadFs(OPFS)——OS 绝对路径放行由
      // Chrome 读盘，OPFS 虚拟工作区（screenshot save_path）照常
      tools: new Tools({ fs: driveUploadFs(fs), log: (m: string) => coreLog(`[action] ${m}`) }),
    }),
    keepalive,
    storage,
    now: () => Date.now(),
    log,
  });
  const driveGateway = createDriveGateway({
    session: driveSession,
    journal,
    // 决策点 ② 在场门：PortServer.hasPorts（晚绑定 ref——portServer 在
    // runManager 之后构造）
    hasSidepanel: () => portServerRef?.hasPorts ?? false,
    audit: createDriveAuditWriter(storage, log),
    now: () => Date.now(),
    log,
  });
  const m1Gateway = createBridgeGateway({
    runManager,
    journal,
    // busy（在位或创建在途）——ensure 数百 ms 在途期 core 仍空，只看 active 会让
    // 并发 run_task 穿透互斥双 attach 互踢（评审轮 1 [1]）
    isDriveActive: () => driveSession.busy,
    log,
  });
  const bridgeRuntime = new BridgeRuntime({
    storage,
    storageOnChanged: chromeStorageOnChanged(),
    alarms: alarmsApi,
    tabsOnUpdated: chromeTabsOnUpdated(),
    tabsQuery: chromeTabsQuery(),
    // SW 的 fetch 同 chrome API 一样 receiver 敏感——裸传方法丢 this 会 Illegal
    // invocation（e2e 探针实证），箭头函数保全局接收者
    fetch: (input, init) => fetch(input, init),
    extensionId: chromeRuntimeId(),
    newId: () => crypto.randomUUID(),
    now: () => Date.now(),
    // run_task ↔ drive/session_stop 串行链（评审轮 1 [1]）：同批/跨批并发派发下
    // 双向门控检查都存在 await 间隙，串行化让前者状态先可见再检查
    dispatch: createMutatingDispatchChain((request, signal) =>
      request.method === "drive" || request.method === "session_stop"
        ? driveGateway(request, signal)
        : m1Gateway(request, signal),
    ),
    log,
  });
  bridgeRuntime.start();

  // SW 被杀恢复：非终态 journal 且无活 run → interrupted（README 决策 5：不续跑）
  void recoverInterruptedRuns(storage, runManager);
  // 排队兜底（#37 D3）：SW 死亡丢失内存 drain 定时器——重启时 queued→cancelled
  // （无人值守自动起跑撞权限卡模型不可接受，与「run 不续跑」同构）
  void sessionRepo
    .cancelAllQueued()
    .then((n) => {
      if (n > 0) log(`queue boot-cancelled: ${n} turns`);
    })
    .catch((e: unknown) =>
      log(`queue boot-cancel failed: ${e instanceof Error ? e.message : String(e)}`),
    );

  // —— boot 唯一 await 点（尾部；失败降级内存空库——评审轮 1 [13]）——
  let store: SkillStore;
  let dbOk = true;
  try {
    store = new SkillStore(await openSkillDb(globalThis.indexedDB));
  } catch (e) {
    log(`skill db unavailable, skills disabled: ${e instanceof Error ? e.message : String(e)}`);
    store = new SkillStore(memorySkillDb());
    dbOk = false;
  }
  skillRefs.store = store;
  // built-in 刷新（fetch 打包清单 → upsert；失败只记日志——skill 是可选增强；
  //  内部 try/catch 恒 settle，可安全作 ExtensionSkillSource 的 ready gate）
  if (dbOk) skillRefs.ready = refreshBuiltins(store);

  // 蒸馏 worker 就位（skill store 依赖尾部 await——故此处构造）+ boot 兜底 drain
  // （SW 被杀时队列里未 ack 的 job 由本次唤醒续跑，D9）
  distillWorkerRef = new DistillWorker({
    queue: distillQueue,
    settingsStore,
    llmFactory: (card) => new LLMClient(card, { log: (m) => log(`[distill-llm] ${m}`) }) as never,
    makeSkillSource: () => {
      const s = skillRefs.store;
      if (s === null) throw new Error("skill store not ready");
      return new ExtensionSkillSource(s, log, skillRefs.ready);
    },
    skillStore: store,
    keepalive,
    // 蒸馏完成广播（D11：sidepanel 轻提示 / options 审阅入口）+ 日志面
    notify: (count) => {
      log(`distill: ${count} 张草稿待审（options 审阅）`);
      portServerRef?.broadcast({ kind: "skill-drafts", count });
    },
    // 过程状态拍（issue #9 D3）：running/done/failed → distill-status 广播
    onPhase: (phase, detail) => {
      portServerRef?.broadcast({
        kind: "distill-status",
        phase,
        ...(detail !== undefined ? { detail } : {}),
      });
    },
    activeCard: (settings) => activeProviderCard(settings),
    log,
  });
  kickDistill();

  log("SW booted (segment D runtime)");
  // issue #9 D1：采纳/丢弃后的计数广播（boot 闭包自查 listDrafts——通知失败只记
  //  日志，不得改变 op 结果；与 worker 的 notify(count) 是两处薄实现，不强行抽象）
  const notifyDrafts = async (): Promise<void> => {
    try {
      const n = (await store.listDrafts()).length;
      log(`drafts: ${n} 张待审（options 审阅）`);
      portServerRef?.broadcast({ kind: "skill-drafts", count: n });
    } catch (e) {
      log(`drafts notify failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return {
    runManager,
    skillStore: store,
    options: { settingsStore, grantStore, skillStore: store, notifyDrafts },
    session: {
      repo: sessionRepo,
      // session-updated 广播（自吞异常——通知失败不改变 op 结果，notifyDrafts 同款）
      notifyUpdated: (sessionId, reason) => {
        try {
          portServerRef?.broadcast({ kind: "session-updated", sessionId, reason });
        } catch (e) {
          log(`session notify failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      // 排队受理（#37 批 A）：入队即尝试出队/节流续播都在 run-manager 队列器
      queue: {
        add: (sessionId, task) => runManager.queueFollowUp(sessionId, task),
        remove: (sessionId, turnId) => runManager.queueRemove(sessionId, turnId),
      },
      // 目标条（#37 批 C）：现查目标 tab URL / session-focus 激活
      targetUrlOf: async (tabId) => {
        if (tabId <= 0) return null;
        try {
          const tabs = await chromeTabsQuery().query({});
          return tabs.find((t) => t.id === tabId)?.url ?? null;
        } catch {
          return null;
        }
      },
      focusTab: async (tabId) => {
        if (tabId <= 0) return false;
        try {
          await browser.tabs.update(tabId, { active: true });
          return true;
        } catch {
          return false;
        }
      },
    },
  };
}

/** built-in 刷新（fetch 打包清单 → upsert；失败只记日志——skill 是可选增强） */
async function refreshBuiltins(store: SkillStore): Promise<void> {
  try {
    // SW 的 location.href 即扩展根（chrome-extension://<id>/…）——相对解析免 API
    const url = new URL("domain-skills.json", globalThis.location.href).href;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
    const manifest = (await res.json()) as BuiltinsManifest;
    const written = await store.refreshBuiltins(manifest);
    log(`skills refreshed: ${written} cards upserted`);
  } catch (e) {
    log(`skills refresh failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 读全部 tc_runUi:<tabId> 快照 → 非终态恢复为 interrupted */
async function recoverInterruptedRuns(
  storage: ReturnType<typeof chromeStorageLocal>,
  runManager: RunManager,
): Promise<void> {
  try {
    const items = await storage.get(null);
    for (const [key, value] of Object.entries(items)) {
      if (!key.startsWith("tc_runUi:")) continue;
      runManager.recoverInterrupted(value as RunJournalSnapshot);
    }
  } catch (e) {
    log(`journal recover failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
