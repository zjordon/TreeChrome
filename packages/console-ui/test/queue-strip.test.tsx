// QueueStrip 组件单测（#37 U2 批 A）：空态不渲染/列表投影（计数+截断）/撤销回调。

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueueStrip } from "../src/queue-strip.js";

describe("QueueStrip", () => {
  it("空态：不渲染", () => {
    const { container } = render(<QueueStrip turns={[]} onRemove={() => {}} />);
    expect(container.querySelector('[data-testid="queue-strip"]')).toBeNull();
  });

  it("列表投影：计数 + 任务摘要（>60 截断）；撤销回调带 turnId", () => {
    const onRemove = vi.fn();
    const long = "长".repeat(80);
    render(
      <QueueStrip
        turns={[
          { turnId: "t1", task: "查价" },
          { turnId: "t2", task: long },
        ]}
        onRemove={onRemove}
      />,
    );
    expect(screen.getByText(/排队中（2）/)).toBeTruthy();
    expect(screen.getByText(/⧗ 查价/)).toBeTruthy();
    expect(screen.getByText(new RegExp(`⧗ ${"长".repeat(60)}…`))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /撤销排队 查价/ }));
    expect(onRemove).toHaveBeenCalledWith("t1");
  });
});
