// 侧边栏组态（m5/05 §2 + issue #20 M3 三区重排 + #35 U1b 转录形态）：PortClient +
// console-ui 装配。chrome 交互只在此层（connect/sessionRequest 工厂由 entrypoints
// 注入）——组件零 chrome。AppShell 三区：header（连接状态/蒸馏/草稿徽标 + 新对话/
// 任务列表/设置钮）+ main（确认卡浮层 + 二视图：任务页 ↔ 落地页/转录——归档 +
// 活动 run 经 projectTranscript 合流，无会话数据时回退旧时间线面）+ dock（运行
// 状态条 + 附件条 + Composer）。事件 ack 逐条回发（journal 环释放）。附件走分块
// 二进制传输（issue #2 C 档）：begun 回执经 begunWaiters 桥回传输编排，SW 拒绝/
// 本地失败统一落 attachmentRejections 展示位。

import {
  AppShell,
  Button,
  Composer,
  type ContextUsage,
  DebugLogPage,
  ExternalDriveCard,
  FinalResult,
  FontSizePopover,
  formatBytes,
  GoalStrip,
  ModelSwitcher,
  type PageRegistration,
  PageTabs,
  PermissionCard,
  projectTranscript,
  QueueStrip,
  RunPanelHeader,
  RunStatusBar,
  RunTimeline,
  SessionsPage,
  SessionTitleBar,
  SettingsOverlay,
  SkillPage,
  SubmitCard,
  serializeTranscriptHtml,
  ThemedRoot,
  TranscriptView,
  WelcomePanel,
} from "@tw/console-ui";
// 导出 HTML 的内联 CSS（#39 批 D D5：console-ui 不 import CSS 副作用进导出——
// vite ?raw 读聚合主题文本，宿主注入纯函数）
import themeCssText from "@tw/console-ui/theme.css?raw";
import type { OptionsOp, SessionMeta, SessionOp, SessionRecord, UiToSwMessage } from "@tw/protocol";
import { type ReactElement, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { type BegunSignal, uploadAttachment } from "./attachment-upload.js";
import { OptionsApp } from "./options-app.js";
import { PortClient, type UiPort } from "./port-client.js";
import { ingestSidepanel, initialSidepanelState, type SidepanelAction } from "./sidepanel-state.js";

export interface SidepanelAppProps {
  connect: () => UiPort;
  /** 草稿数主动查询面（issue #5 可观测性：广播即发即逝——打开/重连时补查一次；
   *  entrypoints 注入 chrome.runtime.sendMessage options op，测试注入 mock。缺省不查） */
  fetchDraftCount?: () => Promise<number | null>;
  /** options 单发请求工厂（issue #20 M4）：注入则设置钮开侧边栏 overlay（OptionsApp 双宿主），
   *  缺省回退 onOpenSettings 跳 options 页（测试/降级）。模块级稳定引用——refresh 依赖其身份 */
  optionsRequest?: (op: OptionsOp, payload?: unknown) => Promise<unknown>;
  /** session 单发请求工厂（issue #35 U1b）：注入则启用会话面（任务页/转录归档），
   *  缺省降级为无会话的旧时间线形态 */
  sessionRequest?: (op: SessionOp, payload?: unknown) => Promise<unknown>;
  /** 设置入口降级路径（optionsRequest 未注入时使用——跳 options 页） */
  onOpenSettings?: () => void;
}

/** TaskBar 的上传进度投影（传输中条目——本地态，不进 protocol） */
interface UploadProgress {
  transferId: string;
  name: string;
  size: number;
  sent: number;
}

export function SidepanelApp({
  connect,
  fetchDraftCount,
  optionsRequest,
  sessionRequest,
  onOpenSettings,
}: SidepanelAppProps) {
  const [state, dispatch] = useReducer(
    (s: typeof initialSidepanelState, a: SidepanelAction) => ingestSidepanel(s, a).state,
    initialSidepanelState,
  );
  const [portStatus, setPortStatus] = useState<"connecting" | "online" | "offline">("connecting");
  const [task, setTask] = useState("");
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 视图态（#39 批 B）：chat 是缺省主视图；页签页 = 静态注册（任务/技能/调试）
  const [view, setView] = useState<"chat" | "tasks" | "skills" | "debug">("chat");
  const clientRef = useRef<PortClient | null>(null);
  /** begin→begun 回执桥（Map<transferId, settle>；超时自清不留悬挂传输） */
  const begunWaiters = useRef(new Map<string, (signal: BegunSignal) => void>());

  useEffect(() => {
    const client = new PortClient({
      connect,
      onMessage: (message) => {
        dispatch(message);
        if (message.kind === "event") client.send({ kind: "journal-ack", seq: message.seq });
        if (message.kind === "attachment-begun") {
          begunWaiters.current.get(message.transferId)?.("begun");
        }
        if (message.kind === "attachment-rejected" && message.rejection.transferId !== undefined) {
          begunWaiters.current.get(message.rejection.transferId)?.("rejected");
        }
      },
      onStatus: setPortStatus,
    });
    clientRef.current = client;
    client.connect();
    return () => {
      client.dispose();
      clientRef.current = null;
      begunWaiters.current.clear();
    };
  }, [connect]);

  // 草稿数补查（issue #5）：skill-drafts 广播只在蒸馏完成瞬间发给当时在线的端口——
  // 面板后开/重连会错过。端口上线时主动查一次当前草稿数（广播照旧，双保险）
  useEffect(() => {
    if (portStatus !== "online" || fetchDraftCount === undefined) return;
    void fetchDraftCount()
      .then((n) => {
        if (typeof n === "number") dispatch({ kind: "skill-drafts", count: n });
      })
      .catch(() => {});
  }, [portStatus, fetchDraftCount]);

  // 活跃卡上下文窗口（#37 批 B 验收④分母）：上线/设置关闭后热读一次（SW 单一写者）
  const [contextWindow, setContextWindow] = useState<number | null>(null);
  useEffect(() => {
    if (portStatus !== "online" || optionsRequest === undefined) return;
    // settingsOpen / modelSwitcherOpen 是纯触发器（主设置/快速换卡关闭后重读分母
    // ——评审轮 1 [7]：换卡正是该功能主路径，分母须跟随）——显式消费让依赖成立
    const reopen = settingsOpen;
    void reopen;
    const reswitch = state.modelSwitcherOpen;
    void reswitch;
    void optionsRequest("get-settings")
      .then((res) => {
        const s = res as {
          ok?: boolean;
          settings?: {
            providerCards?: Array<{ name?: unknown; contextWindow?: unknown }>;
            activeCard?: unknown;
          };
        };
        if (s?.ok !== true || s.settings === undefined) return;
        const card = (s.settings.providerCards ?? []).find(
          (c) => c.name === s.settings?.activeCard,
        );
        setContextWindow(typeof card?.contextWindow === "number" ? card.contextWindow : null);
      })
      .catch(() => {});
  }, [portStatus, optionsRequest, settingsOpen, state.modelSwitcherOpen]);

  // 会话面拉取（#35 U1b）：上线 / session-updated 变更 / 切换当前会话时补查索引
  // 与归档（session-updated 载荷只是定位摘要——全量经单发应答，D8 单源）
  useEffect(() => {
    if (portStatus !== "online" || sessionRequest === undefined) return;
    // sessionRev 是纯触发器（reducer 每次变更 +1）——显式消费让依赖必要性成立
    const rev = state.sessionRev;
    let cancelled = false;
    const run = async (): Promise<void> => {
      void rev;
      try {
        const res = (await sessionRequest("session-list")) as {
          ok?: boolean;
          sessions?: SessionMeta[];
        };
        if (!cancelled && res?.ok === true && Array.isArray(res.sessions)) {
          dispatch({ kind: "session-index", sessions: res.sessions });
        }
      } catch {
        /* fail-soft：索引拉不到保持旧值 */
      }
      const current = state.currentSessionId;
      if (current === null) return;
      try {
        const res = (await sessionRequest("session-open", { sessionId: current })) as {
          ok?: boolean;
          record?: SessionRecord | null;
          notFound?: boolean;
          targetUrl?: string | null;
        };
        if (cancelled) return;
        // 目标条数据（#37 批 C）：随归档同 fetch 现查（tab 关/查询败 → null 不渲染）。
        // 走 reducer（评审轮 1 [5]）：forSessionId 归属守卫 + 换会话分支同步清
        dispatch({
          kind: "session-target",
          url: typeof res?.targetUrl === "string" ? res.targetUrl : null,
          forSessionId: current,
        });
        if (res?.ok === true) {
          dispatch({
            kind: "session-record",
            record: res.record ?? null,
            forSessionId: current,
          });
        } else if (res?.notFound === true) {
          // 确认不存在（LRU/删除竞态）才清当前指向；其余 ok:false（存储瞬时异常）
          // fail-soft 保留旧值——session-updated 触发补查（评审轮 2 [5]）
          dispatch({ kind: "session-record", record: null, forSessionId: current });
        }
      } catch {
        /* fail-soft：归档拉不到保留旧值（live 事件面不受影响） */
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [portStatus, sessionRequest, state.sessionRev, state.currentSessionId]);

  /** 透传 PortClient.send 的送达语义（评审轮 1 [2]）：断连/端口竞态返 false 不抛——
   *  附件传输靠它显式收口；其余调用方忽略返回值 */
  const send = (message: UiToSwMessage): boolean => clientRef.current?.send(message) ?? false;

  const waitForBegun = useCallback(
    (transferId: string, timeoutMs: number) =>
      new Promise<BegunSignal>((resolve) => {
        const timer = setTimeout(() => {
          begunWaiters.current.delete(transferId);
          resolve("timeout");
        }, timeoutMs);
        begunWaiters.current.set(transferId, (signal) => {
          clearTimeout(timer);
          begunWaiters.current.delete(transferId);
          resolve(signal);
        });
      }),
    [],
  );

  const pickFiles = (files: File[]): void => {
    for (const f of files) {
      const transferId = crypto.randomUUID();
      setUploads((prev) => [...prev, { transferId, name: f.name, size: f.size, sent: 0 }]);
      void uploadAttachment(
        {
          name: f.name,
          mimeType: f.type,
          size: f.size,
          slice: (off, end) => f.slice(off, end).arrayBuffer(),
        },
        {
          send,
          waitForBegun,
          onProgress: (tid, sent) =>
            setUploads((prev) => prev.map((u) => (u.transferId === tid ? { ...u, sent } : u))),
          onLocalRejection: (rejection) =>
            dispatch({ kind: "attachment-rejected-local", rejection }),
          generateTransferId: () => transferId,
        },
      ).finally(() => {
        // 乐观收尾（commit 后 SW 的 attachments 广播即回执；失败走 lost 拒绝广播）
        setUploads((prev) => prev.filter((u) => u.transferId !== transferId));
      });
    }
  };

  /** 新对话（#35 D9）：建空会话（tabId 0 未绑定）置当前——下一次 start 显式带
   *  sessionId，SW 侧 rebindTab 落到实际活动 tab。迟到应答守卫（评审轮 2 [6]）：
   *  SW 冷启动应答慢时用户可能已切别的会话——发起时的指向变了就放弃应用 */
  const newChat = (): void => {
    if (sessionRequest === undefined) return;
    const at = currentSessionIdRef.current;
    void sessionRequest("session-new", {})
      .then((res) => {
        const meta = (res as { ok?: boolean; session?: SessionMeta }).session;
        if (
          (res as { ok?: boolean }).ok === true &&
          meta !== undefined &&
          currentSessionIdRef.current === at
        ) {
          dispatch({ kind: "session-current", sessionId: meta.sessionId });
          setTask("");
          setView("chat");
        }
      })
      .catch(() => {});
  };

  const openSession = (sessionId: string): void => {
    // 目标条清理在 reducer 的换会话分支（评审轮 1 [8]）：同会话重入 reducer
    // 早退无状态变化、补查 effect 不重跑——组件态误清后无恢复通道
    dispatch({ kind: "session-current", sessionId });
    setView("chat");
  };

  const snap = state.snapshot;
  const terminal = snap !== null && ["done", "error", "interrupted"].includes(snap.status);
  const running = snap !== null && !terminal;
  const transcript = projectTranscript(state.sessionRecord, snap, state.events);
  const landing = transcript.length === 0 && snap === null && state.events.length === 0;
  // 回退时间线面的会话语境门（评审轮 2 [3]）：snap 属当前会话/无会话语境
  // （旧数据）才承载；新对话/他会话时旧 run 视图不串入
  const runViewEligible =
    snap === null ||
    snap.sessionId === undefined ||
    state.currentSessionId === null ||
    snap.sessionId === state.currentSessionId;
  // 外部直驱只读（#37 批 B）：bridge 会话禁输入——查看态，停止权保留。snap 须属
  // 当前会话（评审轮 1 [4]）：bridge run 在他会话跑时，正在查看的会话不受牵连
  const external = snap !== null && snap.origin === "bridge" && runViewEligible;
  // 运行中仍可输入（#37 批 A：发送→入队而非禁用）；仅附件在途禁发（起跑/入队丢
  // 字节）。运行中但无处入队（无会话面/无当前会话）维持禁用（评审轮 1 [6]：
  // 静默无操作是相对旧禁用钮的行为回归）
  const queueable = state.currentSessionId !== null && sessionRequest !== undefined;
  const canSend = uploads.length === 0 && !external && (!running || queueable);
  const queuedTurns = state.sessionRecord?.turns.filter((t) => t.status === "queued") ?? [];
  // 上下文用量（验收④）：最近一次 model_result 的 inputTokens（多轮拼接模式下即
  // 拼接后 prompt 的实证）——从事件流倒序取首个带值者
  let latestUsage: ContextUsage | undefined;
  for (let i = state.events.length - 1; i >= 0; i -= 1) {
    const e = state.events[i];
    if (e === undefined) continue;
    if (e.type !== "model_result" || typeof e.data !== "object" || e.data === null) continue;
    const tokens = (e.data as { inputTokens?: unknown }).inputTokens;
    if (typeof tokens === "number") {
      latestUsage = { inputTokens: tokens, contextWindow };
      break;
    }
  }
  const currentSessionIdRef = useRef<string | null>(null);
  currentSessionIdRef.current = state.currentSessionId;
  const fileInput = useRef<HTMLInputElement>(null);

  /** 任务页视图（#39 批 B 抽件）：会话索引列表 + 打开/重命名/删除/新建 */
  const TasksView = (): ReactElement => (
    <SessionsPage
      sessions={state.sessions}
      currentSessionId={state.currentSessionId}
      onOpen={openSession}
      onRename={(sessionId, title) => {
        void sessionRequest?.("session-rename", { sessionId, title }).catch(() => {});
      }}
      onDelete={(sessionId) => {
        void sessionRequest?.("session-delete", { sessionId })
          .then((res) => {
            // 删除确认成功才清当前指向（评审轮 2 [9]：ok:false = 存储异常/未删成）
            if ((res as { ok?: boolean }).ok !== true) return;
            if (currentSessionIdRef.current === sessionId) {
              dispatch({ kind: "session-current", sessionId: null });
            }
          })
          .catch(() => {});
      }}
      onNew={newChat}
    />
  );
  /** 调试页视图：原始 journal 事件流（state 面）+ 快照头部态 */
  const DebugView = (): ReactElement => (
    <DebugLogPage events={state.events} snapshot={state.snapshot} />
  );
  /** 技能页视图：技能库 + 草稿审阅（OPTIONS_OPS 单发面——与 options 双宿主一致） */
  const SkillsView = (): ReactElement | null =>
    optionsRequest !== undefined ? <SkillPage request={optionsRequest} /> : null;

  // 静态页签注册（#39 批 B，方案 §5：任务 10/技能 40/调试日志 50；isEnabled=false
  // 不出现——验收③）。数组在组态处声明，聊天不在页签（缺省主视图）
  const pages: PageRegistration[] = [
    {
      id: "tasks",
      title: "任务",
      order: 10,
      isEnabled: sessionRequest !== undefined,
      Component: TasksView,
    },
    {
      id: "skills",
      title: "技能",
      order: 40,
      isEnabled: optionsRequest !== undefined,
      Component: SkillsView,
    },
    { id: "debug", title: "调试", order: 50, isEnabled: true, Component: DebugView },
  ].filter((p) => p.isEnabled);
  const activePage = view === "chat" ? null : (pages.find((p) => p.id === view) ?? null);

  return (
    <ThemedRoot>
      <AppShell
        header={
          <RunPanelHeader
            title="TreeChrome"
            portStatus={portStatus}
            distill={state.distill}
            draftCount={state.draftCount}
            tabs={
              <PageTabs
                pages={pages.map((p) => ({ id: p.id, title: p.title }))}
                activeId={view === "chat" ? null : view}
                onSelect={(id) =>
                  // toggle：点活动中的页签回聊天主视图
                  setView((v) => (v === id ? "chat" : (id as typeof v)))
                }
              />
            }
            onNewChat={sessionRequest !== undefined ? newChat : undefined}
            onOpenSettings={
              optionsRequest !== undefined ? () => setSettingsOpen(true) : onOpenSettings
            }
            onReviewDrafts={
              optionsRequest !== undefined ? () => setSettingsOpen(true) : onOpenSettings
            }
          />
        }
        dock={
          <>
            {snap !== null && !terminal ? (
              <RunStatusBar
                status={snap.status}
                stepCount={snap.stepCount}
                startedAt={snap.startedAt}
                endedAt={snap.endedAt}
                usage={latestUsage}
                onStop={() => send({ kind: "control", action: "stop" })}
              />
            ) : null}
            {/* 附件条（TaskBar 的附件面原样收编——清单/在途/预算/拒绝明细） */}
            {state.attachments.length > 0 ? (
              <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2 }}>
                {state.attachments.map((a) => (
                  <li
                    key={a.attachmentId}
                    style={{ display: "flex", gap: 6, alignItems: "center" }}
                  >
                    <span>
                      {a.name}（{formatBytes(a.size)}）
                    </span>
                    <Button
                      variant="danger"
                      disabled={running}
                      aria-label={`移除附件 ${a.name}`}
                      onClick={() =>
                        send({ kind: "attachment-remove", attachmentId: a.attachmentId })
                      }
                    >
                      ×
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            {uploads.length > 0 ? (
              <ul
                style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2 }}
                aria-label="附件上传中"
              >
                {uploads.map((u) => (
                  <li
                    key={u.transferId}
                    className="tc-ev-muted"
                    style={{ display: "flex", gap: 6 }}
                  >
                    <span>
                      {u.name}（上传中 {u.size > 0 ? Math.floor((u.sent / u.size) * 100) : 100}%）
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {state.attachmentBudget !== null && state.attachmentBudget.usedBytes > 0 ? (
              <p style={{ margin: 0 }} className="tc-ev-muted">
                附件 {formatBytes(state.attachmentBudget.usedBytes)} /{" "}
                {formatBytes(state.attachmentBudget.maxTotalBytes)}
              </p>
            ) : null}
            {state.attachmentRejections.length > 0 ? (
              <ul
                style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2 }}
                aria-label="附件被拒明细"
              >
                {state.attachmentRejections.map((r, i) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: 拒绝明细无稳定 id（同名可重复出现），name+序号复合 key 是务实解（同 submit-card 先例）
                    key={`${r.name}-${i}`}
                    className="tc-ev-err"
                    style={{ display: "flex", gap: 6, alignItems: "center" }}
                  >
                    <span>
                      ⚠ {r.name}
                      {r.size > 0 ? `（${formatBytes(r.size)}）` : ""}
                    </span>
                    <Button
                      variant="danger"
                      aria-label={`清除附件提示 ${r.name}`}
                      onClick={() => dispatch({ kind: "attachment-rejection-dismissed", index: i })}
                    >
                      ×
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            {/* 目标条（#37 批 C）：当前会话目标 tab——点击聚焦（session-focus） */}
            {state.targetUrl !== null && state.currentSessionId !== null && !landing ? (
              <GoalStrip
                url={state.targetUrl}
                onFocus={() => {
                  const sessionId = currentSessionIdRef.current;
                  if (sessionId === null) return;
                  void sessionRequest?.("session-focus", { sessionId }).catch(() => {});
                }}
              />
            ) : null}
            {/* 排队消息条（#37 批 A）：当前会话 queued turns——撤销即 queue-remove */}
            {queuedTurns.length > 0 && sessionRequest !== undefined ? (
              <QueueStrip
                turns={queuedTurns}
                onRemove={(turnId) => {
                  const sessionId = currentSessionIdRef.current;
                  if (sessionId === null) return;
                  void sessionRequest("queue-remove", { sessionId, turnId }).catch(() => {});
                }}
              />
            ) : null}
            <Composer
              task={task}
              onTaskChange={setTask}
              canSend={canSend}
              onSend={() => {
                // 运行中发送 = 入队（#37 批 A：连播而非禁用/拒绝）
                if (running) {
                  const sessionId = currentSessionIdRef.current;
                  if (sessionId !== null && sessionRequest !== undefined) {
                    void sessionRequest("queue-add", { sessionId, task })
                      .then((res) => {
                        if ((res as { ok?: boolean }).ok === true) setTask("");
                      })
                      .catch(() => {});
                  }
                  return;
                }
                dispatch({ kind: "attachment-rejections-cleared" });
                send({
                  kind: "control",
                  action: "start",
                  task,
                  // 显式续接当前会话（缺省由 SW 按 tab 解析——#35 U1 语义）
                  ...(state.currentSessionId !== null ? { sessionId: state.currentSessionId } : {}),
                });
              }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <Button disabled={running} onClick={() => fileInput.current?.click()}>
                📎 附件
              </Button>
            </div>
            <input
              ref={fileInput}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length > 0) pickFiles(files);
                e.target.value = "";
              }}
            />
          </>
        }
      >
        {state.permission !== null ? (
          <PermissionCard
            req={state.permission.req}
            expiresAt={state.permission.req.expiresAt}
            onResolve={(verdict) => {
              send({ kind: "permission-resolve", token: state.permission?.token ?? "", verdict });
              dispatch({ kind: "permission-resolved" });
            }}
          />
        ) : null}
        {state.submit !== null ? (
          <SubmitCard
            req={state.submit.req}
            fields={state.submit.fields}
            onConfirm={() => {
              send({ kind: "submit-resolve", token: state.submit?.token ?? "", approved: true });
              dispatch({ kind: "submit-resolved" });
            }}
            onCancel={() => {
              send({ kind: "submit-resolve", token: state.submit?.token ?? "", approved: false });
              dispatch({ kind: "submit-resolved" });
            }}
          />
        ) : null}

        {activePage !== null ? (
          <activePage.Component />
        ) : (
          <>
            {/* 会话标题条（#39 批 C/D）：行内重命名 + 字号 + 导出 */}
            {state.currentSessionId !== null && !landing ? (
              <SessionTitleBar
                title={state.sessionRecord?.meta.title ?? "会话"}
                onRename={(title) => {
                  void sessionRequest?.("session-rename", {
                    sessionId: state.currentSessionId,
                    title,
                  }).catch(() => {});
                }}
                actions={
                  <>
                    <FontSizePopover />
                    <Button
                      aria-label="导出会话 HTML"
                      title="导出会话 HTML（自包含静态页）"
                      onClick={() => {
                        // 导出（验收④）：当前会话转录 → 零脚本单文件（内联主题 CSS）
                        const record = state.sessionRecord;
                        if (record === null) return;
                        const html = serializeTranscriptHtml(
                          projectTranscript(record, snap, state.events),
                          { cssText: themeCssText, title: record.meta.title },
                        );
                        const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `treechrome-${record.meta.title.slice(0, 30) || "session"}.html`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                    >
                      ⬇ HTML
                    </Button>
                  </>
                }
              />
            ) : null}
            {/* 外部直驱说明卡（#37 批 B）：bridge 会话置顶——查看态 + 停止留权 */}
            {external ? (
              <ExternalDriveCard sessionTitle={state.sessionRecord?.meta.title ?? null} />
            ) : null}
            {landing ? (
              <WelcomePanel
                title="TreeChrome"
                tagline="浏览器里的任务代理"
                historyCount={state.sessions.length}
                onOpenHistory={() => setView("tasks")}
              />
            ) : null}
            {transcript.length > 0 ? (
              <TranscriptView items={transcript} />
            ) : !landing && runViewEligible ? (
              /* 回退旧时间线面：仅承载本会话/无会话语境的 run 视图（归档 fetch 在途
               * 或前会话模型数据）——旧会话的 snap/events 不串入新会话（评审轮 2 [3]） */
              <>
                <RunTimeline
                  events={state.events}
                  discardedBeforeSeq={snap?.discardedBeforeSeq ?? 0}
                  stepCount={snap?.stepCount}
                />
                {terminal ? (
                  <FinalResult
                    finalResult={snap.finalResult}
                    isSuccessful={snap.isSuccessful}
                    attachments={snap.attachments}
                    lastError={snap.lastError}
                    judgement={snap.judgement}
                  />
                ) : null}
              </>
            ) : transcript.length === 0 && !landing ? (
              /* 非本会话的 run 视图被门控（新对话/他会的 fetch 在途）——空转录占位 */
              <TranscriptView items={[]} />
            ) : null}
          </>
        )}
      </AppShell>
      {optionsRequest !== undefined ? (
        <SettingsOverlay open={settingsOpen} onClose={() => setSettingsOpen(false)} title="设置">
          <OptionsApp request={optionsRequest} />
        </SettingsOverlay>
      ) : null}
      {/* 模型快速切换（#37 批 C：Ctrl+Shift+M → SW 广播置位；点选保存后关闭） */}
      {optionsRequest !== undefined && state.modelSwitcherOpen ? (
        <SettingsOverlay
          open
          onClose={() => dispatch({ kind: "model-switcher-closed" })}
          title="模型快速切换"
        >
          <ModelSwitcher
            request={optionsRequest}
            onClose={() => dispatch({ kind: "model-switcher-closed" })}
          />
        </SettingsOverlay>
      ) : null}
    </ThemedRoot>
  );
}
