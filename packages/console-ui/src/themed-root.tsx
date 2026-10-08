// 主题容器（m5/01 §1.3 骨架件，段 E 扩全组件面）：CSS 变量作用域根。亮/暗由
// theme.css 的 prefers-color-scheme 媒体查询实现；data-tc-theme="light|dark" 显式
// 覆盖（强制暗色场景），"auto"（缺省）跟随系统。

export type ThemeMode = "auto" | "light" | "dark";

export interface ThemedRootProps {
  children?: React.ReactNode;
  /** 缺省 "auto"（跟随系统）；显式 light/dark 覆盖媒体查询 */
  theme?: ThemeMode;
}

export function ThemedRoot({ children, theme = "auto" }: ThemedRootProps) {
  return (
    <div className="tc-root" data-tc-theme={theme}>
      {children}
    </div>
  );
}
