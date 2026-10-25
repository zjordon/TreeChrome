// options 请求处理器单测（issue #9 D3/D7：自 entrypoints 迁出换可测面）：
// adopt/discard 成功 → notifyDrafts 广播钩子；坏载荷/防御拒绝不打扰通知；
// 通知实现异常不改 op 结果（D1——通知失败只该记日志）；搬迁行为回归。

import type { Grant, SkillCardDraft } from "@tw/core";
import { describe, expect, it, vi } from "vitest";
import { type SkillDb, SkillStore } from "../src/host/skill-store.js";
import { handleOptionsRequest, type OptionsFace } from "../src/runtime/options-handler.js";

function fakeDb(): SkillDb & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    async get(key) {
      return map.get(key) ?? null;
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
    async getAllKeys() {
      return [...map.keys()];
    },
  };
}

const DRAFT: SkillCardDraft = {
  host: "a.example",
  slug: "bestsellers-report",
  sop: "# SOP",
  selectors: "",
  quirks: "",
  description: "查报表",
  keywords: ["报表"],
  distilledAt: "2026-10-25T00:00:00Z",
  mode: "new",
  sourceTraces: ["r1"],
};

function makeFace(opts: { notifyThrows?: boolean; withDraft?: boolean } = {}): {
  face: OptionsFace;
  store: SkillStore;
  notified: number[];
} {
  const db = fakeDb();
  const store = new SkillStore(db);
  const notified: number[] = [];
  const grants: Grant[] = [];
  const face: OptionsFace = {
    settingsStore: {
      load: async () => {
        throw new Error("不在本测试范围");
      },
      save: async () => {},
    } as never,
    grantStore: {
      loadAlways: async () => grants,
      saveAlways: async (g: Grant[]) => {
        grants.splice(0, grants.length, ...g);
      },
    } as never,
    skillStore: store,
    // D1：通知失败不得改变 op 结果——此处可注入抛错实现验证 handler 不受扰
    notifyDrafts: opts.notifyThrows
      ? () => Promise.reject(new Error("broadcast down"))
      : async () => {
          notified.push(1);
        },
  };
  return { face, store, notified };
}

describe("handleOptionsRequest 蒸馏草稿三操作（issue #9 D1 通知面）", () => {
  it("adopt 成功 → 草稿转正 + notifyDrafts 调用", async () => {
    const { face, store, notified } = makeFace();
    await store.saveDraft(DRAFT);
    const res = (await handleOptionsRequest(
      "adopt-skill-draft",
      { host: "a.example", slug: "bestsellers-report" },
      face,
    )) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(notified).toEqual([1]);
    expect(await store.listDrafts()).toHaveLength(0); // 草稿键已删
    expect((await store.getCard("a.example", "bestsellers-report"))?.sop).toBe("# SOP");
  });

  it("discard 成功 → 草稿删除 + notifyDrafts 调用", async () => {
    const { face, store, notified } = makeFace();
    await store.saveDraft(DRAFT);
    const res = (await handleOptionsRequest(
      "discard-skill-draft",
      { host: "a.example", slug: "bestsellers-report" },
      face,
    )) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(notified).toEqual([1]);
    expect(await store.listDrafts()).toHaveLength(0);
  });

  it("adopt 草稿不存在 → {ok:false} 且不打扰通知", async () => {
    const { face, notified } = makeFace();
    const res = (await handleOptionsRequest(
      "adopt-skill-draft",
      { host: "a.example", slug: "nope" },
      face,
    )) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("草稿不存在");
    expect(notified).toEqual([]);
  });

  it("坏载荷（缺 host/空 slug）→ {ok:false} 不通知", async () => {
    const { face, notified } = makeFace();
    for (const payload of [null, { slug: "x" }, { host: "", slug: "x" }]) {
      const res = (await handleOptionsRequest("adopt-skill-draft", payload, face)) as {
        ok: boolean;
      };
      expect(res.ok).toBe(false);
    }
    const res = (await handleOptionsRequest("discard-skill-draft", { host: "a" }, face)) as {
      ok: boolean;
    };
    expect(res.ok).toBe(false);
    expect(notified).toEqual([]);
  });

  it("notifyDrafts 抛异常 → op 仍成功（D1：通知失败不改结果）", async () => {
    const { face, store } = makeFace({ notifyThrows: true });
    await store.saveDraft(DRAFT);
    const res = (await handleOptionsRequest(
      "adopt-skill-draft",
      { host: "a.example", slug: "bestsellers-report" },
      face,
    )) as { ok: boolean };
    expect(res.ok).toBe(true); // 采纳成功的事实不被通知故障吞掉
    expect(await store.listDrafts()).toHaveLength(0);
  });

  it("list-skill-drafts → 全文投影（搬迁行为回归）", async () => {
    const { face, store } = makeFace();
    await store.saveDraft(DRAFT);
    const res = (await handleOptionsRequest("list-skill-drafts", null, face)) as {
      ok: boolean;
      drafts: Array<{ host: string; slug: string; sop: string; sourceTraces: string[] }>;
    };
    expect(res.ok).toBe(true);
    expect(res.drafts).toHaveLength(1);
    expect(res.drafts[0]).toMatchObject({
      host: "a.example",
      slug: "bestsellers-report",
      sop: "# SOP",
      sourceTraces: ["r1"],
    });
  });

  it("未知 op → {ok:false}（fail-soft 回归）", async () => {
    const { face } = makeFace();
    const res = (await handleOptionsRequest("nope" as never, null, face)) as {
      ok: boolean;
      error: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("未知操作");
  });
});

describe("handleOptionsRequest 搬迁行为回归（settings/grants/skills/test-card）", () => {
  const CARD = {
    name: "main",
    protocol: "anthropic-messages",
    baseUrl: "https://api",
    apiKey: "k",
    model: "m",
    maxTokens: 4096,
  };

  function fullFace(): {
    face: OptionsFace;
    saved: unknown[];
    grants: Grant[];
  } {
    const db = fakeDb();
    const store = new SkillStore(db);
    const saved: unknown[] = [];
    const grants: Grant[] = [
      { capability: "navigate", host: "a.example", verdict: "allow-always" } as Grant,
    ];
    const face = {
      settingsStore: {
        load: async () => ({ providerCards: [CARD], activeCard: "main" }),
        save: async (s: unknown) => {
          saved.push(s);
        },
      },
      grantStore: {
        loadAlways: async () => grants,
        saveAlways: async (g: Grant[]) => {
          grants.splice(0, grants.length, ...g);
        },
      },
      skillStore: store,
      notifyDrafts: async () => {},
    } as unknown as OptionsFace;
    return { face, saved, grants };
  }

  it("get/save-settings：读回 + 落盘走注入 store", async () => {
    const { face, saved } = fullFace();
    const got = (await handleOptionsRequest("get-settings", null, face)) as {
      ok: boolean;
      settings: unknown;
    };
    expect(got.ok).toBe(true);
    expect(got.settings).toMatchObject({ activeCard: "main" });
    const put = (await handleOptionsRequest(
      "save-settings",
      { providerCards: [CARD], activeCard: "main" },
      face,
    )) as { ok: boolean };
    expect(put.ok).toBe(true);
    expect(saved).toHaveLength(1);
  });

  it("list-grants / revoke-grant：列举 + 精确移除；坏载荷拒绝", async () => {
    const { face } = fullFace();
    const list = (await handleOptionsRequest("list-grants", null, face)) as {
      ok: boolean;
      grants: Grant[];
    };
    expect(list.grants).toHaveLength(1);
    const bad = (await handleOptionsRequest("revoke-grant", { host: "a.example" }, face)) as {
      ok: boolean;
    };
    expect(bad.ok).toBe(false);
    const res = (await handleOptionsRequest(
      "revoke-grant",
      { capability: "navigate", host: "a.example" },
      face,
    )) as { ok: boolean; removed: number };
    expect(res).toEqual({ ok: true, removed: 1 });
    const after = (await handleOptionsRequest("list-grants", null, face)) as {
      grants: Grant[];
    };
    expect(after.grants).toHaveLength(0);
  });

  it("list-skills：全卡投影（host/slug/sourceType/updatedAt）", async () => {
    const { face } = fullFace();
    await face.skillStore.saveDraft(DRAFT);
    const res = (await handleOptionsRequest("list-skills", null, face)) as {
      ok: boolean;
      cards: Array<{ host: string; slug: string; sourceType: string; status: string }>;
    };
    expect(res.ok).toBe(true);
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0]).toMatchObject({
      host: "a.example",
      slug: "bestsellers-report",
      sourceType: "distilled",
      status: "draft",
    });
  });

  it("test-card：坏 baseUrl 拒绝；可达探测（fetch stub——不发真网络）", async () => {
    const { face } = fullFace();
    const bad = (await handleOptionsRequest("test-card", { baseUrl: "ftp://x" }, face)) as {
      ok: boolean;
      message: string;
    };
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("不合法");
    const stub = vi.fn(async () => ({ status: 200 })) as never;
    vi.stubGlobal("fetch", stub);
    try {
      const ok = (await handleOptionsRequest("test-card", CARD, face)) as {
        ok: boolean;
        message: string;
      };
      expect(ok).toEqual({ ok: true, message: "HTTP 200（端点可达）" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
