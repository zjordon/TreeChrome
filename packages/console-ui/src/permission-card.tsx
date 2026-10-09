// PermissionCard（m5/05 §1）：权限确认卡。capability 标签 + host + 动作参数表 +
// 元素定位 + 三按钮（本次允许/总是允许/拒绝）+ 倒计时条（expiresAt 线性收敛；
// now 注入测试）。protocol 的 PermissionCardPayload 直收（label 已是中文动作名）。

import type { PermissionCardPayload, PermissionVerdict } from "@tw/protocol";
import { useEffect, useState } from "react";
import { Button } from "./primitives.js";

export interface PermissionCardProps {
  req: PermissionCardPayload;
  onResolve: (verdict: PermissionVerdict) => void;
  expiresAt: number;
  /** 总预算 ms（倒计时条满格基准；缺省 300s——core PolicyGate 同源缺省） */
  totalMs?: number;
  /** 时钟注入（测试）；缺省墙上钟 */
  now?: () => number;
}

export function PermissionCard({
  req,
  onResolve,
  expiresAt,
  totalMs = 300_000,
  now = () => Date.now(),
}: PermissionCardProps) {
  const [remaining, setRemaining] = useState(() => Math.max(0, expiresAt - now()));
  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining(Math.max(0, expiresAt - now()));
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresAt, now]);

  const params = Object.entries(req.params ?? {});
  return (
    <section className="tc-card tc-card-accent" data-testid="permission-card">
      <strong>权限确认：{req.label}</strong>
      <dl className="tc-kv">
        <dt>站点</dt>
        <dd>{req.host}</dd>
        <dt>动作</dt>
        <dd>
          {req.actionName}
          {req.elementIndex !== null ? ` #${req.elementIndex}` : ""}
        </dd>
        {params.length > 0 ? (
          <>
            <dt>参数</dt>
            <dd>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {JSON.stringify(req.params, null, 2)}
              </pre>
            </dd>
          </>
        ) : null}
        {req.elementXpath !== null ? (
          <>
            <dt>xpath</dt>
            <dd>{req.elementXpath}</dd>
          </>
        ) : null}
        {req.elementBbox !== null ? (
          <>
            <dt>位置</dt>
            <dd>
              ({req.elementBbox.left},{req.elementBbox.top}) {req.elementBbox.width}×
              {req.elementBbox.height}
            </dd>
          </>
        ) : null}
      </dl>
      <div
        className="tc-countdown"
        role="progressbar"
        aria-label="剩余确认时间"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(Math.min(100, (remaining / totalMs) * 100))}
      >
        <div style={{ width: `${Math.min(100, (remaining / totalMs) * 100)}%` }} />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="primary" onClick={() => onResolve("allow-once")}>
          本次允许
        </Button>
        <Button onClick={() => onResolve("allow-always")}>总是允许</Button>
        <Button variant="danger" onClick={() => onResolve("deny")}>
          拒绝
        </Button>
      </div>
    </section>
  );
}
