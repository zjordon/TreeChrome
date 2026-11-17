// RunStatusBar/FinalResult 测试（issue #20 M3：StatusLine 已由 RunStatusBar 替代）：
// 状态文案/耗时注入时钟/停止钮；终态三态着色 + 附件清单。

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ExternalDriveCard,
  FinalResult,
  formatSeconds,
  formatTokens,
  RunStatusBar,
} from "../src/index.js";

describe("RunStatusBar", () => {
  it("状态文案 + 步数·耗时（endedAt 注入）；等待态警示点", () => {
    render(
      <RunStatusBar status="awaiting-permission" stepCount={3} startedAt={1_000} endedAt={4_000} />,
    );
    expect(screen.getByText("等待确认 · 第 3 步 · 3s")).toBeDefined();
    expect(document.querySelector(".tc-runstatus-dot--waiting")).not.toBeNull();
  });

  it("未结束 → now()；分钟档；停止钮回调与缺省不渲染", () => {
    const stops: number[] = [];
    const { rerender } = render(
      <RunStatusBar
        status="running"
        stepCount={1}
        startedAt={0}
        now={() => 90_000}
        onStop={() => stops.push(1)}
      />,
    );
    expect(screen.getByText(/运行中 · 第 1 步 · 1m30s/)).toBeDefined();
    expect(document.querySelector(".tc-runstatus-dot--waiting")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(stops).toEqual([1]);
    rerender(<RunStatusBar status="running" stepCount={1} startedAt={0} now={() => 90_000} />);
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
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

  it("Judge 结论（issue #5）：通过徽章 / 拒绝徽章 + 折叠判词（蒸馏门控可见）", () => {
    const { rerender } = render(
      <FinalResult
        finalResult="ok"
        isSuccessful
        attachments={[]}
        judgement={{ verdict: true, reasoning: "完成", failureReason: null }}
      />,
    );
    expect(screen.getByText("✓ Judge 通过")).toBeDefined();
    expect(screen.queryByText(/Judge 判词/)).toBeNull(); // 通过不展开判词
    rerender(
      <FinalResult
        finalResult="ok"
        isSuccessful
        attachments={[]}
        judgement={{ verdict: false, reasoning: "封面弹层从未打开", failureReason: "证据不足" }}
      />,
    );
    expect(screen.getByText("✗ Judge 未通过")).toBeDefined();
    expect(screen.getByText(/封面弹层从未打开/)).toBeDefined(); // 判词折叠仍在 DOM
    expect(screen.getByText(/证据不足/)).toBeDefined();
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

describe("RunStatusBar 上下文用量 pill（#37 批 B）", () => {
  it("usage 注入：数值+分母短写；≥90% 警色类", () => {
    const { container, rerender } = render(
      <RunStatusBar
        status="running"
        stepCount={1}
        startedAt={0}
        endedAt={1000}
        usage={{ inputTokens: 9_800, contextWindow: 128_000 }}
      />,
    );
    const pill = container.querySelector(".tc-runstatus-usage");
    expect(pill?.textContent).toBe("上下文 9.8k / 128k");
    expect(pill?.className).not.toContain("tc-runstatus-usage--warn");
    rerender(
      <RunStatusBar
        status="running"
        stepCount={1}
        startedAt={0}
        endedAt={1000}
        usage={{ inputTokens: 120_000, contextWindow: 128_000 }}
      />,
    );
    const warn = container.querySelector(".tc-runstatus-usage");
    expect(warn?.textContent).toBe("上下文 120k / 128k");
    expect(warn?.className).toContain("tc-runstatus-usage--warn");
  });

  it("contextWindow null：只显绝对量不显分母；usage 缺省不渲染 pill", () => {
    const { container } = render(
      <RunStatusBar
        status="running"
        stepCount={1}
        startedAt={0}
        endedAt={1000}
        usage={{ inputTokens: 500, contextWindow: null }}
      />,
    );
    expect(container.querySelector(".tc-runstatus-usage")?.textContent).toBe("上下文 500");
    const bare = render(<RunStatusBar status="running" stepCount={1} startedAt={0} endedAt={1} />);
    expect(bare.container.querySelector(".tc-runstatus-usage")).toBeNull();
  });

  it("formatTokens 短写梯度：999/1.2k/12k/1.2M", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(12_340)).toBe("12k");
    expect(formatTokens(1_234_000)).toBe("1.2M");
  });
});

describe("ExternalDriveCard（#37 批 B）", () => {
  it("外部直驱说明卡：标题/会话名/只读说明/停止留权文案", () => {
    render(<ExternalDriveCard sessionTitle="外部查价" />);
    expect(screen.getByText("外部客户端直驱中")).toBeTruthy();
    expect(screen.getByText("会话：外部查价")).toBeTruthy();
    expect(screen.getByText(/这里只能查看/)).toBeTruthy();
    expect(screen.getByText(/仍可随时/)).toBeTruthy();
  });

  it("sessionTitle 缺省不渲染会话行", () => {
    render(<ExternalDriveCard />);
    expect(screen.queryByText(/^会话：/)).toBeNull();
  });
});
