// The consent page and the kit's other small pages. Everything a client
// chose (its name, domain, redirect host) is escaped. The page carries no
// script unless Turnstile is on, and then only Cloudflare's, under a nonce.

import { b64url } from '../guard/crypto.js'

export type ClientStatus = 'known' | 'verified' | 'unverified'

export interface ConsentView {
  productName: string
  door: string
  doorLabel?: string
  clientName: string
  status: ClientStatus
  /** The domain of a Client ID Metadata Document client. */
  clientDomain?: string
  redirectHost: string
  redirectIsLoopback: boolean
  handle: string
  action: string
  turnstileSiteKey?: string
}

export const escapeHtml = (v: string): string => v.replace(/[&<>"'`=/]/g, (c) => `&#${c.charCodeAt(0)};`)

const TURNSTILE = 'https://challenges.cloudflare.com'

/** Headers every kit page carries: no framing, no caching, no referrer, a strict CSP. */
export function pageHeaders(nonce: string, turnstile: boolean, base?: Headers): Headers {
  const h = new Headers(base)
  const script = turnstile ? `script-src 'nonce-${nonce}' ${TURNSTILE}; frame-src ${TURNSTILE}; connect-src ${TURNSTILE}; ` : ''
  h.set('content-security-policy', `default-src 'none'; ${script}style-src 'nonce-${nonce}'; img-src 'none'; base-uri 'none'; frame-ancestors 'none'`)
  h.set('x-frame-options', 'DENY')
  h.set('cache-control', 'no-store')
  h.set('referrer-policy', 'no-referrer')
  h.set('x-content-type-options', 'nosniff')
  h.set('content-type', 'text/html; charset=utf-8')
  return h
}

export const newNonce = (): string => b64url(crypto.getRandomValues(new Uint8Array(16)))

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#111;background:#fff}
h1{font-size:1.35rem;margin:0 0 1rem}.box{border:1px solid #ddd;border-radius:8px;padding:1rem;margin:1rem 0}
.warn{background:#fff7e6;border-color:#f0c36d}.ok{background:#eef8f0;border-color:#9fd3aa}
button{font:inherit;padding:.6rem 1.2rem;border-radius:6px;border:1px solid #999;background:#fff;cursor:pointer;margin-right:.5rem}
button.go{background:#111;color:#fff;border-color:#111}small{color:#555}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}.box{border-color:#444}.warn{background:#3a2e10}.ok{background:#12301a}button{background:#222;color:#eee}button.go{background:#eee;color:#111}small{color:#aaa}}`

export function consentPage(v: ConsentView, nonce: string): string {
  const name = escapeHtml(v.clientName)
  const product = escapeHtml(v.productName)
  const where = escapeHtml(v.doorLabel ?? v.door)
  const status =
    v.status === 'known'
      ? `<div class="box ok"><strong>${name}</strong> is an app ${product} knows.${v.clientDomain ? ` Published by <strong>${escapeHtml(v.clientDomain)}</strong>.` : ''}</div>`
      : v.status === 'verified'
        ? `<div class="box">Published by <strong>${escapeHtml(v.clientDomain ?? '')}</strong>, verified by its metadata document. ${product} has not reviewed this app.</div>`
        : `<div class="box warn"><strong>Not verified.</strong> This app registered itself, so its name may not be true. Continue only if you started this from an app you trust.</div>`
  const loop = v.redirectIsLoopback
    ? `<div class="box warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</div>`
    : ''
  const widget = v.turnstileSiteKey
    ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(v.turnstileSiteKey)}"></div><script nonce="${nonce}" src="${TURNSTILE}/turnstile/v0/api.js" async defer></script>`
    : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect ${name}</title><style nonce="${nonce}">${STYLE}</style></head>
<body>
<h1>Connect ${name} to ${product}?</h1>
<p>${name} asks to use ${product} (${where}) on your behalf, with the permissions you hold there. It can do only what you can do, and you can disconnect it at any time.</p>
${status}
<div class="box">Access will be sent to <strong>${escapeHtml(v.redirectHost)}</strong>.</div>
${loop}
<p><small>You sign in to ${product} next.</small></p>
<form method="post" action="${escapeHtml(v.action)}">
<input type="hidden" name="handle" value="${escapeHtml(v.handle)}">
${widget}
<p><button class="go" name="decision" value="approve">Continue</button><button name="decision" value="deny">Cancel</button></p>
</form>
</body></html>`
}

export function messagePage(title: string, text: string, nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style nonce="${nonce}">${STYLE}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></body></html>`
}
