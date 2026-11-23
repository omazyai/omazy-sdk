// @omazyai/sdk/copilot: an open conversation on the product's own data. Each
// turn is one run of a copilot unit, streamed as the AI SDK UI message
// stream so `useChat` reads it. Tool search, a whole-batch check before any
// call runs, consent cards for R2, approval cards for R3, standing grants,
// actors and workflows. Threads in Durable Objects, the conversation in the
// ai kit's thread store. Runtime neutral; no React here.

export {
  ACTOR_TOOL,
  type CallOutcome,
  type CardOutcome,
  COPILOT_RULES,
  type Copilot,
  type CopilotOptions,
  createCopilot,
  REMEMBER_TOOL,
  type ScreenRef,
  SEARCH_TOOL,
  type TurnInput,
  type TurnReport,
  type TurnStart,
} from './copilot.js'
export {
  applyGrantMigrations,
  createGrants,
  d1GrantStore,
  DEFAULT_GRANT_CHANNELS,
  GRANT_MIGRATIONS,
  type GrantOwner,
  type GrantRefusal,
  type GrantUse,
  type Grants,
  type GrantsOptions,
  type GrantStore,
  grantMigrationSql,
  MAX_GRANT_DAILY_CAP,
  MAX_GRANT_DAYS,
  memoryGrantStore,
  type SetGrantResult,
  type StandingGrant,
} from './grants.js'
export {
  type HealthFinding,
  SUPPORT_PROMPT,
  SUPPORT_RETRIEVERS,
  type SupportRecipeOptions,
  supportRecipe,
  supportTicketCapability,
  type TicketDraft,
  type WorkflowCapabilityOptions,
  workflowCapability,
} from './recipes.js'
export { readUiChunks, UI_STREAM_HEADERS, type UiChunk, type UiMessage, type UiPart, type UiWriter, uiResponse, uiWriter } from './stream.js'
export {
  applyApprovalUpdate,
  type ApprovalCard,
  type ApprovalCardStatus,
  approvalObjectName,
  type ApprovalUpdate,
  type CardStatus,
  type ConsentCard,
  CopilotThreadObject,
  type CopilotThread,
  type CopilotThreadStore,
  durableObjectThreads,
  memoryThreadStore,
  SETTLED_APPROVAL,
  type StoredCard,
  type ThreadEvent,
  threadObjectName,
} from './threads.js'
