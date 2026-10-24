// 蒸馏 worker 单测（issue #5 S4）：mock LLM（matcher/distill 双面分流）+ 真
// SkillStore(fakeDb) + 真 DistillQueue(fake area)。覆盖：happy path 草稿落库+notify/
// unchanged 走 bump/建卡 D14 skip/error 重试记账/selfEvolution 关不 drain/保活平衡/
// distillCard 附属卡优先。

import type { DistillLLM, ProviderConfig, SkillSource } from "@tw/core";
import { describe, expect, it } from "vitest";
import { parseExtensionSettings, type SettingsStore } from "../src/host/settings-store.js";
import { type SkillDb, SkillStore } from "../src/host/skill-store.js";
import { type DistillJob, DistillQueue } from "../src/runtime/distill-queue.js";
import { DistillWorker } from "../src/runtime/distill-worker.js";

const CARD: ProviderConfig = {
  name: "main",
  protocol: "anthropic-messages",
  baseUrl: "https://api",
  apiKey: "key",
  model: "m",
  maxTokens: 4096,
};

/** matcher（schema 含 "match"）与蒸馏（DISTILL_OUTPUT_SCHEMA）双面分流的 mock */
function mockLlm(opts: {
  match: Record<string, unknown>;
  distill: Record<string, unknown> | null;
}): { llm: DistillLLM; distillCalls: () => number } {
  let distillCalls = 0;
  return {
    llm: {
      async structuredCall(_s, _p, schema) {
        const props = (schema.properties ?? {}) as Record<string, unknown>;
        if ("match" in props) return opts.match;
        distillCalls += 1;
        return opts.distill;
      },
    },
    distillCalls: () => distillCalls,
  };
}

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

function primedQueue(job: DistillJob): DistillQueue {
  // 直接种子 storage（不经 enqueue——避免异步竞态，drain 首查即见）
  const map = new Map<string, unknown>([["tc_distillQueue", [job]]]);
  const area = {
    async get(key: string) {
      return map.has(key) ? { [key]: map.get(key) } : {};
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) map.set(k, v);
    },
  };
  return new DistillQueue(area);
}

const JOB: DistillJob = {
  runId: "r1",
  task: "查 Bestsellers 报表",
  host: "a.example",
  traceText: "Step 1:\n  URL: https://a.example/reports",
  stepCount: 3,
  enqueuedAt: 1,
  attempts: 0,
};

const VALID_DRAFT = {
  task_slug: "bestsellers-report",
  task_description: "查 Bestsellers 报表",
  task_keywords: ["报表"],
  sop_md: "# 查报表\nstep 1: 打开报表页",
  selectors_md: "",
  quirks_md: "表格行有错位",
};

interface BuildOpts {
  llm: DistillLLM;
  queue?: DistillQueue;
  settings?: ReturnType<typeof parseExtensionSettings>;
  /** skill 源目录（taskCatalog/taskCardText 面） */
  catalog?: { slug: string; description: string; text?: string }[];
  /** 预置正键卡（增量/保护场景） */
  seedCard?: (db: SkillDb & { map: Map<string, unknown> }) => void;
}

function buildWorker(opts: BuildOpts): {
  worker: DistillWorker;
  store: SkillStore;
  queue: DistillQueue;
  holds: number[];
  notified: number[];
  usedCards: Array<ProviderConfig | null>;
} {
  const db = fakeDb();
  opts.seedCard?.(db);
  const store = new SkillStore(db);
  const settings =
    opts.settings ?? parseExtensionSettings({ providerCards: [CARD], activeCard: "main" });
  const holds: number[] = [];
  const notified: number[] = [];
  const usedCards: Array<ProviderConfig | null> = [];
  const catalog = opts.catalog ?? [];
  const skillSource: SkillSource = {
    loadHostSkill: async () => null,
    taskCatalog: async () => catalog,
    taskCardText: async () => catalog[0]?.text ?? "SOP\n\nSEL\n\nQ",
  };
  const queue = opts.queue ?? primedQueue(JOB);
  const worker = new DistillWorker({
    queue,
    settingsStore: { load: async () => settings } as unknown as SettingsStore,
    llmFactory: (c) => {
      usedCards.push(c);
      return opts.llm;
    },
    makeSkillSource: () => skillSource,
    skillStore: store,
    keepalive: {
      hold: () => void holds.push(1),
      release: () => void holds.push(-1),
      onStartRun: () => {},
      onEndRun: () => {},
    } as never,
    notify: (n) => void notified.push(n),
    activeCard: () => {
      usedCards.push(null);
      return CARD;
    },
  });
  return { worker, store, queue, holds, notified, usedCards };
}

describe("DistillWorker", () => {
  it("happy path：新卡草稿落 draft 键空间 → notify(1) → 队列清空", async () => {
    const { llm } = mockLlm({ match: { match: null, confidence: "high" }, distill: VALID_DRAFT });
    const { worker, store, notified } = buildWorker({ llm });
    await worker.drainAll();
    const drafts = await store.listDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      host: "a.example",
      slug: "bestsellers-report",
      status: "draft",
      sourceTraces: ["r1"],
    });
    expect(notified).toEqual([1]);
    expect((await store.getCard("a.example", "bestsellers-report")) === null).toBe(true); // 正键未占
  });

  it("unchanged：无新观察 → 在用卡 streak+1（内容/distilledAt 不动）→ ack", async () => {
    const distilledAt = "2026-10-01T00:00:00Z";
    const { llm } = mockLlm({
      match: { match: "old-task", confidence: "high" },
      distill: { ...VALID_DRAFT, has_new_observations: false },
    });
    const { worker, store } = buildWorker({
      llm,
      catalog: [{ slug: "old-task", description: "旧任务", text: "SOP-OLD" }],
      seedCard: (db) => {
        db.map.set("a.example::old-task", {
          host: "a.example",
          slug: "old-task",
          sop: "SOP-OLD",
          selectors: "",
          quirks: "",
          description: "旧任务",
          distilledAt,
          distillStreak: 1,
          provenance: { sourceType: "distilled" },
          updatedAt: 1,
        });
      },
    });
    await worker.drainAll();
    expect(await store.getCard("a.example", "old-task")).toMatchObject({
      sop: "SOP-OLD",
      distilledAt,
      distillStreak: 2,
    });
    expect(await store.listDrafts()).toHaveLength(0);
  });

  it("D14：matcher 命中 built-in 卡 → 蒸馏调用不发出 → skip ack", async () => {
    const { llm, distillCalls } = mockLlm({
      match: { match: "builtin-task", confidence: "high" },
      distill: VALID_DRAFT,
    });
    const { worker, store } = buildWorker({
      llm,
      catalog: [{ slug: "builtin-task", description: "内置任务" }],
      seedCard: (db) => {
        db.map.set("a.example::builtin-task", {
          host: "a.example",
          slug: "builtin-task",
          sop: "S",
          selectors: "",
          quirks: "",
          description: "内置任务",
          provenance: { sourceType: "built-in" },
          updatedAt: 1,
        });
      },
    });
    await worker.drainAll();
    expect(distillCalls()).toBe(0); // 蒸馏调用被 D14 短路
    expect(await store.listDrafts()).toHaveLength(0);
  });

  it("error：LLM 不可解析 → job 保留（attempts+1）；再失败 → 丢弃", async () => {
    const { llm } = mockLlm({ match: { match: null, confidence: "high" }, distill: null });
    const { worker, queue } = buildWorker({ llm });
    await worker.drainAll();
    expect(await queue.size()).toBe(1); // 保留重试
    expect((await queue.peek())?.attempts).toBe(1);
    await worker.drainAll(); // 第二轮：attempts 达上限 → 丢弃
    expect(await queue.size()).toBe(0);
  });

  it("selfEvolution.enabled=false：整轮不 drain（job 原样保留）", async () => {
    const { llm, distillCalls } = mockLlm({ match: { match: null }, distill: VALID_DRAFT });
    const { worker, queue } = buildWorker({
      llm,
      settings: parseExtensionSettings({
        providerCards: [CARD],
        activeCard: "main",
        selfEvolution: { enabled: false, distillCard: "" },
      }),
    });
    await worker.drainAll();
    expect(distillCalls()).toBe(0); // 未消费
    expect(await queue.size()).toBe(1); // job 原样保留
  });

  it("keepalive hold/release 配对（drain 全程保活）", async () => {
    const { llm } = mockLlm({ match: { match: null }, distill: VALID_DRAFT });
    const { worker, holds } = buildWorker({ llm });
    await worker.drainAll();
    expect(holds).toEqual([1, -1]);
  });

  it("distillCard 附属卡：selfEvolution.distillCard 命中则优先于主卡", async () => {
    const subCard = { ...CARD, name: "sub", model: "mini" };
    const { llm } = mockLlm({ match: { match: null }, distill: VALID_DRAFT });
    const { worker, usedCards } = buildWorker({
      llm,
      settings: parseExtensionSettings({
        providerCards: [CARD, subCard],
        activeCard: "main",
        selfEvolution: { enabled: true, distillCard: "sub" },
      }),
    });
    await worker.drainAll();
    expect(usedCards).toEqual([subCard]); // 附属卡优先，主卡兜底面未被调用
  });
});

// ── 评审轮 1 [7]：落库段异常收口（不无限重跑 LLM） ──────────────────────

describe("DistillWorker 落库异常", () => {
  it("saveDraft 抛错 → queue.fail 记账（attempts 递增，重跑后丢弃）", async () => {
    const { llm, distillCalls } = mockLlm({
      match: { match: null, confidence: "high" },
      distill: VALID_DRAFT,
    });
    const breaking = fakeDb();
    const origPut = breaking.put.bind(breaking);
    breaking.put = async (key, value) => {
      if (key.startsWith("draft::")) throw new Error("QuotaExceeded");
      return origPut(key, value);
    };
    const store = new SkillStore(breaking);
    const queue = primedQueue(JOB);
    const worker = new DistillWorker({
      queue,
      settingsStore: {
        load: async () => parseExtensionSettings({ providerCards: [CARD], activeCard: "main" }),
      } as unknown as SettingsStore,
      llmFactory: () => llm,
      makeSkillSource: () => ({
        loadHostSkill: async () => null,
        taskCatalog: async () => [],
        taskCardText: async () => "",
      }),
      skillStore: store,
      keepalive: {
        hold: () => {},
        release: () => {},
        onStartRun: () => {},
        onEndRun: () => {},
      } as never,
      notify: () => {},
      activeCard: () => CARD,
    });
    await worker.drainAll();
    expect(distillCalls()).toBeGreaterThan(0); // LLM 蒸馏确实跑了
    expect(await queue.size()).toBe(1); // fail 记账保留 job
    expect((await queue.peek())?.attempts).toBe(1);
    await worker.drainAll(); // 第二轮：attempts 达上限 → dropped
    expect(await queue.size()).toBe(0);
  });
});
