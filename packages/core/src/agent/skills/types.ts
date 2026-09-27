// skills 层类型（架构 §6.1 双层）：SkillSource 宿主注入接口（README 决策 8——core
// 不碰 fs；Node 宿主实现读目录，读序与分段格式照搬 loader.py:17-21/:67-106）+
// TaskCardMeta（task_loader.py:37-41 catalogLine 格式字节锚定）。

/** 站点级 skill 三件套（读序固定：SOP 骨架在前 → SELECTORS 批量 → QUIRKS） */
export interface HostSkill {
  sop: string;
  selectors: string;
  quirks: string;
}

/** 宿主 skill 能力注入面（实现方负责缓存；miss 返回 null） */
export interface SkillSource {
  loadHostSkill(host: string): Promise<HostSkill | null>;
  /** 当前 host 的任务卡目录（空数组 = 无） */
  taskCatalog(hostKey: string): Promise<TaskCardMeta[]>;
  /** 命中卡的全文（三件套按 [SOP]/[SELECTORS]/[QUIRKS] 分段拼接） */
  taskCardText(meta: TaskCardMeta): Promise<string>;
}

/** 一张任务卡的检索元数据（TreeForge P4 S6 契约） */
export interface TaskCardMeta {
  slug: string;
  description: string;
  keywords?: readonly string[];
  distilledAt?: string;
}

/** 渲染进匹配 prompt 的一行 catalog 条目（docs/p7/03 附录 B 格式，字节锚定） */
export function catalogLine(meta: TaskCardMeta): string {
  const kw = (meta.keywords ?? []).join(", ");
  const suffix = kw ? ` | keywords: ${kw}` : "";
  return `- \`${meta.slug}\` — ${meta.description}${suffix}`;
}

/** 三件套 → 注入文本（[SOP]/[SELECTORS]/[QUIRKS] 分段头；空段跳过——loader.py 读序） */
export function renderTaskCard(card: { sop: string; selectors: string; quirks: string }): string {
  const sections: Array<[string, string]> = [
    ["[SOP]", card.sop],
    ["[SELECTORS]", card.selectors],
    ["[QUIRKS]", card.quirks],
  ];
  const parts: string[] = [];
  for (const [header, text] of sections) {
    const t = text.trim();
    if (!t) continue;
    parts.push(header, t, "");
  }
  return parts.join("\n").trim();
}
