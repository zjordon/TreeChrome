// options 占位页（m5/01 §A4）：段 E 换 ProviderList/GrantsView/SkillListView 全量组态。

import { ThemedRoot } from "@tw/console-ui";

export function App() {
  return (
    <ThemedRoot>
      <main style={{ maxWidth: 720, margin: "0 auto", padding: 16, display: "grid", gap: 8 }}>
        <h1 style={{ fontSize: 16, margin: 0 }}>TreeChrome 设置</h1>
        <p style={{ margin: 0, color: "var(--tc-muted)" }}>
          M5 段 A 骨架——provider 卡片 / always 授权 / skill 列表在段 E 落地。
        </p>
      </main>
    </ThemedRoot>
  );
}
