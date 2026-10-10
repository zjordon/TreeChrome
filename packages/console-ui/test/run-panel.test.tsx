// StatusLine/FinalResult 测试：状态徽章文案/耗时注入时钟；终态三态着色 + 附件清单。

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FinalResult, formatSeconds, StatusLine } from "../src/index.js";

describe("StatusLine", () => {
  it("六态徽章文案 + 步数 + 耗时（now 注入）", () => {
    render(
      <StatusLine status="awaiting-permission" stepCount={3} startedAt={1_000} endedAt={4_000} />,
    );
    expect(screen.getByText("等待确认")).toBeDefined();
    expect(screen.getByText("步数 3")).toBeDefined();
    expect(screen.getByText("耗时 3s")).toBeDefined();
  });

  it("未结束 → 耗时取 now()；分钟档", () => {
    render(<StatusLine status="running" stepCount={1} startedAt={0} now={() => 90_000} />);
    expect(screen.getByText("耗时 1m30s")).toBeDefined();
  });

  it("formatSeconds 边界", () => {
    expect(formatSeconds(-5)).toBe("0s");
    expect(formatSeconds(59_999)).toBe("1m0s");
    expect(formatSeconds(61_000)).toBe("1m1s");
  });
});

describe("FinalResult", () => {
  it("空载荷（无文本无附件）→ 不渲染", () => {
    const { container } = render(
      <FinalResult finalResult={null} isSuccessful={null} attachments={[]} />,
    );
    expect(container.querySelector("[data-testid='final-result']")).toBeNull();
  });

  it("三态着色：成功/未成功/无判定 + 文本 + 附件名", () => {
    const { rerender } = render(
      <FinalResult finalResult="全部完成" isSuccessful attachments={[]} />,
    );
    expect(screen.getByText("✓ 成功")).toBeDefined();
    expect(screen.getByText("全部完成")).toBeDefined();
    rerender(<FinalResult finalResult="失败" isSuccessful={false} attachments={[]} />);
    expect(screen.getByText("✗ 未成功")).toBeDefined();
    rerender(<FinalResult finalResult="无成功性判定" isSuccessful={null} attachments={[]} />);
    expect(screen.getByText("结束")).toBeDefined();
  });

  it("附件清单（名称 + 体积）", () => {
    render(
      <FinalResult
        finalResult={null}
        isSuccessful
        attachments={[
          { attachmentId: "att_1", name: "v.mp4", mimeType: "video/mp4", size: 2_500_000 },
        ]}
      />,
    );
    expect(screen.getByText(/v\.mp4（2\.5 MB）/)).toBeDefined();
  });
});

describe("FinalResult.lastError（段 F 验收反馈：错误原因可见性）", () => {
  it("error/interrupted 终态：lastError 红字渲染 + 失败徽章（无 finalResult 也渲染）", () => {
    const { container } = render(
      <FinalResult
        finalResult={null}
        isSuccessful={null}
        attachments={[]}
        lastError="LLM 401 unauthorized"
      />,
    );
    expect(container.querySelector("[data-testid='final-result']")).not.toBeNull();
    expect(screen.getByText("✗ 失败原因")).toBeDefined();
    expect(screen.getByText("LLM 401 unauthorized").className).toContain("tc-ev-err");
  });

  it("done 终态无 lastError：维持原三态渲染不受影响", () => {
    render(<FinalResult finalResult="ok" isSuccessful attachments={[]} lastError={null} />);
    expect(screen.getByText("✓ 成功")).toBeDefined();
    expect(screen.queryByText("✗ 失败原因")).toBeNull();
  });
});
