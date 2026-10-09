// ExtensionSkillSource（m5/04 §5）：core SkillSource 的 IndexedDB 实现。三件套
// 读序对齐 FsSkillSource（缓存/miss=null——实现方负责缓存）；任务卡全文无头
// "\n\n" join（P5.5 冻结口径：strip 后无分段头直拼——core renderTaskCard 的带头
// 版是站点级渲染形态，不得使用）。

import type { HostSkill, SkillSource, TaskCardMeta } from "@tw/core";
import type { SkillStore } from "./skill-store.js";

/** 扩展侧任务卡 meta：挂卡定位私有字段（core 匹配后原样回传 taskCardText——
 *  TaskCardMeta 的宿主扩展形态，FsTaskCardMeta 同款） */
export interface ExtensionTaskCardMeta extends TaskCardMeta {
  host: string;
}

export class ExtensionSkillSource implements SkillSource {
  private readonly store: SkillStore;
  private readonly log: (message: string) => void;
  private readonly hostCache = new Map<string, HostSkill | null>();
  private readonly catalogCache = new Map<string, ExtensionTaskCardMeta[]>();

  constructor(store: SkillStore, log: (message: string) => void = () => {}) {
    this.store = store;
    this.log = log;
  }

  async loadHostSkill(host: string): Promise<HostSkill | null> {
    if (host === "") return null;
    if (this.hostCache.has(host)) return this.hostCache.get(host) ?? null;
    const card = await this.store.getCard(host, "");
    if (card === null || (card.sop === "" && card.selectors === "" && card.quirks === "")) {
      this.log(`skill: no card for host=${host}`);
      this.hostCache.set(host, null);
      return null;
    }
    const skill: HostSkill = { sop: card.sop, selectors: card.selectors, quirks: card.quirks };
    this.hostCache.set(host, skill);
    return skill;
  }

  async taskCatalog(hostKey: string): Promise<TaskCardMeta[]> {
    const cached = this.catalogCache.get(hostKey);
    if (cached !== undefined) return [...cached];
    const slugs = await this.store.listTaskSlugs(hostKey);
    const metas: ExtensionTaskCardMeta[] = [];
    for (const slug of slugs) {
      const card = await this.store.getCard(hostKey, slug);
      if (card === null || card.description === undefined) continue;
      metas.push({
        slug,
        description: card.description,
        ...(card.keywords !== undefined ? { keywords: card.keywords } : {}),
        ...(card.distilledAt !== undefined ? { distilledAt: card.distilledAt } : {}),
        host: hostKey,
      });
    }
    this.catalogCache.set(hostKey, metas);
    return [...metas];
  }

  async taskCardText(meta: TaskCardMeta): Promise<string> {
    const host = (meta as ExtensionTaskCardMeta).host ?? "";
    const card = await this.store.getCard(host, meta.slug);
    if (card === null) return "";
    // task_loader.py:127-140 锚定：三件套 strip 后 "\n\n" 直拼（无分段头）
    return [card.sop, card.selectors, card.quirks].map((s) => s.trim()).join("\n\n");
  }
}
