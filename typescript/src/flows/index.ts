// @omazyai/sdk/flows: workflows and automations. Each step is a capability
// through the guard, an ai task or an actor, and each step's effect is in the
// ledger. Writes never retry, R3 writes wait for their approval, a failed
// write goes to a person. Runs on Cloudflare Workflows (`flowEntrypoint`), or
// in memory for tests (`memoryRunner`). A Node runner comes later.

export {
  type Automation,
  AutomationError,
  type AutomationEvent,
  type AutomationSpec,
  type Automations,
  type AutomationsOptions,
  automation,
  automationProblems,
  type Budget,
  createAutomations,
  type EnableResult,
  type FireOutcome,
  type FireResult,
  on,
  type ScheduleOptions,
  type ScheduleZone,
  type Trigger,
} from './automation.js'
export {
  cloudflareHost,
  cloudflareStarter,
  flowEntrypoint,
  instanceIdFor,
  type WorkflowBindingLike,
  type WorkflowEntrypointCtor,
  type WorkflowStepLike,
} from './cloudflare.js'
export { type Cron, CronError, type CronOptions, cron, isTimeZone, type LocalTime, localMinute, localTime } from './cron.js'
export { applyFlowMigrations, d1FlowStore, FLOW_MIGRATIONS, flowMigrationSql } from './d1.js'
export { flowEvents, type Resolution, runFlow } from './engine.js'
export { type MemoryRunner, type MemoryRunStatus, memoryFlowStore, memoryRunner } from './memory.js'
export { createFlows, type Flows, type FlowsOptions, type FlowStarter, type StartRunInput, type StartRunResult, startRun } from './runtime.js'
export * from './types.js'
export { step, type Workflow, WorkflowError, type WorkflowSpec, workflow, WORKFLOW_ID_PATTERN, workflowProblems } from './workflow.js'
