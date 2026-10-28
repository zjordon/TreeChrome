// 布局壳（issue #20 M3）：header/滚动 main/底部 dock 三区——侧边栏与 M6 web-console 共用形态。
// main 独占滚动（dock 常驻），高度链依赖 base.css 的 .tc-root height:100%。

import type { ReactNode } from "react";

export interface AppShellProps {
  header?: ReactNode;
  dock?: ReactNode;
  children: ReactNode;
}

export function AppShell({ header, dock, children }: AppShellProps) {
  return (
    <div className="tc-shell">
      {header !== undefined ? <header className="tc-shell-header">{header}</header> : null}
      <main className="tc-shell-main">{children}</main>
      {dock !== undefined ? <footer className="tc-shell-dock">{dock}</footer> : null}
    </div>
  );
}
