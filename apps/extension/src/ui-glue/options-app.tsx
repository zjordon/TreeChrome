// options 组态（m5/05 §2 + issue #20 M4 分区 tab）：settings 读写走 options 单发请求
// （单一写者=SW——UI 不直碰 chrome.storage）。Segment 四区（模型/授权/技能库/草稿），
// 视觉模式走 Switch；ThemedRoot 由宿主负责（options 页薄壳 / sidepanel overlay 双宿主）。
// request 工厂由 entrypoints 注入（chrome 面）。

import {
  Button,
  GrantsView,
  ProviderCardForm,
  ProviderList,
  Segment,
  SkillDraftReview,
  SkillListView,
  Switch,
} from "@tw/console-ui";
import type {
  Grant,
  OptionsOp,
  ProviderCardDto,
  SkillCardInfo,
  SkillDraftInfo,
} from "@tw/protocol";
import { useCallback, useEffect, useState } from "react";
import type { ExtensionSettings } from "../host/settings-store.js";
import { planCardMutation } from "./card-mutation.js";

export interface OptionsAppProps {
  request: (op: OptionsOp, payload?: unknown) => Promise<unknown>;
}

type FormTarget = { mode: "closed" } | { mode: "new" } | { mode: "edit"; card: ProviderCardDto };

/** 分区 tab（issue #20 M4：Segment 首个消费方） */
type TabKey = "models" | "grants" | "skills" | "drafts";
const TABS = [
  { value: "models", label: "模型" },
  { value: "grants", label: "授权" },
  { value: "skills", label: "技能库" },
  { value: "drafts", label: "草稿" },
];

export function OptionsApp({ request }: OptionsAppProps) {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [skills, setSkills] = useState<SkillCardInfo[]>([]);
  const [drafts, setDrafts] = useState<SkillDraftInfo[]>([]);
  const [form, setForm] = useState<FormTarget>({ mode: "closed" });
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("models");

  const refresh = useCallback(async (): Promise<void> => {
    // fail-soft（评审轮 1 [8]）：SW 被杀/扩展重载时 sendMessage reject——裸 await
    // 是未处理 rejection 且页面永久停留读态；ok:false 信封也走错误呈现
    try {
      const [s, g, k, d] = (await Promise.all([
        request("get-settings"),
        request("list-grants"),
        request("list-skills"),
        request("list-skill-drafts"),
      ])) as Array<{ ok?: boolean; error?: string }>;
      if (s.ok !== true || g.ok !== true || k.ok !== true || d.ok !== true) {
        setError(s.error ?? g.error ?? k.error ?? d.error ?? "读取配置失败");
        return;
      }
      setSettings((s as { settings: ExtensionSettings }).settings);
      setGrants((g as { grants: Grant[] }).grants);
      setSkills((k as { cards: SkillCardInfo[] }).cards);
      setDrafts((d as { drafts: SkillDraftInfo[] }).drafts);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [request]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveSettings = async (next: ExtensionSettings): Promise<void> => {
    try {
      const res = (await request("save-settings", next)) as {
        ok: boolean;
        error?: string;
      };
      if (res.ok) {
        setSettings(next);
        setNotice("已保存（下一次任务生效）");
        setError(null);
      } else {
        setError(res.error ?? "保存失败");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const mutateCard = (card: ProviderCardDto, originalName: string | null): void => {
    if (settings === null) return;
    // 撞名/替换/指针重定向全在纯函数（轮 2 [2][3]：新增路径守卫恒假 +
    // activeCard 双展开互覆）——组件层只留错误呈现
    const plan = planCardMutation(settings, card, originalName);
    if (!plan.ok) {
      setError(plan.error);
      return;
    }
    void saveSettings(plan.next);
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
    <>
      {error !== null ? <p className="tc-ev-err">{error}</p> : null}
      {notice !== null ? <p className="tc-ev-ok">{notice}</p> : null}
      <Segment
        items={TABS}
        value={tab}
        onChange={(v) => setTab(v as TabKey)}
        ariaLabel="设置分区"
      />

      {tab === "models" ? (
        settings === null ? (
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
                <Switch
                  label="视觉模式"
                  checked={settings.agent?.useVision ?? false}
                  onChange={(e) =>
                    void saveSettings({
                      ...settings,
                      agent: { ...settings.agent, useVision: e.target.checked },
                    })
                  }
                />
                <label className="tc-field">
                  <span className="tc-field-label">最大步数</span>
                  <input
                    style={{ width: 80 }}
                    value={settings.agent?.maxSteps ?? ""}
                    placeholder="默认"
                    onChange={(e) => {
                      const v = e.target.value.trim();
                      const n = Number(v);
                      // 清空/非法显式置 undefined（评审轮 1 [7]：条件展开 {} 会保留
                      // 旧值——清空静默失败；0/负数放行无效）——SW 侧 parse 只收
                      // number，undefined 落库即恢复缺省
                      void saveSettings({
                        ...settings,
                        agent: {
                          ...settings.agent,
                          ...(v !== "" && Number.isInteger(n) && n >= 1
                            ? { maxSteps: n }
                            : { maxSteps: undefined }),
                        },
                      });
                    }}
                  />
                </label>
              </div>
            </section>
          </>
        )
      ) : null}

      {tab === "grants" ? (
        <GrantsView
          grants={grants}
          onRevoke={(grant) => {
            void request("revoke-grant", {
              capability: grant.capability,
              host: grant.host,
            })
              .then(() => refresh())
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
          }}
        />
      ) : null}

      {tab === "drafts" ? (
        <SkillDraftReview
          drafts={drafts}
          onAdopt={(host, slug, edits) => {
            void request("adopt-skill-draft", { host, slug, edits })
              .then((res) => {
                const r = res as { ok?: boolean; error?: string };
                if (r.ok === true) {
                  setNotice(`已采纳草稿：${host} / ${slug}`);
                } else {
                  setError(r.error ?? "采纳失败");
                }
                return refresh();
              })
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
          }}
          onDiscard={(host, slug) => {
            void request("discard-skill-draft", { host, slug })
              .then(() => refresh())
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
          }}
        />
      ) : null}

      {tab === "skills" ? <SkillListView cards={skills} /> : null}

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
    </>
  );
}
