// 侧边栏组态（m5/05 §2 + issue #20 M3 三区重排）：PortClient + console-ui 全量装配。
// chrome 交互只在此层（connect 工厂由 entrypoints 注入）——组件零 chrome。AppShell 三区：
// header（连接状态/蒸馏/草稿徽标/设置入口）+ main（确认卡浮层 + 时间线 + 终态 + 空闲欢迎屏）
// + dock（运行状态条 + TaskBar 常驻底部）。事件 ack 逐条回发（journal 环释放）。附件走分块
// 二进制传输（issue #2 C 档）：begun 回执经 begunWaiters 桥回传输编排，SW 拒绝/本地失败
// 统一落 attachmentRejections 展示位。

import {
  AppShell,
  FinalResult,
  PermissionCard,
  RunPanelHeader,
  RunStatusBar,
  RunTimeline,
  SettingsOverlay,
  SubmitCard,
  TaskBar,
  ThemedRoot,
  WelcomePanel,
} from "@tw/console-ui";
import type { OptionsOp, UiToSwMessage } from "@tw/protocol";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { type BegunSignal, uploadAttachment } from "./attachment-upload.js";
import { OptionsApp } from "./options-app.js";
import { PortClient, type UiPort } from "./port-client.js";
import {
  ingestSidepanel,
  initialSidepanelState,
  type SidepanelAction,
  type SidepanelState,
} from "./sidepanel-state.js";

export interface SidepanelAppProps {
  connect: () => UiPort;
  /** 草稿数主动查询面（issue #5 可观测性：广播即发即逝——打开/重连时补查一次；
   *  entrypoints 注入 chrome.runtime.sendMessage options op，测试注入 mock。缺省不查） */
  fetchDraftCount?: () => Promise<number | null>;
  /** options 单发请求工厂（issue #20 M4）：注入则设置钮开侧边栏 overlay（OptionsApp 双宿主），
   *  缺省回退 onOpenSettings 跳 options 页（测试/降级）。模块级稳定引用——refresh 依赖其身份 */
  optionsRequest?: (op: OptionsOp, payload?: unknown) => Promise<unknown>;
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

  const snap = state.snapshot;
  const terminal = snap !== null && ["done", "error", "interrupted"].includes(snap.status);

  return (
    <ThemedRoot>
      <AppShell
        header={
          <RunPanelHeader
            title="TreeChrome"
            portStatus={portStatus}
            distill={state.distill}
            draftCount={state.draftCount}
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
                onStop={() => send({ kind: "control", action: "stop" })}
              />
            ) : null}
            <TaskBar
              task={task}
              onTaskChange={setTask}
              attachments={state.attachments}
              budget={state.attachmentBudget}
              uploads={uploads}
              rejections={state.attachmentRejections}
              onDismissRejection={(index) =>
                dispatch({ kind: "attachment-rejection-dismissed", index })
              }
              onPickFiles={pickFiles}
              onRemoveAttachment={(attachmentId) =>
                send({ kind: "attachment-remove", attachmentId })
              }
              runStatus={snap?.status ?? null}
              onStart={() => {
                dispatch({ kind: "attachment-rejections-cleared" });
                send({ kind: "control", action: "start", task });
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

        {snap === null && state.events.length === 0 ? (
          <WelcomePanel title="TreeChrome" tagline="浏览器里的任务代理" />
        ) : null}

        <RunTimeline
          events={state.events}
          discardedBeforeSeq={snap?.discardedBeforeSeq ?? 0}
          stepCount={snap?.stepCount}
        />

        {snap !== null && terminal ? (
          <FinalResult
            finalResult={snap.finalResult}
            isSuccessful={snap.isSuccessful}
            attachments={snap.attachments}
            lastError={snap.lastError}
            judgement={snap.judgement}
          />
        ) : null}
      </AppShell>
      {optionsRequest !== undefined ? (
        <SettingsOverlay open={settingsOpen} onClose={() => setSettingsOpen(false)} title="设置">
          <OptionsApp request={optionsRequest} />
        </SettingsOverlay>
      ) : null}
    </ThemedRoot>
  );
}
