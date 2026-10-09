// GrantsView（m5/05 §1）：always 授权表（capability/host/时间）+ 撤销。Grant 直收
// （protocol re-export 的 core 形状）。

import type { Grant } from "@tw/protocol";
import { Button, Table } from "./primitives.js";

const CAPABILITY_LABEL: Record<string, string> = {
  CLICK: "点击",
  TYPE: "输入",
  NAVIGATE: "导航",
  UPLOAD: "上传",
  DOWNLOAD: "下载",
  SHELL: "命令",
  READ_FILE: "读文件",
  WRITE_FILE: "写文件",
};

/** createdAt 是毫秒（core PolicyGate 记账用 Date.now()） */
function formatTime(unixMs: number): string {
  return new Date(unixMs).toLocaleString();
}

export interface GrantsViewProps {
  grants: Grant[];
  onRevoke: (grant: Grant) => void;
}

export function GrantsView({ grants, onRevoke }: GrantsViewProps) {
  return (
    <section className="tc-card" data-testid="grants-view">
      <strong>「总是允许」授权</strong>
      {grants.length === 0 ? (
        <p style={{ margin: 0 }} className="tc-ev-muted">
          （无持久授权——每次门控动作都会弹确认卡）
        </p>
      ) : (
        <Table head={["能力", "站点", "授权时间", ""]}>
          {grants.map((g) => (
            <tr key={`${g.capability}|${g.host}|${g.createdAt}`}>
              <td>{CAPABILITY_LABEL[g.capability] ?? g.capability}</td>
              <td>{g.host}</td>
              <td>{formatTime(g.createdAt)}</td>
              <td>
                <Button variant="danger" onClick={() => onRevoke(g)}>
                  撤销
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </section>
  );
}
