// SkillPage（issue #39 U3 批 B）：技能库 + 草稿审阅的页签化组合——与 OptionsApp
// 同款 OPTIONS_OPS 单发面（验收②双宿主数据一致；options 页保留原样）。fail-soft：
// SW 被杀 reject / ok:false 信封都走错误行，不炸页签。

import type { OptionsOp, SkillCardInfo, SkillDraftInfo } from "@tw/protocol";
import { useCallback, useEffect, useState } from "react";
import { SkillDraftReview } from "./skill-draft-review.js";
import { SkillListView } from "./skill-list-view.js";

export interface SkillPageProps {
  request: (op: OptionsOp, payload?: unknown) => Promise<unknown>;
}

export function SkillPage({ request }: SkillPageProps) {
  const [skills, setSkills] = useState<SkillCardInfo[] | null>(null);
  const [drafts, setDrafts] = useState<SkillDraftInfo[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [k, d] = (await Promise.all([
        request("list-skills"),
        request("list-skill-drafts"),
      ])) as Array<{ ok?: boolean; error?: string }>;
      if (k.ok !== true || d.ok !== true) {
        setError(k.error ?? d.error ?? "读取技能数据失败");
        return;
      }
      setError(null);
      setSkills((k as { cards: SkillCardInfo[] }).cards);
      setDrafts((d as { drafts: SkillDraftInfo[] }).drafts);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [request]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div data-testid="skill-page">
      {error !== null ? <p className="tc-ev-err">{error}</p> : null}
      {notice !== null ? <p className="tc-ev-ok">{notice}</p> : null}
      {drafts !== null && drafts.length > 0 ? (
        <section className="tc-card">
          <strong>待审草稿（{drafts.length}）</strong>
          <SkillDraftReview
            drafts={drafts}
            onAdopt={(host, slug, edits) => {
              void request("adopt-skill-draft", { host, slug, edits })
                .then((res) => {
                  const r = res as { ok?: boolean; error?: string };
                  if (r.ok === true) setNotice(`已采纳草稿：${host} / ${slug}`);
                  else setError(r.error ?? "采纳失败");
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
        </section>
      ) : null}
      <section className="tc-card">
        <strong>技能卡</strong>
        {skills === null && error === null ? (
          <p className="tc-ev-muted">读取中…</p>
        ) : (
          <SkillListView cards={skills ?? []} />
        )}
      </section>
      <p style={{ margin: 0 }} className="tc-ev-muted">
        <button
          type="button"
          className="tc-copy-btn"
          data-testid="skill-refresh"
          onClick={() => {
            setNotice(null);
            void refresh();
          }}
        >
          刷新
        </button>
      </p>
    </div>
  );
}
