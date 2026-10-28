// WelcomePanel 单测（issue #20 M3）：标题/tagline/引导文案渲染。

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WelcomePanel } from "../src/index.js";

describe("WelcomePanel", () => {
  it("标题 + tagline + 缺省引导", () => {
    render(<WelcomePanel title="TreeChrome" tagline="浏览器里的任务代理" />);
    expect(screen.getByText("TreeChrome").className).toContain("tc-welcome-title");
    expect(screen.getByText("浏览器里的任务代理")).toBeDefined();
    expect(screen.getByText(/在下方输入任务开始/)).toBeDefined();
  });

  it("hint 可覆写", () => {
    render(<WelcomePanel title="t" tagline="s" hint="自定义引导" />);
    expect(screen.getByText("自定义引导")).toBeDefined();
  });
});
