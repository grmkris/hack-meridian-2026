/**
 * Gives the testnet sandbox its USDC back: each wallet whose passkey a run kept (`--keep-passkeys`) pays its whole
 * balance to the testnet treasury as an owner payment, approved with that passkey on Nod's approval page.
 *
 *   bun evidence/sandbox-return/run.ts <passkeys.json> [<passkeys.json> …]
 *
 * Per wallet: a browser whose virtual authenticator gets the kept credential back (WebAuthn.addCredential); an MCP
 * client connects the way Claude does, signing in with that passkey on the consent page (allowance 1 USDC); then
 * payment_prepare of the whole balance to the treasury (past the allowance, so the owner's nod), the approval page,
 * the passkey, and the receipt. Testnet only. No key is printed. Evidence: evidence/sandbox-return/<timestamp>/.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { perform } from '../../scripts/demo/lib/actions.ts'
import { ownerBrowser } from '../../scripts/demo/lib/browser.ts'
import {
  connect,
  finishAuthorization,
  loopback,
  MemoryAuthProvider,
  startAuthorization,
} from '../../scripts/demo/lib/oauth.ts'

const TREASURY = 'GB4F3NUAD2NIRNOHNB36QS7ONEPWMPVSI5IRT6NY5FMMONLGTDQ4CIU5'
const EXPLORER = 'https://stellar.expert/explorer/testnet'
const files = process.argv.slice(2)
if (files.length === 0) throw new Error('give the kept passkeys files')
const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
const dir = join(import.meta.dir, stamp)
mkdirSync(dir, { recursive: true })

const at = (value: unknown, ...path: ReadonlyArray<string | number>): string => {
  let current: unknown = value
  for (const key of path)
    current = typeof current === 'object' && current !== null ? Reflect.get(current, key) : undefined
  return typeof current === 'string' || typeof current === 'number' || typeof current === 'boolean'
    ? String(current)
    : ''
}
const log: Array<Record<string, unknown>> = []
const step = (name: string, data: Record<string, unknown>) => {
  const entry = { at: new Date().toISOString(), step: name, ...data }
  log.push(entry)
  console.log(JSON.stringify(entry))
}

for (const file of files) {
  const kept: unknown = JSON.parse(readFileSync(file, 'utf8'))
  const base = at(kept, 'base')
  if (!base.startsWith('https://testnet.') && !base.startsWith('http://localhost')) throw new Error(`${base} is not testnet`)
  const who = at(kept, 'who')
  const credential: unknown = typeof kept === 'object' && kept !== null ? Reflect.get(kept, 'credentials') : undefined
  if (!Array.isArray(credential) || credential.length === 0) throw new Error(`${file} holds no credential`)
  const browser = await ownerBrowser(dir)
  await browser.cdp.send('WebAuthn.addCredential', { authenticatorId: browser.authenticatorId, credential: credential[0] })
  const mcpUrl = new URL('/mcp', base)
  const callback = loopback()
  const provider = new MemoryAuthProvider(callback.redirect, 'Sandbox return')
  const authUrl = await startAuthorization(mcpUrl, provider, fetch)
  const redirected = callback.next()
  const browse = (actions: Parameters<typeof perform>[1], vars: Record<string, string>) =>
    perform(browser.page, actions, vars, name => browser.shot(`${who}-${name}`), line => step(`${who} browser`, { line }))
  await browse(
    [
      { do: 'goto', url: '{{auth_url}}' },
      // Sign in with the kept passkey; never the create button (that would make a new, funded wallet).
      { do: 'click', selector: '[data-testid="passkey-signin"]', timeoutMs: 30_000 },
      { do: 'waitFor', selector: '[data-testid="consent-allow"], button[value=approve]', timeoutMs: 120_000 },
      { do: 'fill', selector: '[data-testid="allowance"], input[name=allowance]', value: '1', optional: true },
      { do: 'click', selector: '[data-testid="consent-allow"], button[value=approve]', timeoutMs: 120_000 },
    ],
    { auth_url: authUrl.href },
  )
  const params = await Promise.race([
    redirected,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no OAuth redirect within 180 s')), 180_000)),
  ])
  const code = params.get('code')
  if (code === null) throw new Error(`no code: ${params.get('error') ?? '?'}`)
  await finishAuthorization(mcpUrl, provider, fetch, code)
  const client = await connect(mcpUrl, provider, fetch)
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })
    return Reflect.get(result, 'structuredContent')
  }
  const overview = await call('wallet_overview', {})
  const wallet = at(overview, 'wallet', 'contract_id')
  const balance = at(overview, 'balances', 'usdc')
  step(`${who} wallet`, { wallet: `${EXPLORER}/contract/${wallet}`, usdc: balance })
  const prepared = await call('payment_prepare', {
    recipient: TREASURY,
    amount: balance,
    reason: 'Returning sandbox USDC to the testnet treasury',
    idempotency_key: `return-${who}-${stamp}`,
  })
  await browse(
    [
      { do: 'goto', url: '{{url}}' },
      { do: 'click', selector: '[data-testid="approve"], #approve', timeoutMs: 60_000 },
      { do: 'waitFor', selector: '[data-testid="approval-done"]', optional: true, timeoutMs: 90_000 },
      { do: 'shot', name: 'returned' },
    ],
    { url: at(prepared, 'approval_url') },
  )
  const status = await call('payment_status', { payment_id: at(prepared, 'payment_id') })
  const after = await call('wallet_overview', {})
  step(`${who} returned`, {
    lane: at(prepared, 'lane'),
    status: at(status, 'status'),
    usdc: at(status, 'amount'),
    tx: at(status, 'receipt', 'tx_hash') === '' ? null : `${EXPLORER}/tx/${at(status, 'receipt', 'tx_hash')}`,
    wallet_usdc_after: at(after, 'balances', 'usdc'),
  })
  await client.close()
  await browser.close()
  callback.stop()
}
writeFileSync(join(dir, 'run.json'), `${JSON.stringify({ treasury: TREASURY, steps: log }, null, 2)}\n`)
console.log(`wrote ${join(dir, 'run.json')}`)
