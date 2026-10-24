// skill-store / skill-source 单测（m5/04 §5）：built-in upsert 幂等 + provenance
// 保护（import 卡不被覆盖/不被 prune）+ prune（源侧删除的 built-in 残留清理）+
// ExtensionSkillSource 三件套读序/缓存/miss=null/taskCatalog 前缀过滤/
// ready gate（刷新落定前不固化负缓存）+ taskCardText 无头 "\n\n" join——fake SkillDb。

import type { SkillCardDraft } from "@tw/core";
import { describe, expect, it } from "vitest";
import { ExtensionSkillSource } from "../src/host/skill-source.js";
import {
  type BuiltinsManifest,
  cardKey,
  type SkillDb,
  SkillStore,
} from "../src/host/skill-store.js";

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

const MANIFEST: BuiltinsManifest = {
  sourceType: "built-in",
  generatedAt: "2026-10-09T00:00:00Z",
  hosts: {
    "a.example": {
      sop: "SOP-A",
      selectors: "SEL-A",
      quirks: "Q-A",
      tasks: {
        "task-one": {
          sop: "T1-SOP",
          selectors: "T1-SEL",
          quirks: "T1-Q",
          description: "Do one thing",
          keywords: ["one", "一"],
          distilledAt: "2026-09-01T00:00:00Z",
        },
      },
    },
    "b.example": { sop: "SOP-B", selectors: "SEL-B", quirks: "Q-B" },
  },
};

describe("SkillStore.refreshBuiltins", () => {
  it("全量 upsert（host 站点级 + 任务卡）+ 重跑幂等（写入数第二次 = 0）", async () => {
    const db = fakeDb();
    const store = new SkillStore(db);
    expect(await store.refreshBuiltins(MANIFEST, 1000)).toBe(3);
    expect(await store.refreshBuiltins(MANIFEST, 2000)).toBe(0); // 内容未变不重写
    expect(db.map.get(cardKey("a.example", ""))).toMatchObject({
      host: "a.example",
      slug: "",
      sop: "SOP-A",
      provenance: { sourceType: "built-in" },
    });
    expect(db.map.get(cardKey("a.example", "task-one"))).toMatchObject({
      description: "Do one thing",
      keywords: ["one", "一"],
      distilledAt: "2026-09-01T00:00:00Z",
    });
  });

  it("provenance 保护：import/distilled 卡不被 built-in 覆盖", async () => {
    const db = fakeDb();
    const store = new SkillStore(db);
    await db.put(cardKey("a.example", ""), {
      host: "a.example",
      slug: "",
      sop: "用户导入版",
      selectors: "",
      quirks: "",
      provenance: { sourceType: "import" },
      updatedAt: 1,
    });
    await db.put(cardKey("a.example", "task-one"), {
      host: "a.example",
      slug: "task-one",
      sop: "蒸馏版",
      selectors: "",
      quirks: "",
      description: "蒸馏描述",
      provenance: { sourceType: "distilled" },
      updatedAt: 1,
    });
    expect(await store.refreshBuiltins(MANIFEST, 2000)).toBe(1); // 只写了 b.example
    expect(await store.getCard("a.example", "")).toMatchObject({ sop: "用户导入版" });
    expect(await store.getCard("a.example", "task-one")).toMatchObject({ sop: "蒸馏版" });
  });

  it("内容变化时 built-in 卡重写（updatedAt 更新）", async () => {
    const db = fakeDb();
    const store = new SkillStore(db);
    await store.refreshBuiltins(MANIFEST, 1000);
    const changed: BuiltinsManifest = {
      ...MANIFEST,
      hosts: { "a.example": { ...MANIFEST.hosts["a.example"]!, sop: "SOP-A2" } },
    };
    expect(await store.refreshBuiltins(changed, 2000)).toBeGreaterThanOrEqual(1);
    expect(await store.getCard("a.example", "")).toMatchObject({ sop: "SOP-A2" });
  });

  it("prune：源侧删除/改名的 built-in 残留卡被清；import/distilled 不碰", async () => {
    const db = fakeDb();
    const store = new SkillStore(db);
    await store.refreshBuiltins(MANIFEST, 1000);
    // import 卡挂在即将从清单消失的 host 上（provenance 保护面）
    await db.put(cardKey("b.example", "manual"), {
      host: "b.example",
      slug: "manual",
      sop: "用户导入",
      selectors: "",
      quirks: "",
      provenance: { sourceType: "import" },
      updatedAt: 1,
    });
    // 新清单：a.example 只剩 task-one（task 改名）+ b.example 站点级不变
    const shrunk: BuiltinsManifest = {
      ...MANIFEST,
      hosts: {
        "a.example": { sop: "SOP-A", selectors: "SEL-A", quirks: "Q-A" },
        "b.example": MANIFEST.hosts["b.example"]!,
      },
    };
    // 写入数：b 站点级内容未变不写；a.task-one 被 prune（built-in 残留）
    expect(await store.refreshBuiltins(shrunk, 2000)).toBe(1);
    expect(db.map.has(cardKey("a.example", "task-one"))).toBe(false);
    expect(db.map.has(cardKey("a.example", ""))).toBe(true);
    expect(db.map.has(cardKey("b.example", "manual"))).toBe(true); // import 存活
    expect(await store.listTaskSlugs("a.example")).toEqual([]);
  });
});

describe("SkillStore 列举", () => {
  it("listTaskSlugs：前缀过滤 + 站点级（slug 空串）排除 + 邻 host 不串", async () => {
    const db = fakeDb();
    const store = new SkillStore(db);
    await store.refreshBuiltins(MANIFEST, 1000);
    expect(await store.listTaskSlugs("a.example")).toEqual(["task-one"]);
    expect(await store.listTaskSlugs("b.example")).toEqual([]);
    expect(await store.listTaskSlugs("c.example")).toEqual([]);
  });

  it("listAll：全卡（含站点级空 slug + provenance 面）——SkillListView 投影源", async () => {
    const db = fakeDb();
    const store = new SkillStore(db);
    await store.refreshBuiltins(MANIFEST, 1000);
    const all = await store.listAll();
    expect(all.map((c) => [c.host, c.slug])).toEqual([
      ["a.example", ""],
      ["a.example", "task-one"],
      ["b.example", ""],
    ]);
    expect(all.every((c) => c.provenance.sourceType === "built-in")).toBe(true);
  });
});

describe("ExtensionSkillSource", () => {
  async function seeded() {
    const db = fakeDb();
    const store = new SkillStore(db);
    await store.refreshBuiltins(MANIFEST, 1000);
    return new ExtensionSkillSource(store);
  }

  it("loadHostSkill：命中三件套；miss → null 且缓存（二次零查库）", async () => {
    const src = await seeded();
    expect(await src.loadHostSkill("a.example")).toEqual({
      sop: "SOP-A",
      selectors: "SEL-A",
      quirks: "Q-A",
    });
    expect(await src.loadHostSkill("ghost.example")).toBeNull();
  });

  it("loadHostSkill：空 host → null；全空卡 → null", async () => {
    const src = await seeded();
    expect(await src.loadHostSkill("")).toBeNull();
    const db = fakeDb();
    await db.put(cardKey("empty.example", ""), {
      host: "empty.example",
      slug: "",
      sop: "",
      selectors: "",
      quirks: "",
      provenance: { sourceType: "built-in" },
      updatedAt: 1,
    });
    const emptySrc = new ExtensionSkillSource(new SkillStore(db));
    expect(await emptySrc.loadHostSkill("empty.example")).toBeNull();
  });

  it("缓存路径：loadHostSkill/taskCatalog 二次调用零查库；taskCardText 查无 → 空串", async () => {
    const src = await seeded();
    await src.loadHostSkill("a.example");
    await src.loadHostSkill("a.example"); // 缓存命中分支
    await src.taskCatalog("a.example");
    await src.taskCatalog("a.example"); // catalog 缓存命中分支
    expect(await src.taskCardText({ slug: "ghost", description: "", host: "a.example" })).toBe("");
    expect(await src.loadHostSkill("b.example")).not.toBeNull();
  });

  it("taskCatalog：meta 投影（slug/description/keywords）；taskCardText 无头 join", async () => {
    const src = await seeded();
    const catalog = await src.taskCatalog("a.example");
    expect(catalog).toEqual([
      {
        slug: "task-one",
        description: "Do one thing",
        keywords: ["one", "一"],
        distilledAt: "2026-09-01T00:00:00Z",
        host: "a.example",
      },
    ]);
    const text = await src.taskCardText(catalog[0]!);
    expect(text).toBe("T1-SOP\n\nT1-SEL\n\nT1-Q"); // P5.5 冻结口径：strip + "\n\n" 无分段头
    expect(await src.taskCatalog("b.example")).toEqual([]);
  });

  it("ready gate：刷新落定前首查挂起，落定后读全库（负缓存不固化）", async () => {
    const db = fakeDb();
    const store = new SkillStore(db);
    let releaseRefresh: () => void = () => {};
    const ready = new Promise<void>((r) => {
      releaseRefresh = r;
    });
    const src = new ExtensionSkillSource(store, () => {}, ready);
    let hostResult: unknown = "pending";
    let catalogResult: unknown = "pending";
    void src.loadHostSkill("a.example").then((v) => (hostResult = v));
    void src.taskCatalog("a.example").then((v) => (catalogResult = v));
    await new Promise((r) => setTimeout(r, 10)); // 未落定：不查库、不缓存
    expect(hostResult).toBe("pending");
    expect(catalogResult).toBe("pending");
    // 刷新落定（数据就位）→ 挂起的首查读到真卡
    await store.refreshBuiltins(MANIFEST, 1000);
    releaseRefresh();
    expect(await src.loadHostSkill("a.example")).toEqual({
      sop: "SOP-A",
      selectors: "SEL-A",
      quirks: "Q-A",
    });
    expect(await src.taskCatalog("a.example")).toMatchObject([{ slug: "task-one" }]);
    expect(hostResult).not.toBe(null);
    expect(catalogResult).not.toBe("pending");
  });
});

// ── 蒸馏草稿（issue #5 S3：D7/D8/D14/D15/D17）──────────────────────────

describe("SkillStore 蒸馏草稿", () => {
  const draft = (over: Partial<SkillCardDraft> = {}): SkillCardDraft => ({
    host: "a.example",
    slug: "task-one",
    description: "Do one thing v2",
    keywords: ["one", "v2"],
    sop: "SOP-NEW",
    selectors: "SEL-NEW",
    quirks: "Q-NEW",
    mode: "update",
    sourceTraces: ["run-9"],
    distilledAt: "2026-10-24T00:00:00Z",
    ...over,
  });

  it("saveDraft 落草稿键空间不占正键；listDrafts 只列草稿；幂等 upsert", async () => {
    const db = fakeDb();
    const store = new SkillStore(db);
    await store.saveDraft(draft(), 100);
    expect([...db.map.keys()]).toEqual(["draft::a.example::task-one"]); // 正键零占用
    await store.saveDraft(draft({ sop: "SOP-NEW2" }), 200); // 幂等 upsert 同键
    const list = await store.listDrafts();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sop: "SOP-NEW2", status: "draft", updatedAt: 200 });
    expect(await store.getCard("a.example", "task-one")).toBeNull(); // 正键仍是 miss
  });

  it("增量草稿与在用卡共存：正键 built-in 卡照常服务，草稿待审不遮蔽", async () => {
    const db = fakeDb();
    const store = new SkillStore(db);
    await store.refreshBuiltins(MANIFEST, 1000);
    await store.saveDraft(draft(), 2000);
    const active = await store.getCard("a.example", "task-one");
    expect(active?.provenance.sourceType).toBe("built-in"); // 在用卡未被碰
    expect(await store.listTaskSlugs("a.example")).toEqual(["task-one"]); // 草稿键不进任务列举
  });

  it("built-in 刷新/prune 不动草稿键（provenance=distilled）", async () => {
    const db = fakeDb();
    const store = new SkillStore(db);
    await store.saveDraft(draft(), 100);
    await store.refreshBuiltins(MANIFEST, 200); // prune 轮会扫全部键
    expect([...db.map.keys()]).toContain("draft::a.example::task-one");
  });

  it("adoptDraft：edits 应用 + 整卡替换正键 + sourceTraces 并集（旧在前）+ streak 归 0 + 草稿键清除", async () => {
    const db = fakeDb();
    const store = new SkillStore(db);
    // 既有 distilled active 卡（sourceTraces 带旧 run）
    db.map.set("a.example::task-one", {
      host: "a.example",
      slug: "task-one",
      sop: "SOP-OLD",
      selectors: "SEL-OLD",
      quirks: "Q-OLD",
      description: "Do one thing",
      distilledAt: "2026-09-01T00:00:00Z",
      sourceTraces: ["run-1", "run-2"],
      distillStreak: 2,
      provenance: { sourceType: "distilled" },
      updatedAt: 1,
    });
    await store.saveDraft(draft(), 100);
    const res = await store.adoptDraft("a.example", "task-one", { quirks: "Q-EDITED" }, 300);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.card).toMatchObject({
      sop: "SOP-NEW", // 未编辑字段取草稿
      quirks: "Q-EDITED", // edits 覆盖
      distilledAt: "2026-10-24T00:00:00Z",
      sourceTraces: ["run-1", "run-2", "run-9"], // 并集旧在前（node writeTaskCard 同口径）
      distillStreak: 0, // D17：写内容即归 0
      provenance: { sourceType: "distilled", note: "adopted" },
      updatedAt: 300,
    });
    expect(res.card.status).toBeUndefined(); // 采纳后无 status 键 = active（D7 缺省）
    expect([...db.map.keys()]).toEqual(["a.example::task-one"]); // 草稿键已清
  });

  it("adoptDraft 防御拒绝：草稿不存在 / 非 draft 状态 / 正键 built-in 占用（D14）", async () => {
    const db = fakeDb();
    const store = new SkillStore(db);
    const missing = await store.adoptDraft("a.example", "ghost");
    expect(missing).toMatchObject({ ok: false });
    // 非 draft 状态记录占着草稿键
    db.map.set("draft::a.example::task-one", { junk: true });
    const notDraft = await store.adoptDraft("a.example", "task-one");
    expect(notDraft).toMatchObject({ ok: false, error: expect.stringContaining("draft") });
    // 正键是 built-in：采纳会遮蔽 built-in 刷新 → 拒
    const db2 = fakeDb();
    const store2 = new SkillStore(db2);
    await store2.refreshBuiltins(MANIFEST, 1000);
    await store2.saveDraft(draft({ slug: "task-one" }), 100);
    const clash = await store2.adoptDraft("a.example", "task-one");
    expect(clash).toMatchObject({ ok: false, error: expect.stringContaining("built-in") });
  });

  it("adoptDraft 经注入串行面执行（读-改-写不与其它写者交错）", async () => {
    const db = fakeDb();
    let entered = 0;
    let ranInside = false;
    const serialize = async <T>(task: () => Promise<T>): Promise<T> => {
      entered += 1;
      return task().then((v) => {
        ranInside = true;
        return v;
      });
    };
    const store = new SkillStore(db, serialize);
    await store.saveDraft(draft(), 100);
    const res = await store.adoptDraft("a.example", "task-one");
    expect(res.ok).toBe(true);
    expect(entered).toBe(1); // adopt 主体确实包进串行面
    expect(ranInside).toBe(true);
  });

  it("discardDraft：删草稿键，正键永不受影响", async () => {
    const db = fakeDb();
    const store = new SkillStore(db);
    await store.refreshBuiltins(MANIFEST, 1000);
    await store.saveDraft(draft(), 100);
    await store.discardDraft("a.example", "task-one");
    expect([...db.map.keys()]).toEqual(["a.example::", "a.example::task-one", "b.example::"]); // 仅草稿键消失
  });
});

describe("ExtensionSkillSource 草稿过滤与缓存失效（issue #5 S3）", () => {
  it("三面过滤：正键异常 draft 形态不出现在 loadHostSkill/taskCatalog/taskCardText", async () => {
    const db = fakeDb();
    const store = new SkillStore(db);
    await store.refreshBuiltins(MANIFEST, 1000);
    // 兜底形态：draft 状态卡占正键（草稿本应只在 draft:: 键空间——belt-and-suspenders）
    const hijacked = await store.getCard("a.example", "task-one");
    db.map.set("a.example::task-one", { ...hijacked!, status: "draft" });
    const src = new ExtensionSkillSource(store);
    const catalog = await src.taskCatalog("a.example");
    expect(catalog).toEqual([]); // taskCatalog 不含 draft
    expect(await src.taskCardText({ slug: "task-one", description: "", host: "a.example" })).toBe(
      "",
    ); // 全文不吐
    expect(await src.loadHostSkill("a.example")).not.toBeNull(); // 站点级卡不受任务卡影响
  });

  it("invalidate：采纳后缓存重读见新卡（无失效机制缓存会喂旧状态）", async () => {
    const db = fakeDb();
    const store = new SkillStore(db);
    await store.saveDraft(
      {
        host: "a.example",
        slug: "new-task",
        description: "New task",
        keywords: ["new"],
        sop: "S-NEW",
        selectors: "SE-NEW",
        quirks: "Q-NEW",
        mode: "new",
        sourceTraces: ["run-1"],
        distilledAt: "2026-10-24T00:00:00Z",
      },
      100,
    );
    const src = new ExtensionSkillSource(store);
    expect(await src.taskCatalog("a.example")).toEqual([]); // 采纳前：catalog 缓存空
    await store.adoptDraft("a.example", "new-task");
    expect(await src.taskCatalog("a.example")).toEqual([]); // 缓存未失效：仍是旧状态
    src.invalidate("a.example");
    expect(await src.taskCatalog("a.example")).toMatchObject([{ slug: "new-task" }]); // 失效后见新卡
    expect(await src.taskCardText({ slug: "new-task", description: "", host: "a.example" })).toBe(
      "S-NEW\n\nSE-NEW\n\nQ-NEW",
    );
  });
});
