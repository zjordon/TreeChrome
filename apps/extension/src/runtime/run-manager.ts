// run-manager（m5/04 §9）：run 生命周期状态机。单飞互斥（同 tab 仅一活 run；跨
// tab 起跑拒绝）；start = 绑活动 tab → 热读 settings → 装配（assemble）→
// agent.run（keepAlive 语义——finally 只 stop 自建连接，不关用户浏览器）；stop/
// pause/resume 接 core Agent.stop()/pause()/resume()；绑定 tab onRemoved → abort
// （interrupted）；SW 被杀 → 初始化时读 journal 非终态且无活 run → interrupted
// （不做消息历史 checkpoint 续跑——README 决策 5，续跑能力后置登记）。
// issue #35 U1a：start 受理面挂会话模型——记 UserTurn（task 原文）、前情块拼接
// （continuity，core 零改动）、终态归档（journal 归档缓冲 → SessionRepository）；
// 全部 fail-soft（转录缺档可容忍，run 终态不可逆——D3）。

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
import type {
  AttachmentInfo,
  RunJournalSnapshot,
  SessionOrigin,
  SwToUiMessage,
  TerminalRunStatus,
  UiToSwMessage,
} from "@tw/protocol";
import type { AttachmentRegistry } from "../host/attachment-registry.js";
import type { TabsOnRemovedApi, TabsQueryApi } from "../host/chrome-apis.js";
import type { KeepaliveController } from "../host/keepalive.js";
import type { OpfsFs } from "../host/opfs-fs.js";
import type { ExtensionSettings, SettingsStore } from "../host/settings-store.js";
import { selfEvolutionOf, sensitiveSpecsOf } from "../host/settings-store.js";
import { type AssembledRun, assembleRun } from "./assemble.js";
import { buildContinuityBlock, type ContinuityTurn, withContinuity } from "./continuity.js";
import type { DistillJobInput } from "./distill-queue.js";
import { EventForwarder } from "./event-forwarder.js";
import type { RunJournal } from "./journal.js";
import { SidepanelPolicyBridge } from "./policy-bridge.js";
import {
  compressArchiveEvents,
  type RunArchiveInput,
  type SessionRepository,
  sumUsage,
} from "./session-repo.js";
import { pickActiveDrivableTab, tabByIdDrivable } from "./tab-pick.js";

export type ControlResult =
  | { ok: true }
  | { ok: false; error: string }
  /** 非失败的中止（排队出队面）：任务已不在队列（被撤销）——调用方立即试下一条，
   *  不计退避次数（#37 评审轮 1 [3][9]） */
  | { ok: false; error: string; skipped: true };

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
  /** 会话存储面（issue #35 U1a：缺省 null = 会话面禁用降级——旧单测兼容；
   *  background 生产装配必须注入，漏注入由 boot 日志确认） */
  sessions?: SessionRepository | null;
  /** 终态→排队续播的节流毫秒（#37 批 A：缺省 2000——测试注入小值） */
  drainDelayMs?: number;
  /** 出队被拒的退避重试毫秒（#37 评审轮 1 [9]：缺省 10s——测试注入小值） */
  drainRetryMs?: number;
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
  /** 会话归属（issue #35；null = 会话面禁用/写失败降级——run 照常） */
  sessionId: string | null;
  /** 本 run 的用户 turn（null = 未记上，终态归档跳过） */
  turnId: string | null;
  origin: SessionOrigin;
}

/** 终态集合（awaiting-* 是挂起态可回 running） */
const TERMINAL: readonly string[] = ["done", "error", "interrupted"];

/** 任务文本的附件指涉（起跑守卫 #11 D3 + 排队受理守卫 #37 评审轮 1 [9] 共用） */
const ATTACHMENT_REF_RE = /附件|attachment:/i;

/** 出队被拒的连续上限（#37 评审轮 1 [9]）：达到即头阻塞解除——头 turn 转
 *  cancelled + 广播，立即续试下一条（无新触发点的搁浅比丢失更糟） */
const QUEUE_DRAIN_MAX_ATTEMPTS = 3;

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
        void this.control(message.action, message.task, message.sessionId)
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
      case "session":
        return; // session 同为 sendMessage 单发应答面（session-handler）——Port 不受理
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

  /** control 面（start/stop/pause/resume + steer 预留）；拒绝文案直回 UI 层呈现。
   *  start 的 sessionId 缺省 = 续当前 tab 绑定会话（issue #35 U1 语义） */
  async control(
    action: "start" | "stop" | "pause" | "resume" | "steer",
    task?: string,
    sessionId?: string,
  ): Promise<ControlResult> {
    if (action === "steer") {
      // 协议预留（D6）：core 无 mid-run 注入——U2 排队面先行吸收，L2 远期提案
      return { ok: false, error: "运行中插话（steering）尚未支持——请等待本轮结束或停止后重发" };
    }
    if (action === "start") return this.start(task ?? "", { origin: "user", sessionId });
    const active = this.active;
    if (active === null) return { ok: false, error: "当前没有运行中的任务" };
    if (action === "stop") {
      active.interruptReason = "用户中断";
      active.agent.stop();
      // agent.stop() 只置标志位——挂在桥 pending 上的 run 要等收口才解除（最长
      // 300s gate 兜底），此处同步 deny 未决确认（评审轮 1 [17]）
      active.bridge.cancelAll();
      // 连播语义（#37 D2）：叫停的是这个会话的整个队列——排队 turns 标 cancelled；
      // 只清本会话 drain timer（评审轮 1 [2]：per-session 分区后他会话续播不受累）
      if (active.sessionId !== null) {
        this.clearDrainTimer(active.sessionId);
        void this.cancelQueue(active.sessionId);
      }
      return { ok: true };
    }
    if (action === "pause") {
      active.agent.pause();
      return { ok: true };
    }
    active.agent.resume();
    return { ok: true };
  }

  /** bridge run_task 受理面（issue #35：origin=bridge 进快照与会话——外部直驱标识） */
  startRun(task: string, origin: SessionOrigin): Promise<ControlResult> {
    return this.start(task, { origin });
  }

  private async start(
    task: string,
    options: {
      origin: SessionOrigin;
      sessionId?: string;
      queueTurnId?: string;
      /** 排队续播的会话绑定 tab（#37 评审轮 1 [10]）：显式指定时不走活动页挑选 */
      tabId?: number;
    },
  ): Promise<ControlResult> {
    if (this.active !== null || this.starting) {
      return { ok: false, error: "请先停止当前任务" };
    }
    this.starting = true;
    try {
      return await this.startInner(task, options);
    } finally {
      this.starting = false;
    }
  }

  private async startInner(
    task: string,
    options: {
      origin: SessionOrigin;
      sessionId?: string;
      queueTurnId?: string;
      tabId?: number;
    },
  ): Promise<ControlResult> {
    if (task.trim() === "") {
      return { ok: false, error: "任务不能为空" };
    }
    // issue #11 D3 附件起跑守卫：任务文本指涉附件但注册表为空（SW 被杀丢内存态 /
    // 上一轮 clearForRun 清表）→ 拒绝起跑给可行动提示——否则任务文本无 [Attachments]
    // 段，模型瞎猜文件路径空烧 ~10 步（2026-10-25 实录）。误报（如反向表述）成本低：
    // 附加文件或改措辞即可
    if (ATTACHMENT_REF_RE.test(task) && this.deps.attachments.list().length === 0) {
      return {
        ok: false,
        error: "任务提到附件但附件列表为空——请先在下方附加文件（浏览器重启或上一轮结束会清空附件）",
      };
    }
    let tabId: number | undefined;
    let sawRestricted = false;
    if (options.tabId !== undefined) {
      // 排队续播驱动会话绑定 tab（评审轮 1 [10]）：不抢用户当前活动页——绑定 tab
      // 即任务语境（GoalStrip/session-focus 同源）；已关/内部页 → 拒绝走重试面
      let check: Awaited<ReturnType<typeof tabByIdDrivable>>;
      try {
        check = await tabByIdDrivable(this.deps.tabsQuery, options.tabId);
      } catch {
        return { ok: false, error: "会话目标标签页查询失败" };
      }
      if (!check.ok) {
        return {
          ok: false,
          error:
            check.reason === "closed"
              ? "会话目标标签页已关闭——请重新打开后再试"
              : "会话目标标签页是浏览器内部页面（chrome:// 等）无法被驱动",
        };
      }
      tabId = options.tabId;
    } else {
      try {
        // 降级链挑选（issue #32 抽出 tab-pick 共享——drive-session 同款）：
        // currentWindow → lastFocusedWindow → 任意窗口 active；每级先取可驱动页
        // （http/https——chrome:// 等内部页 chrome.debugger 拒绝附着）
        const pick = await pickActiveDrivableTab(this.deps.tabsQuery);
        tabId = pick.tabId;
        sawRestricted = pick.sawRestricted;
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
    }
    const settings = await this.deps.settingsStore.load();
    const runId = this.deps.newRunId?.() ?? `run_${Date.now().toString(16)}`;
    // 会话解析 + 前情块（issue #35 U1a：fail-soft——失败回 null，run 照常无会话语义）
    const session = await this.resolveSession(tabId, task, options);
    const effectiveTask = withContinuity(task, session?.continuity ?? null);
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
        { task: effectiveTask, tabId, settings },
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
    // 排队激活前置（评审轮 1 [3]）：miss（出队窗口内被 queue-remove 撤销）或存储
    // 异常 → 无副作用中止（journal.begin 未发生、无新 turn）——撤销是用户显式
    // 意图，优先于「任务不丢」；turn 已是 cancelled，留队重试语义不适用
    let turnId: string | null = null;
    if (session !== null && options.queueTurnId !== undefined) {
      const sessions = this.deps.sessions;
      if (sessions != null) {
        try {
          const activated = await sessions.activateQueuedTurn(
            session.sessionId,
            options.queueTurnId,
            runId,
          );
          if (!activated) {
            this.deps.log?.(`queue activate missed (cancelled): ${options.queueTurnId}`);
            return { ok: false, error: "排队任务已被撤销", skipped: true };
          }
          turnId = options.queueTurnId;
        } catch (e) {
          this.deps.log?.(`queue activate failed: ${e instanceof Error ? e.message : String(e)}`);
          return { ok: false, error: "排队任务激活失败（稍后自动重试）" };
        }
      }
    }
    this.deps.journal.begin({
      runId,
      tabId,
      task: assembled.taskText,
      attachments: this.deps.attachments.list(),
      ...(session !== null ? { sessionId: session.sessionId, origin: options.origin } : {}),
    });
    // 起始快照广播（评审轮 1 [6]）：journal.begin 重置 seq——不广播则保持连接的
    // UI 侧 seq 去重把新 run 事件全部判为旧 run 补发重复而丢弃
    const startSnapshot = this.deps.journal.current();
    if (startSnapshot !== null) {
      this.deps.broadcast({ kind: "journal-snapshot", snapshot: startSnapshot });
    }
    // 记用户 turn（task 原文——转录用户气泡来源；前情块只进 prompt 不回写 turn）。
    // 排队路径已在上面激活复用；此处只走非排队的新建
    if (session !== null && turnId === null) {
      const sessions = this.deps.sessions;
      if (sessions != null) {
        try {
          turnId =
            (
              await sessions.beginRun(session.sessionId, {
                runId,
                task,
                attachments: this.deps.attachments.list(),
              })
            )?.turnId ?? null;
        } catch (e) {
          this.deps.log?.(`session beginRun failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    if (session !== null && turnId !== null) {
      this.deps.broadcast({
        kind: "session-updated",
        sessionId: session.sessionId,
        reason: "turn",
      });
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
      sessionId: session?.sessionId ?? null,
      turnId,
      origin: options.origin,
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

  /**
   * 会话解析与前情块（issue #35 U1a W5）：显式 sessionId 优先（tab 错位容忍——
   * tab 绑定只是 follow-up 解析的缺省依据）；否则取 tab 最新会话；无则建新（标题 =
   * 任务前 30 字符）。前情块只取该会话既有终态 turn（任务 + 对应归档 finalResult）。
   * 全程 fail-soft（D3）：任何失败回 null——run 照常，仅无会话语义。
   */
  private async resolveSession(
    tabId: number,
    task: string,
    options: { origin: SessionOrigin; sessionId?: string },
  ): Promise<{ sessionId: string; continuity: string | null } | null> {
    const sessions = this.deps.sessions ?? null;
    if (sessions === null) return null;
    const createNew = async (): Promise<string> => {
      const meta = await sessions.createSession({
        tabId,
        origin: options.origin,
        title: task.slice(0, 30),
      });
      this.deps.broadcast({ kind: "session-updated", sessionId: meta.sessionId, reason: "index" });
      return meta.sessionId;
    };
    try {
      let sessionId = options.sessionId ?? null;
      if (sessionId === null) {
        sessionId = (await sessions.resolveSessionForTab(tabId))?.sessionId ?? null;
      }
      if (sessionId === null) {
        return { sessionId: await createNew(), continuity: null };
      }
      const record = await sessions.open(sessionId);
      if (record === null) {
        // 显式指定但已删（LRU/用户删除）——按新会话续跑
        return { sessionId: await createNew(), continuity: null };
      }
      // 显式续跑跟随当前 tab（目标 tab 重绑——follow-up 缺省解析不脱节）
      if (record.meta.tabId !== tabId) {
        await sessions.rebindTab(sessionId, tabId);
        this.deps.broadcast({ kind: "session-updated", sessionId, reason: "index" });
      }
      const resultByTurn = new Map(record.runs.map((r) => [r.turnId, r.finalResult]));
      const priorTurns: ContinuityTurn[] = record.turns
        .filter((t) => t.status === "done" || t.status === "error" || t.status === "interrupted")
        .map((t) => ({
          task: t.task,
          finalResult: resultByTurn.get(t.turnId) ?? null,
          status: t.status,
        }));
      return { sessionId, continuity: buildContinuityBlock(priorTurns) };
    } catch (e) {
      this.deps.log?.(
        `session resolve failed (run continues without session): ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
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
      // 会话终态收口（issue #35 U1a：turn 置终态 + run 归档——fail-soft D3，
      // 失败只记日志不改变 run 终态广播）
      await this.archiveActiveRun(active);
      // 排队续播（#37 批 A）：终态收口后 2s 节流出队同会话下一条 queued turn
      if (active.sessionId !== null) this.scheduleDrain(active.sessionId);
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
   * 会话终态归档（issue #35 U1a）：journal 归档缓冲（环淘汰独立——全量事件）压缩
   * 后连同终态字段写 SessionRepository。fail-soft（D3）：失败记日志，不影响 run
   * 终态与广播——转录缺本 run 归档可容忍，run 崩不可容忍。
   */
  // —— 排队面（#37 U2 批 A）：入队/出队/清空（D1 内聚 run-manager——出队即 start
  //     语义，互斥/节流/收口都在本类生命周期内）——

  /** 入队受理（session-handler queue-add 消费）；入队即尝试出队（空闲时立刻跑） */
  async queueFollowUp(
    sessionId: string,
    task: string,
    attachments: AttachmentInfo[] = [],
  ): Promise<{ ok: true; turnId: string } | { ok: false; error: string }> {
    const sessions = this.deps.sessions ?? null;
    if (sessions === null) return { ok: false, error: "会话面未启用" };
    if (task.trim() === "") return { ok: false, error: "任务不能为空" };
    // 附件指涉不入队（评审轮 1 [9]）：附件不随排队传递（start 读注册表不读 turn，
    // 且注册表随本轮 clearForRun 清空）——出队必被起跑守卫拒，FIFO 头永久阻塞
    if (ATTACHMENT_REF_RE.test(task)) {
      return {
        ok: false,
        error: "排队任务不支持附件指涉——附件不随排队传递（本轮结束即清空），请在本轮结束后直接发送",
      };
    }
    try {
      const r = await sessions.appendQueuedTurn(sessionId, { task, attachments });
      if (!r.ok) {
        return {
          ok: false,
          error: r.error === "queue-full" ? "排队已满（上限 5 条）" : "会话不存在",
        };
      }
      this.deps.broadcast({ kind: "session-updated", sessionId, reason: "queue" });
      this.scheduleDrain(sessionId, 0);
      return { ok: true, turnId: r.turn.turnId };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 撤销单条排队（queue-remove 消费） */
  async queueRemove(sessionId: string, turnId: string): Promise<boolean> {
    const sessions = this.deps.sessions ?? null;
    if (sessions === null) return false;
    try {
      const ok = await sessions.cancelQueuedTurn(sessionId, turnId);
      if (ok) this.deps.broadcast({ kind: "session-updated", sessionId, reason: "queue" });
      return ok;
    } catch {
      return false;
    }
  }

  /** stop 连播语义（D2）：清空一会话全部排队 */
  private async cancelQueue(sessionId: string): Promise<void> {
    const sessions = this.deps.sessions ?? null;
    if (sessions === null) return;
    try {
      const n = await sessions.cancelQueued(sessionId);
      if (n > 0) {
        this.deps.log?.(`queue cancelled (${n}): ${sessionId}`);
        this.deps.broadcast({ kind: "session-updated", sessionId, reason: "queue" });
      }
    } catch (e) {
      this.deps.log?.(`queue cancel failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 出队节流（#37 批 A + 评审轮 1 [2][9]）：per-session timer——终态收口 2s /
   *  入队即时（0ms）/ 占位让位重排 / 拒绝退避重试。延迟可注入（测试小值免假钟） */
  private drainTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 出队被拒的连续次数（per-session；成功出队 / 队列空即清零） */
  private drainAttempts = new Map<string, number>();
  private scheduleDrain(sessionId: string, delayMs?: number): void {
    if (this.drainTimers.has(sessionId)) return;
    const delay = delayMs ?? this.deps.drainDelayMs ?? 2000;
    this.drainTimers.set(
      sessionId,
      setTimeout(() => {
        this.drainTimers.delete(sessionId);
        void this.drainQueue(sessionId);
      }, delay),
    );
  }

  private clearDrainTimer(sessionId: string): void {
    const timer = this.drainTimers.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.drainTimers.delete(sessionId);
  }

  private async drainQueue(sessionId: string): Promise<void> {
    if (this.active !== null || this.starting) {
      // 占位让位重排（评审轮 1 [2]）：终态收口只调度本 run 所属会话——等待中会话
      // 若无自身 timer 会永久搁浅（跨会话排队场景）
      this.scheduleDrain(sessionId);
      return;
    }
    const sessions = this.deps.sessions ?? null;
    if (sessions === null) return;
    try {
      const turn = await sessions.firstQueuedTurn(sessionId);
      if (turn === null) {
        this.drainAttempts.delete(sessionId);
        return;
      }
      // 续播绑定会话目标 tab（评审轮 1 [10]）：不抢用户当前活动页（否则 agent 在
      // 无关页面执行任务 + rebindTab 静默改绑目标）。tabId 0 = 未绑定（新会话首跑
      // 前入队）——回落活动页挑选（与显式续跑 rebind 语义一致）
      const boundTabId = (await sessions.open(sessionId))?.meta.tabId ?? 0;
      const r =
        boundTabId > 0
          ? await this.start(turn.task, {
              origin: "user",
              sessionId,
              queueTurnId: turn.turnId,
              tabId: boundTabId,
            })
          : await this.start(turn.task, { origin: "user", sessionId, queueTurnId: turn.turnId });
      if (r.ok) {
        this.drainAttempts.delete(sessionId);
        return;
      }
      if (this.active !== null || this.starting) {
        // 出队窗口被手动起跑抢占——让位重排（不计退避次数）
        this.scheduleDrain(sessionId);
        return;
      }
      if ("skipped" in r) {
        // 头 turn 出队窗口内被撤销——立即续试下一条（不计退避次数）
        this.scheduleDrain(sessionId, 0);
        return;
      }
      // 出队被拒（评审轮 1 [9]）：退避重试；连续达上限 → 头阻塞解除（转 cancelled
      // + 广播）后立即试下一条。此前「留队等下个触发点」在无新触发时永久搁浅
      this.deps.log?.(`queue dequeue rejected: ${r.error}`);
      const attempts = (this.drainAttempts.get(sessionId) ?? 0) + 1;
      if (attempts < QUEUE_DRAIN_MAX_ATTEMPTS) {
        this.drainAttempts.set(sessionId, attempts);
        this.scheduleDrain(sessionId, this.deps.drainRetryMs ?? 10_000);
        return;
      }
      this.drainAttempts.delete(sessionId);
      this.deps.log?.(`queue drain attempts exhausted — cancel head turn: ${turn.turnId}`);
      const cancelled = await sessions.cancelQueuedTurn(sessionId, turn.turnId);
      if (cancelled) {
        this.deps.broadcast({ kind: "session-updated", sessionId, reason: "queue" });
      }
      this.scheduleDrain(sessionId, 0);
    } catch (e) {
      this.deps.log?.(`queue drain failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async archiveActiveRun(active: ActiveRun): Promise<void> {
    const sessions = this.deps.sessions ?? null;
    if (sessions === null || active.sessionId === null || active.turnId === null) return;
    try {
      const snapshot = this.deps.journal.current();
      if (snapshot === null) return;
      const buffer = this.deps.journal.takeArchiveBuffer();
      const events = compressArchiveEvents(buffer.events);
      // 终态收窄（防御：archiveActiveRun 只在终态后调用——非终态值兜底 interrupted）
      const status: TerminalRunStatus =
        snapshot.status === "done" || snapshot.status === "error" ? snapshot.status : "interrupted";
      const archive: RunArchiveInput = {
        runId: active.runId,
        startedAt: snapshot.startedAt,
        endedAt: snapshot.endedAt ?? this.now(),
        status,
        finalResult: snapshot.finalResult,
        lastError: snapshot.lastError,
        events,
        usage: sumUsage(events),
        discardedBeforeSeq: buffer.discardedBeforeSeq,
      };
      await sessions.completeRun(active.sessionId, { turnId: active.turnId, archive });
      this.deps.broadcast({
        kind: "session-updated",
        sessionId: active.sessionId,
        reason: "archive",
      });
    } catch (e) {
      this.deps.log?.(
        `session archive failed (transcript may lack this run): ${e instanceof Error ? e.message : String(e)}`,
      );
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

  /** SW 重启恢复：非终态快照且无活 run → interrupted（SW 被杀即终态——不续跑）。
   *  会话对账（issue #35 U1a）：半途 run 的 turn 置 interrupted + 环幸存事件归档
   *  （归档缓冲随 SW 死亡丢失——discardedBeforeSeq 如实记账；无 sessionId 的旧
   *  快照跳过对账） */
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
    void this.reconcileInterruptedSession(snapshot);
  }

  /** 恢复对账的会话面（fire-and-forget；fail-soft 同 D3） */
  private async reconcileInterruptedSession(snapshot: RunJournalSnapshot): Promise<void> {
    const sessions = this.deps.sessions ?? null;
    const sessionId = snapshot.sessionId;
    if (sessions === null || sessionId === undefined) return;
    try {
      const record = await sessions.open(sessionId);
      if (record === null) return;
      const turn =
        record.turns.find((t) => t.runId === snapshot.runId && t.status === "running") ?? null;
      if (turn === null) return;
      const events = compressArchiveEvents(snapshot.events);
      await sessions.completeRun(sessionId, {
        turnId: turn.turnId,
        archive: {
          runId: snapshot.runId,
          startedAt: snapshot.startedAt,
          endedAt: this.now(),
          status: "interrupted",
          finalResult: snapshot.finalResult,
          lastError: "Service worker was killed during the run",
          events,
          usage: sumUsage(events),
          discardedBeforeSeq: snapshot.discardedBeforeSeq,
        },
      });
      this.deps.broadcast({ kind: "session-updated", sessionId, reason: "archive" });
    } catch (e) {
      this.deps.log?.(`session reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** 可驱动 tab 挑选（降级链）已抽出 tab-pick.ts 共享（issue #32）——run 与直驱同款 */

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
