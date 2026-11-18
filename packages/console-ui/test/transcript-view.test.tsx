// TranscriptView 组件单测（issue #35 U1b B8）：用户气泡（非 done 状态章/附件行）/
// run 块（状态头 + 事件 + 终态结果）/空态。

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RunBlockItem, UserTurnItem } from "../src/transcript.js";
import { isAtBottom, TranscriptView } from "../src/transcript-view.js";

const user = (over: Partial<UserTurnItem> = {}): UserTurnItem => ({
  kind: "user-turn",
  turnId: "t1",
  task: "查价",
  status: "done",
  attachments: [],
  createdAt: 1,
  ...over,
});

const run = (over: Partial<RunBlockItem> = {}): RunBlockItem => ({
  kind: "run-block",
  runId: "r1",
  turnId: "t1",
  status: "done",
  events: [{ seq: 1, type: "step_start", ts: 1, data: { step: 1 } }],
  stepCount: 1,
  startedAt: 1,
  endedAt: 2,
  finalResult: "答：42",
  lastError: null,
  discardedBeforeSeq: 0,
  ...over,
});

describe("TranscriptView", () => {
  it("空态：尚无对话", () => {
    render(<TranscriptView items={[]} />);
    expect(screen.getByText("（尚无对话）")).toBeTruthy();
  });

  it("用户气泡：task 原文；running 出状态章；附件名列出", () => {
    render(
      <TranscriptView
        items={[
          user({
            status: "running",
            attachments: [{ attachmentId: "a1", name: "v.mp4", mimeType: "video/mp4", size: 3 }],
          }),
        ]}
      />,
    );
    expect(screen.getByText("查价")).toBeTruthy();
    expect(screen.getByText("运行中")).toBeTruthy();
    expect(screen.getByText("v.mp4")).toBeTruthy();
  });

  it("run 块：状态头 + 事件行 + 终态结果；live 块无终态结果", () => {
    const { rerender } = render(<TranscriptView items={[run()]} />);
    expect(screen.getByText("完成")).toBeTruthy();
    // 步行会同时出现在分组 summary 与 step_start 行——多重命中即事件面在渲染
    expect(screen.getAllByText(/第 1 步/).length).toBeGreaterThan(0);
    expect(screen.getByText("答：42")).toBeTruthy();
    rerender(
      <TranscriptView items={[run({ status: "live", finalResult: null, endedAt: null })]} />,
    );
    expect(screen.getByText("运行中")).toBeTruthy();
    expect(screen.queryByText(/结束/)).toBeNull();
  });

  it("出错 run：错误红字面（lastError 经 FinalResult）", () => {
    render(
      <TranscriptView
        items={[run({ status: "error", finalResult: null, lastError: "连接断开" })]}
      />,
    );
    expect(screen.getByText("出错")).toBeTruthy();
    expect(screen.getByText("连接断开")).toBeTruthy();
  });
});

describe("TranscriptView 弱替代钮（#41 批 A）", () => {
  it("onReuseTurn 提供：用户气泡出 ↻ 钮，点击回传该 turn；run 块无此钮", () => {
    const reused: string[] = [];
    render(
      <TranscriptView
        items={[user({ turnId: "t9", task: "查价并汇总" }), run({ turnId: "t9" })]}
        onReuseTurn={(item) => reused.push(item.turnId)}
      />,
    );
    const btn = screen.getByTestId("reuse-turn-btn");
    expect(btn.getAttribute("title")).toContain("不自动起跑");
    fireEvent.click(btn);
    expect(reused).toEqual(["t9"]);
  });

  it("onReuseTurn 缺省：钮不渲染（旧宿主零变化）", () => {
    render(<TranscriptView items={[user()]} />);
    expect(screen.queryByTestId("reuse-turn-btn")).toBeNull();
  });
});

describe("TranscriptView 搜索高亮（#41 批 B）", () => {
  it("命中 mark 化 + 当前命中强标识（data-search-ordinal 全局序）；无 highlight 零 mark", () => {
    const { rerender } = render(
      <TranscriptView
        items={[user({ turnId: "t1", task: "查价格、比价格" })]}
        highlight={{ query: "价格", activeOrdinal: 1 }}
      />,
    );
    const marks = screen.getAllByText("价格");
    expect(marks).toHaveLength(2);
    expect(marks[0]?.getAttribute("data-search-ordinal")).toBe("0");
    expect(marks[1]?.getAttribute("data-search-ordinal")).toBe("1");
    expect(marks[1]?.className).toContain("tc-search-hit--active");
    expect(marks[0]?.className).not.toContain("tc-search-hit--active");
    rerender(<TranscriptView items={[user({ turnId: "t1", task: "查价格、比价格" })]} />);
    expect(screen.queryAllByText("价格").length).toBe(0); // 原文整段渲染（无 mark）
    expect(screen.getByText("查价格、比价格")).toBeTruthy();
  });

  it("run 块跨 lastError/finalResult 计序（错误行在结果前——DOM 序）且终态降级纯文本", () => {
    render(
      <TranscriptView
        items={[
          run({
            runId: "r1",
            finalResult: "结果含价格",
            lastError: "价格超时重试",
          }),
        ]}
        highlight={{ query: "价格", activeOrdinal: 2 }}
      />,
    );
    const marks = screen.getAllByText("价格");
    expect(marks).toHaveLength(2);
    // lastError 命中是序 0（DOM 在前），finalResult 命中序 1——active=2 落他处不在本块
    expect(marks[0]?.getAttribute("data-search-ordinal")).toBe("0");
    expect(marks[1]?.getAttribute("data-search-ordinal")).toBe("1");
    // 搜索态终态降级纯文本（markdown 不渲染——命中序不错位）
    expect(screen.getByTestId("final-result-plain")).toBeTruthy();
    expect(screen.queryByTestId("markdown-text")).toBeNull();
  });

  it("跨条目全局序：用户气泡命中在前占序，run 块 base 顺延", () => {
    render(
      <TranscriptView
        items={[
          user({ turnId: "t1", task: "查价格" }),
          run({ runId: "r1", finalResult: "价格 42", lastError: null }),
        ]}
        highlight={{ query: "价格", activeOrdinal: 1 }}
      />,
    );
    const marks = screen.getAllByText(/价格/);
    expect(marks.map((m) => m.getAttribute("data-search-ordinal"))).toEqual(["0", "1"]);
    expect(marks[1]?.className).toContain("tc-search-hit--active");
  });
});

describe("TranscriptView 滚动意图（#37 批 D）", () => {
  it("isAtBottom 判定：距底 ≤28 真 / >28 假；阈值可参", () => {
    expect(isAtBottom(972, 1000, 0)).toBe(true); // 距底 28
    expect(isAtBottom(971, 1000, 0)).toBe(false); // 距底 29
    expect(isAtBottom(90, 100, 0, 20)).toBe(true);
  });

  it("上滚解除 → 浮钮出现；回底/点浮钮 → 恢复跟随、浮钮消失", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      user({ turnId: `t${i}`, task: `第${i}条`, createdAt: i }),
    );
    const { rerender } = render(<TranscriptView items={many} />);
    const el = screen.getByTestId("transcript-view");
    expect(screen.queryByTestId("transcript-jump")).toBeNull(); // 初始跟随无浮钮
    // jsdom 无真实布局：scrollHeight/clientHeight 恒 0——用 scrollTop 模拟距底
    Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 0, configurable: true });
    el.scrollTop = 500; // 距底 500 > 28
    fireEvent.scroll(el);
    expect(screen.getByTestId("transcript-jump")).toBeTruthy();
    // 回底（距底 10）
    el.scrollTop = 990;
    fireEvent.scroll(el);
    expect(screen.queryByTestId("transcript-jump")).toBeNull();
    // 再解除后点浮钮回底
    el.scrollTop = 100;
    fireEvent.scroll(el);
    fireEvent.click(screen.getByTestId("transcript-jump"));
    expect(screen.queryByTestId("transcript-jump")).toBeNull();
    // rerender 保活（items 变更路径不炸）
    rerender(<TranscriptView items={[...many, user({ turnId: "new", task: "新" })]} />);
    expect(screen.getByText("新")).toBeTruthy();
  });
});
