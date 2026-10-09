// 极简基础件（m5/05 §1 共享件）：不引组件库（依赖纪律）——Button/Badge/Field/Table
// 只做语义类名与可访问性最小面，视觉全在 theme.css 变量与类。

import { cloneElement, isValidElement, type ReactElement, type ReactNode, useId } from "react";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "danger" | "ghost";
}

export function Button({ variant = "ghost", className, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={["tc-btn", `tc-btn-${variant}`, className].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}

export type BadgeTone = "neutral" | "accent" | "success" | "danger" | "warning";

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`tc-badge tc-badge-${tone}`}>{children}</span>;
}

/** 标签-控件对：useId 生成 id 注入唯一子元素 + htmlFor 真关联（a11y 规则面） */
export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: ReactNode;
}) {
  const id = useId();
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<{ id?: string }>, { id })
    : children;
  return (
    <div className="tc-field">
      <label className="tc-field-label" htmlFor={id}>
        {label}
      </label>
      {control}
      {error !== undefined && error !== "" ? <span className="tc-field-error">{error}</span> : null}
    </div>
  );
}

/** 表格薄包装（thead/tbody 结构语义；列头由调用方给） */
export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <table className="tc-table">
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}
