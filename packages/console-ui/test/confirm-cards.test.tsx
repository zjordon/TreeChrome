// PermissionCard/SubmitCard 测试：三按钮回调/倒计时条收敛（fake timers + now 注入）/
// 字段表与超长截断/空字段态。

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { PermissionCardPayload } from "@tw/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clipValue, PermissionCard, SubmitCard } from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

const REQ: PermissionCardPayload = {
  capability: "CLICK",
  host: "a.example",
  actionName: "click",
  params: { index: 3 },
  tabId: 7,
  elementIndex: 3,
  elementBbox: { left: 1, top: 2, width: 30, height: 40 },
  elementXpath: "//button[1]",
  label: "点击",
  expiresAt: 10_000,
};

describe("PermissionCard", () => {
  it("卡面：标签/host/动作/参数表/xpath/bbox + 三按钮 verdict 回调", () => {
    const verdicts: string[] = [];
    render(<PermissionCard req={REQ} onResolve={(v) => verdicts.push(v)} expiresAt={10_000} />);
    expect(screen.getByText("权限确认：点击")).toBeDefined();
    expect(screen.getByText("a.example")).toBeDefined();
    expect(screen.getByText("click #3")).toBeDefined();
    expect(screen.getByText(/"index": 3/)).toBeDefined();
    expect(screen.getByText("//button[1]")).toBeDefined();
    expect(screen.getByText("(1,2) 30×40")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "本次允许" }));
    fireEvent.click(screen.getByRole("button", { name: "总是允许" }));
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    expect(verdicts).toEqual(["allow-once", "allow-always", "deny"]);
  });

  it("倒计时条：注入 now 收敛 + 定时 tick 更新 + 卸载清理", () => {
    vi.useFakeTimers();
    let fakeNow = 0;
    render(
      <PermissionCard
        req={REQ}
        onResolve={() => {}}
        expiresAt={10_000}
        totalMs={10_000}
        now={() => fakeNow}
      />,
    );
    const bar = screen.getByLabelText("剩余确认时间").firstElementChild as HTMLDivElement;
    expect(bar.style.width).toBe("100%");
    fakeNow = 5_000;
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(bar.style.width).toBe("50%");
    fakeNow = 20_000; // 过期钳 0
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(bar.style.width).toBe("0%");
  });
});

describe("SubmitCard", () => {
  it("字段摘要表 + 确认/取消回调", () => {
    let decided = "";
    render(
      <SubmitCard
        req={REQ}
        fields={[
          { name: "user", value: "alice" },
          { name: "pwd", value: "***" },
        ]}
        onConfirm={() => (decided = "yes")}
        onCancel={() => (decided = "no")}
      />,
    );
    expect(screen.getByRole("cell", { name: "user" })).toBeDefined();
    expect(screen.getByRole("cell", { name: "***" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "确认提交" }));
    expect(decided).toBe("yes");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(decided).toBe("no");
  });

  it("空字段态 + clipValue 40 字符截断", () => {
    expect(clipValue("short")).toBe("short");
    expect(clipValue("y".repeat(50))).toHaveLength(41);
    render(<SubmitCard req={REQ} fields={[]} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText("（无字段变更摘要）")).toBeDefined();
  });
});
