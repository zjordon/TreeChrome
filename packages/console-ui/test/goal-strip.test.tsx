// GoalStrip/ModelSwitcher/预设模板 单测（#37 U2 批 C）。

import { fireEvent, render, screen } from "@testing-library/react";
import type { ProviderCardDto } from "@tw/protocol";
import { describe, expect, it, vi } from "vitest";
import { GoalStrip, goalLabelOf } from "../src/goal-strip.js";
import { ModelSwitcher } from "../src/model-switcher.js";
import { PRESET_CARDS, ProviderCardForm } from "../src/provider-card-form.js";

describe("GoalStrip", () => {
  it("host+路径投影（>48 截断；短 URL 原样；坏 URL 原样）；点击聚焦回调", () => {
    const long = goalLabelOf("https://www.example.com/some/very/long/path/segments?query=1");
    expect(long.length).toBe(48); // 47 + …
    expect(long.endsWith("…")).toBe(true);
    expect(goalLabelOf("https://a.b/pricing")).toBe("a.b/pricing");
    expect(goalLabelOf("not a url")).toBe("not a url");
    const onFocus = vi.fn();
    render(<GoalStrip url="https://www.example.com/pricing" onFocus={onFocus} />);
    fireEvent.click(screen.getByTestId("goal-strip"));
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("goal-strip").textContent).toContain("www.example.com/pricing");
  });
});

const CARDS: ProviderCardDto[] = [
  {
    name: "主卡",
    protocol: "openai-completions",
    baseUrl: "https://a",
    apiKey: "k1",
    model: "m1",
    maxTokens: 8,
  },
  {
    name: "副卡",
    protocol: "anthropic-messages",
    baseUrl: "https://b",
    apiKey: "k2",
    model: "m2",
    maxTokens: 8,
  },
];

describe("ModelSwitcher", () => {
  function requestFactory(over: { failSave?: boolean } = {}) {
    const calls: Array<{ op: string; payload?: unknown }> = [];
    const request = async (op: string, payload?: unknown): Promise<unknown> => {
      calls.push({ op, payload });
      if (op === "get-settings") {
        return { ok: true, settings: { providerCards: CARDS, activeCard: "主卡" } };
      }
      if (over.failSave === true) return { ok: false, error: "写失败" };
      return { ok: true };
    };
    return { request: request as never, calls };
  }

  it("拉卡列表渲染；点选即 save-settings activeCard 并关闭", async () => {
    const onClose = vi.fn();
    const { request, calls } = requestFactory();
    render(<ModelSwitcher request={request} onClose={onClose} />);
    await screen.findByText("副卡");
    fireEvent.click(screen.getByRole("radio", { name: "激活 副卡" }));
    await screen.findByText(/点选即切换/);
    expect(calls.some((c) => c.op === "save-settings")).toBe(true);
    const save = calls.find((c) => c.op === "save-settings");
    expect(save?.payload).toMatchObject({ activeCard: "副卡", providerCards: CARDS });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("保存失败呈现错误不关闭", async () => {
    const onClose = vi.fn();
    const { request } = requestFactory({ failSave: true });
    render(<ModelSwitcher request={request} onClose={onClose} />);
    await screen.findByText("副卡");
    fireEvent.click(screen.getByRole("radio", { name: "激活 副卡" }));
    await screen.findByText("写失败");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("ProviderCardForm 预设（#37 批 C）", () => {
  const noop = async () => ({ ok: true, message: "" });

  it("新增模式渲染预设钮；点选预填 name/protocol/baseUrl/model（不碰 apiKey）", () => {
    render(<ProviderCardForm onSave={() => {}} onCancel={() => {}} onTest={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "预设 智谱" }));
    expect((screen.getByLabelText(/卡片名/) as HTMLInputElement).value).toBe("智谱");
    expect((screen.getByLabelText(/Base URL/) as HTMLInputElement).value).toContain(
      "open.bigmodel.cn",
    );
    expect((screen.getByLabelText(/模型/) as HTMLInputElement).value).toBe("glm-4.7");
    expect((screen.getByLabelText(/API Key/) as HTMLInputElement).value).toBe("");
  });

  it("已手填名称不被预设覆盖；编辑模式不渲染预设行", () => {
    const { rerender } = render(
      <ProviderCardForm onSave={() => {}} onCancel={() => {}} onTest={noop} />,
    );
    fireEvent.change(screen.getByLabelText(/卡片名/), { target: { value: "我的卡" } });
    fireEvent.click(screen.getByRole("button", { name: "预设 OpenAI" }));
    expect((screen.getByLabelText(/卡片名/) as HTMLInputElement).value).toBe("我的卡");
    expect((screen.getByLabelText(/Base URL/) as HTMLInputElement).value).toContain(
      "api.openai.com",
    );
    rerender(
      <ProviderCardForm card={CARDS[0]} onSave={() => {}} onCancel={() => {}} onTest={noop} />,
    );
    expect(screen.queryByRole("button", { name: /预设/ })).toBeNull();
  });

  it("预设表形态健全：五条、protocol 合法、URL https", () => {
    expect(PRESET_CARDS.length).toBeGreaterThanOrEqual(5);
    for (const p of PRESET_CARDS) {
      expect(["openai-completions", "anthropic-messages", "gemini"]).toContain(p.protocol);
      expect(p.baseUrl.startsWith("https://")).toBe(true);
      expect(p.model).not.toBe("");
    }
  });
});
