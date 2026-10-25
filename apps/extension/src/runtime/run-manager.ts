// run-manager（m5/04 §9）：run 生命周期状态机。单飞互斥（同 tab 仅一活 run；跨
// tab 起跑拒绝）；start = 绑活动 tab → 热读 settings → 装配（assemble）→
// agent.run（keepAlive 语义——finally 只 stop 自建连接，不关用户浏览器）；stop/
// pause/resume 接 core Agent.stop()/pause()/resume()；绑定 tab onRemoved → abort
// （interrupted）；SW 被杀 → 初始化时读 journal 非终态且无活 run → interrupted
// （不做消息历史 checkpoint 续跑——README 决策 5，续跑能力后置登记）。

import {
  type AgentHistoryList,
  type CdpTransport,
  clipTraceTail,
  DISTILL_TRACE_MAX_CHARS,
  dominantHostOf,
  type EventBus,
  type GrantStore,
  gateFailureReason,
  redactSensitiveString,
  type SkillSource,
  serializeTraceForPrompt,
} from "@tw/core";
import type { RunJournalSnapshot, SwToUiMessage, UiToSwMessage } from "@tw/protocol";
import type { AttachmentRegistry } from "../host/attachment-registry.js";
import type { TabsOnRemovedApi, TabsQueryApi } from "../host/chrome-apis.js";
import type { KeepaliveController } from "../host/keepalive.js";
import type { OpfsFs } from "../host/opfs-fs.js";
import type { ExtensionSettings, SettingsStore } from "../host/settings-store.js";
import { selfEvolutionOf, sensitiveSpecsOf } from "../host/settings-store.js";
import { type AssembledRun, assembleRun } from "./assemble.js";
import type { DistillJobInput } from "./distill-queue.js";
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
  /** 蒸馏入队面（issue #5 S4；不注入 = 不蒸馏——旧装配/单测兼容）。
   *  enqueue/kick 均在 run 终态收口后调用（D9 异步语义） */
  distill?: {
    enqueue: (job: DistillJobInput) => Promise<void>;
    kick: () => void;
  };
  now?: () => number;
  newRunId?: () => string;
  log?: (message: string) => void;
}
interface ActiveRun {
  runId: string;
  tabId: number;
  task: string;
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

/** sensitiveData 配置 → key→真值映射（core distill keyToReal 同口径——URL 过滤
 *  条目保守一律脱敏：蒸馏输入宁可过度占位） */
function secretsMapOf(settings: ExtensionSettings): Record<string, string> {
  const specs = sensitiveSpecsOf(settings);
  if (specs === null) return {};
  const out: Record<string, string> = {};
  for (const [key, spec] of Object.entries(specs)) {
    const real = typeof spec === "string" ? spec : (spec.value ?? "");
    if (real !== "") out[key] = real;
  }
  return out;
}

/** done 步 judgement（core JudgementResult 形态，ActionResult 侧是 unknown）→
 *  快照持久化投影——收尾后可查证蒸馏门控依据 */
function narrowJudgement(j: unknown): RunJournalSnapshot["judgement"] {
  if (typeof j !== "object" || j === null) return null;
  const r = j as Record<string, unknown>;
  return {
    verdict: r.verdict === true,
    reasoning: typeof r.reasoning === "string" ? r.reasoning : null,
    failureReason: typeof r.failureReason === "string" ? r.failureReason : null,
  };
}

/** commit 彻底未知（pending 已被超时/错位清理）时的 lost 拒绝占位——UI 按
 *  transferId 用本地传输记录补全展示 */
const LOST_PLACEHOLDER = { name: "（未知附件）", mimeType: "", size: 0 } as const;

/** 停跑原因中文映射（issue #10 D6：done 终态 isDone=false 时进 lastError——
 *  FinalResult 既有红字渲染面直接生效，零协议改动。2026-10-25 HTTP 401 实测：
 *  此前 UI 仅「✗ 未成功」无任何解释） */
const STOP_REASON_TEXT: Record<string, string> = {
  max_steps: "已达最大步数上限——任务未完成",
  max_consecutive_failures: "连续失败达到上限——常见原因：模型输出持续不可解析或动作持续报错",
  max_infra_failures: "LLM 基建失败达到上限——常见原因：API key 失效/网络不通/端点不可达",
  history_degraded: "历史记录连续降级（finalize 异常）——轨迹不完整",
};

function stopReasonText(reason: string | null): string {
  return reason !== null && STOP_REASON_TEXT[reason] !== undefined
    ? STOP_REASON_TEXT[reason]
    : "任务未完成（未知停跑原因）";
}

export class RunManager {
  private readonly deps: RunManagerDeps;
  private active: ActiveRun | null = null;
  /** 起跑互斥（评审轮 1 [8]）：判空与置 active 之间有 await 间隙——双击/双面板
   *  并发 start 会穿透单飞互斥，starting 标志在首个 await 前同步占位 */
  private starting = false;
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
      case "attachment-begin":
        this.beginAttachment(message.transferId, message.name, message.mimeType, message.size);
        return;
      case "attachment-chunk":
        // 错位/越界/未知 transferId → registry 废整条 pending；此处只留痕不广播
        //（UI 侧靠 commit 的 lost 拒绝收口，避免中间态噪音）
        if (!this.deps.attachments.append(message.transferId, message.offset, message.data)) {
          this.deps.log?.(`attachment chunk dropped: ${message.transferId}@${message.offset}`);
        }
        return;
      case "attachment-commit": {
        const r = this.deps.attachments.commit(message.transferId);
        if (r.ok) {
          this.broadcastAttachments();
        } else {
          this.deps.broadcast({
            kind: "attachment-rejected",
            rejection: {
              transferId: message.transferId,
              ...(r.meta ?? LOST_PLACEHOLDER),
              reason: "lost",
              limit: 0,
            },
          });
        }
        return;
      }
      case "attachment-abort":
        this.deps.attachments.abort(message.transferId);
        return;
      case "attachment-remove":
        this.deps.attachments.remove(message.attachmentId);
        this.broadcastAttachments();
        return;
      case "settings-changed":
        return; // 热读面：每次 start 前 load——运行中不换卡（run 装配一次性）
      case "options":
        return; // options 是 sendMessage 单发应答面（message-router 分发）——Port 不受理
      case "diag":
        return;
    }
  }

  /** begin 预检：通过 → begun 回执（UI 才开始发块）；拒绝 → 明细广播 UI 展示 */
  private beginAttachment(transferId: string, name: string, mimeType: string, size: number): void {
    const result = this.deps.attachments.begin(transferId, name, mimeType, size);
    if (result.ok) {
      this.deps.broadcast({ kind: "attachment-begun", transferId });
      return;
    }
    this.deps.log?.(`attachment rejected: ${result.reason} (${result.size} > ${result.limit})`);
    this.deps.broadcast({
      kind: "attachment-rejected",
      rejection: {
        transferId,
        // 信封层只校验 kind——字段以 unknown 形态可达，非数 size 归 0 展示
        name: typeof name === "string" ? name : "",
        mimeType: typeof mimeType === "string" ? mimeType : "",
        size: typeof size === "number" && Number.isSafeInteger(size) && size > 0 ? size : 0,
        reason: result.reason,
        limit: result.limit,
      },
    });
  }

  /** attachments 广播（items + budget 预算投影——UI 余量呈现的单一来源） */
  private broadcastAttachments(): void {
    this.deps.broadcast({
      kind: "attachments",
      items: this.deps.attachments.list(),
      budget: this.deps.attachments.budget(),
    });
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
      // agent.stop() 只置标志位——挂在桥 pending 上的 run 要等收口才解除（最长
      // 300s gate 兜底），此处同步 deny 未决确认（评审轮 1 [17]）
      active.bridge.cancelAll();
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
    if (this.active !== null || this.starting) {
      return { ok: false, error: "请先停止当前任务" };
    }
    this.starting = true;
    try {
      return await this.startInner(task);
    } finally {
      this.starting = false;
    }
  }

  private async startInner(task: string): Promise<ControlResult> {
    if (task.trim() === "") {
      return { ok: false, error: "任务不能为空" };
    }
    // issue #11 D3 附件起跑守卫：任务文本指涉附件但注册表为空（SW 被杀丢内存态 /
    // 上一轮 clearForRun 清表）→ 拒绝起跑给可行动提示——否则任务文本无 [Attachments]
    // 段，模型瞎猜文件路径空烧 ~10 步（2026-10-25 实录）。误报（如反向表述）成本低：
    // 附加文件或改措辞即可
    if (/附件|attachment:/i.test(task) && this.deps.attachments.list().length === 0) {
      return {
        ok: false,
        error: "任务提到附件但附件列表为空——请先在下方附加文件（浏览器重启或上一轮结束会清空附件）",
      };
    }
    let tabId: number | undefined;
    let sawRestricted = false;
    try {
      // headless/SW 语境 currentWindow 可能为空（无聚焦窗口）——降级链：
      // currentWindow → lastFocusedWindow → 任意窗口的 active tab；每级先取可
      // 驱动页（http/https）——chrome:// 等内部页面 chrome.debugger 拒绝附着
      // （段 F 验收：在 chrome://extensions 重载扩展后直接开跑即
      // "Cannot access a chrome:// URL"）。url 不可读（权限缺失/注入测试）时
      // 保持原行为（不判形态）
      let tabs = await this.deps.tabsQuery.query({ active: true, currentWindow: true });
      let pick = drivableOf(tabs);
      if (pick === undefined) {
        tabs = await this.deps.tabsQuery.query({ active: true, lastFocusedWindow: true });
        pick = drivableOf(tabs);
      }
      if (pick === undefined) tabs = await this.deps.tabsQuery.query({ active: true });
      sawRestricted = tabs.some((t) => t.url !== undefined && !isDrivableUrl(t.url));
      tabId = pick?.id ?? drivableOf(tabs)?.id;
    } catch {
      tabId = undefined;
    }
    if (tabId === undefined) {
      return sawRestricted
        ? {
            ok: false,
            error:
              "当前活动标签页是浏览器内部页面（chrome:// 等）无法被驱动——请切换到普通网页标签页后再开始",
          }
        : { ok: false, error: "找不到活动标签页" };
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
    // 起始快照广播（评审轮 1 [6]）：journal.begin 重置 seq——不广播则保持连接的
    // UI 侧 seq 去重把新 run 事件全部判为旧 run 补发重复而丢弃
    const startSnapshot = this.deps.journal.current();
    if (startSnapshot !== null) {
      this.deps.broadcast({ kind: "journal-snapshot", snapshot: startSnapshot });
    }
    const forwarder = new EventForwarder(assembled.bus, this.deps.journal, this.deps.broadcast);
    forwarder.start();

    // 监听器闭包捕获本 run 引用（评审轮 1 [10]）：操作 active 自身而非
    // this.active——后者可能被并发路径覆盖（防御纵深，配合 starting 互斥）
    const active: ActiveRun = {
      runId,
      tabId,
      task,
      agent: assembled.agent,
      browser: assembled.browser,
      bus: assembled.bus,
      bridge,
      interruptReason: null,
      onTabRemoved: () => {},
    };
    active.onTabRemoved = (removed: number): void => {
      if (removed !== tabId) return;
      active.interruptReason = "绑定标签页被关闭";
      active.agent.stop();
      active.bridge.cancelAll();
    };
    this.deps.tabsOnRemoved.addListener(active.onTabRemoved);
    this.deps.keepalive.onStartRun();

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
          // issue #10 D6：非 done 收口带停跑原因（isDone=true 时恒 null——
          // lastError 语义保持「终态失败解释」单一职责）
          lastError: history.isDone() ? null : stopReasonText(history.stopReason),
          judgement: narrowJudgement(
            history.history[history.history.length - 1]?.result.find((r) => r.isDone)?.judgement,
          ),
        });
        // issue #5 S4：done 分支门控入队（D1/D9——异步增强，失败/异常均不影响
        // run 终态已收口的事实）
        await this.enqueueDistill(active, history);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const interrupted = active.interruptReason !== null || isConnectionLost(e);
      // Chrome 原生拒绝附着内部页面——换用户可行动文案（段 F 验收反馈）
      const userFacing = message.includes("Cannot access a chrome:// URL")
        ? "无法驱动浏览器内部页面（chrome://）——请切换到普通网页标签页后重试"
        : message;
      journal.setStatus(interrupted ? "interrupted" : "error", {
        endedAt: this.now(),
        lastError: active.interruptReason ?? userFacing,
      });
    } finally {
      // 兜底收口（agent 异常路径可能残留未决确认——deny 后 promise 才不泄漏）
      active.bridge.cancelAll();
      this.deps.tabsOnRemoved.removeListener(active.onTabRemoved);
      this.deps.keepalive.onEndRun();
      this.deps.attachments.clearForRun();
      // 清表广播（评审轮 1 [16]）：add/remove 均广播，clear 静默会让已连接
      // sidepanel 的附件视图与注册表失同步（下一 run 静默丢附件）
      this.broadcastAttachments();
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
      // 身份校验（评审轮 1 [9]）：防御纵深——只清自己的控制引用
      if (this.active === active) {
        this.active = null;
      }
      // 终态广播（sidepanel 收 journal-snapshot 收口视图）
      const snapshot = journal.current();
      if (snapshot !== null) this.deps.broadcast({ kind: "journal-snapshot", snapshot });
      this.deps.log?.(`run ended: ${active.runId} (${journal.status ?? "?"})`);
      // 失败原因进 SW 控制台（段 F 验收反馈：lastError 原先只在 storage 快照里）
      if (
        journal.status === "error" ||
        (journal.status === "interrupted" && snapshot?.lastError !== null)
      ) {
        this.deps.log?.(`run failed: ${snapshot?.lastError ?? "unknown"}`);
      }
    }
  }

  /**
   * 蒸馏门控入队（issue #5 S4，D1/D3/D9）：selfEvolution 开 → 门控（done(success)
   *  + judge verdict）→ host 多数票 → 序列化+敏感占位脱敏+尾部截断 → 入队 → kick。
   *  每步不过即静默跳过（日志）——蒸馏是可选增强，任何失败不影响 run 终态。
   */
  private async enqueueDistill(active: ActiveRun, history: AgentHistoryList): Promise<void> {
    const distill = this.deps.distill;
    if (distill === undefined) return;
    try {
      const settings = await this.deps.settingsStore.load();
      if (!selfEvolutionOf(settings).enabled) return;
      // issue #10 D4：归因单源（core gateFailureReason 三态）——judgement=null
      //（未执行/调用失败）与 verdict=false（复核拒绝）不再混为一句
      const gateReason = gateFailureReason(history);
      if (gateReason !== null) {
        this.deps.log?.(`distill: 门控未过——${gateReason}`);
        return;
      }
      const host = dominantHostOf(history);
      if (host === null) {
        this.deps.log?.("distill: 轨迹无 http URL，无法判定 host——跳过");
        return;
      }
      const traceRaw = serializeTraceForPrompt(history);
      if (traceRaw === "") return;
      const secrets = secretsMapOf(settings);
      const hasSecrets = Object.keys(secrets).length > 0;
      const traceText = clipTraceTail(
        hasSecrets ? redactSensitiveString(traceRaw, secrets) : traceRaw,
        DISTILL_TRACE_MAX_CHARS,
      );
      const task = hasSecrets ? redactSensitiveString(active.task, secrets) : active.task;
      await distill.enqueue({
        runId: active.runId,
        task,
        host,
        traceText,
        stepCount: history.history.length,
      });
      // issue #9 D3：入队成功即广播 queued——run 结束到 worker 开跑之间的空窗可见
      //（matcher+蒸馏两次串行慢调用实测 ~4 分钟，此前零状态提示）
      this.deps.broadcast({ kind: "distill-status", phase: "queued" });
      distill.kick();
    } catch (e) {
      this.deps.log?.(
        `distill: 入队失败（不影响 run）——${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** 全部端口断连（port-server 回调——活跃桥收口未决确认 fail-closed） */
  onAllPortsDisconnected(): void {
    this.active?.bridge.onAllPortsDisconnected();
  }

  /** 未决确认卡（port-server 重连补发面） */
  pendingCards(): SwToUiMessage[] {
    return this.active?.bridge.pendingCards() ?? [];
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

/** 可驱动 URL 判定：http/https（chrome://、edge://、about:、devtools:// 等
 *  内部页面 chrome.debugger 拒绝附着）；url 未知（undefined）不判形态 */
function isDrivableUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

function drivableOf(
  tabs: Array<{ id: number | undefined; url?: string }>,
): { id: number | undefined; url?: string } | undefined {
  return tabs.find((t) => t.url === undefined || isDrivableUrl(t.url));
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
