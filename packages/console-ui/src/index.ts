// @tw/console-ui 公共导出面（架构 §2：侧边栏与 M6 web-console 共用的 React 组件包）。
// 段 E 全量：任务条/时间线/状态行/终态/权限卡/提交卡/options 三件 + 基础件。
// 本包禁 chrome.*（biome overrides 强制）——宿主交互经 props/回调注入。

export type { AppShellProps } from "./app-shell.js";
export { AppShell } from "./app-shell.js";
export { formatBytes } from "./bytes.js";
export type { FinalResultProps } from "./final-result.js";
export { FinalResult } from "./final-result.js";
export type { GrantsViewProps } from "./grants-view.js";
export { GrantsView } from "./grants-view.js";
export type { IconButtonProps } from "./icon-button.js";
export { IconButton } from "./icon-button.js";
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
export type { DistillState, PortStatus, RunPanelHeaderProps } from "./run-panel-header.js";
export { distillStatusText, RunPanelHeader } from "./run-panel-header.js";
export type { RunStatusBarProps } from "./run-status-bar.js";
export { formatSeconds, RunStatusBar } from "./run-status-bar.js";
export type { RunTimelineProps } from "./run-timeline.js";
export { groupByStep, RunTimeline, repeatedSkillSeqs } from "./run-timeline.js";
export type { SegmentItem, SegmentProps } from "./segment.js";
export { Segment } from "./segment.js";
export type { SettingsOverlayProps } from "./settings-overlay.js";
export { SettingsOverlay } from "./settings-overlay.js";
export type { SkillDraftEdits, SkillDraftReviewProps } from "./skill-draft-review.js";
export { SkillDraftReview } from "./skill-draft-review.js";
export type { SkillListViewProps } from "./skill-list-view.js";
export { SkillListView } from "./skill-list-view.js";
export type { SubmitCardProps } from "./submit-card.js";
export { clipValue, SubmitCard } from "./submit-card.js";
export type { SwitchProps } from "./switch.js";
export { Switch } from "./switch.js";
export type { TaskBarProps } from "./task-bar.js";
export { TaskBar } from "./task-bar.js";
export type { ThemedRootProps, ThemeMode } from "./themed-root.js";
export { ThemedRoot } from "./themed-root.js";
export type { WelcomePanelProps } from "./welcome-panel.js";
export { WelcomePanel } from "./welcome-panel.js";
