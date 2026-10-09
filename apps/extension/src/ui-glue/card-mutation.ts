// 卡片保存变更计划（m5/05 轮 2 [2][3]）：ProviderCardForm.onSave 的宿主侧
// 纯函数——撞名统一判定（新增路径 originalName=null 时旧守卫恒不触发，同名
// 新增静默整卡替换既有卡）与 activeCard 单点计算（「无活跃卡自动激活」与
// 「改名指针重定向」两个条件展开互覆——对象展开后者胜吞掉前者）。

import type { ProviderCardDto } from "@tw/protocol";
import type { ExtensionSettings } from "../host/settings-store.js";

export type CardMutationPlan = { ok: true; next: ExtensionSettings } | { ok: false; error: string };

/**
 * 计划一次卡片保存：
 * - 新增（originalName=null）：同名占用即拒绝（守卫不再恒假）；
 * - 编辑：按原名替换；改名时新名被其他卡占用即拒绝；activeCard/taskSkill/
 *   judge/extract 指向旧名的指针重定向到新名；
 * - 无活跃卡时自动激活本次保存的卡（先自动激活再重定向——合一计算防互覆）。
 */
export function planCardMutation(
  settings: ExtensionSettings,
  card: ProviderCardDto,
  originalName: string | null,
): CardMutationPlan {
  const target = originalName ?? card.name;
  // 撞名：同名卡存在且不是被编辑卡本身（新增时任何同名占用都算）
  const collision = settings.providerCards.some(
    (c) => c.name === card.name && (originalName === null || c.name !== target),
  );
  if (collision) {
    return { ok: false, error: `卡片名「${card.name}」已被占用` };
  }
  const exists = settings.providerCards.some((c) => c.name === target);
  const providerCards = exists
    ? settings.providerCards.map((c) => (c.name === target ? card : c))
    : [...settings.providerCards, card];
  const renamed = card.name !== target;
  const retarget = (v: string | undefined): string | undefined => (v === target ? card.name : v);
  // 单点计算：无活跃卡 → 自动激活；改名 → 指针重定向（两者叠加不互覆）
  let activeCard = settings.activeCard === "" ? card.name : settings.activeCard;
  if (renamed && activeCard === target) activeCard = card.name;
  return {
    ok: true,
    next: {
      ...settings,
      providerCards,
      activeCard,
      ...(renamed ? { taskSkillCard: retarget(settings.taskSkillCard) } : {}),
      ...(renamed ? { judgeCard: retarget(settings.judgeCard) } : {}),
      ...(renamed ? { extractCard: retarget(settings.extractCard) } : {}),
    },
  };
}
