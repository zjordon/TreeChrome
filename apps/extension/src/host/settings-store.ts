// 扩展配置存取（m5/04 §3）：chrome.storage.local 的 `tc_settings` 键 ⇄
// ExtensionSettings。apiKey 明文存 local（webbrain 同款——扩展本地边界内，不做
// OS 级加密，登记）。options 写入后发 settings-changed → run-manager 热读（只
// 影响下一次 run；运行中不换卡——run 装配一次性，node-host 同款）。

import type { SensitiveDataSpec } from "@tw/core";
import type { ProviderCardDto } from "@tw/protocol";
import type { StorageArea } from "./chrome-apis.js";

/** tc_settings 落盘形态（m5/04 §3.1 表） */
export interface ExtensionSettings {
  providerCards: ProviderCardDto[];
  /** activeCard 指名的卡片名；无匹配 → 装配报错（用户可见） */
  activeCard: string;
  /** 附属卡名（providerCards 内查）；未设 = 复用主卡 */
  taskSkillCard?: string;
  judgeCard?: string;
  extractCard?: string;
  /** 敏感数据占位符配置（secret-provider 消费） */
  sensitiveData?: Record<string, { value: string; urls: string[] | null }>;
  agent?: {
    useVision?: boolean;
    maxSteps?: number;
  };
}

export const SETTINGS_KEY = "tc_settings";

export const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = {
  providerCards: [],
  activeCard: "",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 存储值宽松收窄为卡片（缺字段在 LLMClient 构造/请求时显形——读路径不抛） */
function toCard(v: unknown): ProviderCardDto | null {
  if (!isRecord(v) || typeof v.name !== "string" || typeof v.protocol !== "string") return null;
  return v as unknown as ProviderCardDto;
}

/** 存储值 → ExtensionSettings（宽松收窄：坏形态键回缺省，不抛——读路径容错） */
export function parseExtensionSettings(raw: unknown): ExtensionSettings {
  if (!isRecord(raw)) return { ...DEFAULT_EXTENSION_SETTINGS };
  const cards = Array.isArray(raw.providerCards)
    ? raw.providerCards.map(toCard).filter((c): c is ProviderCardDto => c !== null)
    : [];
  const activeCard = typeof raw.activeCard === "string" ? raw.activeCard : "";
  const out: ExtensionSettings = { providerCards: cards, activeCard };
  if (typeof raw.taskSkillCard === "string") out.taskSkillCard = raw.taskSkillCard;
  if (typeof raw.judgeCard === "string") out.judgeCard = raw.judgeCard;
  if (typeof raw.extractCard === "string") out.extractCard = raw.extractCard;
  if (isRecord(raw.sensitiveData)) {
    const sd: Record<string, { value: string; urls: string[] | null }> = {};
    for (const [placeholder, spec] of Object.entries(raw.sensitiveData)) {
      if (!isRecord(spec) || typeof spec.value !== "string") continue;
      sd[placeholder] = {
        value: spec.value,
        urls: Array.isArray(spec.urls) ? (spec.urls as string[]) : null,
      };
    }
    out.sensitiveData = sd;
  }
  if (isRecord(raw.agent)) {
    out.agent = {
      ...(typeof raw.agent.useVision === "boolean" ? { useVision: raw.agent.useVision } : {}),
      ...(typeof raw.agent.maxSteps === "number" ? { maxSteps: raw.agent.maxSteps } : {}),
    };
  }
  return out;
}

/** 热读（每次 start 前调；缺键/坏形态回缺省空卡——装配层报「无可用卡片」） */
export class SettingsStore {
  private readonly area: StorageArea;

  constructor(area: StorageArea) {
    this.area = area;
  }

  async load(): Promise<ExtensionSettings> {
    const items = await this.area.get(SETTINGS_KEY);
    return parseExtensionSettings(items[SETTINGS_KEY]);
  }

  async save(settings: ExtensionSettings): Promise<void> {
    await this.area.set({ [SETTINGS_KEY]: settings });
  }
}

/** 按名取卡（activeCard 未命中 → null；assemble 报错面） */
export function findCard(
  settings: ExtensionSettings,
  name: string | undefined,
): ProviderCardDto | null {
  if (name === undefined || name === "") return null;
  return settings.providerCards.find((c) => c.name === name) ?? null;
}

/** 敏感数据映射（AgentOptions.sensitiveData 直传形态；空配置 → null） */
export function sensitiveSpecsOf(
  settings: ExtensionSettings,
): Record<string, SensitiveDataSpec> | null {
  if (settings.sensitiveData === undefined) return null;
  const entries = Object.entries(settings.sensitiveData);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.map(([k, v]) => [k, { value: v.value, urls: v.urls }]));
}
