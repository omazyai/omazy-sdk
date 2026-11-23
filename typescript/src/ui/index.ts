// @omazyai/sdk/ui: the framework-free core of the ui kit. A chat on the AI SDK
// UI message stream, fetch clients for the copilot's routes and the kit
// routes, view models for each screen, Bangla and English text, the optional
// stylesheet. No server code: `uiRoutes` is in `@omazyai/sdk/ui/server`. No
// React here: the components are in `@omazyai/sdk/ui/react`; a Preact or
// plain product renders the view models itself.

export {
  type ChatLike,
  type ChatMessage,
  type ChatOptions,
  type ChatPart,
  type ChatState,
  type ChatStatus,
  type ChatStore,
  createChat,
  messageBuilder,
  readSse,
} from './chat.js'
export { type CopilotClient, copilotClient, type HttpOptions, type UiClient, uiClient, UiHttpError } from './clients.js'
export { createResource, type Resource, type ResourceState } from './store.js'
export { formatDate, formatNumber, intlLocale, UI_TEXT, type UiLocale, type UiText, type UiTextOverrides, uiText } from './text.js'
export {
  type ActorView,
  actorDataOf,
  actorView,
  activeGrants,
  type ApprovalView,
  approvalView,
  cardAfter,
  type ConsentView,
  consentView,
  type DiffRow,
  diffRows,
  type Expiry,
  expiry,
  formatValue,
  lastAssistantText,
  memoryGroups,
  type PartView,
  partView,
  personName,
  replaceDataPart,
} from './views.js'
export { UI_CSS } from './styles.js'
export type * from './types.js'
