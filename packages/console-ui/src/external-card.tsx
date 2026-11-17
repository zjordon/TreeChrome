// ExternalDriveCard（#37 批 B）：外部直驱说明卡——bridge 会话在场时置转录顶部。
// 「同一面板服务人与 agent」的降级面：说明 + tc-bridge 用法行（不含可复制配对
// URL——扩展侧不回读 bridge 配置，D4 登记偏离）+ 停止留权提示。零 chrome。

export interface ExternalDriveCardProps {
  /** 会话标题（缺省只显示通用文案） */
  sessionTitle?: string | null;
}

export function ExternalDriveCard({ sessionTitle = null }: ExternalDriveCardProps) {
  return (
    <section className="tc-card tc-card-accent" data-testid="external-drive-card">
      <strong>外部客户端直驱中</strong>
      {sessionTitle !== null && sessionTitle !== "" ? (
        <div className="tc-ev-muted">会话：{sessionTitle}</div>
      ) : null}
      <p style={{ margin: "4px 0" }} className="tc-ev-muted">
        本会话由外部客户端（tc-bridge / MCP）直接操作，这里只能查看——输入已停用。
      </p>
      <p style={{ margin: 0 }} className="tc-ev-muted">
        连接命令在桥侧：<code>npx tc-bridge connect</code>（配对 URL 由 tc-bridge 输出）。
        你仍可随时<span className="tc-ev-err">停止</span>本任务。
      </p>
    </section>
  );
}
