// SearchOverlay 组件单测（issue #41 U4 批 B，验收①）：计数 aria-live 播报 /
// Enter·Shift+Enter 导航 / Esc 关闭 / 受控输入。

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchOverlay } from "../src/search-overlay.js";

const setup = (over: Partial<Parameters<typeof SearchOverlay>[0]> = {}) =>
  render(
    <SearchOverlay
      query="价格"
      onQueryChange={vi.fn()}
      matchIndex={0}
      matchCount={3}
      onPrev={vi.fn()}
      onNext={vi.fn()}
      onClose={vi.fn()}
      {...over}
    />,
  );

describe("SearchOverlay（#41 批 B）", () => {
  it("计数 aria-live 播报：n/N 处；零命中播「无命中」（验收①）", () => {
    const first = setup({ matchIndex: 1, matchCount: 5 });
    const count = screen.getByTestId("search-count");
    expect(count.textContent).toBe("2/5 处");
    expect(count.getAttribute("aria-live")).toBe("polite");
    first.unmount();
    setup({ matchIndex: 0, matchCount: 0 });
    expect(screen.getByTestId("search-count").textContent).toBe("无命中");
  });

  it("Enter 下一处 / Shift+Enter 上一处 / Esc 关闭", () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    const onClose = vi.fn();
    setup({ onNext, onPrev, onClose });
    const input = screen.getByTestId("search-input");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNext).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onPrev).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("受控输入与按钮导航/关闭", () => {
    const onQueryChange = vi.fn();
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const onClose = vi.fn();
    setup({ onQueryChange, onPrev, onNext, onClose });
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "新词" } });
    expect(onQueryChange).toHaveBeenCalledWith("新词");
    fireEvent.click(screen.getByTestId("search-prev"));
    expect(onPrev).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("search-next"));
    expect(onNext).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("search-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
