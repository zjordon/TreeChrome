// options 请求处理器（m5/04 段 E 原居 entrypoints/background.ts，issue #9 D7 迁出
// 换可测面——纯函数 + 注入面，零 chrome 依赖）：settings 读写 / grants 列举撤销 /
// skills 列举 / 端点测试 / 蒸馏草稿审阅三操作（issue #5）。全路径 fail-soft：异常/
// 坏载荷回 {ok:false,error} 不炸通道。

import type { OptionsOp, ProviderCardDto } from "@tw/protocol";
import type { ChromeGrantStore } from "../host/grant-store.js";
import { parseExtensionSettings, type SettingsStore } from "../host/settings-store.js";
import type { SkillStore } from "../host/skill-store.js";
import { createMutationQueue } from "./mutation-queue.js";

/** options 面：宿主 boot 装配注入（单一写者=SW——UI 不直碰 chrome.storage，
 *  避免双端竞态） */
export interface OptionsFace {
  settingsStore: SettingsStore;
  grantStore: ChromeGrantStore;
  skillStore: SkillStore;
  /** 草稿计数广播（issue #9 D1：adopt/discard 成功后调用，消除 sidepanel 只增
   *  不减的幻影提示）。**实现侧必须自吞异常**——通知失败只记日志，不得改变
   *  op 的成功返回值 */
  notifyDrafts: () => Promise<void>;
}

const grantsMutation = createMutationQueue();

export async function handleOptionsRequest(
  op: OptionsOp,
  payload: unknown,
  face: OptionsFace,
): Promise<unknown> {
  try {
    switch (op) {
      case "get-settings":
        return { ok: true, settings: await face.settingsStore.load() };
      case "save-settings":
        // 宽松收窄再落盘（单一写者=SW——UI 不直碰 chrome.storage，避免双端竞态）
        await face.settingsStore.save(parseExtensionSettings(payload));
        return { ok: true };
      case "list-grants":
        return { ok: true, grants: await face.grantStore.loadAlways() };
      case "revoke-grant": {
        const p = payload as { capability?: unknown; host?: unknown } | null;
        if (
          p === null ||
          typeof p.capability !== "string" ||
          typeof p.host !== "string" ||
          p.capability === "" ||
          p.host === ""
        ) {
          return { ok: false, error: "revoke-grant 需要 {capability, host}" };
        }
        // 读-改-写串行化（评审轮 1 [12]）：两条 revoke 在 await 点交错时后写者
        // 以陈旧全量覆盖回——已撤销的授权复活且不再弹权限卡。removed 先算后写：
        // loadAlways 若返回活引用（fake/内存实现），saveAlways 的 splice 会把
        // 原数组改掉——后求值恒得 0（迁移测试实抓的顺序脆弱性）
        const removed = await grantsMutation(() =>
          (async () => {
            const grants = await face.grantStore.loadAlways();
            const kept = grants.filter(
              (g) => !(g.capability === p.capability && g.host === p.host),
            );
            const removedCount = grants.length - kept.length;
            await face.grantStore.saveAlways(kept);
            return removedCount;
          })(),
        );
        return { ok: true, removed };
      }
      case "list-skills": {
        const cards = await face.skillStore.listAll();
        return {
          ok: true,
          cards: cards.map((c) => ({
            host: c.host,
            slug: c.slug,
            sourceType: c.provenance.sourceType,
            updatedAt: c.updatedAt,
            ...(c.distilledAt !== undefined ? { distilledAt: c.distilledAt } : {}),
            ...(c.status !== undefined ? { status: c.status } : {}),
          })),
        };
      }
      case "list-skill-drafts": {
        // 草稿全文（options 审阅面编辑底稿）——draft:: 键空间专用列举
        const drafts = await face.skillStore.listDrafts();
        return {
          ok: true,
          drafts: drafts.map((d) => ({
            host: d.host,
            slug: d.slug,
            ...(d.description !== undefined ? { description: d.description } : {}),
            ...(d.keywords !== undefined ? { keywords: d.keywords } : {}),
            sop: d.sop,
            selectors: d.selectors,
            quirks: d.quirks,
            ...(d.distilledAt !== undefined ? { distilledAt: d.distilledAt } : {}),
            ...(d.sourceTraces !== undefined ? { sourceTraces: d.sourceTraces } : {}),
            updatedAt: d.updatedAt,
          })),
        };
      }
      case "adopt-skill-draft": {
        const p = payload as { host?: unknown; slug?: unknown; edits?: unknown } | null;
        if (
          p === null ||
          typeof p.host !== "string" ||
          typeof p.slug !== "string" ||
          p.host === "" ||
          p.slug === ""
        ) {
          return { ok: false, error: "adopt-skill-draft 需要 {host, slug}" };
        }
        // edits 宽松收窄（三件套/描述可编辑；空串=不覆盖——与 store 层语义一致）
        const rawEdits = (p.edits ?? {}) as Record<string, unknown>;
        const edits: Record<string, string | string[]> = {};
        for (const key of ["sop", "selectors", "quirks", "description"] as const) {
          if (typeof rawEdits[key] === "string") edits[key] = rawEdits[key] as string;
        }
        if (Array.isArray(rawEdits.keywords)) {
          edits.keywords = (rawEdits.keywords as unknown[]).filter(
            (k): k is string => typeof k === "string",
          );
        }
        const res = await face.skillStore.adoptDraft(p.host, p.slug, edits);
        if (!res.ok) return { ok: false, error: res.error };
        // issue #9 D1：采纳成功 → 广播当前草稿数（sidepanel 徽标即刻清零）。
        // 兜底吞通知异常——实现侧（boot 闭包）应自吞并记日志，此处保证 op 结果
        // 不被通知故障吞掉（采纳已成功的事实优先）
        try {
          await face.notifyDrafts();
        } catch {
          /* 通知失败不影响 op 结果 */
        }
        return { ok: true };
      }
      case "discard-skill-draft": {
        const p = payload as { host?: unknown; slug?: unknown } | null;
        if (
          p === null ||
          typeof p.host !== "string" ||
          typeof p.slug !== "string" ||
          p.host === "" ||
          p.slug === ""
        ) {
          return { ok: false, error: "discard-skill-draft 需要 {host, slug}" };
        }
        await face.skillStore.discardDraft(p.host, p.slug);
        // issue #9 D1：丢弃成功 → 广播当前草稿数（同 adopt 的兜底语义）
        try {
          await face.notifyDrafts();
        } catch {
          /* 通知失败不影响 op 结果 */
        }
        return { ok: true };
      }
      case "test-card": {
        const card = payload as ProviderCardDto | null;
        if (
          card === null ||
          typeof card.baseUrl !== "string" ||
          !/^https?:\/\//.test(card.baseUrl)
        ) {
          return { ok: false, message: "baseUrl 形态不合法" };
        }
        // 可达性探测（非语义级验证）：任何 HTTP 应答即端点可达；5s 超时
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        try {
          const res = await fetch(card.baseUrl, { method: "GET", signal: ctrl.signal });
          return { ok: true, message: `HTTP ${res.status}（端点可达）` };
        } catch (e) {
          return { ok: false, message: e instanceof Error ? e.message : String(e) };
        } finally {
          clearTimeout(timer);
        }
      }
      default:
        return { ok: false, error: `未知操作：${op}` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
