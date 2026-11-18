// SkillPage 单测（issue #39 U3 批 B，验收②双宿主数据一致）：list-skills +
// list-skill-drafts 双拉、采纳/丢弃经 OPTIONS_OPS 同款 op、ok:false/reject fail-soft
// 错误行、无草稿不渲染审阅区。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { OptionsOp } from "@tw/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillPage } from "../src/skill-page.js";

afterEach(cleanup);

const CARDS = [
  {
    host: "a.example",
    slug: "card-a",
    source: "builtin" as const,
    updatedAt: 1,
    draft: false,
  },
];
const DRAFTS = [
  {
    host: "b.example",
    slug: "draft-b",
    description: "d",
    keywords: ["k"],
    sop: "s",
    quirks: "q",
    selectors: "sel",
    createdAt: 1,
  },
];

type Handler = (op: OptionsOp, payload?: unknown) => Promise<unknown>;

function makeRequest(overrides: Partial<Record<OptionsOp, Handler>> = {}): Handler {
  return vi.fn((op: OptionsOp) => {
    const custom = overrides[op];
    if (custom !== undefined) return custom(op);
    switch (op) {
      case "list-skills":
        return Promise.resolve({ ok: true, cards: CARDS });
      case "list-skill-drafts":
        return Promise.resolve({ ok: true, drafts: DRAFTS });
      default:
        return Promise.resolve({ ok: true });
    }
  }) as unknown as Handler;
}

describe("SkillPage", () => {
  it("双拉渲染：技能卡列表 + 待审草稿区", async () => {
    render(<SkillPage request={makeRequest()} />);
    await waitFor(() => {
      expect(screen.getByTestId("skill-page").textContent).toContain("card-a");
    });
    expect(screen.getByTestId("skill-page").textContent).toContain("待审草稿（1）");
    expect(screen.getByTestId("skill-page").textContent).toContain("draft-b");
  });

  it("采纳草稿走 adopt-skill-draft op 并刷新", async () => {
    const req = makeRequest();
    render(<SkillPage request={req} />);
    // 展开草稿行（「审阅」钮）后点「采纳」
    const expander = await screen.findByRole("button", { name: "审阅" });
    fireEvent.click(expander);
    const adoptBtn = await screen.findByRole("button", { name: "采纳" });
    fireEvent.click(adoptBtn);
    await waitFor(() => {
      const calls = (req as unknown as { mock: { calls: Array<[OptionsOp]> } }).mock.calls;
      expect(calls.some(([op]) => op === "adopt-skill-draft")).toBe(true);
      // 刷新（list-skills 至少两次）
      expect(calls.filter(([op]) => op === "list-skills").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("ok:false 信封 → 错误行（不炸页签）", async () => {
    render(
      <SkillPage
        request={makeRequest({
          "list-skills": () => Promise.resolve({ ok: false, error: "存储不可读" }),
        })}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("skill-page").textContent).toContain("存储不可读");
    });
  });

  it("reject（SW 被杀）fail-soft 错误行", async () => {
    render(
      <SkillPage
        request={makeRequest({
          "list-skill-drafts": () => Promise.reject(new Error("port dead")),
        })}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("skill-page").textContent).toContain("port dead");
    });
  });

  it("无草稿——审阅区不渲染", async () => {
    render(
      <SkillPage
        request={makeRequest({
          "list-skill-drafts": () => Promise.resolve({ ok: true, drafts: [] }),
        })}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("skill-page").textContent).toContain("card-a");
    });
    expect(screen.getByTestId("skill-page").textContent).not.toContain("待审草稿");
  });
});
