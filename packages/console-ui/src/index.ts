// @tw/console-ui 公共导出面（架构 §2：侧边栏与 M6 web-console 共用的 React 组件包）。
// 段 A 骨架：ThemedRoot 主题容器；段 E 扩 RunTimeline/权限卡/设置件全量。
// 本包禁 chrome.*（biome overrides 强制）——宿主交互经 props/回调注入。

export type { ThemedRootProps, ThemeMode } from "./themed-root.js";
export { ThemedRoot } from "./themed-root.js";
