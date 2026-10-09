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
import type { OptionsOp, ProviderCardDto, RunJournalSnapshot, UiDiagMessage } from "@tw/protocol";
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { AttachmentRegistry } from "../src/host/attachment-registry.js";
import {
  chromeAlarms,
  chromeOnConnect,
  chromeOnInstalled,
  chromeStorageLocal,
  chromeTabsOnRemoved,
  chromeTabsQuery,
} from "../src/host/chrome-apis.js";
import { makeDebuggerTransportFactory } from "../src/host/debugger-api.js";
import { ChromeGrantStore } from "../src/host/grant-store.js";
import { KeepaliveController } from "../src/host/keepalive.js";
import { OpfsFs } from "../src/host/opfs-fs.js";
import { parseExtensionSettings, SettingsStore } from "../src/host/settings-store.js";
import { ExtensionSkillSource } from "../src/host/skill-source.js";
import {
  type BuiltinsManifest,
  openSkillDb,
  type SkillDb,
  SkillStore,
} from "../src/host/skill-store.js";
import { DebounceScheduler, RunJournal } from "../src/runtime/journal.js";
import { registerMessageRouter } from "../src/runtime/message-router.js";
import { createMutationQueue } from "../src/runtime/mutation-queue.js";
import { PortServer } from "../src/runtime/port-server.js";
import { RunManager } from "../src/runtime/run-manager.js";

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

  const bootPromise = boot();
  bootPromise.catch((e: unknown) => {
    console.error(`[tc] boot failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  });
});

interface Booted {
  runManager: RunManager;
  skillStore: SkillStore;
  /** options 请求-应答面（段 E） */
  options: OptionsFace;
}

/** options 面（段 E）：settings 读写 / grants 列举撤销 / skills 列举 / 端点测试 */
interface OptionsFace {
  settingsStore: SettingsStore;
  grantStore: ChromeGrantStore;
  skillStore: SkillStore;
}

/** options 请求处理（全路径 fail-soft：异常/坏载荷回 {ok:false,error} 不炸通道） */
const grantsMutation = createMutationQueue();

async function handleOptionsRequest(
  op: OptionsOp,
  payload: unknown,
  face: OptionsFace,
): Promise<unknown> {
  try {
    switch (op) {
      case "get-settings":
        return { ok: true, settings: await face.settingsStore.load() };
      case "save-settings":
        // 宽松收窄再落盘（单一写者=SW——UI 不直碰 chrome.storage，避免双端竞态）
        await face.settingsStore.save(parseExtensionSettings(payload));
        return { ok: true };
      case "list-grants":
        return { ok: true, grants: await face.grantStore.loadAlways() };
      case "revoke-grant": {
        const p = payload as { capability?: unknown; host?: unknown } | null;
        if (
          p === null ||
          typeof p.capability !== "string" ||
          typeof p.host !== "string" ||
          p.capability === "" ||
          p.host === ""
        ) {
          return { ok: false, error: "revoke-grant 需要 {capability, host}" };
        }
        // 读-改-写串行化（评审轮 1 [12]）：两条 revoke 在 await 点交错时后写者
        // 以陈旧全量覆盖回——已撤销的授权复活且不再弹权限卡
        const removed = await grantsMutation(() =>
          (async () => {
            const grants = await face.grantStore.loadAlways();
            const kept = grants.filter(
              (g) => !(g.capability === p.capability && g.host === p.host),
            );
            await face.grantStore.saveAlways(kept);
            return grants.length - kept.length;
          })(),
        );
        return { ok: true, removed };
      }
      case "list-skills": {
        const cards = await face.skillStore.listAll();
        return {
          ok: true,
          cards: cards.map((c) => ({
            host: c.host,
            slug: c.slug,
            sourceType: c.provenance.sourceType,
            updatedAt: c.updatedAt,
            ...(c.distilledAt !== undefined ? { distilledAt: c.distilledAt } : {}),
          })),
        };
      }
      case "test-card": {
        const card = payload as ProviderCardDto | null;
        if (
          card === null ||
          typeof card.baseUrl !== "string" ||
          !/^https?:\/\//.test(card.baseUrl)
        ) {
          return { ok: false, message: "baseUrl 形态不合法" };
        }
        // 可达性探测（非语义级验证）：任何 HTTP 应答即端点可达；5s 超时
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        try {
          const res = await fetch(card.baseUrl, { method: "GET", signal: ctrl.signal });
          return { ok: true, message: `HTTP ${res.status}（端点可达）` };
        } catch (e) {
          return { ok: false, message: e instanceof Error ? e.message : String(e) };
        } finally {
          clearTimeout(timer);
        }
      }
      default:
        return { ok: false, error: `未知操作：${op}` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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

  // 广播/端口态闭包晚绑定（portServer 在 runManager 之后构造——双向引用经 holder 收口）
  let portServerRef: PortServer | null = null;
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
    log,
  });
  portServerRef = new PortServer(chromeOnConnect(), {
    hello: () => runManager.hello(),
    onUiMessage: (message) => runManager.handleUiMessage(message),
    onAllPortsDisconnected: () => runManager.onAllPortsDisconnected(),
    pendingCards: () => runManager.pendingCards(),
  });
  chromeOnInstalled().addListener((details: unknown) => {
    const reason = (details as { reason?: unknown } | null)?.reason;
    if (reason === "install" || reason === "update") void refreshSkills();
  });

  // SW 被杀恢复：非终态 journal 且无活 run → interrupted（README 决策 5：不续跑）
  void recoverInterruptedRuns(storage, runManager);

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

  log("SW booted (segment D runtime)");
  return {
    runManager,
    skillStore: store,
    options: { settingsStore, grantStore, skillStore: store },
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
