/**
 * An MCP agent for `scripts/events-check.ts` on the local stage without the testnet treasury: its wallet is made
 * deposit-first in a browser with a virtual passkey (no welcome USDC), the consent page signs in with that passkey and
 * sets a 1 USDC allowance (the account deploys there; the relayer pays), and the client and tokens are written where
 * events-check reads them (.local/agents/local-<name>.json, mode 600).
 *
 *   bun evidence/topup/local-agent.ts [--name events]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { perform } from '../../scripts/demo/lib/actions.ts'
import { ownerBrowser } from '../../scripts/demo/lib/browser.ts'
import { finishAuthorization, loopback, MemoryAuthProvider, startAuthorization } from '../../scripts/demo/lib/oauth.ts'

const BASE = 'http://localhost:18960'
const name = process.argv.includes('--name') ? (process.argv[process.argv.indexOf('--name') + 1] ?? 'events') : 'events'
const root = resolve(import.meta.dir, '../..')
const dir = join(root, '.local/agents', `local-${name}-consent`)
mkdirSync(dir, { recursive: true })

const browser = await ownerBrowser(dir)
await browser.page.goto(`${BASE}/`, { waitUntil: 'load' })
// The claim page's "Create my wallet": deposit-first, so no welcome USDC leaves the treasury.
const made: unknown = await browser.page.evaluate(`(async () => {
  const enc = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
  const dec = t => Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json())
  const o = await post('/api/wallets/options', { name: 'Events agent' })
  const c = await navigator.credentials.create({ publicKey: { challenge: dec(o.challenge), rp: { id: o.rp_id, name: o.rp_name },
    user: { id: dec(o.user_id), name: o.user_name, displayName: o.user_name }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' } } })
  return post('/api/wallets', { name: 'Events agent', credential_id: enc(c.rawId), public_key: enc(c.response.getPublicKey()),
    client_data_json: enc(c.response.clientDataJSON), attestation_object: enc(c.response.attestationObject), deposit_first: true })
})()`)
console.log(`wallet ${JSON.stringify(made).slice(0, 160)}`)
const mcpUrl = new URL('/mcp', BASE)
const callback = loopback()
const provider = new MemoryAuthProvider(callback.redirect, `Nod agent (${name})`)
const authUrl = await startAuthorization(mcpUrl, provider, fetch)
const redirected = callback.next()
await perform(
  browser.page,
  [
    { do: 'goto', url: '{{auth_url}}' },
    { do: 'waitFor', selector: '[data-testid="consent-allow"], button[value=approve]', timeoutMs: 120_000 },
    { do: 'fill', selector: '[data-testid="allowance"], input[name=allowance]', value: '1', optional: true },
    { do: 'click', selector: '[data-testid="consent-allow"], button[value=approve]', timeoutMs: 120_000 },
  ],
  { auth_url: authUrl.href },
  shot => browser.shot(shot),
  line => console.log(line),
)
const params = await redirected
const code = params.get('code')
if (code === null) throw new Error(`no code: ${params.get('error') ?? '?'}`)
await finishAuthorization(mcpUrl, provider, fetch, code)
const file = join(root, '.local/agents', `local-${name}.json`)
writeFileSync(file, JSON.stringify({ client: provider.client, tokens: provider.tokens(), wallet: made }, null, 2), {
  mode: 0o600,
})
console.log(`wrote ${file}`)
await browser.close()
callback.stop()
