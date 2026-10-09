// skill-store / skill-source 单测（m5/04 §5）：built-in upsert 幂等 + provenance
// 保护（import 卡不被覆盖/不被 prune）+ prune（源侧删除的 built-in 残留清理）+
// ExtensionSkillSource 三件套读序/缓存/miss=null/taskCatalog 前缀过滤/
// ready gate（刷新落定前不固化负缓存）+ taskCardText 无头 "\n\n" join——fake SkillDb。

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
