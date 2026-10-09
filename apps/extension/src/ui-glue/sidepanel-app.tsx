// 侧边栏组态（m5/05 §2）：PortClient + console-ui 全量装配。chrome 交互只在此层
// （connect 工厂由 entrypoints 注入）——组件零 chrome。端口状态条 + TaskBar +
// 确认卡浮层（权限/提交，同时至多一张——core 守卫链串行语义）+ StatusLine +
// RunTimeline + FinalResult。事件 ack 逐条回发（journal 环释放）。

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
import { useEffect, useReducer, useRef, useState } from "react";
import { fileToBase64 } from "./attachment-file.js";
import { PortClient, type UiPort } from "./port-client.js";
import { ingestSidepanel, initialSidepanelState, type SidepanelAction } from "./sidepanel-state.js";

export interface SidepanelAppProps {
  connect: () => UiPort;
}

export function SidepanelApp({ connect }: SidepanelAppProps) {
  const [state, dispatch] = useReducer(
    (s: typeof initialSidepanelState, a: SidepanelAction) => ingestSidepanel(s, a).state,
    initialSidepanelState,
  );
  const [portStatus, setPortStatus] = useState<"connecting" | "online" | "offline">("connecting");
  const [task, setTask] = useState("");
  const clientRef = useRef<PortClient | null>(null);

  useEffect(() => {
    const client = new PortClient({
      connect,
      onMessage: (message) => {
        dispatch(message);
        if (message.kind === "event") client.send({ kind: "journal-ack", seq: message.seq });
      },
      onStatus: setPortStatus,
    });
    clientRef.current = client;
    client.connect();
    return () => {
      client.dispose();
      clientRef.current = null;
    };
  }, [connect]);

  const send = (message: UiToSwMessage): void => {
    clientRef.current?.send(message);
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
          onPickFiles={(files) => {
            for (const f of files) {
              void fileToBase64(f).then((base64) =>
                send({ kind: "attachment-add", name: f.name, mimeType: f.type, base64 }),
              );
            }
          }}
          onRemoveAttachment={(attachmentId) => send({ kind: "attachment-remove", attachmentId })}
          runStatus={snap?.status ?? null}
          onStart={() => send({ kind: "control", action: "start", task })}
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
          />
        ) : null}
      </main>
    </ThemedRoot>
  );
}
