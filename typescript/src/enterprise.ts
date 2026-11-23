import { DEFAULT_BASE_URL, Omazy, VERSION, type OmazyOptions } from './index.js'
import { buildUrl, request, type ResponseInfo, type Transport } from './transport.js'
import type {
  AccountUsage,
  AccountUsageQuery,
  CreateWorkspaceRequest,
  CreateWorkspaceResult,
  EnterpriseAccount,
  ListWorkspacesQuery,
  ManagedWorkspace,
  RotateInstallRequest,
  RotateInstallResult,
  UpdateWorkspaceRequest,
  WorkspacePage,
} from './types.js'

export const DEFAULT_ENTERPRISE_BASE_URL = 'https://mw.omazy.ai/api/v1/enterprise'

// Every Enterprise API route this client covers, keyed by the name the
// contract gives it (contracts/enterprise-api.routes.json). The tests hold the
// table to the contract.
export const ENTERPRISE_ROUTES = {
  account: ['GET', '/account'],
  'workspaces.list': ['GET', '/workspaces'],
  'workspaces.create': ['POST', '/workspaces'],
  'workspaces.get': ['GET', '/workspaces/{id}'],
  'workspaces.update': ['PATCH', '/workspaces/{id}'],
  'workspaces.close': ['DELETE', '/workspaces/{id}'],
  'workspaces.rotate_install': ['POST', '/workspaces/{id}/install/rotate'],
  usage: ['GET', '/usage'],
} as const satisfies Record<string, readonly [string, string]>

export type EnterpriseRouteName = keyof typeof ENTERPRISE_ROUTES

// Routes the client sends again after a 429, a gateway error or a dropped
// connection. Creating a workspace is one of them: external_id names the
// customer, so a second request finds the workspace the first one made.
// Rotating a token is not: each run replaces the token before it.
export const ENTERPRISE_REPEATABLE: ReadonlySet<EnterpriseRouteName> = new Set<EnterpriseRouteName>([
  'account',
  'workspaces.list',
  'workspaces.create',
  'workspaces.get',
  'workspaces.update',
  'workspaces.close',
  'usage',
])

export interface OmazyEnterpriseOptions {
  /** An account key, `eak_<prefix>.<secret>`. Server side only. */
  token: string
  baseUrl?: string
  /** Retries after a 429, 502, 503, 504 or a dropped connection, on routes that are safe to repeat. Default 2. */
  maxRetries?: number
  /** Give up on a request after this long. Default 60 s. */
  timeoutMs?: number
  fetch?: typeof fetch
}

interface CallInit {
  path?: Record<string, string>
  query?: Record<string, string | undefined>
  json?: unknown
}

/**
 * Client for the Omazy Enterprise API, for a product that runs one workspace
 * per customer. An account key creates and runs the workspaces. It never calls
 * a model: each workspace has its own install token for the Core API, and
 * `core(token)` gives you the client for it.
 *
 * ```ts
 * const account = new OmazyEnterprise({ token: process.env.OMAZY_ACCOUNT_KEY! })
 * const { workspace, token } = await account.workspaces.create({ external_id: 'cust_42', name: 'Acme Bank' })
 * if (token) await saveTokenFor('cust_42', token) // shown once
 * const acme = account.core(await tokenFor('cust_42'))
 * await acme.knowledge.documents.create({ title: 'Opening hours', content: '9 to 5' })
 * ```
 */
export class OmazyEnterprise {
  private readonly base: string
  private readonly maxRetries: number
  private readonly transport: Transport
  private readonly coreOptions: Pick<OmazyOptions, 'baseUrl' | 'fetch'>
  private readonly opts: OmazyEnterpriseOptions
  private forward?: (info: ResponseInfo) => void
  /**
   * Headers of the most recent response of this client, whichever call it
   * answered: request id and the key's deadline. Calls made at once can
   * replace it before you read it; `withResponse` gives one call's headers.
   */
  last: ResponseInfo = { tokenIsPrevious: false, replayed: false }

  constructor(opts: OmazyEnterpriseOptions) {
    if (!opts?.token) throw new Error('OmazyEnterprise: token is required')
    this.opts = opts
    this.base = (opts.baseUrl ?? DEFAULT_ENTERPRISE_BASE_URL).replace(/\/+$/, '')
    this.maxRetries = opts.maxRetries ?? 2
    this.transport = {
      token: opts.token,
      timeoutMs: opts.timeoutMs ?? 60_000,
      fetcher: opts.fetch ?? globalThis.fetch.bind(globalThis),
      userAgent: `omazy-sdk-typescript/${VERSION}`,
      api: 'the Enterprise API',
      onResponse: (info) => {
        this.last = info
        this.forward?.(info)
      },
    }
    // The Core API of the same deployment: .../enterprise becomes .../core.
    const coreBase = this.base.endsWith('/enterprise') ? this.base.slice(0, -'/enterprise'.length) + '/core' : DEFAULT_BASE_URL
    this.coreOptions = { baseUrl: coreBase, fetch: opts.fetch }
  }

  /** The account behind the key, its limits, how many workspaces it manages, and the key. Needs no scope. */
  account = () => this.json<EnterpriseAccount>('account')

  /**
   * Usage and cost per UTC day of the account's workspaces, one page of them,
   * with the account's totals over every workspace. The last 30 days by
   * default, at most 90. Needs `usage:read`.
   */
  usage = async (q: AccountUsageQuery = {}): Promise<AccountUsage> => {
    const res = await this.send('usage', {
      query: {
        from: q.from,
        to: q.to,
        status: q.status,
        external_id: q.external_id,
        cursor: q.cursor,
        limit: q.limit ? String(q.limit) : undefined,
        group_by: q.group_by,
        unit: q.unit,
        run_id: q.run_id,
      },
    })
    const body = (await res.json()) as { data?: Omit<AccountUsage, 'next_cursor'>; meta?: { next_cursor?: string } }
    return { ...(body.data as Omit<AccountUsage, 'next_cursor'>), next_cursor: body.meta?.next_cursor || undefined }
  }

  readonly workspaces = {
    /**
     * Creates the workspace of a customer, with its agent, its plan and its
     * install. Safe to repeat: the same `external_id` returns the same
     * workspace, with `created: false` and no token. Needs `workspaces:manage`;
     * the install is minted when the key also holds `installs:manage`.
     */
    create: (req: CreateWorkspaceRequest) => this.json<CreateWorkspaceResult>('workspaces.create', { json: req }),

    /** One page of the account's workspaces, newest first. Needs `workspaces:manage`. */
    list: async (q: ListWorkspacesQuery = {}): Promise<WorkspacePage> => {
      const res = await this.send('workspaces.list', {
        query: { status: q.status, external_id: q.external_id, cursor: q.cursor, limit: q.limit ? String(q.limit) : undefined },
      })
      const body = (await res.json()) as { data?: ManagedWorkspace[]; meta?: { next_cursor?: string } }
      return { workspaces: body.data ?? [], next_cursor: body.meta?.next_cursor || undefined }
    },

    /** Every workspace of the account, page by page. */
    all: (q: Omit<ListWorkspacesQuery, 'cursor' | 'external_id'> = {}): AsyncGenerator<ManagedWorkspace> => this.allWorkspaces(q),

    /** One workspace by its id. Needs `workspaces:manage`. */
    get: (id: string) => this.json<ManagedWorkspace>('workspaces.get', { path: { id } }),

    /** The workspace of a customer by your own id for them, or null when there is none. */
    findByExternalId: async (externalId: string): Promise<ManagedWorkspace | null> =>
      (await this.workspaces.list({ external_id: externalId })).workspaces[0] ?? null,

    /** Rename, rebrand, suspend or resume. `status: 'active'` on a closed workspace reopens it. Needs `workspaces:manage`. */
    update: (id: string, req: UpdateWorkspaceRequest) => this.json<ManagedWorkspace>('workspaces.update', { path: { id }, json: req }),

    /** Stop serving a workspace. Its Core calls are refused within about 30 seconds; a call in progress finishes. */
    suspend: (id: string) => this.workspaces.update(id, { status: 'suspended' }),

    /** Serve a suspended workspace again, or reopen a closed one. */
    resume: (id: string) => this.workspaces.update(id, { status: 'active' }),

    /** Close a workspace. Nothing is erased, and `resume` reopens it. Needs `workspaces:manage`. */
    close: (id: string) => this.json<ManagedWorkspace>('workspaces.close', { path: { id } }),

    /**
     * A new install token for the workspace. The old one keeps working for
     * `overlap_hours`. A workspace with no install gets one. Never sent twice
     * by the client: each run replaces the token before it. Needs `installs:manage`.
     */
    rotateInstall: (id: string, req: RotateInstallRequest = {}) =>
      this.json<RotateInstallResult>('workspaces.rotate_install', { path: { id }, json: req }),
  }

  /**
   * Runs `fn` with a client of its own and returns what `fn` returned with the
   * headers of the last response that client received, which no other call
   * can change. `last` here still follows every response.
   */
  async withResponse<T>(fn: (client: OmazyEnterprise) => Promise<T>): Promise<{ result: T; response: ResponseInfo }> {
    const child = new OmazyEnterprise(this.opts)
    child.forward = (info) => {
      this.last = info
      this.forward?.(info)
    }
    const result = await fn(child)
    return { result, response: child.last }
  }

  /**
   * A Core API client for one customer, from that customer's install token.
   * It talks to the same deployment as this client.
   */
  core(installToken: string, opts: Omit<OmazyOptions, 'token'> = {}): Omazy {
    return new Omazy({ ...this.coreOptions, ...opts, token: installToken })
  }

  private async *allWorkspaces(q: Omit<ListWorkspacesQuery, 'cursor' | 'external_id'>): AsyncGenerator<ManagedWorkspace> {
    let cursor: string | undefined
    do {
      const page = await this.workspaces.list({ ...q, cursor })
      yield* page.workspaces
      cursor = page.next_cursor
    } while (cursor)
  }

  private async json<T>(route: EnterpriseRouteName, init: CallInit = {}): Promise<T> {
    const res = await this.send(route, init)
    return ((await res.json()) as { data?: T }).data as T
  }

  private send(route: EnterpriseRouteName, init: CallInit = {}): Promise<Response> {
    const [method, template] = ENTERPRISE_ROUTES[route]
    return request(this.transport, {
      method,
      url: buildUrl(this.base, template, init.path, init.query),
      json: init.json,
      retries: ENTERPRISE_REPEATABLE.has(route) ? this.maxRetries : 0,
    })
  }
}
