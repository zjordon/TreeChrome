// Composer 组件单测（issue #35 U1b B8）：Enter 发送 / Shift+Enter 换行不发送 /
// 空输入禁用 / canSend=false 禁用输入与发送。

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "../src/composer.js";

describe("Composer", () => {
  it("Enter 发送（onSend 触发且换行被吃掉）；Shift+Enter 不发送", () => {
    const onSend = vi.fn();
    render(<Composer task="查价" onTaskChange={() => {}} onSend={onSend} canSend />);
    const box = screen.getByLabelText("任务输入");
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("空输入：Enter 不发送、发送钮禁用", () => {
    const onSend = vi.fn();
    render(<Composer task="  " onTaskChange={() => {}} onSend={onSend} canSend />);
    fireEvent.keyDown(screen.getByLabelText("任务输入"), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("canSend=false：输入与发送均禁用（运行中）", () => {
    render(<Composer task="t" onTaskChange={() => {}} onSend={() => {}} canSend={false} />);
    expect((screen.getByLabelText("任务输入") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("输入变更回调 + 提示行默认文案", () => {
    const onTaskChange = vi.fn();
    render(<Composer task="" onTaskChange={onTaskChange} onSend={() => {}} canSend />);
    fireEvent.change(screen.getByLabelText("任务输入"), { target: { value: "新任务" } });
    expect(onTaskChange).toHaveBeenCalledWith("新任务");
    expect(screen.getByText("Enter 发送 · Shift+Enter 换行")).toBeTruthy();
  });
});
