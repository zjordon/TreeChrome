// SessionsPage（issue #35 U1b B4）：任务页 v0——会话索引列表 + 打开切换 +
// 行内重命名（input 替换，Enter/失焦提交）+ 删除（两段确认）+ 新对话。零 chrome；
// 数据由宿主经 session-list/session-open 应答喂入。

import type { SessionMeta, TerminalRunStatus } from "@tw/protocol";
import { useRef, useState } from "react";
import { Button } from "./primitives.js";

const LAST_STATUS_LABEL: Record<TerminalRunStatus, string> = {
  done: "完成",
  error: "出错",
  interrupted: "已中断",
};

/** meta.lastStatus 类型面是全量 RunStatus（运行中/挂起由 ongoing 分支接住） */
function lastStatusLabel(status: SessionMeta["lastStatus"]): string {
  if (status === null) return "未跑";
  if (status === "running" || status === "awaiting-permission" || status === "awaiting-submit") {
    return "进行中";
  }
  return LAST_STATUS_LABEL[status];
}

const ORIGIN_LABEL = { user: "", bridge: "外部" } as const;

function formatWhen(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

interface RowProps {
  meta: SessionMeta;
  isCurrent: boolean;
  onOpen: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onDelete: (sessionId: string) => void;
}

function SessionRow({ meta, isCurrent, onOpen, onRename, onDelete }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(meta.title);
  const [confirming, setConfirming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const commitRename = (): void => {
    setEditing(false);
    const next = draft.trim().slice(0, 100);
    if (next !== "" && next !== meta.title) onRename(meta.sessionId, next);
    else setDraft(meta.title);
  };

  return (
    <li
      className={isCurrent ? "tc-session-row tc-session-row--current" : "tc-session-row"}
      data-testid={`session-${meta.sessionId}`}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          aria-label="重命名会话"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            // IME 组字态不接键（评审轮 2 [7]）：中文确认候选词的 Enter/取消候选
            // 的 Escape 会误触提交/退出——composer 同款防护
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              setDraft(meta.title);
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="tc-session-open"
          onClick={() => onOpen(meta.sessionId)}
          title="打开会话"
        >
          <strong>{meta.title}</strong>
          <span className="tc-ev-muted">
            {ORIGIN_LABEL[meta.origin] ? `${ORIGIN_LABEL[meta.origin]} · ` : ""}
            {meta.runCount} 轮 · {lastStatusLabel(meta.lastStatus)} · {formatWhen(meta.updatedAt)}
            {meta.attachmentCount > 0 ? ` · 📎 ${meta.attachmentCount}` : ""}
          </span>
        </button>
      )}
      <Button
        variant="secondary"
        aria-label={`重命名 ${meta.title}`}
        onClick={() => {
          setDraft(meta.title);
          setEditing(true);
          // 挂起态已渲染后聚焦（行内编辑入口可键盘达）
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
      >
        ✎
      </Button>
      {confirming ? (
        <>
          <Button
            variant="danger"
            aria-label={`确认删除 ${meta.title}`}
            onClick={() => onDelete(meta.sessionId)}
          >
            确认删除
          </Button>
          <Button variant="secondary" aria-label="取消删除" onClick={() => setConfirming(false)}>
            取消
          </Button>
        </>
      ) : (
        <Button
          variant="danger"
          aria-label={`删除 ${meta.title}`}
          onClick={() => setConfirming(true)}
        >
          ×
        </Button>
      )}
    </li>
  );
}

export interface SessionsPageProps {
  sessions: SessionMeta[];
  currentSessionId: string | null;
  onOpen: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onDelete: (sessionId: string) => void;
  onNew: () => void;
}

export function SessionsPage({
  sessions,
  currentSessionId,
  onOpen,
  onRename,
  onDelete,
  onNew,
}: SessionsPageProps) {
  return (
    <section className="tc-card" data-testid="sessions-page">
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <strong>任务</strong>
        <span className="tc-ev-muted">（{sessions.length}）</span>
        <span style={{ flex: 1 }} />
        <Button variant="primary" onClick={onNew}>
          ⊕ 新对话
        </Button>
      </div>
      {sessions.length === 0 ? (
        <p className="tc-ev-muted">还没有历史会话——发第一个任务开始。</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 4 }}>
          {sessions.map((meta) => (
            <SessionRow
              key={meta.sessionId}
              meta={meta}
              isCurrent={meta.sessionId === currentSessionId}
              onOpen={onOpen}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
