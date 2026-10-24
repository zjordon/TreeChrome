// SkillDraftReview（issue #5 S5）：蒸馏草稿审阅面——列表 + 展开编辑（描述/关键词/
// 三件套）+ 采纳（带编辑覆盖）/丢弃。平台无关组件：adopt/discard 经回调上抛，
// 宿主接 options 单发（扩展）或自实现面（web-console）。

import type { SkillDraftInfo } from "@tw/protocol";
import { Fragment, type ReactNode, useState } from "react";
import { Badge, Button, Table } from "./primitives.js";

/** 编辑覆盖（空串字段不上抛——store 层语义：空串=不覆盖草稿原文） */
export interface SkillDraftEdits {
  description?: string;
  keywords?: string[];
  sop?: string;
  selectors?: string;
  quirks?: string;
}

export interface SkillDraftReviewProps {
  drafts: SkillDraftInfo[];
  onAdopt: (host: string, slug: string, edits: SkillDraftEdits) => void;
  onDiscard: (host: string, slug: string) => void;
}

const draftKey = (host: string, slug: string): string => `${host}|${slug}`;

function EditRow({ label, value }: { label: string; value: ReactNode }) {
  // div 而非 label：控件经 value 插槽传入，静态分析无法确认关联（a11y 规则）；
  // 视觉标题语义由 span 承担
  return (
    <div style={{ marginTop: 4 }}>
      <span style={{ display: "block" }} className="tc-ev-muted">
        {label}
      </span>
      {value}
    </div>
  );
}

export function SkillDraftReview({ drafts, onAdopt, onDiscard }: SkillDraftReviewProps) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  /** host|slug → 编辑态（三件套/描述文本 + 关键词原始串） */
  const [edits, setEdits] = useState<
    Record<string, { text: SkillDraftEdits; keywordsRaw: string }>
  >({});

  const patch = (key: string, next: { text?: SkillDraftEdits; keywordsRaw?: string }): void => {
    setEdits((prev) => ({
      ...prev,
      [key]: {
        text: { ...prev[key]?.text, ...next.text },
        keywordsRaw: next.keywordsRaw ?? prev[key]?.keywordsRaw ?? "",
      },
    }));
  };

  const editsOf = (d: SkillDraftInfo): SkillDraftEdits => {
    const state = edits[draftKey(d.host, d.slug)];
    if (state === undefined) return {};
    const out: SkillDraftEdits = { ...state.text };
    const kw = state.keywordsRaw.trim();
    if (kw !== "")
      out.keywords = kw
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
    return out;
  };

  return (
    <section className="tc-card" data-testid="skill-draft-review">
      <strong>蒸馏草稿（待审）</strong>
      {drafts.length === 0 ? (
        <p style={{ margin: 0 }} className="tc-ev-muted">
          （空——任务成功且 Judge 复核通过后自动蒸馏出草稿）
        </p>
      ) : (
        <Table head={["站点", "任务", "蒸馏于", ""]}>
          {drafts.map((d) => {
            const key = draftKey(d.host, d.slug);
            const open = openKey === key;
            const state = edits[key];
            return (
              <Fragment key={key}>
                <tr data-testid={`draft-row-${key}`}>
                  <td>{d.host}</td>
                  <td>{d.slug}</td>
                  <td>{d.distilledAt ?? "—"}</td>
                  <td>
                    <Button
                      onClick={() => {
                        if (!open) {
                          patch(key, {});
                          setOpenKey(key);
                        } else {
                          setOpenKey(null);
                        }
                      }}
                    >
                      {open ? "收起" : "审阅"}
                    </Button>
                  </td>
                </tr>
                {open ? (
                  <tr>
                    <td colSpan={4}>
                      <EditRow
                        label="任务描述"
                        value={
                          <input
                            data-testid={`draft-desc-${key}`}
                            value={state?.text.description ?? d.description ?? ""}
                            onChange={(e) => patch(key, { text: { description: e.target.value } })}
                          />
                        }
                      />
                      <EditRow
                        label="关键词（逗号分隔）"
                        value={
                          <input
                            data-testid={`draft-keywords-${key}`}
                            value={state?.keywordsRaw ?? (d.keywords ?? []).join(", ")}
                            onChange={(e) => patch(key, { keywordsRaw: e.target.value })}
                          />
                        }
                      />
                      <EditRow
                        label="SOP"
                        value={
                          <textarea
                            data-testid={`draft-sop-${key}`}
                            rows={8}
                            style={{ width: "100%" }}
                            value={state?.text.sop ?? d.sop}
                            onChange={(e) => patch(key, { text: { sop: e.target.value } })}
                          />
                        }
                      />
                      <EditRow
                        label="Selectors"
                        value={
                          <textarea
                            data-testid={`draft-selectors-${key}`}
                            rows={4}
                            style={{ width: "100%" }}
                            value={state?.text.selectors ?? d.selectors}
                            onChange={(e) => patch(key, { text: { selectors: e.target.value } })}
                          />
                        }
                      />
                      <EditRow
                        label="Quirks"
                        value={
                          <textarea
                            data-testid={`draft-quirks-${key}`}
                            rows={4}
                            style={{ width: "100%" }}
                            value={state?.text.quirks ?? d.quirks}
                            onChange={(e) => patch(key, { text: { quirks: e.target.value } })}
                          />
                        }
                      />
                      <p style={{ margin: "4px 0" }}>
                        <Badge tone="accent">{(d.sourceTraces ?? []).length} 条来源轨迹</Badge>{" "}
                        <Button
                          variant="primary"
                          onClick={() => onAdopt(d.host, d.slug, editsOf(d))}
                        >
                          采纳
                        </Button>{" "}
                        <Button
                          variant="danger"
                          onClick={() => {
                            onDiscard(d.host, d.slug);
                            setOpenKey(null);
                          }}
                        >
                          丢弃
                        </Button>
                      </p>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </Table>
      )}
    </section>
  );
}
