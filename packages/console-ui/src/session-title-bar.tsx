// 会话标题条（issue #39 U3 批 C，方案 §6「会话标题条收拢」）：主区顶部条件行——
// 当前会话标题行内重命名（Enter 提交/Escape 取消/IME isComposing 守卫——SessionsPage
// 同款交互）+ 右侧动作区（字号 Aa / 导出——宿主注入 ReactNode 插槽）。

import { type ReactNode, useEffect, useRef, useState } from "react";

export interface SessionTitleBarProps {
  title: string;
  /** 行内重命名提交（空题由宿主拒——组件不清空既有标题） */
  onRename: (title: string) => void;
  /** 右侧动作区（字号/导出钮——宿主注入） */
  actions?: ReactNode;
}

export function SessionTitleBar({ title, onRename, actions }: SessionTitleBarProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = (): void => {
    const next = draft.trim();
    setEditing(false);
    if (next !== "" && next !== title) onRename(next);
  };

  return (
    <div className="tc-session-title-bar" data-testid="session-title-bar">
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          aria-label="会话标题"
          data-testid="session-title-input"
          style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // IME 组字确认的 Enter 不是提交（SessionsPage 同款守卫）
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="tc-session-title"
          data-testid="session-title"
          title="重命名会话"
          style={{ textAlign: "left" }}
          onClick={() => {
            setDraft(title);
            setEditing(true);
          }}
        >
          {title}
        </button>
      )}
      {actions !== undefined ? <span className="tc-session-title-actions">{actions}</span> : null}
    </div>
  );
}
