// FinalResult（m5/05 §1 + #39 U3 批 A）：done 后 final_result 展示（markdown 渲染
// + 复制钮；is_successful 着色 + 附件清单链接位——只列名）。error/interrupted 终态
// 时渲染 lastError（纯文本——D6 不做 markdown）。

import type { AttachmentInfo } from "@tw/protocol";
import { formatBytes } from "./bytes.js";
import { CopyButton, MarkdownText } from "./markdown.js";
import { Badge } from "./primitives.js";

export interface FinalResultProps {
  finalResult: string | null;
  /** null = 无成功性判定（neutral） */
  isSuccessful: boolean | null;
  attachments: AttachmentInfo[];
  /** error/interrupted 终态的失败原因（红字展示——观测缺口修补） */
  lastError?: string | null;
  /** Judge 复核结论（issue #5：蒸馏门控依据——不做永远不可见） */
  judgement?: {
    verdict: boolean;
    reasoning: string | null;
    failureReason: string | null;
  } | null;
}

export function FinalResult({
  finalResult,
  isSuccessful,
  attachments,
  lastError,
  judgement,
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
        {judgement !== undefined && judgement !== null ? (
          judgement.verdict ? (
            <Badge tone="success">✓ Judge 通过</Badge>
          ) : (
            <Badge tone="danger">✗ Judge 未通过</Badge>
          )
        ) : null}
        {finalResult !== null ? (
          <span style={{ marginLeft: "auto" }}>
            <CopyButton text={finalResult} label="复制结果" />
          </span>
        ) : null}
      </div>
      {judgement !== undefined && judgement !== null && judgement.verdict === false ? (
        // 拒绝判词可长——折叠展示（蒸馏门控为什么没过的直接答案）
        <details style={{ margin: "2px 0" }}>
          <summary className="tc-ev-muted" style={{ cursor: "pointer" }}>
            Judge 判词（未通过——不会触发蒸馏）
          </summary>
          {judgement.reasoning !== null ? (
            <p style={{ margin: "4px 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {judgement.reasoning}
            </p>
          ) : null}
          {judgement.failureReason !== null ? (
            <p style={{ margin: "4px 0" }} className="tc-ev-err">
              失败原因：{judgement.failureReason}
            </p>
          ) : null}
        </details>
      ) : null}
      {lastError !== undefined && lastError !== null ? (
        <p
          style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
          className="tc-ev-err"
        >
          {lastError}
        </p>
      ) : null}
      {finalResult !== null ? <MarkdownText>{finalResult}</MarkdownText> : null}
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
