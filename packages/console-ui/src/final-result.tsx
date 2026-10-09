// FinalResult（m5/05 §1）：done 后 final_result 展示（is_successful 着色 + 附件
// 清单链接位——M5 只列名，不实现打开）。

import type { AttachmentInfo } from "@tw/protocol";
import { formatBytes } from "./bytes.js";
import { Badge } from "./primitives.js";

export interface FinalResultProps {
  finalResult: string | null;
  /** null = 无成功性判定（neutral） */
  isSuccessful: boolean | null;
  attachments: AttachmentInfo[];
}

export function FinalResult({ finalResult, isSuccessful, attachments }: FinalResultProps) {
  if (finalResult === null && attachments.length === 0) return null;
  return (
    <section className="tc-card" data-testid="final-result">
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {isSuccessful === true ? <Badge tone="success">✓ 成功</Badge> : null}
        {isSuccessful === false ? <Badge tone="danger">✗ 未成功</Badge> : null}
        {isSuccessful === null ? <Badge>结束</Badge> : null}
      </div>
      {finalResult !== null ? (
        <p style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{finalResult}</p>
      ) : null}
      {attachments.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {attachments.map((a) => (
            <li key={a.attachmentId}>
              {a.name}（{formatBytes(a.size)}）
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
