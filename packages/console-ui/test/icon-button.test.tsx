// IconButton 单测（issue #20 M2）：可访问名必填语义、尺寸/变体类名、disabled 透传。

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IconButton } from "../src/index.js";

describe("IconButton", () => {
  it("label 注入 aria-label 与 title（可访问名同源），children 渲染为内容", () => {
    render(<IconButton label="关闭">✕</IconButton>);
    const btn = screen.getByRole("button", { name: "关闭" });
    expect(btn.getAttribute("aria-label")).toBe("关闭");
    expect(btn.getAttribute("title")).toBe("关闭");
    expect(btn.textContent).toBe("✕");
  });

  it("默认尺寸 md；xs/sm 档与 secondary/danger 变体类名", () => {
    const { rerender } = render(<IconButton label="操作">✕</IconButton>);
    expect(screen.getByRole("button").className).toContain("tc-icon-btn--md");
    rerender(
      <IconButton label="操作" size="xs">
        ✕
      </IconButton>,
    );
    expect(screen.getByRole("button").className).toContain("tc-icon-btn--xs");
    rerender(
      <IconButton label="操作" size="sm" variant="danger">
        ✕
      </IconButton>,
    );
    const cls = screen.getByRole("button").className;
    expect(cls).toContain("tc-icon-btn--sm");
    expect(cls).toContain("tc-icon-btn-danger");
    rerender(
      <IconButton label="操作" variant="secondary">
        ✕
      </IconButton>,
    );
    expect(screen.getByRole("button").className).toContain("tc-icon-btn-secondary");
  });

  it("disabled 透传原生属性", () => {
    render(
      <IconButton label="操作" disabled>
        ✕
      </IconButton>,
    );
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });
});
