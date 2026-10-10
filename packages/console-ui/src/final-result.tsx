// FinalResult（m5/05 §1）：done 后 final_result 展示（is_successful 着色 + 附件
// 清单链接位——M5 只列名，不实现打开）。error/interrupted 终态时渲染 lastError
//（段 F 验收反馈：错误原因原先无处显示——用户只见「出错 步数 0」）。

import type { AttachmentInfo } from "@tw/protocol";
import { formatBytes } from "./bytes.js";
import { Badge } from "./primitives.js";

export interface FinalResultProps {
  finalResult: string | null;
  /** null = 无成功性判定（neutral） */
  isSuccessful: boolean | null;
  attachments: AttachmentInfo[];
  /** error/interrupted 终态的失败原因（红字展示——观测缺口修补） */
  lastError?: string | null;
}

export function FinalResult({
  finalResult,
  isSuccessful,
  attachments,
  lastError,
}: FinalResultProps) {
  if (
    finalResult === null &&
    attachments.length === 0 &&
    (lastError === undefined || lastError === null)
  ) {
    return null;
  }
  return (
    <section className="tc-card" data-testid="final-result">
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {isSuccessful === true ? <Badge tone="success">✓ 成功</Badge> : null}
        {isSuccessful === false ? <Badge tone="danger">✗ 未成功</Badge> : null}
        {isSuccessful === null && lastError !== undefined && lastError !== null ? (
          <Badge tone="danger">✗ 失败原因</Badge>
        ) : null}
        {isSuccessful === null && (lastError === undefined || lastError === null) ? (
          <Badge>结束</Badge>
        ) : null}
      </div>
      {lastError !== undefined && lastError !== null ? (
        <p
          style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
          className="tc-ev-err"
        >
          {lastError}
        </p>
      ) : null}
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
