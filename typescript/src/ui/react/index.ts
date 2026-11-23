// @omazyai/sdk/ui/react: the ui kit's React components. React (18 or 19) is
// an optional peer dependency; nothing else is needed. The components are
// unstyled: they carry `omz-*` class names, `data-status` and ARIA state for
// the product's own design system, or `@omazyai/sdk/ui/styles.css` as a
// small default themed with CSS variables. Text comes in English and Bangla
// through `UiProvider` and can be overridden word by word.

export { type UiConfig, type UiContextValue, UiProvider, useUi } from './context.js'
export { type CopilotChatOptions, useCopilotChat, useFocusAfter, useNow, useReducedMotion, useResource, useStore } from './hooks.js'
export { ConfirmAction, Diff, type HeadingLevel } from './bits.js'
export {
  ActorCard,
  type ActorCardProps,
  ApprovalCard,
  type ApprovalCardProps,
  ConsentCard,
  type ConsentCardProps,
  MemorySuggestion,
  type MemorySuggestionProps,
} from './cards.js'
export { CopilotPanel, type CopilotPanelProps } from './panel.js'
export { ApprovalDetail, type ApprovalDetailProps, ApprovalsInbox, type ApprovalsInboxProps, type StepUpSlotProps } from './approvals.js'
export { ConnectedApps, MemoryPage, StandingGrants } from './pages.js'
