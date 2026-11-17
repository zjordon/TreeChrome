// PageTabs 单测（issue #39 U3 批 B）：tablist 语义（aria-selected）、切换回调、
// 空数组不渲染、键盘左右移动焦点（roving）。toggle 语义在宿主 onSelect 裁决
//（点活动页签回聊天）——组件只如实上报。

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageTabs } from "../src/page-tabs.js";

afterEach(cleanup);

const PAGES = [
  { id: "tasks", title: "任务" },
  { id: "skills", title: "技能" },
  { id: "debug", title: "调试" },
];

describe("PageTabs", () => {
  it("渲染 tablist 与全部页签；aria-selected 反映 activeId", () => {
    render(<PageTabs pages={PAGES} activeId="skills" onSelect={() => {}} />);
    const list = screen.getByTestId("page-tabs");
    expect(list.getAttribute("role")).toBe("tablist");
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("false");
  });

  it("activeId=null（聊天主视图）——无页签选中；点击上报 id（含活动中的——toggle 由宿主）", () => {
    const onSelect = vi.fn();
    render(<PageTabs pages={PAGES} activeId={null} onSelect={onSelect} />);
    expect(
      screen.getAllByRole("tab").every((t) => t.getAttribute("aria-selected") === "false"),
    ).toBe(true);
    fireEvent.click(screen.getByTestId("page-tab-debug"));
    expect(onSelect).toHaveBeenCalledWith("debug");
  });

  it("点活动中的页签也如实上报（宿主 toggle 回聊天）", () => {
    const onSelect = vi.fn();
    render(<PageTabs pages={PAGES} activeId="tasks" onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("page-tab-tasks"));
    expect(onSelect).toHaveBeenCalledWith("tasks");
  });

  it("键盘 ArrowRight/Left 移动焦点（循环）", () => {
    render(<PageTabs pages={PAGES} activeId={null} onSelect={() => {}} />);
    const first = screen.getByTestId("page-tab-tasks");
    first.focus();
    fireEvent.keyDown(screen.getByTestId("page-tabs"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByTestId("page-tab-skills"));
    fireEvent.keyDown(screen.getByTestId("page-tabs"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByTestId("page-tab-tasks"));
    fireEvent.keyDown(screen.getByTestId("page-tabs"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByTestId("page-tab-debug"));
  });

  it("空 pages 不渲染", () => {
    const { container } = render(<PageTabs pages={[]} activeId={null} onSelect={() => {}} />);
    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });
});
