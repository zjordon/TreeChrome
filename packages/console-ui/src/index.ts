// @tw/console-ui 公共导出面（架构 §2：侧边栏与 M6 web-console 共用的 React 组件包）。
// 段 E 全量：任务条/时间线/状态行/终态/权限卡/提交卡/options 三件 + 基础件。
// 本包禁 chrome.*（biome overrides 强制）——宿主交互经 props/回调注入。

export type { AppShellProps } from "./app-shell.js";
export { AppShell } from "./app-shell.js";
export { formatBytes } from "./bytes.js";
export { ClipboardUtil } from "./clipboard.js";
export type { ComposerProps } from "./composer.js";
export { COMPOSER_MAX_HEIGHT, COMPOSER_MIN_HEIGHT, Composer } from "./composer.js";
export type { DebugLogPageProps } from "./debug-log-page.js";
export { DebugLogPage } from "./debug-log-page.js";
export type { ExportHtmlOptions } from "./export-html.js";
export { escapeHtml, serializeTranscriptHtml } from "./export-html.js";
export type { ExternalDriveCardProps } from "./external-card.js";
export { ExternalDriveCard } from "./external-card.js";
export type { FinalResultProps } from "./final-result.js";
export { FinalResult } from "./final-result.js";
export type { FontSize, FontSizePopoverProps } from "./font-size.js";
export { FONT_SIZE_KEY, FontSizePopover, readFontSize } from "./font-size.js";
export type { GoalStripProps } from "./goal-strip.js";
export { GoalStrip, goalLabelOf } from "./goal-strip.js";
export type { GrantsViewProps } from "./grants-view.js";
export { GrantsView } from "./grants-view.js";
export type { IconButtonProps } from "./icon-button.js";
export { IconButton } from "./icon-button.js";
export { CopyButton, MarkdownText, safeUrlTransform } from "./markdown.js";
export type { ModelSwitcherProps } from "./model-switcher.js";
export { ModelSwitcher } from "./model-switcher.js";
export type { PageRegistration, PageTabsProps } from "./page-tabs.js";
export { PageTabs } from "./page-tabs.js";
export type { PermissionCardProps } from "./permission-card.js";
export { PermissionCard } from "./permission-card.js";
export type { BadgeTone, ButtonProps } from "./primitives.js";
export { Badge, Button, Field, Table } from "./primitives.js";
export type {
  CardFormErrors,
  CardFormState,
  ProtocolOption,
  ProviderCardFormProps,
  ProviderPreset,
} from "./provider-card-form.js";
export {
  formStateOf,
  PRESET_CARDS,
  PROTOCOL_OPTIONS,
  ProviderCardForm,
  validateCardForm,
} from "./provider-card-form.js";
export type { ProviderListProps } from "./provider-list.js";
export { ProviderList } from "./provider-list.js";
export type { QueueStripProps } from "./queue-strip.js";
export { QueueStrip } from "./queue-strip.js";
export type { DistillState, PortStatus, RunPanelHeaderProps } from "./run-panel-header.js";
export { distillStatusText, RunPanelHeader } from "./run-panel-header.js";
export type { ContextUsage, RunStatusBarProps } from "./run-status-bar.js";
export { formatSeconds, formatTokens, RunStatusBar } from "./run-status-bar.js";
export type { RunTimelineProps } from "./run-timeline.js";
export { groupByStep, RunTimeline, repeatedSkillSeqs } from "./run-timeline.js";
export type { SegmentItem, SegmentProps } from "./segment.js";
export { Segment } from "./segment.js";
export type { SessionTitleBarProps } from "./session-title-bar.js";
export { SessionTitleBar } from "./session-title-bar.js";
export type { SessionsPageProps } from "./sessions-page.js";
export { SessionsPage } from "./sessions-page.js";
export type { SettingsOverlayProps } from "./settings-overlay.js";
export { SettingsOverlay } from "./settings-overlay.js";
export type { SkillDraftEdits, SkillDraftReviewProps } from "./skill-draft-review.js";
export { SkillDraftReview } from "./skill-draft-review.js";
export type { SkillListViewProps } from "./skill-list-view.js";
export { SkillListView } from "./skill-list-view.js";
export type { SkillPageProps } from "./skill-page.js";
export { SkillPage } from "./skill-page.js";
export type { SubmitCardProps } from "./submit-card.js";
export { clipValue, SubmitCard } from "./submit-card.js";
export type { SwitchProps } from "./switch.js";
export { Switch } from "./switch.js";
export type { TaskBarProps } from "./task-bar.js";
export { TaskBar } from "./task-bar.js";
export type { ThemedRootProps, ThemeMode } from "./themed-root.js";
export { ThemedRoot } from "./themed-root.js";
export type { RunBlockItem, TranscriptItem, UserTurnItem } from "./transcript.js";
export { projectTranscript } from "./transcript.js";
export type { TranscriptViewProps } from "./transcript-view.js";
export { FOLLOW_BOTTOM_THRESHOLD_PX, isAtBottom, TranscriptView } from "./transcript-view.js";
export type { WelcomePanelProps } from "./welcome-panel.js";
export { WelcomePanel } from "./welcome-panel.js";
