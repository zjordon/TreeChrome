// SessionsPage 组件单测（issue #35 U1b B8）：列表投影/打开切换/行内重命名
// （Enter 提交、Escape 回退、空题回退）/两段删除/新对话/空态。

import { fireEvent, render, screen } from "@testing-library/react";
import type { SessionMeta } from "@tw/protocol";
import { describe, expect, it, vi } from "vitest";
import { SessionsPage } from "../src/sessions-page.js";

const meta = (sessionId: string, over: Partial<SessionMeta> = {}): SessionMeta => ({
  sessionId,
  tabId: 7,
  title: `会话 ${sessionId}`,
  origin: "user",
  runCount: 2,
  lastStatus: "done",
  createdAt: 1,
  updatedAt: 100,
  usageTokens: 50,
  attachmentCount: 0,
  ...over,
});

describe("SessionsPage", () => {
  it("空态：引导文案 + 新对话钮仍可用", () => {
    const onNew = vi.fn();
    render(
      <SessionsPage
        sessions={[]}
        currentSessionId={null}
        onOpen={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        onNew={onNew}
      />,
    );
    expect(screen.getByText(/还没有历史会话/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /新对话/ }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("列表投影：轮数/状态/外部标识；打开切换回调带 sessionId", () => {
    const onOpen = vi.fn();
    render(
      <SessionsPage
        sessions={[meta("s1"), meta("s2", { origin: "bridge", lastStatus: null, runCount: 0 })]}
        currentSessionId="s1"
        onOpen={onOpen}
        onRename={() => {}}
        onDelete={() => {}}
        onNew={() => {}}
      />,
    );
    expect(screen.getByText(/2 轮 · 完成/)).toBeTruthy();
    expect(screen.getByText(/外部 · 0 轮 · 未跑/)).toBeTruthy();
    fireEvent.click(screen.getByText("会话 s2"));
    expect(onOpen).toHaveBeenCalledWith("s2");
  });

  it("行内重命名：Enter 提交；Escape 回退不提交；空题回退", () => {
    const onRename = vi.fn();
    render(
      <SessionsPage
        sessions={[meta("s1")]}
        currentSessionId="s1"
        onOpen={() => {}}
        onRename={onRename}
        onDelete={() => {}}
        onNew={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /重命名 会话 s1/ }));
    const input = screen.getByLabelText("重命名会话");
    fireEvent.change(input, { target: { value: "新名" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("s1", "新名");
    // Escape 路径
    fireEvent.click(screen.getByRole("button", { name: /重命名 会话 s1/ }));
    const input2 = screen.getByLabelText("重命名会话");
    fireEvent.change(input2, { target: { value: "x" } });
    fireEvent.keyDown(input2, { key: "Escape" });
    expect(onRename).toHaveBeenCalledTimes(1);
    // 空题回退
    fireEvent.click(screen.getByRole("button", { name: /重命名 会话 s1/ }));
    const input3 = screen.getByLabelText("重命名会话");
    fireEvent.change(input3, { target: { value: "   " } });
    fireEvent.keyDown(input3, { key: "Enter" });
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("两段删除：先确认钮，确认才回调", () => {
    const onDelete = vi.fn();
    render(
      <SessionsPage
        sessions={[meta("s1")]}
        currentSessionId={null}
        onOpen={() => {}}
        onRename={() => {}}
        onDelete={onDelete}
        onNew={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /删除 会话 s1/ }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /确认删除 会话 s1/ }));
    expect(onDelete).toHaveBeenCalledWith("s1");
  });
});
