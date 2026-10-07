// FsSkillSource（P5.5 skill 宿主装载层）：loader.py / task_loader.py 语义锚定——
// 三件套读序/缺件降级/坏卡守卫/排序/缓存/日志面，taskCardText 无分段头 "\n\n" 直拼
// （task_loader.py:127-140 card_text 锚定）。临时目录 fixture，用后即删。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assembleAgent } from "../src/agent-boot.js";
import type { HostSettings } from "../src/settings.js";
import { FsSkillSource } from "../src/skill-source.js";
import { deadLlm, fakeTransport, settings } from "./agent-boot-helpers.js";

let root: string;
const roots: string[] = [];
const mkRoot = (): string => {
  root = mkdtempSync(join(tmpdir(), "tw-skill-source-"));
  roots.push(root);
  return root;
};
afterAll(() => {
  for (const r of roots) {
    rmSync(r, { recursive: true, force: true });
  }
});

const writeHost = (host: string, files: Record<string, string>): void => {
  mkdirSync(join(root, host), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, host, name), body, "utf8");
  }
};

const writeCard = (
  host: string,
  slug: string,
  meta: string | null,
  files?: Record<string, string>,
): void => {
  const dir = join(root, host, "tasks", slug);
  mkdirSync(dir, { recursive: true });
  if (meta !== null) {
    writeFileSync(join(dir, "_task.json"), meta, "utf8");
  }
  for (const [name, body] of Object.entries(files ?? {}) as Array<[string, string]>) {
    writeFileSync(join(dir, name), body, "utf8");
  }
};

describe("FsSkillSource 站点级（loader.py 锚定）", () => {
  it("三件套全出（strip）；loaded 日志带 chars 与文件清单", async () => {
    const r = mkRoot();
    writeHost("a.example", {
      "_sop.md": "  step one\nstep two  ",
      "selectors.md": "| tbl |",
      "quirks.md": "quirk",
    });
    const logs: string[] = [];
    const src = new FsSkillSource(r, (m) => logs.push(m));
    const card = await src.loadHostSkill("a.example");
    expect(card).toEqual({ sop: "step one\nstep two", selectors: "| tbl |", quirks: "quirk" });
    expect(logs.some((m) => m.startsWith("skill loaded: host=a.example chars="))).toBe(true);
    expect(logs.some((m) => m.includes("files=[_sop.md, selectors.md, quirks.md]"))).toBe(true);
  });

  it("缺 selectors 出两段；全空 → null + skill empty 日志；无 host 目录 → null + no directory 日志", async () => {
    const r = mkRoot();
    writeHost("partial.example", { "_sop.md": "sop", "quirks.md": "q" });
    writeHost("blank.example", { "_sop.md": "   " });
    const logs: string[] = [];
    const src = new FsSkillSource(r, (m) => logs.push(m));
    expect(await src.loadHostSkill("partial.example")).toEqual({
      sop: "sop",
      selectors: "",
      quirks: "q",
    });
    expect(await src.loadHostSkill("blank.example")).toBeNull();
    expect(await src.loadHostSkill("missing.example")).toBeNull();
    expect(logs).toContain("skill empty: host=blank.example (all files blank/missing)");
    expect(
      logs.some((m) => m.startsWith("skill: no directory for host=missing.example (looked at")),
    ).toBe(true);
  });

  it("per-host 缓存：首次读取后改盘不再生效（miss 也缓存）", async () => {
    const r = mkRoot();
    writeHost("cache.example", { "_sop.md": "v1" });
    const src = new FsSkillSource(r);
    expect((await src.loadHostSkill("cache.example"))?.sop).toBe("v1");
    writeFileSync(join(r, "cache.example", "_sop.md"), "v2", "utf8");
    expect((await src.loadHostSkill("cache.example"))?.sop).toBe("v1");
    expect(await src.loadHostSkill("nomiss.example")).toBeNull();
    mkdirSync(join(r, "nomiss.example"), { recursive: true });
    expect(await src.loadHostSkill("nomiss.example")).toBeNull(); // miss 缓存
  });

  it("空 host → null（loader.py not host 分支）", async () => {
    const src = new FsSkillSource(mkRoot());
    expect(await src.loadHostSkill("")).toBeNull();
  });
});

describe("FsSkillSource 任务卡 catalog（task_loader.py 锚定）", () => {
  it("正常卡 meta 全字段 + 排序（目录名字典序）+ 有卡日志", async () => {
    const r = mkRoot();
    writeCard(
      "h.example",
      "b-card",
      '{"slug":"b-card","task_description":"Do b","task_keywords":["x","y"],"distilled_at":"2026-01-02"}',
    );
    writeCard(
      "h.example",
      "a-card",
      '{"task_description":"Do a","task_keywords":[],"distilled_at":"2026-01-01"}',
    );
    const logs: string[] = [];
    const src = new FsSkillSource(r, (m) => logs.push(m));
    const catalog = await src.taskCatalog("h.example");
    expect(catalog.map((c) => c.slug)).toEqual(["a-card", "b-card"]);
    expect(catalog[1]).toMatchObject({
      slug: "b-card",
      description: "Do b",
      keywords: ["x", "y"],
      distilledAt: "2026-01-02",
    });
    expect(logs).toContain("task-skill catalog: 2 cards (host_key=h.example)");
  });

  it("守卫族：坏 JSON / 非 dict / 无描述 / 无 _task.json 目录（glob 未命中=静默）/ slug 缺省目录名 / keywords 三形态", async () => {
    const r = mkRoot();
    writeCard("h.example", "bad-json", "{not json");
    writeCard("h.example", "non-dict", "[1,2]");
    writeCard("h.example", "no-desc", '{"task_description":"  "}');
    writeCard("h.example", "no-meta", null, { "selectors.md": "x" }); // 无 _task.json → glob 不命中
    writeCard("h.example", "kw-str", '{"task_description":"d","task_keywords":"单键"}');
    writeCard("h.example", "kw-null", '{"task_description":"d","task_keywords":42}');
    writeCard("h.example", "slug-default", '{"task_description":"d"}');
    const logs: string[] = [];
    const src = new FsSkillSource(r, (m) => logs.push(m));
    const catalog = await src.taskCatalog("h.example");
    expect(catalog.map((c) => c.slug)).toEqual(["kw-null", "kw-str", "slug-default"]);
    expect(catalog.find((c) => c.slug === "kw-str")?.keywords).toEqual(["单键"]);
    expect(catalog.find((c) => c.slug === "kw-null")?.keywords).toEqual([]);
    expect(logs.some((m) => m.includes("skip unparseable card") && m.includes("bad-json"))).toBe(
      true,
    );
    expect(logs.some((m) => m.includes("skip non-dict card"))).toBe(true);
    expect(logs.some((m) => m.includes("skip card without description"))).toBe(true);
  });

  it("目录在零有效卡（全坏）→ warning（防坏迁移静默——task_loader.py:74-78）", async () => {
    const r2 = mkRoot();
    writeCard("zero.example", "only-bad", "{oops");
    const logs: string[] = [];
    const src = new FsSkillSource(r2, (m) => logs.push(m));
    expect(await src.taskCatalog("zero.example")).toEqual([]);
    expect(logs.some((m) => m.includes("0 cards under") && m.includes("all unparseable"))).toBe(
      true,
    );
  });

  it("无 tasks 目录 → 空数组 + info（非 warning）；catalog 缓存（删目录后仍旧值）", async () => {
    const r = mkRoot();
    writeHost("plain.example", { "_sop.md": "s" });
    const logs: string[] = [];
    const src = new FsSkillSource(r, (m) => logs.push(m));
    expect(await src.taskCatalog("plain.example")).toEqual([]);
    expect(logs).toContain("task-skill catalog: 0 cards (no tasks/ dir, host_key=plain.example)");
    writeCard("plain.example", "late-card", '{"task_description":"d"}');
    expect(await src.taskCatalog("plain.example")).toEqual([]); // 缓存
    expect(await src.taskCatalog("")).toEqual([]);
  });
});

describe("FsSkillSource.taskCardText（card_text :127-140 无头锚定）", () => {
  it("三件 strip 后 \\n\\n 直拼——无 [SOP] 分段头", async () => {
    const r = mkRoot();
    writeCard("h.example", "c", '{"task_description":"d"}', {
      "_sop.md": "  step A\n",
      "selectors.md": "sel body",
      "quirks.md": "\nquirk line\n",
    });
    const src = new FsSkillSource(r);
    const catalog = await src.taskCatalog("h.example");
    const text = await src.taskCardText(catalog[0]);
    expect(text).toBe("step A\n\nsel body\n\nquirk line");
    expect(text).not.toContain("[SOP]");
  });

  it("缺件跳过；无 cardDir 的裸 meta（core 侧构造）→ 空串", async () => {
    const r = mkRoot();
    writeCard("h.example", "c", '{"task_description":"d"}', { "quirks.md": "only q" });
    const src = new FsSkillSource(r);
    const catalog = await src.taskCatalog("h.example");
    expect(await src.taskCardText(catalog[0])).toBe("only q");
    expect(await src.taskCardText({ slug: "x", description: "y" })).toBe("");
  });
});

describe("assembleAgent skillSource 接线（P5.5 S2-3）", () => {
  it("settings.skillsDir 驱动构造 / null 关闭 / 显式注入位优先", () => {
    const r = mkRoot();
    writeHost("wired.example", { "_sop.md": "s" });
    const withDir = assembleAgent({
      task: "t",
      settings: settings({ skillsDir: r } as Partial<HostSettings>),
      wsUrl: "ws://stub",
      console: false,
      llm: deadLlm(),
      transportFactory: async () => fakeTransport(),
    });
    expect(withDir.agent.skillSource).toBeInstanceOf(FsSkillSource);

    const off = assembleAgent({
      task: "t",
      settings: settings(),
      wsUrl: "ws://stub",
      console: false,
      llm: deadLlm(),
      transportFactory: async () => fakeTransport(),
    });
    expect(off.agent.skillSource).toBeNull();

    const explicit = new FsSkillSource(r);
    const injected = assembleAgent({
      task: "t",
      settings: settings(), // skillsDir=null，但显式注入位优先
      wsUrl: "ws://stub",
      console: false,
      llm: deadLlm(),
      transportFactory: async () => fakeTransport(),
      skillSource: explicit,
    });
    expect(injected.agent.skillSource).toBe(explicit);

    // 显式 null = 强制关闭（轮 1 #1：JSDoc 契约——即使 settings.skillsDir 非空也不得
    // 落入 skillsDir 分支照常构造；评测基线形态）
    const forcedOff = assembleAgent({
      task: "t",
      settings: settings({ skillsDir: r } as Partial<HostSettings>),
      wsUrl: "ws://stub",
      console: false,
      llm: deadLlm(),
      transportFactory: async () => fakeTransport(),
      skillSource: null,
    });
    expect(forcedOff.agent.skillSource).toBeNull();
  });
});
