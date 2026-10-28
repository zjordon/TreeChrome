// 开关原语（issue #20 M2）：原生 checkbox 驱动——键盘可达与表单语义由原生保证，
// 视觉隐藏 input + 相邻选择器渲染轨道；label 可选文字与开关隐式关联（点击文字可切换）。

import type { InputHTMLAttributes } from "react";

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** 开关旁可见文字；缺省不渲染文字位（纯开关） */
  label?: string;
}

export function Switch({ label, className, ...rest }: SwitchProps) {
  return (
    <label className={["tc-switch", className].filter(Boolean).join(" ")}>
      <input type="checkbox" className="tc-switch-input" {...rest} />
      <span className="tc-switch-track" aria-hidden="true">
        <span className="tc-switch-thumb" />
      </span>
      {label !== undefined && label !== "" ? (
        <span className="tc-switch-label">{label}</span>
      ) : null}
    </label>
  );
}
