// ProviderList（m5/05 §1）：卡列表 + active 选择 + 编辑入口。附属卡（taskSkill/
// judge/extract）选择与 agent 覆盖在宿主 options 组态——本件只管主卡面。

import type { ProviderCardDto } from "@tw/protocol";
import { Badge, Button, Table } from "./primitives.js";

export interface ProviderListProps {
  cards: ProviderCardDto[];
  activeCard: string;
  onActivate: (name: string) => void;
  onEdit: (card: ProviderCardDto) => void;
  onAdd: () => void;
}

export function ProviderList({ cards, activeCard, onActivate, onEdit, onAdd }: ProviderListProps) {
  return (
    <section className="tc-card" data-testid="provider-list">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong>LLM 卡片</strong>
        <Button onClick={onAdd}>+ 新增</Button>
      </div>
      {cards.length === 0 ? (
        <p style={{ margin: 0 }} className="tc-ev-muted">
          （尚无卡片——新增并激活后才能起跑任务）
        </p>
      ) : (
        <Table head={["", "卡片名", "协议", "模型", ""]}>
          {cards.map((c) => (
            <tr key={c.name}>
              <td>
                <input
                  type="radio"
                  name="tc-active-card"
                  aria-label={`激活 ${c.name}`}
                  checked={c.name === activeCard}
                  onChange={() => onActivate(c.name)}
                />
              </td>
              <td>
                {c.name} {c.name === activeCard ? <Badge tone="success">活跃</Badge> : null}
              </td>
              <td>{c.protocol}</td>
              <td>{c.model}</td>
              <td>
                <Button onClick={() => onEdit(c)}>编辑</Button>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </section>
  );
}
