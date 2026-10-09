// settings-store / grant-store 单测（m5/04 §3）：存储形态宽松收窄（坏形态回缺省）、
// findCard 按名取卡、sensitiveSpecsOf 映射、Grant load/save 形态过滤——fake
// StorageArea（Map 化）。

import { describe, expect, it } from "vitest";
import type { StorageArea } from "../src/host/chrome-apis.js";
import { ChromeGrantStore, PERMISSIONS_KEY } from "../src/host/grant-store.js";
import {
  DEFAULT_EXTENSION_SETTINGS,
  findCard,
  parseExtensionSettings,
  SETTINGS_KEY,
  SettingsStore,
  sensitiveSpecsOf,
} from "../src/host/settings-store.js";

function fakeArea(): StorageArea & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys) {
      const wanted = keys === null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of wanted) if (data.has(k)) out[k] = data.get(k);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
  };
}

const CARD = {
  name: "main",
  protocol: "anthropic-messages",
  baseUrl: "https://x",
  apiKey: "k",
  model: "m",
  maxTokens: 4096,
} as const;

describe("parseExtensionSettings", () => {
  it("null/非对象 → 缺省；坏形态键回缺省", () => {
    expect(parseExtensionSettings(null)).toEqual({ ...DEFAULT_EXTENSION_SETTINGS });
    expect(parseExtensionSettings("junk")).toEqual({ ...DEFAULT_EXTENSION_SETTINGS });
    const s = parseExtensionSettings({
      providerCards: [CARD, { bogus: true }, "junk"],
      activeCard: 123,
      sensitiveData: { ok: { value: "v", urls: ["u"] }, bad: "notobj" },
      agent: { useVision: "yes", maxSteps: 50 },
    });
    expect(s.providerCards).toEqual([CARD]);
    expect(s.activeCard).toBe("");
    expect(s.sensitiveData).toEqual({ ok: { value: "v", urls: ["u"] } });
    expect(s.agent).toEqual({ maxSteps: 50 });
  });

  it("附属卡名与 agent 覆盖直映", () => {
    const s = parseExtensionSettings({
      providerCards: [CARD],
      activeCard: "main",
      taskSkillCard: "ts",
      judgeCard: "j",
      agent: { useVision: true },
    });
    expect(s).toMatchObject({ activeCard: "main", taskSkillCard: "ts", judgeCard: "j" });
    expect(s.agent).toEqual({ useVision: true });
  });
});

describe("findCard / sensitiveSpecsOf", () => {
  const settings = parseExtensionSettings({ providerCards: [CARD], activeCard: "main" });
  it("按名取卡（未设/未命中 → null）", () => {
    expect(findCard(settings, "main")?.name).toBe("main");
    expect(findCard(settings, "ghost")).toBeNull();
    expect(findCard(settings, undefined)).toBeNull();
    expect(findCard(settings, "")).toBeNull();
  });
  it("敏感映射（无配置/空 → null）", () => {
    expect(sensitiveSpecsOf(settings)).toBeNull();
    const withSd = parseExtensionSettings({
      providerCards: [CARD],
      sensitiveData: { pwd: { value: "v", urls: null } },
    });
    expect(sensitiveSpecsOf(withSd)).toEqual({ pwd: { value: "v", urls: null } });
  });
});

describe("SettingsStore", () => {
  it("load 缺键 → 缺省；save/load 往返", async () => {
    const area = fakeArea();
    const store = new SettingsStore(area);
    expect(await store.load()).toEqual({ ...DEFAULT_EXTENSION_SETTINGS });
    await store.save(parseExtensionSettings({ providerCards: [CARD], activeCard: "main" }));
    expect(area.data.get(SETTINGS_KEY)).toMatchObject({ activeCard: "main" });
    expect((await store.load()).providerCards).toEqual([CARD]);
  });
});

describe("ChromeGrantStore", () => {
  const grant = {
    capability: "CLICK",
    host: "a.example",
    decision: "allow",
    duration: "always",
    tabId: null,
    createdAt: 1,
  } as const;
  it("save/load 往返；坏形态条目被过滤；缺键 → []", async () => {
    const area = fakeArea();
    const store = new ChromeGrantStore(area);
    expect(await store.loadAlways()).toEqual([]);
    await store.saveAlways([grant, { bogus: true }]);
    expect(await store.loadAlways()).toEqual([grant]);
    expect(area.data.get(PERMISSIONS_KEY)).toEqual([grant, { bogus: true }]);
    // 多样坏形态：字段类型错/枚举外值/tabId 类型错——全滤
    area.data.set(PERMISSIONS_KEY, [
      { ...grant, decision: "maybe", duration: "forever", tabId: 5 },
      "junk",
      null,
      grant,
    ]);
    expect(await store.loadAlways()).toEqual([grant]);
    area.data.set(PERMISSIONS_KEY, "not-array");
    expect(await store.loadAlways()).toEqual([]);
  });
});
