// The route contract check a product runs in its CI. The product pins an
// exact SDK version; the platform publishes its route contract with every
// SDK release. This holds the pinned client's route table against the
// contract: a route the client sends that the platform no longer serves, or
// serves on another method or path, fails the build before it fails a call.

import { ROUTES } from '../routes.js'
import { VERSION } from '../index.js'

/** The route contract as published: `contracts/core-api.routes.json`. */
export interface RouteContract {
  base?: string
  routes: readonly { method: string; path: string; sdk: string; [k: string]: unknown }[]
}

/** Where the contract of the latest SDK release is published. */
export const CONTRACT_URL = 'https://raw.githubusercontent.com/omazyai/omazy-sdk/main/contracts/core-api.routes.json'

export interface ContractProblem {
  route: string
  kind: 'missing_on_platform' | 'changed'
  message: string
}

export interface ContractReport {
  sdkVersion: string
  ok: boolean
  problems: ContractProblem[]
  /** Routes the platform serves that this SDK does not know yet: a newer SDK has them. Not a failure. */
  newOnPlatform: string[]
  checked: number
  /** Where the contract came from: the live route's URL, the published file's URL, or `given`. */
  source: string
  /** Why the live route was not used, when a `baseUrl` was given and the check fell back. */
  liveError?: string
}

export interface ContractCheckOptions {
  /**
   * The Core API base URL, such as `https://mw.omazy.ai/api/v1/core`. Given, the
   * check reads the contract the live platform serves at `GET {baseUrl}/contract`
   * (no token needed) and falls back to `contract` when that fails.
   */
  baseUrl?: string
  /** The contract, or the URL to fetch it from. Default `CONTRACT_URL`. */
  contract?: RouteContract | string
  /** The client's route table. Default this SDK's. */
  routes?: Readonly<Record<string, readonly [string, string]>>
  /** Only the routes the product calls, such as `['ai.complete', 'knowledge.search']`. Default every route. */
  uses?: readonly string[]
  fetch?: typeof fetch
}

/** Reads the contract the live platform serves, in the `{ success, data }` envelope. */
async function liveContract(baseUrl: string, f: typeof fetch): Promise<{ url: string; contract: RouteContract }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/contract`
  const res = await f(url)
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  const body = (await res.json()) as { data?: RouteContract }
  if (!Array.isArray(body?.data?.routes)) throw new Error(`${url} has no routes list`)
  return { url, contract: body.data }
}

/**
 * Compares the route table with the contract. With `baseUrl`, the contract is
 * the live platform's; otherwise, or when the live route fails, the one given
 * or fetched from its URL.
 */
export async function checkRouteContract(o: ContractCheckOptions = {}): Promise<ContractReport> {
  const f = o.fetch ?? fetch
  let contract: RouteContract | undefined
  let source = 'given'
  let liveError: string | undefined
  if (o.baseUrl) {
    try {
      const live = await liveContract(o.baseUrl, f)
      contract = live.contract
      source = live.url
    } catch (e) {
      liveError = e instanceof Error ? e.message : String(e)
    }
  }
  if (!contract) {
    if (typeof o.contract === 'object' && o.contract) contract = o.contract
    else {
      const url = typeof o.contract === 'string' ? o.contract : CONTRACT_URL
      const res = await f(url)
      if (!res.ok) throw new Error(`the route contract at ${url} answered ${res.status}`)
      contract = (await res.json()) as RouteContract
      source = url
    }
  }
  if (!Array.isArray(contract?.routes)) throw new Error('the route contract has no routes list')
  const table = o.routes ?? (ROUTES as Readonly<Record<string, readonly [string, string]>>)
  const byName = new Map(contract.routes.map((r) => [r.sdk, r]))
  const names = o.uses ?? Object.keys(table)
  const problems: ContractProblem[] = []
  for (const name of names) {
    const mine = table[name]
    if (!mine) {
      problems.push({ route: name, kind: 'missing_on_platform', message: `${name} is not a route of this SDK (${VERSION}); the product names a route it cannot call` })
      continue
    }
    const theirs = byName.get(name)
    if (!theirs) problems.push({ route: name, kind: 'missing_on_platform', message: `${name} (${mine[0]} ${mine[1]}) is not in the platform's contract` })
    else if (theirs.method !== mine[0] || theirs.path !== mine[1]) {
      problems.push({ route: name, kind: 'changed', message: `${name} is ${theirs.method} ${theirs.path} on the platform, ${mine[0]} ${mine[1]} in SDK ${VERSION}` })
    }
  }
  const newOnPlatform = contract.routes.map((r) => r.sdk).filter((n) => !table[n])
  return { sdkVersion: VERSION, ok: problems.length === 0, problems, newOnPlatform, checked: names.length, source, ...(liveError ? { liveError } : {}) }
}

export class ContractError extends Error {
  override readonly name = 'ContractError'
  constructor(readonly report: ContractReport) {
    super(`SDK ${report.sdkVersion} does not match the platform's route contract: ${report.problems.map((p) => p.message).join('; ')}`)
  }
}

/** Throws `ContractError` when the pinned SDK sends a route the platform does not serve as it expects. */
export async function assertRouteContract(o: ContractCheckOptions = {}): Promise<ContractReport> {
  const r = await checkRouteContract(o)
  if (!r.ok) throw new ContractError(r)
  return r
}
