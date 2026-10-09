// SubmitCard（m5/05 §1）：submit 预确认卡。字段摘要表（≤8 行——probe 侧已裁；
// password 值已打码 ***）+ 确认/取消。防御性截断：字段值超 40 字符折叠（probe 同
// 源上限，恢复态超长时兜底）。

import type { PermissionCardPayload, SubmitField } from "@tw/protocol";
import { Button, Table } from "./primitives.js";

function clipValue(value: string): string {
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}

export interface SubmitCardProps {
  req: PermissionCardPayload;
  fields: SubmitField[];
  onConfirm: () => void;
  onCancel: () => void;
}

export function SubmitCard({ req, fields, onConfirm, onCancel }: SubmitCardProps) {
  return (
    <section className="tc-card tc-card-accent" data-testid="submit-card">
      <strong>提交确认：{req.host}</strong>
      <p style={{ margin: 0 }} className="tc-ev-muted">
        即将点击提交类按钮——以下表单变更将被提交，请核对。
      </p>
      {fields.length > 0 ? (
        <Table head={["字段", "值"]}>
          {fields.map((f) => (
            <tr key={f.name}>
              <td>{f.name}</td>
              <td>{clipValue(f.value)}</td>
            </tr>
          ))}
        </Table>
      ) : (
        <p style={{ margin: 0 }} className="tc-ev-muted">
          （无字段变更摘要）
        </p>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="primary" onClick={onConfirm}>
          确认提交
        </Button>
        <Button variant="danger" onClick={onCancel}>
          取消
        </Button>
      </div>
    </section>
  );
}

export { clipValue };
