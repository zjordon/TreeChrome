// 字号档位 + 会话标题条单测（issue #39 U3 批 C，验收⑤）：档位持久化/坏值回退
// md/档位类挂 html、双主题由 token 继承（结构断言）；标题行内重命名三路径
//（Enter 提交/Escape 取消/isComposing 守卫）与空题/同题不提交。

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FONT_SIZE_KEY, FontSizePopover, initFontSize, readFontSize } from "../src/font-size.js";
import { SessionTitleBar } from "../src/session-title-bar.js";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.className = "";
});

describe("readFontSize", () => {
  it("缺省/坏值回退 md；合法值透传；storage 抛错回退 md", () => {
    expect(readFontSize()).toBe("md");
    window.localStorage.setItem(FONT_SIZE_KEY, "lg");
    expect(readFontSize()).toBe("lg");
    window.localStorage.setItem(FONT_SIZE_KEY, "xxx");
    expect(readFontSize()).toBe("md");
    const spy = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readFontSize()).toBe("md");
    spy.mockRestore();
  });
});

describe("initFontSize（冷启动恢复——轮 1 [7]）", () => {
  it("读 localStorage 并挂档位类：欢迎页/页签页无弹卡也生效", () => {
    window.localStorage.setItem(FONT_SIZE_KEY, "lg");
    const restored = initFontSize();
    expect(restored).toBe("lg");
    expect(document.documentElement.classList.contains("tc-font-lg")).toBe(true);
  });

  it("无偏好时 md——不挂任何档位类", () => {
    expect(initFontSize()).toBe("md");
    expect(document.documentElement.className).toBe("");
  });
});

describe("FontSizePopover（验收⑤持久化 + 档位类）", () => {
  it("选择档位：html 挂对应类 + localStorage 持久化；md 无类", () => {
    render(<FontSizePopover />);
    fireEvent.click(screen.getByTestId("font-size-toggle"));
    fireEvent.click(screen.getByTestId("font-size-lg"));
    expect(document.documentElement.classList.contains("tc-font-lg")).toBe(true);
    expect(window.localStorage.getItem(FONT_SIZE_KEY)).toBe("lg");
    // 重开再切 md——类摘除
    fireEvent.click(screen.getByTestId("font-size-toggle"));
    fireEvent.click(screen.getByTestId("font-size-md"));
    expect(document.documentElement.classList.contains("tc-font-lg")).toBe(false);
    expect(window.localStorage.getItem(FONT_SIZE_KEY)).toBe("md");
  });

  it("初值来自 localStorage（挂载即应用档位类）", () => {
    window.localStorage.setItem(FONT_SIZE_KEY, "sm");
    render(<FontSizePopover />);
    expect(document.documentElement.classList.contains("tc-font-sm")).toBe(true);
  });

  it("Esc 关闭弹卡；aria-expanded 反映", () => {
    render(<FontSizePopover />);
    const toggle = screen.getByTestId("font-size-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(toggle, { key: "Escape" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("SessionTitleBar", () => {
  it("点击标题进入编辑；Enter 提交新题；Escape 取消不提交", () => {
    const onRename = vi.fn();
    render(<SessionTitleBar title="旧标题" onRename={onRename} />);
    fireEvent.click(screen.getByTestId("session-title"));
    const input = screen.getByTestId("session-title-input");
    fireEvent.change(input, { target: { value: "新标题" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("新标题");
    // 再编辑后 Escape——不提交
    fireEvent.click(screen.getByTestId("session-title"));
    fireEvent.change(screen.getByTestId("session-title-input"), {
      target: { value: "另一题" },
    });
    fireEvent.keyDown(screen.getByTestId("session-title-input"), { key: "Escape" });
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("空题/同题不提交；isComposing 的 Enter 不提交", () => {
    const onRename = vi.fn();
    render(<SessionTitleBar title="标题" onRename={onRename} />);
    fireEvent.click(screen.getByTestId("session-title"));
    const input = screen.getByTestId("session-title-input");
    // IME 组字确认
    fireEvent.keyDown(input, { key: "Enter", nativeEvent: { isComposing: true } } as never);
    expect(onRename).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "标题" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).not.toHaveBeenCalled();
  });

  it("actions 插槽渲染（字号/导出由宿主注入）", () => {
    render(
      <SessionTitleBar title="t" onRename={() => {}} actions={<button type="button">X</button>} />,
    );
    expect(screen.getByText("X")).not.toBeNull();
  });
});
