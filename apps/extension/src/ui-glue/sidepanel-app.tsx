// 侧边栏组态（m5/05 §2）：PortClient + console-ui 全量装配。chrome 交互只在此层
// （connect 工厂由 entrypoints 注入）——组件零 chrome。端口状态条 + TaskBar +
// 确认卡浮层（权限/提交，同时至多一张——core 守卫链串行语义）+ StatusLine +
// RunTimeline + FinalResult。事件 ack 逐条回发（journal 环释放）。附件走分块
// 二进制传输（issue #2 C 档）：begun 回执经 begunWaiters 桥回传输编排，SW 拒绝/
// 本地失败统一落 attachmentRejections 展示位。

import {
  FinalResult,
  PermissionCard,
  RunTimeline,
  StatusLine,
  SubmitCard,
  TaskBar,
  ThemedRoot,
} from "@tw/console-ui";
import type { UiToSwMessage } from "@tw/protocol";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { type BegunSignal, uploadAttachment } from "./attachment-upload.js";
import { PortClient, type UiPort } from "./port-client.js";
import { ingestSidepanel, initialSidepanelState, type SidepanelAction } from "./sidepanel-state.js";

export interface SidepanelAppProps {
  connect: () => UiPort;
}

/** TaskBar 的上传进度投影（传输中条目——本地态，不进 protocol） */
interface UploadProgress {
  transferId: string;
  name: string;
  size: number;
  sent: number;
}

export function SidepanelApp({ connect }: SidepanelAppProps) {
  const [state, dispatch] = useReducer(
    (s: typeof initialSidepanelState, a: SidepanelAction) => ingestSidepanel(s, a).state,
    initialSidepanelState,
  );
  const [portStatus, setPortStatus] = useState<"connecting" | "online" | "offline">("connecting");
  const [task, setTask] = useState("");
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
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

  const send = (message: UiToSwMessage): void => {
    clientRef.current?.send(message);
  };

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
      <main style={{ padding: 10, display: "grid", gap: 8 }}>
        {portStatus !== "online" ? (
          <p style={{ margin: 0 }} className="tc-ev-warn">
            {portStatus === "connecting"
              ? "连接服务…（SW 可能正在唤醒）"
              : "连接已断开——自动重连中…"}
          </p>
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
          onRemoveAttachment={(attachmentId) => send({ kind: "attachment-remove", attachmentId })}
          runStatus={snap?.status ?? null}
          onStart={() => {
            dispatch({ kind: "attachment-rejections-cleared" });
            send({ kind: "control", action: "start", task });
          }}
          onStop={() => send({ kind: "control", action: "stop" })}
        />

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

        {snap !== null ? (
          <StatusLine
            status={snap.status}
            stepCount={snap.stepCount}
            startedAt={snap.startedAt}
            endedAt={snap.endedAt}
          />
        ) : (
          <p style={{ margin: 0 }} className="tc-ev-muted">
            空闲——配置好 LLM 卡片（设置页）后输入任务开始。
          </p>
        )}

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
          />
        ) : null}
      </main>
    </ThemedRoot>
  );
}
