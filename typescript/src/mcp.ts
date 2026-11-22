import { OmazyError } from './errors.js'

export interface McpTool {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
}

export interface McpToolResult {
  /** The tool's answer as text (JSON for most tools). */
  text: string
  /** The same answer as an object, when the tool returned one. */
  data?: Record<string, unknown>
  /** True when the tool refused or failed. `text` then says why. */
  isError: boolean
}

type Post = (body: unknown) => Promise<unknown>

/**
 * The Core API's MCP server (POST /mcp), for a caller that would sooner speak
 * the Model Context Protocol than REST. The tools are the Core verbs this
 * token's scopes allow, and a call spends the same limits its route does.
 *
 * To hand the server to an MCP client of your own, use `config()`.
 */
export class McpClient {
  private id = 0
  constructor(
    private readonly post: Post,
    private readonly url: string,
    private readonly token: string,
  ) {}

  /** The URL and headers an MCP client needs to connect (Streamable HTTP). */
  config(): { type: 'http'; url: string; headers: Record<string, string> } {
    return { type: 'http', url: this.url, headers: { Authorization: `Bearer ${this.token}` } }
  }

  private async rpc<T>(method: string, params?: unknown): Promise<T> {
    const res = (await this.post({ jsonrpc: '2.0', id: ++this.id, method, params })) as {
      result?: T
      error?: { code: number; message: string }
    }
    if (res?.error) throw new OmazyError(res.error.message, 200, `MCP_${res.error.code}`)
    if (res?.result === undefined) throw new OmazyError('the server did not answer with a JSON-RPC result', 200, 'MCP_BAD_RESPONSE')
    return res.result
  }

  /** Server name, version and what it is for. */
  initialize(protocolVersion = '2025-06-18') {
    return this.rpc<{ protocolVersion: string; serverInfo: { name: string; version: string }; instructions?: string }>(
      'initialize',
      { protocolVersion, capabilities: {}, clientInfo: { name: '@omazyai/sdk', version: '0.4.0' } },
    )
  }

  async listTools(): Promise<McpTool[]> {
    return (await this.rpc<{ tools: McpTool[] }>('tools/list')).tools
  }

  /**
   * Calls a tool. A refusal (a bad argument, a spent budget, a rate limit) is
   * returned with `isError: true`, as the protocol does, and is not thrown. An
   * unknown tool is thrown.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    const r = await this.rpc<{
      content?: { type: string; text?: string }[]
      structuredContent?: Record<string, unknown>
      isError?: boolean
    }>('tools/call', { name, arguments: args })
    return {
      text: (r.content ?? []).map((c) => c.text ?? '').join(''),
      data: r.structuredContent,
      isError: r.isError === true,
    }
  }
}
