// Segment 单测（issue #20 M2）：受控 active 态（aria-pressed）、onChange 回调、group 可访问名。

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Segment } from "../src/index.js";

const ITEMS = [
  { value: "models", label: "模型" },
  { value: "skills", label: "技能" },
  { value: "grants", label: "授权" },
];

describe("Segment", () => {
  it("group 可访问名 + active 项 aria-pressed", () => {
    render(<Segment items={ITEMS} value="skills" onChange={() => {}} ariaLabel="设置分类" />);
    expect(screen.getByRole("group", { name: "设置分类" })).toBeDefined();
    const active = screen.getByRole("button", { name: "技能" });
    expect(active.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "模型" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("受控：点击上报 value，active 态由父层 value 决定", () => {
    const onChange = vi.fn();
    render(<Segment items={ITEMS} value="models" onChange={onChange} ariaLabel="设置分类" />);
    fireEvent.click(screen.getByRole("button", { name: "授权" }));
    expect(onChange).toHaveBeenCalledWith("grants");
    // 受控——父层未变，active 仍在 models
    expect(screen.getByRole("button", { name: "模型" }).getAttribute("aria-pressed")).toBe("true");
  });
});
