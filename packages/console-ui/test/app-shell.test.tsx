// AppShell 单测（issue #20 M3）：三区结构渲染（header/main/dock 各归其位）。

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "../src/index.js";

describe("AppShell", () => {
  it("header/main/dock 三区：各节点类名与内容归位", () => {
    render(
      <AppShell header={<span>头部</span>} dock={<span>底栏</span>}>
        <p>主体</p>
      </AppShell>,
    );
    expect(document.querySelector(".tc-shell > .tc-shell-header")?.textContent).toContain("头部");
    expect(document.querySelector(".tc-shell > .tc-shell-main")?.textContent).toContain("主体");
    expect(document.querySelector(".tc-shell > .tc-shell-dock")?.textContent).toContain("底栏");
  });

  it("main 是语义化 landmark（role=navigation 之外的主区）", () => {
    render(<AppShell>内容</AppShell>);
    expect(screen.getByRole("main").textContent).toBe("内容");
  });

  it("缺省 header/dock 不渲染空节点", () => {
    render(<AppShell>内容</AppShell>);
    expect(document.querySelector(".tc-shell-header")).toBeNull();
    expect(document.querySelector(".tc-shell-dock")).toBeNull();
  });
});
