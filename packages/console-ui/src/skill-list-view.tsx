// SkillListView（m5/05 §1）：技能卡列表只读（host/slug/来源/更新时间）。M5 无编辑
// 面（URL 导入/蒸馏/审阅是 M7）。

import type { SkillCardInfo } from "@tw/protocol";
import { Badge, Table } from "./primitives.js";

const SOURCE_LABEL: Record<SkillCardInfo["sourceType"], string> = {
  "built-in": "内置",
  import: "导入",
  distilled: "蒸馏",
};

export interface SkillListViewProps {
  cards: SkillCardInfo[];
}

export function SkillListView({ cards }: SkillListViewProps) {
  return (
    <section className="tc-card" data-testid="skill-list-view">
      <strong>技能库</strong>
      {cards.length === 0 ? (
        <p style={{ margin: 0 }} className="tc-ev-muted">
          （空——内置技能在扩展安装/更新时自动装载）
        </p>
      ) : (
        <Table head={["站点", "任务", "来源", "更新时间"]}>
          {cards.map((c) => (
            <tr key={`${c.host}|${c.slug}`}>
              <td>{c.host}</td>
              <td>{c.slug === "" ? <Badge>站点级</Badge> : c.slug}</td>
              <td>{SOURCE_LABEL[c.sourceType]}</td>
              <td>{new Date(c.updatedAt).toLocaleString()}</td>
            </tr>
          ))}
        </Table>
      )}
    </section>
  );
}
