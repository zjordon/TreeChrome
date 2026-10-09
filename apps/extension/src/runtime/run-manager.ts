// run-manager（m5/04 §9）：run 生命周期状态机。单飞互斥（同 tab 仅一活 run；跨
// tab 起跑拒绝）；start = 绑活动 tab → 热读 settings → 装配（assemble）→
// agent.run（keepAlive 语义——finally 只 stop 自建连接，不关用户浏览器）；stop/
// pause/resume 接 core Agent.stop()/pause()/resume()；绑定 tab onRemoved → abort
// （interrupted）；SW 被杀 → 初始化时读 journal 非终态且无活 run → interrupted
// （不做消息历史 checkpoint 续跑——README 决策 5，续跑能力后置登记）。

import type { AgentHistoryList, CdpTransport, EventBus, GrantStore, SkillSource } from "@tw/core";
import type { RunJournalSnapshot, SwToUiMessage, UiToSwMessage } from "@tw/protocol";
import type { AttachmentRegistry } from "../host/attachment-registry.js";
import type { TabsOnRemovedApi, TabsQueryApi } from "../host/chrome-apis.js";
import type { KeepaliveController } from "../host/keepalive.js";
import type { OpfsFs } from "../host/opfs-fs.js";
import type { SettingsStore } from "../host/settings-store.js";
import { type AssembledRun, assembleRun } from "./assemble.js";
import { EventForwarder } from "./event-forwarder.js";
import type { RunJournal } from "./journal.js";
import { SidepanelPolicyBridge } from "./policy-bridge.js";

export type ControlResult = { ok: true } | { ok: false; error: string };

export interface RunManagerDeps {
  settingsStore: SettingsStore;
  attachments: AttachmentRegistry;
  journal: RunJournal;
  fs: OpfsFs;
  keepalive: KeepaliveController;
  tabsQuery: TabsQueryApi;
  tabsOnRemoved: TabsOnRemovedApi;
  /** cdp-chrome 工厂（绑 tabId） */
  transportFactoryFor: (tabId: number) => () => Promise<CdpTransport>;
  /** skill 源（每 run 新实例——缓存不跨 run） */
  makeSkillSource: () => SkillSource;
  grantStore: GrantStore | null;
  /** 广播与端口态（port-server 注入） */
  broadcast: (message: SwToUiMessage) => void;
  hasPorts: () => boolean;
  /** LLM 构造面（测试注入 mock） */
  llmFactory?: import("./assemble.js").AssembleDeps["llmFactory"];
  /** 装配覆盖缝（缺省 assembleRun；状态机单测注入 stub agent） */
  assemble?: typeof assembleRun;
  now?: () => number;
  newRunId?: () => string;
  log?: (message: string) => void;
}
interface ActiveRun {
  runId: string;
  tabId: number;
  agent: {
    run: () => Promise<AgentHistoryList>;
    stop: () => void;
    pause: () => void;
    resume: () => void;
  };
  browser: { stop: () => Promise<void> };
  bus: EventBus;
  bridge: SidepanelPolicyBridge;
  /** stop 请求来源标记（终态判定：interrupted vs done） */
  interruptReason: string | null;
  onTabRemoved: (tabId: number) => void;
}

/** 终态集合（awaiting-* 是挂起态可回 running） */
const TERMINAL: readonly string[] = ["done", "error", "interrupted"];

export class RunManager {
  private readonly deps: RunManagerDeps;
  private active: ActiveRun | null = null;
  private readonly now: () => number;

  constructor(deps: RunManagerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  get busy(): boolean {
    return this.active !== null;
  }

  /** Port hello 载荷（无活 run → null/null；活 run → journal 快照） */
  hello(): { runId: string | null; snapshot: RunJournalSnapshot | null } {
    return { runId: this.deps.journal.runId, snapshot: this.deps.journal.current() };
  }

  /** UI 消息分发（port-server onUiMessage 接线） */
  handleUiMessage(message: UiToSwMessage): void {
    switch (message.kind) {
      case "journal-ack":
        this.deps.journal.ack(message.seq);
        return;
      case "permission-resolve":
        this.active?.bridge.resolvePermission(message.token, message.verdict);
        return;
      case "submit-resolve":
        this.active?.bridge.resolveSubmit(message.token, message.approved);
        return;
      case "control":
        void this.control(message.action, message.task)
          .then((r) => {
            if (!r.ok) this.deps.log?.(`control ${message.action} rejected: ${r.error}`);
          })
          .catch((e: unknown) => {
            this.deps.log?.(
              `control ${message.action} failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          });
        return;
      case "attachment-add":
        this.addAttachment(message.name, message.mimeType, message.base64);
        return;
      case "attachment-remove":
        this.deps.attachments.remove(message.attachmentId);
        this.deps.broadcast({ kind: "attachments", items: this.deps.attachments.list() });
        return;
      case "settings-changed":
        return; // 热读面：每次 start 前 load——运行中不换卡（run 装配一次性）
      case "diag":
        return;
    }
  }

  private addAttachment(name: string, mimeType: string, base64: string): void {
    const result = this.deps.attachments.add(base64, name, mimeType);
    if (!result.ok) {
      this.deps.log?.(`attachment rejected: ${result.reason} (${result.size} > ${result.limit})`);
      return;
    }
    this.deps.broadcast({ kind: "attachments", items: this.deps.attachments.list() });
  }

  /** control 面（start/stop/pause/resume）；拒绝文案直回 UI 层呈现 */
  async control(
    action: "start" | "stop" | "pause" | "resume",
    task?: string,
  ): Promise<ControlResult> {
    if (action === "start") return this.start(task ?? "");
    const active = this.active;
    if (active === null) return { ok: false, error: "当前没有运行中的任务" };
    if (action === "stop") {
      active.interruptReason = "用户中断";
      active.agent.stop();
      return { ok: true };
    }
    if (action === "pause") {
      active.agent.pause();
      return { ok: true };
    }
    active.agent.resume();
    return { ok: true };
  }

  private async start(task: string): Promise<ControlResult> {
    if (this.active !== null) {
      return { ok: false, error: "请先停止当前任务" };
    }
    if (task.trim() === "") {
      return { ok: false, error: "任务不能为空" };
    }
    let tabId: number | undefined;
    try {
      // headless/SW 语境 currentWindow 可能为空（无聚焦窗口）——降级链：
      // currentWindow → lastFocusedWindow → 任意窗口的 active tab
      let tabs = await this.deps.tabsQuery.query({ active: true, currentWindow: true });
      if (tabs.length === 0) {
        tabs = await this.deps.tabsQuery.query({ active: true, lastFocusedWindow: true });
      }
      if (tabs.length === 0) tabs = await this.deps.tabsQuery.query({ active: true });
      tabId = tabs[0]?.id;
    } catch {
      tabId = undefined;
    }
    if (tabId === undefined) {
      return { ok: false, error: "找不到活动标签页" };
    }
    const settings = await this.deps.settingsStore.load();
    const runId = this.deps.newRunId?.() ?? `run_${Date.now().toString(16)}`;
    // 确认卡桥先建（journal/broadcast/端口态均已就绪——桥只在请求时点读写 journal，
    // 不要求 begin 已发生）；装配带门 → begin → forwarder 接线（首事件前快照在位）
    const bridge = new SidepanelPolicyBridge({
      journal: this.deps.journal,
      broadcast: this.deps.broadcast,
      hasPorts: this.deps.hasPorts,
      runTabId: tabId,
    });
    let assembled: AssembledRun | undefined;
    const assembleFn = this.deps.assemble ?? assembleRun;
    try {
      assembled = assembleFn(
        { task, tabId, settings },
        {
          transportFactory: this.deps.transportFactoryFor(tabId),
          fs: this.deps.fs,
          attachments: this.deps.attachments,
          skillSource: this.deps.makeSkillSource(),
          policyInteraction: bridge.interaction,
          grantStore: this.deps.grantStore,
          ...(this.deps.llmFactory !== undefined ? { llmFactory: this.deps.llmFactory } : {}),
          log: this.deps.log,
        },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    this.deps.journal.begin({
      runId,
      tabId,
      task: assembled.taskText,
      attachments: this.deps.attachments.list(),
    });
    const forwarder = new EventForwarder(assembled.bus, this.deps.journal, this.deps.broadcast);
    forwarder.start();

    const onTabRemoved = (removed: number): void => {
      if (removed === tabId && this.active !== null) {
        this.active.interruptReason = "绑定标签页被关闭";
        this.active.agent.stop();
      }
    };
    this.deps.tabsOnRemoved.addListener(onTabRemoved);
    this.deps.keepalive.onStartRun();

    const active: ActiveRun = {
      runId,
      tabId,
      agent: assembled.agent,
      browser: assembled.browser,
      bus: assembled.bus,
      bridge,
      interruptReason: null,
      onTabRemoved,
    };
    this.active = active;
    this.deps.log?.(`run started: ${runId} (tab ${tabId})`);

    void this.drive(active);
    return { ok: true };
  }

  /** run 驱动与终态收口（fire-and-forget；异常全吞在 journal 终态里） */
  private async drive(active: ActiveRun): Promise<void> {
    const journal = this.deps.journal;
    try {
      const history = await active.agent.run();
      if (active.interruptReason !== null) {
        journal.setStatus("interrupted", {
          endedAt: this.now(),
          lastError: active.interruptReason,
          isDone: history.isDone(),
        });
      } else {
        journal.setStatus("done", {
          endedAt: this.now(),
          finalResult: history.finalResult(),
          isDone: history.isDone(),
          isSuccessful: history.isSuccessful(),
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const interrupted = active.interruptReason !== null || isConnectionLost(e);
      journal.setStatus(interrupted ? "interrupted" : "error", {
        endedAt: this.now(),
        lastError: active.interruptReason ?? message,
      });
    } finally {
      this.deps.tabsOnRemoved.removeListener(active.onTabRemoved);
      this.deps.keepalive.onEndRun();
      this.deps.attachments.clearForRun();
      try {
        active.bus.close();
      } catch {
        // 清理路径不抛
      }
      try {
        await active.browser.stop();
      } catch {
        // 清理路径不抛（连接已断时的二次 stop）
      }
      this.active = null;
      // 终态广播（sidepanel 收 journal-snapshot 收口视图）
      const snapshot = journal.current();
      if (snapshot !== null) this.deps.broadcast({ kind: "journal-snapshot", snapshot });
      this.deps.log?.(`run ended: ${active.runId} (${journal.status ?? "?"})`);
    }
  }

  /** 全部端口断连（port-server 回调——活跃桥收口未决确认 fail-closed） */
  onAllPortsDisconnected(): void {
    this.active?.bridge.onAllPortsDisconnected();
  }

  /** SW 重启恢复：非终态快照且无活 run → interrupted（SW 被杀即终态——不续跑） */
  recoverInterrupted(snapshot: RunJournalSnapshot | null): void {
    if (this.active !== null) return;
    if (snapshot === null) return;
    if (TERMINAL.includes(snapshot.status)) return;
    this.deps.journal.restore(snapshot);
    this.deps.journal.setStatus("interrupted", {
      endedAt: this.now(),
      lastError: "Service worker was killed during the run",
    });
    const updated = this.deps.journal.current();
    if (updated !== null) this.deps.broadcast({ kind: "journal-snapshot", snapshot: updated });
  }
}

function isConnectionLost(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    msg.includes("websocket connection closed") ||
    msg.includes("connection closed") ||
    msg.includes("connection reset") ||
    msg.includes("debugger detach") ||
    msg.includes("detached") ||
    msg.includes("browser has been closed")
  );
}
