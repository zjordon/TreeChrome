// skill 存储（m5/04 §5）：IndexedDB db `treewalker-skills` store `cards`。窄存储面
// 注入（真实现走 indexedDB.open；单测 fake Map）——IDB 全 API 面不进测试。built-in
// 刷新：onInstalled/onUpdated → fetch 打包清单（domain-skills.json，构建期生成）
// → upsert（provenance.sourceType==="built-in" 精确匹配才覆盖——import/distilled
// 卡不碰）。M7（issue #5 S3）：蒸馏草稿——独立 `draft::` 键空间（草稿永不占
// 正键，增量草稿与在用卡共存到采纳），adopt/discard 走注入的串行面。

import type { SkillCardDraft } from "@tw/core";

/** 卡面形态（架构 §6.2 SkillCard 收敛；slug="" 表示站点级三件套） */
export interface SkillCardData {
  host: string;
  /** "" = 站点级；非空 = 任务卡 slug */
  slug: string;
  sop: string;
  selectors: string;
  quirks: string;
  /** 任务卡 meta（站点级无） */
  description?: string;
  keywords?: string[];
  distilledAt?: string;
  /** 蒸馏治理位（D7/D17）：缺省 active（存量卡零迁移）；sourceTraces = 来源 runId 并集 */
  status?: "active" | "draft";
  sourceTraces?: string[];
  /** 连续无新观察次数（D17 收敛；采纳写内容即归 0，unchanged 路径递增） */
  distillStreak?: number;
  provenance: { sourceType: "built-in" | "import" | "distilled"; note?: string };
  updatedAt: number;
}

/** 打包清单（构建期 scripts/embed-skills.mjs 生成 domain-skills.json 的形态） */
export interface BuiltinsManifest {
  sourceType: "built-in";
  generatedAt: string;
  hosts: Record<
    string,
    {
      sop: string;
      selectors: string;
      quirks: string;
      tasks?: Record<
        string,
        {
          sop: string;
          selectors: string;
          quirks: string;
          description: string;
          keywords?: string[];
          distilledAt?: string;
        }
      >;
    }
  >;
}

/** 窄存储面（键 = `${host}::${slug}`；真实现 IndexedDB，测试 fake） */
export interface SkillDb {
  get(key: string): Promise<unknown>;
  put(key: string, value: SkillCardData): Promise<void>;
  delete(key: string): Promise<void>;
  getAllKeys(): Promise<string[]>;
}

export const SKILL_DB_NAME = "treewalker-skills";
export const SKILL_STORE_NAME = "cards";

export const cardKey = (host: string, slug: string): string => `${host}::${slug}`;

/** 草稿键空间前缀（issue #5）：`draft::${host}::${slug}`——与正键隔离，增量草稿
 *  不遮蔽在用卡（读侧三面天然扫不到），采纳时搬运到正键 */
export const DRAFT_KEY_PREFIX = "draft::";

export const draftKey = (host: string, slug: string): string =>
  `${DRAFT_KEY_PREFIX}${host}::${slug}`;

/** IndexedDB 窄实现（onupgradeneeded 建库；调用点 SW——真 IDB 绑定不进 node
 *  单测：node 无 IDB，此函数由 e2e 真机覆盖；窄接口面经 SkillDb fake 全覆盖） */
/* v8 ignore start */
export async function openSkillDb(indexedDB: {
  open(name: string, version: number): IDBOpenDBRequest;
}): Promise<SkillDb> {
  return new Promise<SkillDb>((resolve, reject) => {
    const req = indexedDB.open(SKILL_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SKILL_STORE_NAME)) db.createObjectStore(SKILL_STORE_NAME);
    };
    req.onsuccess = () => {
      const db = req.result;
      resolve({
        async get(key) {
          return new Promise((res, rej) => {
            const r = db
              .transaction(SKILL_STORE_NAME, "readonly")
              .objectStore(SKILL_STORE_NAME)
              .get(key);
            r.onsuccess = () => res(r.result ?? null);
            r.onerror = () => rej(r.error);
          });
        },
        async put(key, value) {
          return new Promise((res, rej) => {
            const r = db
              .transaction(SKILL_STORE_NAME, "readwrite")
              .objectStore(SKILL_STORE_NAME)
              .put(value, key);
            r.onsuccess = () => res();
            r.onerror = () => rej(r.error);
          });
        },
        async delete(key) {
          return new Promise((res, rej) => {
            const r = db
              .transaction(SKILL_STORE_NAME, "readwrite")
              .objectStore(SKILL_STORE_NAME)
              .delete(key);
            r.onsuccess = () => res();
            r.onerror = () => rej(r.error);
          });
        },
        async getAllKeys() {
          return new Promise((res, rej) => {
            const r = db
              .transaction(SKILL_STORE_NAME, "readonly")
              .objectStore(SKILL_STORE_NAME)
              .getAllKeys();
            r.onsuccess = () => res((r.result ?? []) as string[]);
            r.onerror = () => rej(r.error);
          });
        },
      });
    };
    req.onerror = () => reject(req.error);
  });
}
/* v8 ignore stop */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** promise 链串行面（runtime/mutation-queue 同款实现内联——host 层不得反向
 *  import runtime；评审轮 1 [3]：缺省直通会让生产装配遗漏注入时静默失去互斥） */
function makeInternalQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task);
    tail = next.catch(() => {});
    return next;
  };
}

export class SkillStore {
  private readonly db: SkillDb;
  private readonly serialize: <T>(task: () => Promise<T>) => Promise<T>;

  constructor(
    db: SkillDb,
    /** 变更串行面（注入可观测——测试计数；缺省内建 promise 链）——全部写路径
     *  （save/discard/adopt/bump/built-ins 刷新）经此串行，读-改-写不交错
     *  （m5/05 轮 1 [12] 教训；评审轮 1 [3][4] 收紧为全写者共面） */
    serialize?: <T>(task: () => Promise<T>) => Promise<T>,
  ) {
    this.db = db;
    this.serialize = serialize ?? makeInternalQueue();
  }

  async getCard(host: string, slug: string): Promise<SkillCardData | null> {
    const raw = await this.db.get(cardKey(host, slug));
    return isRecord(raw) ? (raw as unknown as SkillCardData) : null;
  }

  /** 任务卡 slug 列举（`${host}::` 前缀过滤；站点级 slug="" 排除） */
  async listTaskSlugs(host: string): Promise<string[]> {
    const prefix = `${host}::`;
    const keys = await this.db.getAllKeys();
    return keys
      .filter((k) => k.startsWith(prefix) && k.length > prefix.length)
      .map((k) => k.slice(prefix.length));
  }

  /** 全卡列举（options SkillListView 投影源——键序即返回序） */
  async listAll(): Promise<SkillCardData[]> {
    const out: SkillCardData[] = [];
    for (const key of await this.db.getAllKeys()) {
      const raw = await this.db.get(key);
      if (isRecord(raw)) out.push(raw as unknown as SkillCardData);
    }
    return out;
  }

  /**
   * built-in 刷新（幂等）：清单卡 upsert——已有卡 provenance.sourceType 必须精确
   * 为 "built-in" 才覆盖（import/distilled 不碰），且内容未变（updatedAt 外全等）
   * 不重写；随后 prune（评审轮 1 [2]）：不在本清单内且 provenance 为 built-in 的
   * 残留卡删除（源侧删除/改名后扩展与技能源失同步且无自愈——import/distilled
   * 不碰）。返回写入数（含删除；重装幂等可断言——第二次应为 0）。
   */
  async refreshBuiltins(manifest: BuiltinsManifest, now = Date.now()): Promise<number> {
    let written = 0;
    const live = new Set<string>();
    for (const [host, bundle] of Object.entries(manifest.hosts)) {
      const hostCard: SkillCardData = {
        host,
        slug: "",
        sop: bundle.sop,
        selectors: bundle.selectors,
        quirks: bundle.quirks,
        provenance: { sourceType: "built-in" },
        updatedAt: now,
      };
      if (await this.upsertBuiltins(hostCard)) written += 1;
      live.add(cardKey(host, ""));
      for (const [slug, task] of Object.entries(bundle.tasks ?? {})) {
        const taskCard: SkillCardData = {
          host,
          slug,
          sop: task.sop,
          selectors: task.selectors,
          quirks: task.quirks,
          description: task.description,
          ...(task.keywords !== undefined ? { keywords: task.keywords } : {}),
          ...(task.distilledAt !== undefined ? { distilledAt: task.distilledAt } : {}),
          provenance: { sourceType: "built-in" },
          updatedAt: now,
        };
        if (await this.upsertBuiltins(taskCard)) written += 1;
        live.add(cardKey(host, slug));
      }
    }
    for (const key of await this.db.getAllKeys()) {
      if (live.has(key)) continue;
      const raw = await this.db.get(key);
      const prov = isRecord(raw) ? raw.provenance : null;
      if (isRecord(prov) && prov.sourceType === "built-in") {
        await this.serialize(() => this.db.delete(key));
        written += 1;
      }
    }
    return written;
  }

  /** 单卡 upsert 判定：非 built-in 在位不碰；内容未变不重写（经串行面——与
   *  adopt 的 D14 built-in 检查互斥，评审轮 1 [3]） */
  private async upsertBuiltins(card: SkillCardData): Promise<boolean> {
    return this.serialize(async () => {
      const existing = await this.getCard(card.host, card.slug);
      if (existing !== null) {
        if (existing.provenance.sourceType !== "built-in") return false;
        const { updatedAt: _old, ...oldRest } = existing;
        const { updatedAt: _new, ...newRest } = card;
        void _old;
        void _new;
        if (JSON.stringify(oldRest) === JSON.stringify(newRest)) return false;
      }
      await this.db.put(cardKey(card.host, card.slug), card);
      return true;
    });
  }

  // ── 蒸馏草稿（issue #5 D7/D8/D15/D17）────────────────────────────────

  /** 蒸馏产物落草稿键（幂等 upsert；不碰正键——增量草稿与在用卡共存到采纳）。
   *  经串行面——与 adopt 的读-删窗互斥（评审轮 1 [4]：否则并发 saveDraft 可
   *  在 adopt 读旧草稿后覆盖写、随后被 adopt 的 delete 吞掉新修订） */
  async saveDraft(draft: SkillCardDraft, now = Date.now()): Promise<void> {
    const card: SkillCardData = {
      host: draft.host,
      slug: draft.slug,
      sop: draft.sop,
      selectors: draft.selectors,
      quirks: draft.quirks,
      description: draft.description,
      ...(draft.keywords.length > 0 ? { keywords: draft.keywords } : {}),
      distilledAt: draft.distilledAt,
      status: "draft",
      sourceTraces: draft.sourceTraces,
      provenance: { sourceType: "distilled", note: `distill:${draft.mode}` },
      updatedAt: now,
    };
    await this.serialize(() => this.db.put(draftKey(draft.host, draft.slug), card));
  }

  /** 草稿列举（options 审阅面；键序即返回序） */
  async listDrafts(): Promise<SkillCardData[]> {
    const out: SkillCardData[] = [];
    for (const key of await this.db.getAllKeys()) {
      if (!key.startsWith(DRAFT_KEY_PREFIX)) continue;
      const raw = await this.db.get(key);
      if (isRecord(raw)) out.push(raw as unknown as SkillCardData);
    }
    return out;
  }

  /**
   * 采纳草稿（D8：整卡替换到正键——edits 覆盖 + status 转 active + sourceTraces
   * 并集（旧在前，node writeTaskCard 同口径）+ distilledAt 取草稿 + streak 归 0）。
   * 防御拒绝：草稿不存在/非 draft 状态/正键被 built-in 占用（D14——蒸馏草稿不得
   * 遮蔽扩展更新时的 built-in 刷新）。整段经注入的串行面执行。
   */
  async adoptDraft(
    host: string,
    slug: string,
    edits: Partial<
      Pick<SkillCardData, "sop" | "selectors" | "quirks" | "description" | "keywords">
    > = {},
    now = Date.now(),
  ): Promise<{ ok: true; card: SkillCardData } | { ok: false; error: string }> {
    return this.serialize(async () => {
      const raw = await this.db.get(draftKey(host, slug));
      if (!isRecord(raw)) return { ok: false, error: `草稿不存在: ${host}::${slug}` };
      const draftCard = raw as unknown as SkillCardData;
      if (draftCard.status !== "draft") return { ok: false, error: "非 draft 状态不可采纳" };
      const existing = await this.getCard(host, slug);
      if (existing?.provenance.sourceType === "built-in") {
        return { ok: false, error: "built-in 卡不可被草稿覆盖（D14 保护）" };
      }
      const card: SkillCardData = {
        host,
        slug,
        sop: edits.sop?.trim() ? edits.sop : draftCard.sop,
        selectors: edits.selectors?.trim() ? edits.selectors : draftCard.selectors,
        quirks: edits.quirks?.trim() ? edits.quirks : draftCard.quirks,
        description: edits.description?.trim() ? edits.description : draftCard.description,
        keywords: edits.keywords && edits.keywords.length > 0 ? edits.keywords : draftCard.keywords,
        distilledAt: draftCard.distilledAt,
        sourceTraces: [
          ...new Set([...(existing?.sourceTraces ?? []), ...(draftCard.sourceTraces ?? [])]),
        ],
        distillStreak: 0,
        provenance: { sourceType: "distilled", note: "adopted" },
        updatedAt: now,
      };
      await this.db.put(cardKey(host, slug), card);
      await this.db.delete(draftKey(host, slug));
      return { ok: true, card };
    });
  }

  /** 丢弃草稿（只删草稿键，正键永不受影响；经串行面与 saveDraft/adopt 共面） */
  async discardDraft(host: string, slug: string): Promise<void> {
    await this.serialize(() => this.db.delete(draftKey(host, slug)));
  }

  /** D17 收敛计数：unchanged 路径递增在用卡 streak（内容/distilledAt 不动——与
   *  node bumpDistillStreak 只重写 _task.json 同口径）。卡不存在静默 no-op */
  async bumpDistillStreak(host: string, slug: string, now = Date.now()): Promise<void> {
    await this.serialize(async () => {
      const card = await this.getCard(host, slug);
      if (card === null) return;
      await this.db.put(cardKey(host, slug), {
        ...card,
        distillStreak: (card.distillStreak ?? 0) + 1,
        updatedAt: now,
      });
    });
  }
}
