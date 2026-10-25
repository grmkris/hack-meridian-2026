import type { ConsentDescription } from '@cloudflare/workers-oauth-provider'

import type { PaymentIntent, PaymentStatus } from './payments.ts'

export const escape = (value: string) => value.replace(/[&<>"']/gu, char => `&#${char.charCodeAt(0)};`)

const STYLE = `<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}
.card{border:1px solid #ddd;border-radius:12px;padding:1rem 1.25rem;margin:1rem 0}
.warn{background:#fff7e0;border-color:#f0c040}.muted{color:#666;font-size:.9em}.err{color:#b00020}
button{font:inherit;padding:.5rem 1.1rem;border-radius:8px;border:1px solid #888;cursor:pointer}
button.primary{background:#111;color:#fff;border-color:#111}input[type=password]{font:inherit;padding:.4rem;width:100%;box-sizing:border-box}
code{word-break:break-all}dt{font-weight:600}dd{margin:0 0 .5rem}
</style>`

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>${STYLE}<body>${body}</body></html>`

/** Expiry choices; "tomorrow 12:00 UTC" is the demo default. */
export function expiryOptions(now = new Date()): string {
  const tomorrowNoon = new Date(now)
  tomorrowNoon.setUTCDate(tomorrowNoon.getUTCDate() + 1)
  tomorrowNoon.setUTCHours(12, 0, 0, 0)
  const choices: [string, Date][] = [
    ['1 hour', new Date(now.getTime() + 3600_000)],
    ['tomorrow 12:00 UTC', tomorrowNoon],
    ['7 days', new Date(now.getTime() + 7 * 86400_000)],
  ]
  return choices
    .map(([label, at], i) => `<option value="${at.toISOString()}"${i === 1 ? ' selected' : ''}>${label}</option>`)
    .join('')
}

/** The OAuth consent page: who is asking, where tokens go, what the connection may (and may not) do. */
export function consentPage(details: ConsentDescription, handle: string, error?: string): string {
  const name = escape(details.clientName)
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : 'This app registered itself; its name is not verified.'
  return page(
    `Connect ${details.clientName}`,
    `<h1>Connect <em>${name}</em> to your wallet?</h1>
<div class="card">
  <p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
  ${details.redirectIsLoopback ? '<p class="warn card"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>' : ''}
  <p class="muted">Scopes: ${details.scope.length > 0 ? details.scope.map(escape).join(', ') : '(none requested; wallet granted)'}</p>
</div>
<form method="post" action="/authorize">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <div class="card">
    <p><label>Wallet <select name="wallet"><option value="wal_personal">Personal (stellar testnet)</option></select></label></p>
    <p>Allow <strong>${name}</strong> to spend up to
      <input name="allowance" value="5.00" inputmode="decimal" pattern="\\d+(\\.\\d{1,2})?" size="6" required> <strong>USDC</strong> total until
      <select name="valid_until">${expiryOptions()}</select>.</p>
    <p class="muted">Larger payments need your passkey: they come back to you as an approval link. (Spike: no key is installed onchain; the product signs the allowance here with the passkey.)</p>
  </div>
  <label>Owner sign-in (spike: shared dev password)<br><input type="password" name="password" autocomplete="current-password" required></label>
  ${error ? `<p class="err">${escape(error)}</p>` : ''}
  <p><button class="primary" name="decision" value="approve">Allow</button> <button name="decision" value="deny" formnovalidate>Deny</button></p>
</form>`,
  )
}

/** The approval page: opening it has no side effect; only the Approve POST (with the owner sign-in) changes state. */
export function approvalPage(intent: PaymentIntent, status: PaymentStatus, error?: string): string {
  const open = status === 'awaiting_approval'
  return page(
    `Approve ${intent.amount} ${intent.asset}`,
    `<h1>${open ? 'Approve this payment?' : `Payment ${escape(status)}`}</h1>
<div class="card">
<dl>
  <dt>Recipient</dt><dd><code>${escape(intent.recipient)}</code></dd>
  <dt>Amount</dt><dd><strong>${escape(intent.amount)} ${escape(intent.asset)}</strong></dd>
  <dt>Network</dt><dd>${escape(intent.network)}</dd>
  <dt>Requested by</dt><dd>${escape(intent.requester)} <span class="muted">(connection ${escape(intent.connection_id.slice(0, 8))})</span></dd>
  ${intent.reason ? `<dt>Reason</dt><dd>“${escape(intent.reason)}” <span class="muted">(the agent’s claim)</span></dd>` : ''}
  <dt>Expires</dt><dd>${escape(intent.expires_at)}</dd>
  <dt>Payment id</dt><dd><code>${escape(intent.payment_id)}</code></dd>
</dl>
</div>
${
  open
    ? `<form method="post">
  <label>Owner sign-in (spike: shared dev password; the product uses your passkey)<br><input type="password" name="password" autocomplete="current-password" required></label>
  ${error ? `<p class="err">${escape(error)}</p>` : ''}
  <p><button class="primary" name="decision" value="approve" id="approve">Approve</button></p>
</form>`
    : intent.receipt
      ? `<div class="card"><p>Receipt: <code>${escape(intent.receipt.tx_hash)}</code></p><p class="muted">${escape(intent.receipt.note)}</p></div>`
      : ''
}`,
  )
}

export const messagePage = (title: string, message: string) =>
  page(title, `<h1>${escape(title)}</h1><p>${escape(message)}</p>`)

export const html = (body: string, init: ResponseInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Content-Security-Policy', "frame-ancestors 'none'")
  headers.set('Cache-Control', 'no-store')
  return new Response(body, { ...init, headers })
}
