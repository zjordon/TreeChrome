// skill 存储（m5/04 §5）：IndexedDB db `treewalker-skills` store `cards`。窄存储面
// 注入（真实现走 indexedDB.open；单测 fake Map）——IDB 全 API 面不进测试。built-in
// 刷新：onInstalled/onUpdated → fetch 打包清单（domain-skills.json，构建期生成）
// → upsert（provenance.sourceType==="built-in" 精确匹配才覆盖——import/distilled
// 卡不碰）。M5 不做：URL 导入/蒸馏/审阅流（M7）。

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

export class SkillStore {
  private readonly db: SkillDb;

  constructor(db: SkillDb) {
    this.db = db;
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
        await this.db.delete(key);
        written += 1;
      }
    }
    return written;
  }

  /** 单卡 upsert 判定：非 built-in 在位不碰；内容未变不重写 */
  private async upsertBuiltins(card: SkillCardData): Promise<boolean> {
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
  }
}
