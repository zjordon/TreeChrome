// options 三件测试：ProviderCardForm 校验（protocol 必填/baseUrl 形态/数值面）与
// onSave 载荷、测试连接异步回显、增删面；ProviderList 激活/编辑/新增；GrantsView
// 撤销；SkillListView 只读投影。

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Grant, ProviderCardDto } from "@tw/protocol";
import { describe, expect, it } from "vitest";
import {
  formStateOf,
  GrantsView,
  ProviderCardForm,
  ProviderList,
  type SkillDraftEdits,
  SkillDraftReview,
  SkillListView,
  validateCardForm,
} from "../src/index.js";

const CARD: ProviderCardDto = {
  name: "main",
  protocol: "anthropic-messages",
  baseUrl: "https://api.example",
  apiKey: "k",
  model: "m",
  maxTokens: 4096,
};

describe("validateCardForm（纯函数）", () => {
  it("空态全错集 + baseUrl 形态 + 数值面", () => {
    const base = formStateOf();
    expect(Object.keys(validateCardForm(base))).toEqual(["name", "baseUrl", "apiKey", "model"]);
    expect(
      validateCardForm({ ...base, baseUrl: "ftp://x", name: "n", apiKey: "k", model: "m" }).baseUrl,
    ).toBe("须以 http:// 或 https:// 开头");
    const ok = validateCardForm({
      ...formStateOf(CARD),
      maxTokens: "16384",
      temperature: "0.7",
    });
    expect(ok).toEqual({});
    expect(validateCardForm({ ...formStateOf(CARD), maxTokens: "0" }).maxTokens).toBe("须为正整数");
    expect(validateCardForm({ ...formStateOf(CARD), maxTokens: "1.5" }).maxTokens).toBe(
      "须为正整数",
    );
    expect(validateCardForm({ ...formStateOf(CARD), temperature: "3" }).temperature).toBe(
      "0-2 之间",
    );
  });

  it("formStateOf：缺省协议 openai-completions/maxTokens 16384；卡片回填", () => {
    expect(formStateOf()).toMatchObject({ protocol: "openai-completions", maxTokens: "16384" });
    expect(formStateOf(CARD)).toMatchObject({ name: "main", baseUrl: "https://api.example" });
    expect(formStateOf({ ...CARD, temperature: 0.5 }).temperature).toBe("0.5");
  });
});

describe("ProviderCardForm", () => {
  it("合法输入 → onSave 收完整卡（trim + 数值化 + 可选温度省键 + 原名 null）", () => {
    const saved: Array<[ProviderCardDto, string | null]> = [];
    render(
      <ProviderCardForm
        onSave={(c, orig) => saved.push([c, orig])}
        onCancel={() => {}}
        onTest={async () => ({ ok: true, message: "" })}
      />,
    );
    fireEvent.change(screen.getByLabelText("卡片名"), { target: { value: " glm " } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://api" } });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: " k " } });
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: " glm-5 " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(saved).toEqual([
      [
        {
          name: "glm",
          protocol: "openai-completions",
          baseUrl: "https://api",
          apiKey: "k",
          model: "glm-5",
          maxTokens: 16384,
        },
        null,
      ],
    ]);
  });

  it("编辑保存：onSave 带原卡名 + 高级字段原样透传（不剥离）+ apiKey 遮挡输入", () => {
    const saved: Array<[ProviderCardDto, string | null]> = [];
    const advanced: ProviderCardDto = {
      ...CARD,
      maxTokensField: "max_completion_tokens",
      temperatureSuppressed: true,
      capabilities: { supportsVision: true },
      fallback: { ...CARD, name: "backup" },
    };
    render(
      <ProviderCardForm
        card={advanced}
        onSave={(c, orig) => saved.push([c, orig])}
        onCancel={() => {}}
        onTest={async () => ({ ok: true, message: "" })}
      />,
    );
    // apiKey 输入遮挡（屏幕共享泄露面）
    expect((screen.getByLabelText("API Key") as HTMLInputElement).type).toBe("password");
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "gpt-5" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(saved).toHaveLength(1);
    const [card, orig] = saved[0];
    expect(orig).toBe("main"); // 原名回传（宿主按原名替换）
    expect(card.model).toBe("gpt-5");
    expect(card.maxTokensField).toBe("max_completion_tokens");
    expect(card.temperatureSuppressed).toBe(true);
    expect(card.capabilities).toEqual({ supportsVision: true });
    expect(card.fallback).toMatchObject({ name: "backup" });
  });

  it("非法输入 → 错误文案 + 不 onSave", () => {
    const saved: Array<[ProviderCardDto, string | null]> = [];
    render(
      <ProviderCardForm
        onSave={(c, orig) => saved.push([c, orig])}
        onCancel={() => {}}
        onTest={async () => ({ ok: true, message: "" })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getAllByText("必填")).toHaveLength(4);
    expect(saved).toEqual([]);
  });

  it("切换编辑目标/新增不重挂时表单态跟随新 card 重置（轮 2 [1] 混源保存防线）", () => {
    const saved: Array<[ProviderCardDto, string | null]> = [];
    const { rerender } = render(
      <ProviderCardForm
        card={CARD}
        onSave={(c, orig) => saved.push([c, orig])}
        onCancel={() => {}}
        onTest={async () => ({ ok: true, message: "" })}
      />,
    );
    // 编辑 A 中改字段 → 不关表单直接切到卡 B：字段必须重置为 B
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "A 的改动" } });
    rerender(
      <ProviderCardForm
        card={{ ...CARD, name: "B", model: "b-model", apiKey: "b-key" }}
        onSave={(c, orig) => saved.push([c, orig])}
        onCancel={() => {}}
        onTest={async () => ({ ok: true, message: "" })}
      />,
    );
    expect((screen.getByLabelText("模型") as HTMLInputElement).value).toBe("b-model");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(saved).toHaveLength(1);
    const [saved1, orig1] = saved[0];
    expect(orig1).toBe("B"); // 原名跟随新 card（不再是 A）
    expect(saved1.model).toBe("b-model");
    expect(saved1.apiKey).toBe("b-key"); // 密钥不再混源
    // 切到新增（card=undefined）：表单清空 + 原名 null
    rerender(
      <ProviderCardForm
        onSave={(c, orig) => saved.push([c, orig])}
        onCancel={() => {}}
        onTest={async () => ({ ok: true, message: "" })}
      />,
    );
    expect((screen.getByLabelText("模型") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "n" } });
    fireEvent.change(screen.getByLabelText("卡片名"), { target: { value: "n" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://x" } });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "k" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(saved[1][1]).toBeNull();
    expect(saved[1][0]).not.toHaveProperty("maxTokensField"); // 新增不带他卡高级字段
  });

  it("测试连接：loading 态 + 异步结果回显；编辑态出删除钮", async () => {
    const holder: { resolve?: (r: { ok: boolean; message: string }) => void } = {};
    render(
      <ProviderCardForm
        card={CARD}
        onSave={() => {}}
        onCancel={() => {}}
        onTest={() =>
          new Promise<{ ok: boolean; message: string }>((r) => {
            holder.resolve = r;
          })
        }
        onDelete={() => {}}
      />,
    );
    const testBtn = screen.getByRole("button", { name: "测试连接" });
    fireEvent.click(testBtn);
    expect(screen.getByRole("button", { name: "测试中…" })).toBeDefined();
    holder.resolve?.({ ok: true, message: "HTTP 200（端点可达）" });
    await waitFor(() => expect(screen.getByText("HTTP 200（端点可达）")).toBeDefined());
    expect(screen.getByRole("button", { name: "删除" })).toBeDefined();
  });
});

describe("ProviderList", () => {
  it("行渲染 + 活跃徽章 + 激活/编辑/新增回调；空态提示", () => {
    const calls: string[] = [];
    render(
      <ProviderList
        cards={[CARD, { ...CARD, name: "sub", model: "mini" }]}
        activeCard="main"
        onActivate={(n) => calls.push(`act:${n}`)}
        onEdit={(c) => calls.push(`edit:${c.name}`)}
        onAdd={() => calls.push("add")}
      />,
    );
    expect(screen.getByText("main")).toBeDefined();
    expect(screen.getAllByText("活跃")).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("激活 sub"));
    fireEvent.click(screen.getAllByRole("button", { name: "编辑" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "+ 新增" }));
    expect(calls).toEqual(["act:sub", "edit:sub", "add"]);

    render(
      <ProviderList
        cards={[]}
        activeCard=""
        onActivate={() => {}}
        onEdit={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(screen.getByText(/尚无卡片/)).toBeDefined();
  });
});

describe("GrantsView", () => {
  it("授权行（能力中文/站点/时间）+ 撤销回调；空态", () => {
    const revoked: Grant[] = [];
    const grant: Grant = {
      capability: "CLICK",
      host: "a.example",
      decision: "allow",
      duration: "always",
      tabId: null,
      createdAt: 1_700_000_000_000,
    };
    render(<GrantsView grants={[grant]} onRevoke={(g) => revoked.push(g)} />);
    expect(screen.getByText("点击")).toBeDefined();
    expect(screen.getByText("a.example")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(revoked).toEqual([grant]);
    render(<GrantsView grants={[]} onRevoke={() => {}} />);
    expect(screen.getByText(/无持久授权/)).toBeDefined();
  });
});

describe("SkillListView", () => {
  it("行投影：站点级徽章/任务 slug/来源中文；空态", () => {
    render(
      <SkillListView
        cards={[
          { host: "douyin.com", slug: "", sourceType: "built-in", updatedAt: 1 },
          {
            host: "douyin.com",
            slug: "upload",
            sourceType: "distilled",
            updatedAt: 2,
            distilledAt: "t",
          },
        ]}
      />,
    );
    expect(screen.getByText("站点级")).toBeDefined();
    expect(screen.getByText("upload")).toBeDefined();
    expect(screen.getByText("内置")).toBeDefined();
    expect(screen.getByText("蒸馏")).toBeDefined();
    render(<SkillListView cards={[]} />);
    expect(screen.getByText(/内置技能在扩展安装\/更新时自动装载/)).toBeDefined();
  });
});

// ── issue #5 S5：草稿审阅面 + 列表状态列 ────────────────────────────────

describe("SkillDraftReview（issue #5 S5）", () => {
  const DRAFT = {
    host: "a.example",
    slug: "task-one",
    description: "做一件事",
    keywords: ["one", "一"],
    sop: "SOP-1",
    selectors: "SEL-1",
    quirks: "Q-1",
    distilledAt: "2026-10-24T00:00:00Z",
    sourceTraces: ["run-1", "run-2"],
    updatedAt: 1,
  };

  it("空态文案；列表行（host/slug/distilledAt）+ 来源轨迹徽章", () => {
    render(<SkillDraftReview drafts={[]} onAdopt={() => {}} onDiscard={() => {}} />);
    expect(screen.getByText(/任务成功且 Judge 复核通过后自动蒸馏/)).toBeDefined();
    const adopts: unknown[] = [];
    const { unmount } = render(
      <SkillDraftReview
        drafts={[DRAFT]}
        onAdopt={(...a) => void adopts.push(a)}
        onDiscard={() => {}}
      />,
    );
    unmount();
    render(<SkillDraftReview drafts={[DRAFT]} onAdopt={() => {}} onDiscard={() => {}} />);
    expect(screen.getByText("a.example")).toBeDefined();
    expect(screen.getByText("task-one")).toBeDefined();
    fireEvent.click(screen.getByText("审阅"));
    expect(screen.getByText("2 条来源轨迹")).toBeDefined();
    expect(screen.getByTestId("draft-sop-a.example|task-one").textContent).toContain("SOP-1");
  });

  it("编辑后采纳带 edits 覆盖（keywords 逗号拆分）；未编辑字段不上抛", () => {
    const adopts: Array<[string, string, SkillDraftEdits]> = [];
    render(
      <SkillDraftReview
        drafts={[DRAFT]}
        onAdopt={(host, slug, edits) => void adopts.push([host, slug, edits])}
        onDiscard={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("审阅"));
    fireEvent.change(screen.getByTestId("draft-sop-a.example|task-one"), {
      target: { value: "SOP-EDITED" },
    });
    fireEvent.change(screen.getByTestId("draft-keywords-a.example|task-one"), {
      target: { value: "新词, second" },
    });
    fireEvent.click(screen.getByText("采纳"));
    expect(adopts).toHaveLength(1);
    const [host, slug, edits] = adopts[0]!;
    expect([host, slug]).toEqual(["a.example", "task-one"]);
    expect(edits).toMatchObject({ sop: "SOP-EDITED", keywords: ["新词", "second"] });
    expect(edits.selectors).toBeUndefined(); // 未编辑不上抛
    expect(edits.quirks).toBeUndefined();
  });

  it("丢弃回调带 host/slug；收起后编辑区隐藏", () => {
    const discards: Array<[string, string]> = [];
    render(
      <SkillDraftReview
        drafts={[DRAFT]}
        onAdopt={() => {}}
        onDiscard={(host, slug) => void discards.push([host, slug])}
      />,
    );
    fireEvent.click(screen.getByText("审阅"));
    fireEvent.click(screen.getByText("丢弃"));
    expect(discards).toEqual([["a.example", "task-one"]]);
    expect(screen.queryByTestId("draft-sop-a.example|task-one")).toBeNull();
  });

  it("收起按钮切换编辑区；描述/selectors/quirks 全字段可编辑并随采纳上抛", () => {
    const adopts: Array<[string, string, SkillDraftEdits]> = [];
    render(
      <SkillDraftReview
        drafts={[DRAFT]}
        onAdopt={(host, slug, edits) => void adopts.push([host, slug, edits])}
        onDiscard={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("审阅"));
    fireEvent.click(screen.getByText("收起")); // 切换分支：open→收起
    expect(screen.queryByTestId("draft-sop-a.example|task-one")).toBeNull();
    fireEvent.click(screen.getByText("审阅")); // 再展开
    fireEvent.change(screen.getByTestId("draft-desc-a.example|task-one"), {
      target: { value: "新描述" },
    });
    fireEvent.change(screen.getByTestId("draft-selectors-a.example|task-one"), {
      target: { value: "SEL-E" },
    });
    fireEvent.change(screen.getByTestId("draft-quirks-a.example|task-one"), {
      target: { value: "Q-E" },
    });
    fireEvent.click(screen.getByText("采纳"));
    expect(adopts[0]?.[2]).toMatchObject({
      description: "新描述",
      selectors: "SEL-E",
      quirks: "Q-E",
    });
  });
});

describe("SkillListView 状态列（issue #5 S5）", () => {
  it("draft 徽章 vs 正式", () => {
    render(
      <SkillListView
        cards={[
          { host: "a.example", slug: "t1", sourceType: "distilled", updatedAt: 1, status: "draft" },
          { host: "a.example", slug: "t2", sourceType: "built-in", updatedAt: 2 },
        ]}
      />,
    );
    expect(screen.getByText("草稿")).toBeDefined();
    expect(screen.getByText("正式")).toBeDefined();
  });
});
