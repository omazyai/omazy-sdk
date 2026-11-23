// @omazyai/sdk/capabilities: define each action a product offers once, and
// generate its MCP tools, model tools, forms, logs and changelog from that
// one definition. Runtime neutral: no Node APIs, runs on Cloudflare Workers.

export {
  type AnyCapability,
  type BaseCtx,
  type Capability,
  CapabilityError,
  type CapabilitySpec,
  type Channel,
  type Ctx,
  capability,
  DEPRECATION_DAYS,
  DESCRIPTION_MAX,
  DESCRIPTION_MIN,
  type Deprecation,
  defineCapabilities,
  definitionProblems,
  NAME_PATTERN,
  type Preview,
  type Principal,
  removeAfter,
  type Seat,
  setTierAboveRiskHandler,
  tierFor,
} from './capability.js'
export { assertParity, ParityError, type ParityOptions, type ParityProblem, parityProblems, type Surface, type Surfaces } from './parity.js'
export { REDACTED, redact, redactedJson, truncateUtf8 } from './redact.js'
export { createRegistry, type DescribeOptions, type McpToolDefinition, type ParseResult, type Registry, registry, type ToolListOptions } from './registry.js'
export { type Infer, type Presence, Schema, schema } from './schema.js'
export { type SearchHit, type SearchIndex, type SearchOptions, type Searchable, searchIndex, tokenize } from './search.js'
export {
  closeObjects,
  type Issue,
  type JsonSchema,
  type Parsed,
  type SchemaLike,
  type StandardJSONSchemaV1,
  type StandardSchemaV1,
  toJsonSchema,
  unknownFields,
  validate,
  withJsonSchema,
} from './standard.js'
export {
  annotationsOf,
  isTier,
  type McpAnnotations,
  type Mode,
  modeOf,
  needsApproval,
  needsConfirm,
  TIERS,
  type Tier,
  tierRank,
} from './tiers.js'
export {
  assertAdditive,
  BreakingChangeError,
  type CapabilitySnapshot,
  type CatalogSnapshot,
  type Change,
  type ChangeKind,
  type ChangelogOptions,
  type CompareOptions,
  compareSnapshots,
  diffSchema,
  snapshotOf,
  toolsChangelog,
} from './versioning.js'
