// skill 宿主装载层：SkillLoader + TaskSkillLoader（tree_walker/skills/loader.py 与
// task_loader.py @640d52a）合并实现的 SkillSource——站点级三件套与任务卡 catalog/全文，
// per-host 进程内缓存零重复 IO，缺目录/坏卡静默降级（skill 是可选增强）。
//
// 偏离登记（p5/01-skill-face S1）：
// - loader.py:42-65 resolve_dir 的 repo-root 回退不移植——服务 Python editable 安装
//   （.pth 指回仓库根）特有形态；TS link: 消费者经 AGENT_SKILLS_DIR 显式给相对
//   （CWD 解析）或绝对路径，CWD 下无目录 = 静默无 skill（与非 editable Python 同行为）。
// - loader.py:108-113 invalidate 不移植——评测/示例进程生命周期短，扩展侧 M5 换
//   IndexedDB 源另议。
// - 直用 node:fs/promises（node-host 合法面）：core 的 FileSystem 五接口无列目录成员，
//   不为任务卡枚举扩宿主接口契约。
//
// 任务卡全文语义（task_loader.py:127-140 card_text 锚定）：三件套读序 strip 后
// **无分段头** `"\n\n"` 直拼——core 的 renderTaskCard（带头版）是站点级渲染形态，
// 此处不得使用。

import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { HostSkill, SkillSource, TaskCardMeta } from "@tw/core";

/** 站点级三件套文件名（读序固定：SOP 骨架在前——loader.py:17-21） */
const HOST_SKILL_FILES = {
  sop: "_sop.md",
  selectors: "selectors.md",
  quirks: "quirks.md",
} as const;

/** 读序固定的 (字段, 文件名) 对 */
const HOST_SKILL_ENTRIES: Array<[keyof HostSkill, string]> = [
  ["sop", HOST_SKILL_FILES.sop],
  ["selectors", HOST_SKILL_FILES.selectors],
  ["quirks", HOST_SKILL_FILES.quirks],
];

/** 任务卡三件套读序（task_loader.py:22——与站点级一致） */
const TASK_CARD_FILES = ["_sop.md", "selectors.md", "quirks.md"] as const;

/** node-host 侧任务卡 meta：挂卡目录私有字段（对象经 core 匹配后原样回传 taskCardText，
 *  core 不窥探额外字段——TaskCardMeta 的宿主扩展形态） */
export interface FsTaskCardMeta extends TaskCardMeta {
  cardDir: string;
}

/**
 * 读目录版 SkillSource。构造零 IO（禁用态安全实例化——loader.py:35-40 同款）；
 * 首次 loadHostSkill/taskCatalog 才触盘并按 host 缓存（miss 也缓存，重复查询零 IO）。
 */
export class FsSkillSource implements SkillSource {
  private readonly rootDir: string;
  private readonly log: (message: string) => void;
  private readonly hostCache = new Map<string, HostSkill | null>();
  private readonly catalogCache = new Map<string, FsTaskCardMeta[]>();

  constructor(rootDir: string, log: (message: string) => void = () => {}) {
    this.rootDir = rootDir;
    this.log = log;
  }

  async loadHostSkill(host: string): Promise<HostSkill | null> {
    if (!host) return null;
    if (this.hostCache.has(host)) {
      return this.hostCache.get(host) ?? null;
    }
    const hostDir = join(this.rootDir, host);
    let isDir = false;
    try {
      isDir = (await fsp.stat(hostDir)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      // 便于排查 host 不匹配（如访问 member.bilibili.com 但卡在 www.bilibili.com）
      this.log(`skill: no directory for host=${host} (looked at ${hostDir})`);
      this.hostCache.set(host, null);
      return null;
    }
    const card: HostSkill = { sop: "", selectors: "", quirks: "" };
    const loaded: string[] = [];
    for (const [field, filename] of HOST_SKILL_ENTRIES) {
      const text = await this.readTrimmed(join(hostDir, filename));
      if (text === null || text === "") continue;
      card[field] = text;
      loaded.push(filename);
    }
    if (loaded.length === 0) {
      this.log(`skill empty: host=${host} (all files blank/missing)`);
      this.hostCache.set(host, null);
      return null;
    }
    // 日志口径锚 loader.py:103（chars = 分段渲染长度，与 core 注入渲染同构）
    const rendered = loaded
      .map((f) => `[${this.headerOf(f)}]\n${card[this.fileField(f)]}\n`)
      .join("\n")
      .trim();
    this.log(`skill loaded: host=${host} chars=${rendered.length} files=[${loaded.join(", ")}]`);
    this.hostCache.set(host, card);
    return card;
  }

  async taskCatalog(hostKey: string): Promise<TaskCardMeta[]> {
    if (!hostKey) return [];
    const cached = this.catalogCache.get(hostKey);
    if (cached !== undefined) return cached;
    const tasksDir = join(this.rootDir, hostKey, "tasks");
    let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
    let dirExists = true;
    try {
      entries = await fsp.readdir(tasksDir, { withFileTypes: true });
    } catch {
      dirExists = false;
    }
    const cards: FsTaskCardMeta[] = [];
    if (dirExists) {
      // Python sorted(glob("*/_task.json")) = 目录名字典序
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (!entry.isDirectory()) continue;
        const card = await this.parseCard(join(tasksDir, entry.name));
        if (card !== null) cards.push(card);
      }
    }
    if (cards.length > 0) {
      this.log(`task-skill catalog: ${cards.length} cards (host_key=${hostKey})`);
    } else if (dirExists) {
      // 目录在零卡 = 卡全坏（坏迁移/全不可解析）——比目录不存在严重，warning 级
      // （task_loader.py:74-78 防再犯）
      this.log(`task-skill catalog: 0 cards under ${tasksDir} (all unparseable? bad migration?)`);
    } else {
      this.log(`task-skill catalog: 0 cards (no tasks/ dir, host_key=${hostKey})`);
    }
    this.catalogCache.set(hostKey, cards);
    return cards;
  }

  async taskCardText(meta: TaskCardMeta): Promise<string> {
    const dir = (meta as FsTaskCardMeta).cardDir;
    if (dir === undefined) return "";
    const parts: string[] = [];
    for (const filename of TASK_CARD_FILES) {
      const text = await this.readTrimmed(join(dir, filename));
      if (text !== null && text !== "") parts.push(text);
    }
    return parts.join("\n\n");
  }

  /** 读文件 strip；不存在/读失败 → null（调用方按缺件跳过） */
  private async readTrimmed(path: string): Promise<string | null> {
    try {
      return (await fsp.readFile(path, "utf8")).trim();
    } catch {
      return null;
    }
  }

  /** 解析单张 _task.json（task_loader.py:84-116 守卫逐条：坏 JSON/非 dict/无描述 skip
   *  并告警；keywords str|array 双形态守卫；slug 缺省目录名）；文件不存在 → null 静默
   *  （等价 glob 未命中）。 */
  private async parseCard(cardDir: string): Promise<FsTaskCardMeta | null> {
    const metaPath = join(cardDir, "_task.json");
    let raw: string;
    try {
      raw = await fsp.readFile(metaPath, "utf8");
    } catch {
      return null;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      this.log(
        `task-skill: skip unparseable card ${metaPath} (${e instanceof Error ? e.message : String(e)})`,
      );
      return null;
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      this.log(`task-skill: skip non-dict card ${metaPath}`);
      return null;
    }
    const record = data as Record<string, unknown>;
    const slug = String(record.slug ?? "").trim() || (cardDir.split(/[\\/]/).pop() ?? "");
    const description = String(record.task_description ?? "").trim();
    if (description === "") {
      // 无描述 = 无检索锚点，卡不可匹配（如模板模式产物）
      this.log(`task-skill: skip card without description ${metaPath}`);
      return null;
    }
    const rawKeywords = record.task_keywords;
    let keywords: string[];
    if (typeof rawKeywords === "string") {
      keywords = rawKeywords.trim() === "" ? [] : [rawKeywords];
    } else if (Array.isArray(rawKeywords)) {
      keywords = rawKeywords.map((k) => String(k)).filter((k) => k.trim() !== "");
    } else {
      keywords = [];
    }
    return {
      slug,
      description,
      keywords,
      distilledAt: String(record.distilled_at ?? ""),
      cardDir,
    };
  }

  /** 以下两映射仅服务 loaded 日志的字段还原 */
  private fileField(filename: string): keyof HostSkill {
    if (filename === HOST_SKILL_FILES.selectors) return "selectors";
    if (filename === HOST_SKILL_FILES.quirks) return "quirks";
    return "sop";
  }

  private headerOf(filename: string): string {
    if (filename === HOST_SKILL_FILES.selectors) return "SELECTORS";
    if (filename === HOST_SKILL_FILES.quirks) return "QUIRKS";
    return "SOP";
  }
}
