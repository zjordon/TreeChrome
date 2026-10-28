// RunPanelHeader 单测（issue #20 M3）：连接状态点、蒸馏状态（failed 红）、草稿徽标、设置入口。

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { distillStatusText, RunPanelHeader } from "../src/index.js";

describe("RunPanelHeader", () => {
  it("标题 + 连接状态点三态类名", () => {
    const { rerender } = render(<RunPanelHeader title="TreeChrome" portStatus="online" />);
    expect(screen.getByText("TreeChrome")).toBeDefined();
    expect(document.querySelector(".tc-port-dot")).not.toBeNull();
    rerender(<RunPanelHeader title="t" portStatus="connecting" />);
    expect(document.querySelector(".tc-port-dot--connecting")).not.toBeNull();
    rerender(<RunPanelHeader title="t" portStatus="offline" />);
    expect(document.querySelector(".tc-port-dot--offline")).not.toBeNull();
    rerender(<RunPanelHeader title="t" />);
    expect(document.querySelector(".tc-port-dot")).toBeNull();
  });

  it("蒸馏状态：glyph + title 全文；failed 红色类", () => {
    render(<RunPanelHeader title="t" distill={{ phase: "done", detail: null }} />);
    expect(screen.getByTitle(distillStatusText({ phase: "done", detail: null })).textContent).toBe(
      "✓",
    );
    render(<RunPanelHeader title="t" distill={{ phase: "failed", detail: "LLM 400" }} />);
    expect(screen.getByTitle(/蒸馏失败：LLM 400/).className).toContain("tc-ev-err");
  });

  it("草稿徽标：count>0 渲染可点，缺省回退 onOpenSettings", () => {
    const onOpen = vi.fn();
    const onReview = vi.fn();
    const { rerender } = render(
      <RunPanelHeader title="t" draftCount={2} onOpenSettings={onOpen} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /2 草稿/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    rerender(
      <RunPanelHeader title="t" draftCount={2} onOpenSettings={onOpen} onReviewDrafts={onReview} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /2 草稿/ }));
    expect(onReview).toHaveBeenCalledTimes(1);
    rerender(<RunPanelHeader title="t" draftCount={0} />);
    expect(screen.queryByRole("button", { name: /草稿/ })).toBeNull();
  });

  it("设置入口：aria-label=设置；缺省 onOpenSettings 不渲染", () => {
    const onOpen = vi.fn();
    const { rerender } = render(<RunPanelHeader title="t" onOpenSettings={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    rerender(<RunPanelHeader title="t" />);
    expect(screen.queryByRole("button", { name: "设置" })).toBeNull();
  });
});
