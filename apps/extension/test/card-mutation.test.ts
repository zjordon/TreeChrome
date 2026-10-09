// 卡片保存变更计划单测（m5/05 轮 2 [2][3]）：撞名统一判定（新增路径不再恒假）/
// 按原名替换 / 改名指针重定向 / activeCard 自动激活与重定向合并不互覆。

import type { ProviderCardDto } from "@tw/protocol";
import { describe, expect, it } from "vitest";
import type { ExtensionSettings } from "../src/host/settings-store.js";
import { planCardMutation } from "../src/ui-glue/card-mutation.js";

const card = (name: string, model = "m"): ProviderCardDto => ({
  name,
  protocol: "anthropic-messages",
  baseUrl: "https://api",
  apiKey: `key-${name}`,
  model,
  maxTokens: 4096,
});

const settings = (over: Partial<ExtensionSettings> = {}): ExtensionSettings => ({
  providerCards: [card("main"), card("sub", "mini")],
  activeCard: "main",
  ...over,
});

describe("planCardMutation", () => {
  it("新增：无同名 → 追加 + 自动激活；同名占用 → 拒绝（轮 2 [2] 守卫不再恒假）", () => {
    const ok = planCardMutation(settings(), card("new"), null);
    expect(ok).toMatchObject({ ok: true });
    if (ok.ok) {
      expect(ok.next.providerCards.map((c) => c.name)).toEqual(["main", "sub", "new"]);
      expect(ok.next.activeCard).toBe("main"); // 已有活跃卡不夺走
    }
    const dup = planCardMutation(settings(), card("main"), null);
    expect(dup).toMatchObject({ ok: false, error: expect.stringContaining("已被占用") });
  });

  it("新增同名不再静默整卡替换（既有密钥/高级字段保命）", () => {
    const withAdvanced = settings({
      providerCards: [
        { ...card("main"), maxTokensField: "max_completion_tokens" },
        card("sub", "mini"),
      ],
    });
    const res = planCardMutation(withAdvanced, card("main", "evil"), null);
    expect(res.ok).toBe(false);
  });

  it("编辑同名：原位替换（不追加不重复）；改名：按原名替换 + 指针重定向 + 占用拒绝", () => {
    const same = planCardMutation(settings(), { ...card("main"), model: "m2" }, "main");
    expect(same.ok).toBe(true);
    if (same.ok) {
      expect(same.next.providerCards).toHaveLength(2);
      expect(same.next.providerCards[0]).toMatchObject({ name: "main", model: "m2" });
    }
    const renamed = planCardMutation(
      settings({ taskSkillCard: "main", judgeCard: "sub" }),
      card("renamed"),
      "main",
    );
    expect(renamed.ok).toBe(true);
    if (renamed.ok) {
      expect(renamed.next.providerCards.map((c) => c.name)).toEqual(["renamed", "sub"]);
      expect(renamed.next.activeCard).toBe("renamed"); // 指向旧名 → 新名
      expect(renamed.next.taskSkillCard).toBe("renamed");
      expect(renamed.next.judgeCard).toBe("sub"); // 非旧名不动
    }
    const collide = planCardMutation(settings(), card("sub"), "main");
    expect(collide).toMatchObject({ ok: false });
  });

  it("无活跃卡 + 改名：自动激活与重定向合并不互覆（轮 2 [3]——旧双展开会吞掉激活）", () => {
    const res = planCardMutation(settings({ activeCard: "" }), card("renamed"), "main");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.activeCard).toBe("renamed"); // 先激活再重定向：新名存活
    }
  });
});
