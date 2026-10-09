// options 组态（m5/05 §2）：settings 读写走 options 单发请求（单一写者=SW——UI
// 不直碰 chrome.storage）。ProviderList/ProviderCardForm + always 授权 + skill 库 +
// 附属卡/agent 覆盖（M5 极简内联面）。request 工厂由 entrypoints 注入（chrome 面）。

import {
  Button,
  GrantsView,
  ProviderCardForm,
  ProviderList,
  SkillListView,
  ThemedRoot,
} from "@tw/console-ui";
import type { Grant, OptionsOp, ProviderCardDto, SkillCardInfo } from "@tw/protocol";
import { useCallback, useEffect, useState } from "react";
import type { ExtensionSettings } from "../host/settings-store.js";

export interface OptionsAppProps {
  request: (op: OptionsOp, payload?: unknown) => Promise<unknown>;
}

type FormTarget = { mode: "closed" } | { mode: "new" } | { mode: "edit"; card: ProviderCardDto };

export function OptionsApp({ request }: OptionsAppProps) {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [skills, setSkills] = useState<SkillCardInfo[]>([]);
  const [form, setForm] = useState<FormTarget>({ mode: "closed" });
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const [s, g, k] = await Promise.all([
      request("get-settings"),
      request("list-grants"),
      request("list-skills"),
    ]);
    if ((s as { ok?: boolean }).ok === true)
      setSettings((s as { settings: ExtensionSettings }).settings);
    if ((g as { ok?: boolean }).ok === true) setGrants((g as { grants: Grant[] }).grants);
    if ((k as { ok?: boolean }).ok === true) setSkills((k as { cards: SkillCardInfo[] }).cards);
  }, [request]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveSettings = async (next: ExtensionSettings): Promise<void> => {
    const res = (await request("save-settings", next)) as { ok: boolean; error?: string };
    if (res.ok) {
      setSettings(next);
      setNotice("已保存（下一次任务生效）");
      setError(null);
    } else {
      setError(res.error ?? "保存失败");
    }
  };

  const mutateCard = (card: ProviderCardDto): void => {
    if (settings === null) return;
    const exists = settings.providerCards.some((c) => c.name === card.name);
    const cards = exists
      ? settings.providerCards.map((c) => (c.name === card.name ? card : c))
      : [...settings.providerCards, card];
    void saveSettings({
      ...settings,
      providerCards: cards,
      ...(settings.activeCard === "" ? { activeCard: card.name } : {}),
    });
    setForm({ mode: "closed" });
  };

  const deleteCard = (name: string): void => {
    if (settings === null) return;
    void saveSettings({
      ...settings,
      providerCards: settings.providerCards.filter((c) => c.name !== name),
      ...(settings.activeCard === name ? { activeCard: "" } : {}),
      ...(settings.taskSkillCard === name ? { taskSkillCard: undefined } : {}),
      ...(settings.judgeCard === name ? { judgeCard: undefined } : {}),
      ...(settings.extractCard === name ? { extractCard: undefined } : {}),
    });
    setForm({ mode: "closed" });
  };

  const auxSelect = (label: string, key: "taskSkillCard" | "judgeCard" | "extractCard") => (
    <label className="tc-field" key={key}>
      <span className="tc-field-label">{label}</span>
      <select
        value={settings?.[key] ?? ""}
        onChange={(e) => {
          if (settings === null) return;
          const v = e.target.value;
          void saveSettings({
            ...settings,
            ...(v === "" ? { [key]: undefined } : { [key]: v }),
          } as ExtensionSettings);
        }}
      >
        <option value="">（复用主卡）</option>
        {(settings?.providerCards ?? []).map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <ThemedRoot>
      <main style={{ maxWidth: 860, margin: "0 auto", padding: 16, display: "grid", gap: 10 }}>
        <h1 style={{ fontSize: 16, margin: 0 }}>TreeChrome 设置</h1>
        {error !== null ? <p className="tc-ev-err">{error}</p> : null}
        {notice !== null ? <p className="tc-ev-ok">{notice}</p> : null}

        {settings === null ? (
          <p className="tc-ev-muted">读取设置中…</p>
        ) : (
          <>
            <ProviderList
              cards={settings.providerCards}
              activeCard={settings.activeCard}
              onActivate={(name) => void saveSettings({ ...settings, activeCard: name })}
              onEdit={(card) => setForm({ mode: "edit", card })}
              onAdd={() => setForm({ mode: "new" })}
            />
            {form.mode !== "closed" ? (
              <ProviderCardForm
                card={form.mode === "edit" ? form.card : undefined}
                onSave={mutateCard}
                onCancel={() => setForm({ mode: "closed" })}
                onTest={async (card) => {
                  const res = (await request("test-card", card)) as {
                    ok: boolean;
                    message?: string;
                  };
                  return { ok: res.ok, message: res.message ?? "" };
                }}
                onDelete={form.mode === "edit" ? deleteCard : undefined}
              />
            ) : null}

            <section className="tc-card">
              <strong>附属模型卡（缺省复用主卡）</strong>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                {auxSelect("任务技能匹配", "taskSkillCard")}
                {auxSelect("Judge", "judgeCard")}
                {auxSelect("结构化抽取", "extractCard")}
              </div>
            </section>

            <section className="tc-card">
              <strong>Agent 覆盖</strong>
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <label className="tc-field">
                  <span className="tc-field-label">视觉模式</span>
                  <input
                    type="checkbox"
                    checked={settings.agent?.useVision ?? false}
                    onChange={(e) =>
                      void saveSettings({
                        ...settings,
                        agent: { ...settings.agent, useVision: e.target.checked },
                      })
                    }
                  />
                </label>
                <label className="tc-field">
                  <span className="tc-field-label">最大步数</span>
                  <input
                    style={{ width: 80 }}
                    value={settings.agent?.maxSteps ?? ""}
                    placeholder="默认"
                    onChange={(e) => {
                      const v = e.target.value.trim();
                      void saveSettings({
                        ...settings,
                        agent: {
                          ...settings.agent,
                          ...(v === "" || !Number.isInteger(Number(v))
                            ? {}
                            : { maxSteps: Number(v) }),
                        },
                      });
                    }}
                  />
                </label>
              </div>
            </section>
          </>
        )}

        <GrantsView
          grants={grants}
          onRevoke={(grant) => {
            void request("revoke-grant", {
              capability: grant.capability,
              host: grant.host,
            }).then(() => refresh());
          }}
        />
        <SkillListView cards={skills} />
        <p style={{ margin: 0 }} className="tc-ev-muted">
          <Button
            onClick={() => {
              setNotice(null);
              void refresh();
            }}
          >
            刷新
          </Button>
        </p>
      </main>
    </ThemedRoot>
  );
}
