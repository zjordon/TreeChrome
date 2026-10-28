// 设置 overlay（issue #20 M4）：底部弹出卡——分区 tab 由宿主塞入 children（OptionsApp）。
// 三条关闭路径：× 钮 / backdrop 点击 / Esc；动画受 base.css reduced-motion 兜底。

import { type ReactNode, useEffect } from "react";
import { IconButton } from "./icon-button.js";

export interface SettingsOverlayProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

export function SettingsOverlay({ open, onClose, title, children }: SettingsOverlayProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label={title}>
      <div className="tc-settings-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="tc-settings-sheet">
        <div className="tc-settings-head">
          <span className="tc-settings-title">{title}</span>
          <IconButton className="tc-settings-close" label="关闭" size="sm" onClick={onClose}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </IconButton>
        </div>
        <div className="tc-settings-body">{children}</div>
      </div>
    </div>
  );
}
