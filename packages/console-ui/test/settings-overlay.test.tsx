// SettingsOverlay 单测（issue #20 M4）：开合渲染、三条关闭路径（× 钮 / backdrop / Esc）、
// dialog 语义。

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsOverlay } from "../src/index.js";

describe("SettingsOverlay", () => {
  it("open=false 不渲染；open 渲染 dialog 语义 + 标题 + 内容", () => {
    const { rerender } = render(
      <SettingsOverlay open={false} onClose={() => {}} title="设置">
        内容
      </SettingsOverlay>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(
      <SettingsOverlay open={true} onClose={() => {}} title="设置">
        内容
      </SettingsOverlay>,
    );
    expect(screen.getByRole("dialog", { name: "设置" })).toBeDefined();
    expect(screen.getByText("内容")).toBeDefined();
  });

  it("三条关闭路径：× 钮 / backdrop 点击 / Esc", () => {
    const onClose = vi.fn();
    render(
      <SettingsOverlay open={true} onClose={onClose} title="设置">
        内容
      </SettingsOverlay>,
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(document.querySelector(".tc-settings-backdrop") as Element);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
    // 非 Esc 键不触发
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
