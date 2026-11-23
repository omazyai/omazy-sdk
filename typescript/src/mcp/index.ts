// @omazyai/sdk/mcp: an MCP server per door, driven by the capabilities
// registry and the guard, on the official MCP TypeScript SDK v2. Needs
// `@modelcontextprotocol/server` installed beside this package.

export {
  CONFIRM_ARGUMENT,
  CONFIRM_META_KEY,
  confirmResult,
  declinedResult,
  errorResult,
  GENERIC_ERROR,
  OUTCOME_META_KEY,
  type OutcomeMeta,
  okResult,
  pendingResult,
  refusalResult,
  type ToolResult,
} from './outcomes.js'
export {
  DOOR_OFF_MESSAGE,
  MCP_VERSION_2024,
  MCP_VERSIONS,
  type McpDoor,
  type McpFailure,
  type McpPromptDef,
  type McpResourceDef,
  type McpServerOptions,
  mcpDoors,
  mcpServer,
  type SeatGrant,
} from './server.js'
