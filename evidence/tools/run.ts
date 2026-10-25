/**
 * The six tools after the first fifteen, one call of each (plus the lane rule they bring), against a running stage on
 * the real chain (testnet):
 *
 *   bun evidence/tools/run.ts [--base http://localhost:18960]
 *
 * The AI app connects the way Claude does (DCR, PKCE, the consent page with a virtual-authenticator passkey; the
 * testnet wallet gets its 10 welcome USDC). Then: tools/list; contact_add of Dave (a fresh testnet account with a USDC
 * trustline); 0.50 to Dave needs the nod though it is inside the allowance (new_contact), the owner approves; the next
 * 0.50 goes alone; contact_update; contact_add + contact_remove; wallet_deposit_address; payments_list;
 * connection_grant_update, approved on its page, and the old rule removed. Writes evidence/tools/<timestamp>/.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Stellar } from '../../apps/seller/demo-deps.ts'
import { perform } from '../../scripts/demo/lib/actions.ts'
import { ownerBrowser } from '../../scripts/demo/lib/browser.ts'
import {
  connect,
  finishAuthorization,
  loopback,
  MemoryAuthProvider,
  startAuthorization,
} from '../../scripts/demo/lib/oauth.ts'

const arg = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name)
  return index > 0 ? (process.argv[index + 1] ?? fallback) : fallback
}
const BASE = arg('--base', 'http://localhost:18960')
const EXPLORER = 'https://stellar.expert/explorer/testnet'
const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
const dir = join(import.meta.dir, stamp)
mkdirSync(dir, { recursive: true })

const log: Array<Record<string, unknown>> = []
const step = (name: string, data: Record<string, unknown>) => {
  const entry = { at: new Date().toISOString(), step: name, ...data }
  log.push(entry)
  console.log(JSON.stringify(entry))
}
const at = (value: unknown, ...path: ReadonlyArray<string | number>): string => {
  let current: unknown = value
  for (const key of path)
    current = typeof current === 'object' && current !== null ? Reflect.get(current, key) : undefined
  return typeof current === 'string' || typeof current === 'number' || typeof current === 'boolean'
    ? String(current)
    : ''
}
const tx = (hash: string) => (hash === '' ? null : `${EXPLORER}/tx/${hash}`)

// Dave: a fresh testnet account that can hold USDC (friendbot + trustline), so the payments land for real.
const horizon = new Stellar.Horizon.Server('https://horizon-testnet.stellar.org')
const dave = Stellar.Keypair.random()
await fetch(`https://friendbot.stellar.org/?addr=${dave.publicKey()}`)
const daveAccount = await horizon.loadAccount(dave.publicKey())
const trust = new Stellar.TransactionBuilder(daveAccount, { fee: '1000', networkPassphrase: Stellar.Networks.TESTNET })
  .addOperation(
    Stellar.Operation.changeTrust({
      asset: new Stellar.Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'),
    }),
  )
  .setTimeout(60)
  .build()
trust.sign(dave)
const trusted = await horizon.submitTransaction(trust)
step('dave', { address: dave.publicKey(), trustline_tx: tx(trusted.hash) })

// The AI app connects.
const mcpUrl = new URL('/mcp', BASE)
const owner = await ownerBrowser(dir)
const shot = (name: string) => owner.shot(name)
const callback = loopback()
const provider = new MemoryAuthProvider(callback.redirect, 'Tools run')
const authUrl = await startAuthorization(mcpUrl, provider, fetch)
const redirected = callback.next()
const browse = (actions: Parameters<typeof perform>[1], vars: Record<string, string>) =>
  perform(owner.page, actions, vars, shot, line => step('browser', { line }))
await browse(
  [
    { do: 'goto', url: '{{auth_url}}' },
    { do: 'click', selector: '[data-testid="passkey-create"], [data-testid="passkey-signin"]', optional: true },
    { do: 'waitFor', selector: '[data-testid="consent-allow"], button[value=approve]', timeoutMs: 120_000 },
    { do: 'fill', selector: '[data-testid="allowance"], input[name=allowance]', value: '5', optional: true },
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
const calls: Array<Record<string, unknown>> = []
const call = async (name: string, args: Record<string, unknown>) => {
  const started = Date.now()
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })
  const content = Reflect.get(result, 'content')
  const out = {
    structured: Reflect.get(result, 'structuredContent'),
    text: Array.isArray(content) ? at(content, 0, 'text') : '',
    isError: Reflect.get(result, 'isError') === true,
  }
  calls.push({ tool: name, arguments: args, ms: Date.now() - started, ...out })
  step(name, { ms: Date.now() - started, is_error: out.isError, sentence: out.text })
  return out
}
const listed = (await client.listTools()).tools.map(tool => tool.name)
step('tools/list', { count: listed.length, names: listed })
const wallet = at((await call('wallet_overview', {})).structured, 'wallet', 'contract_id')
step('wallet', { contract: `${EXPLORER}/contract/${wallet}` })

// contact_add, and the lane rule: the first payment to Dave needs the nod even inside the allowance.
const added = await call('contact_add', { name: 'Dave', address: dave.publicKey(), idempotency_key: `add-${stamp}` })
step('contact_add result', { result: at(added.structured, 'result'), added_by: at(added.structured, 'contact', 'added_by') })
const first = await call('payment_prepare', { recipient: 'Dave', amount: '0.50', idempotency_key: `dave-1-${stamp}` })
const firstId = at(first.structured, 'payment_id')
step('first payment to Dave', {
  status: at(first.structured, 'status'),
  lane: at(first.structured, 'lane'),
  approval_reason: at(first.structured, 'approval_reason'),
  approval_url: at(first.structured, 'approval_url'),
})
await browse(
  [
    { do: 'goto', url: '{{approval_url}}' },
    { do: 'click', selector: '[data-testid="approve"], #approve', timeoutMs: 60_000 },
    { do: 'waitFor', selector: '[data-testid="approval-done"]', optional: true, timeoutMs: 90_000 },
    { do: 'shot', name: 'dave-first-approved' },
  ],
  { approval_url: at(first.structured, 'approval_url') },
)
const firstDone = await call('payment_status', { payment_id: firstId })
step('first payment to Dave, after the nod', {
  status: at(firstDone.structured, 'status'),
  tx: tx(at(firstDone.structured, 'receipt', 'tx_hash')),
})
const second = await call('payment_prepare', { recipient: 'Dave', amount: '0.50', idempotency_key: `dave-2-${stamp}` })
step('second payment to Dave', {
  status: at(second.structured, 'status'),
  lane: at(second.structured, 'lane'),
})
const secondPaid = await call('payment_execute', {
  payment_id: at(second.structured, 'payment_id'),
  idempotency_key: `dave-2-exec-${stamp}`,
})
step('second payment to Dave, alone', {
  status: at(secondPaid.structured, 'status'),
  tx: tx(at(secondPaid.structured, 'receipt', 'tx_hash')),
})

// contact_update, contact_add + contact_remove.
const updated = await call('contact_update', {
  contact: 'Dave',
  aliases: ['dave from the run'],
  idempotency_key: `upd-${stamp}`,
})
step('contact_update result', { result: at(updated.structured, 'result') })
const temp = Stellar.Keypair.random().publicKey()
await call('contact_add', { name: 'Temp', address: temp, idempotency_key: `add-temp-${stamp}` })
const removed = await call('contact_remove', { contact: 'Temp', idempotency_key: `rm-temp-${stamp}` })
step('contact_remove result', { result: at(removed.structured, 'result') })

// wallet_deposit_address, payments_list.
const deposit = await call('wallet_deposit_address', {})
step('wallet_deposit_address result', {
  status: at(deposit.structured, 'status'),
  address: at(deposit.structured, 'address'),
  expires_at: at(deposit.structured, 'expires_at'),
})
const payments = await call('payments_list', { limit: 10 })
step('payments_list result', {
  count: at(payments.structured, 'payments', 'length'),
  newest: at(payments.structured, 'payments', 0, 'receipt', 'explorer_url'),
})

// connection_grant_update: the link, the passkey, the new rule; then the old rule goes.
const update = await call('connection_grant_update', { amount: '6', valid_for_hours: 48, idempotency_key: `up-${stamp}` })
const url = at(update.structured, 'url')
await browse(
  [
    { do: 'goto', url: '{{url}}' },
    { do: 'shot', name: 'allowance-before' },
    { do: 'click', selector: '[data-testid="allowance-approve"]', timeoutMs: 60_000 },
    { do: 'waitFor', selector: '[data-testid="allowance-done"]', timeoutMs: 120_000 },
    { do: 'shot', name: 'allowance-installed' },
    { do: 'click', selector: '[data-testid="allowance-remove-old"]', timeoutMs: 30_000 },
    { do: 'waitForText', text: 'The old allowance is removed', timeoutMs: 120_000 },
    { do: 'shot', name: 'allowance-old-removed' },
  ],
  { url },
)
const status = await owner.page.locator('#status').textContent()
const installTx = (await owner.page.locator('#done-tx').textContent())?.replace('Transaction ', '') ?? ''
step('connection_grant_update installed', {
  url,
  install_tx: tx(installTx.trim()),
  removal: status,
})
const after = await call('wallet_overview', {})
step('allowance after the update', {
  total: at(after.structured, 'grant', 'total'),
  remaining: at(after.structured, 'grant_remaining'),
  valid_until: at(after.structured, 'grant', 'valid_until'),
  install_tx: tx(at(after.structured, 'grant', 'install_tx')),
})

writeFileSync(join(dir, 'run.json'), `${JSON.stringify({ base: BASE, steps: log, calls }, null, 2)}\n`)
console.log(`wrote ${join(dir, 'run.json')}`)
await client.close()
await owner.close()
callback.stop()
