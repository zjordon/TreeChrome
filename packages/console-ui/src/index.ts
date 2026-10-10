// @tw/console-ui 公共导出面（架构 §2：侧边栏与 M6 web-console 共用的 React 组件包）。
// 段 E 全量：任务条/时间线/状态行/终态/权限卡/提交卡/options 三件 + 基础件。
// 本包禁 chrome.*（biome overrides 强制）——宿主交互经 props/回调注入。

export { formatBytes } from "./bytes.js";
export type { FinalResultProps } from "./final-result.js";
export { FinalResult } from "./final-result.js";
export type { GrantsViewProps } from "./grants-view.js";
export { GrantsView } from "./grants-view.js";
export type { PermissionCardProps } from "./permission-card.js";
export { PermissionCard } from "./permission-card.js";
export type { BadgeTone, ButtonProps } from "./primitives.js";
export { Badge, Button, Field, Table } from "./primitives.js";
export type {
  CardFormErrors,
  CardFormState,
  ProtocolOption,
  ProviderCardFormProps,
} from "./provider-card-form.js";
export {
  formStateOf,
  PROTOCOL_OPTIONS,
  ProviderCardForm,
  validateCardForm,
} from "./provider-card-form.js";
export type { ProviderListProps } from "./provider-list.js";
export { ProviderList } from "./provider-list.js";
export type { RunTimelineProps } from "./run-timeline.js";
export { groupByStep, RunTimeline, repeatedSkillSeqs } from "./run-timeline.js";
export type { SkillListViewProps } from "./skill-list-view.js";
export { SkillListView } from "./skill-list-view.js";
export type { StatusLineProps } from "./status-line.js";
export { formatSeconds, StatusLine } from "./status-line.js";
export type { SubmitCardProps } from "./submit-card.js";
export { clipValue, SubmitCard } from "./submit-card.js";
export type { TaskBarProps } from "./task-bar.js";
export { TaskBar } from "./task-bar.js";
export type { ThemedRootProps, ThemeMode } from "./themed-root.js";
export { ThemedRoot } from "./themed-root.js";
