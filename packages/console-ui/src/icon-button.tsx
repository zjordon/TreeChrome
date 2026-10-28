// 图标按钮原语（issue #20 M2）：图标无文字——label 必填注入 aria-label+title，可访问名强制；
// children 为 SVG（尺寸由 .tc-icon-btn svg 统一收口）。

import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 可访问名（aria-label 与 title 同源）——图标按钮无文字，必填 */
  label: string;
  size?: "xs" | "sm" | "md";
  variant?: "secondary" | "danger";
  children: ReactNode;
}

export function IconButton({
  label,
  size = "md",
  variant,
  className,
  children,
  ...rest
}: IconButtonProps) {
  const cls = [
    "tc-icon-btn",
    `tc-icon-btn--${size}`,
    variant === undefined ? undefined : `tc-icon-btn-${variant}`,
    className,
  ];
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cls.filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
}
