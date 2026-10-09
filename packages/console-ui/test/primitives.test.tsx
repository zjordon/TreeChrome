// 基础件测试：Button 变体类/Badge tone/Field 错误面/Table 列头 + formatBytes。

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge, Button, Field, formatBytes, Table } from "../src/index.js";

describe("基础件", () => {
  it("Button：缺省 ghost/primary/danger 类名 + disabled 透传 + onClick", () => {
    const clicks: string[] = [];
    const { rerender } = render(<Button onClick={() => clicks.push("a")}>跑</Button>);
    const btn = screen.getByRole("button", { name: "跑" });
    expect(btn.className).toContain("tc-btn-ghost");
    fireEvent.click(btn);
    rerender(
      <Button variant="primary" disabled>
        跑
      </Button>,
    );
    expect(screen.getByRole("button", { name: "跑" }).className).toContain("tc-btn-primary");
    expect((screen.getByRole("button", { name: "跑" }) as HTMLButtonElement).disabled).toBe(true);
    expect(clicks).toEqual(["a"]);
  });

  it("Badge：tone 类名", () => {
    render(<Badge tone="success">完成</Badge>);
    expect(screen.getByText("完成").className).toContain("tc-badge-success");
  });

  it("Field：label 关联 + error 渲染（空串不渲染）", () => {
    const { rerender } = render(
      <Field label="卡片名">
        <input />
      </Field>,
    );
    expect(screen.getByText("卡片名")).toBeDefined();
    expect(screen.queryByText("必填")).toBeNull();
    rerender(
      <Field label="卡片名" error="必填">
        <input />
      </Field>,
    );
    expect(screen.getByText("必填")).toBeDefined();
  });

  it("Table：列头行", () => {
    render(
      <Table head={["字段", "值"]}>
        <tr>
          <td>user</td>
          <td>alice</td>
        </tr>
      </Table>,
    );
    expect(screen.getByRole("columnheader", { name: "字段" })).toBeDefined();
    expect(screen.getByRole("cell", { name: "alice" })).toBeDefined();
  });

  it("formatBytes 进制短写", () => {
    expect(formatBytes(3)).toBe("3 B");
    expect(formatBytes(1500)).toBe("1.5 KB");
    expect(formatBytes(2_500_000)).toBe("2.5 MB");
  });
});
