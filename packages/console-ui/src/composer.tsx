// Composer（issue #35 U1b B3）：自适应高度输入框 + Enter 发送 / Shift+Enter 换行
// + 发送钮（空输入禁用）+ 提示行。qz composer 形态的 TC 裁剪版（附件清单/预算/
// 拒绝明细行由宿主在组件上方组合——组件不管附件面）。零 chrome。

import { type KeyboardEvent, useRef } from "react";
import { Button } from "./primitives.js";

/** 自适应高度上下限（qz 同值：min 20px / max 120px） */
export const COMPOSER_MIN_HEIGHT = 20;
export const COMPOSER_MAX_HEIGHT = 120;

export interface ComposerProps {
  task: string;
  onTaskChange: (task: string) => void;
  /** 发送（canSend=false 时钮禁用；Enter 同钮语义） */
  onSend: () => void;
  /** false = 禁用输入与发送（运行中 U1 仍禁用——排队是 U2） */
  canSend: boolean;
  placeholder?: string;
  /** 提示行文案（缺省 Enter 发送 · Shift+Enter 换行） */
  hint?: string;
}

export function Composer({
  task,
  onTaskChange,
  onSend,
  canSend,
  placeholder = "描述任务，如：打开 douyin.com，上传视频并选择合集…",
  hint = "Enter 发送 · Shift+Enter 换行",
}: ComposerProps) {
  const textarea = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = (): void => {
    const el = textarea.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, COMPOSER_MIN_HEIGHT), COMPOSER_MAX_HEIGHT)}px`;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend && task.trim() !== "") onSend();
    }
  };

  return (
    <section className="tc-card" data-testid="composer">
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          ref={textarea}
          rows={1}
          dir="auto"
          style={{ flex: 1, resize: "none", minHeight: COMPOSER_MIN_HEIGHT }}
          placeholder={placeholder}
          value={task}
          disabled={!canSend}
          onChange={(e) => {
            onTaskChange(e.target.value);
            adjustHeight();
          }}
          onKeyDown={onKeyDown}
          aria-label="任务输入"
        />
        <Button
          variant="primary"
          disabled={!canSend || task.trim() === ""}
          onClick={onSend}
          aria-label="发送"
        >
          ➤
        </Button>
      </div>
      <div className="tc-ev-muted" style={{ fontSize: 11 }}>
        {hint}
      </div>
    </section>
  );
}
