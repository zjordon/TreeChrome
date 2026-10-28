// Switch 单测（issue #20 M2）：原生 checkbox 语义、受控/非受控切换、label 隐式关联、disabled。

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Switch } from "../src/index.js";

describe("Switch", () => {
  it("原生 checkbox：角色可查、缺省未选中", () => {
    render(<Switch />);
    const input = screen.getByRole("checkbox") as HTMLInputElement;
    expect(input.checked).toBe(false);
  });

  it("受控：checked 受 props 支配，onChange 在点击时上报事件", () => {
    const onChange = vi.fn();
    render(<Switch checked={true} onChange={onChange} />);
    const input = screen.getByRole("checkbox") as HTMLInputElement;
    expect(input.checked).toBe(true);
    fireEvent.click(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(input.checked).toBe(true); // 受控——父层未变则状态不变
  });

  it("非受控：点击 label 文字也能切换（隐式关联）", () => {
    render(<Switch label="自动蒸馏" defaultChecked={false} />);
    const input = screen.getByRole("checkbox") as HTMLInputElement;
    fireEvent.click(screen.getByText("自动蒸馏"));
    expect(input.checked).toBe(true);
  });

  it("disabled：原生属性落位（浏览器据此拒绝交互）", () => {
    render(<Switch disabled label="停用" />);
    const input = screen.getByRole("checkbox") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    // 不做 click 后 checked 不变的断言：jsdom fireEvent 会无视 disabled 触发激活行为（与浏览器分歧）
  });
});
