/**
 * Claim link v2 against a running stage on the real chain (testnet), end to end:
 *
 *   bun evidence/claims/run.ts [--base http://localhost:18960] [--amount 1]
 *
 * 1. The sender connects an MCP client the way Claude does (DCR, PKCE, the consent page with a passkey from a
 *    virtual authenticator; on testnet the new wallet gets its 10 welcome USDC) and sets a 5 USDC allowance.
 * 2. payment_prepare { recipient: "new", recipient_name: "Jan" } returns a claim link; nothing is paid.
 * 3. Jan, in a second browser with its own virtual authenticator, opens the link and taps "Create my wallet and
 *    receive": a deposit-first Nod wallet (no XLM, no welcome USDC), and the payment runs in the allowance lane.
 * 4. payment_status on the link returns the receipt; Jan's planned C… is deployed and holds the USDC onchain.
 *
 * Screenshots and run.json go to evidence/claims/<timestamp>/. Testnet only; no secret is read.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Stellar } from '../../apps/seller/demo-deps.ts'
import { perform } from '../../scripts/demo/lib/actions.ts'
import { ownerBrowser } from '../../scripts/demo/lib/browser.ts'
import { connect, finishAuthorization, loopback, MemoryAuthProvider, startAuthorization } from '../../scripts/demo/lib/oauth.ts'

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(name)
  return at > 0 ? (process.argv[at + 1] ?? fallback) : fallback
}
const BASE = arg('--base', 'http://localhost:18960')
const AMOUNT = arg('--amount', '1')
const EXPLORER = 'https://stellar.expert/explorer/testnet'
const USDC_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
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

const soroban = new Stellar.rpc.Server('https://soroban-testnet.stellar.org')
const contractExists = async (contractId: string) => {
  const key = Stellar.xdr.LedgerKey.contractData(
    new Stellar.xdr.LedgerKeyContractData({
      contract: new Stellar.Address(contractId).toScAddress(),
      key: Stellar.xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: Stellar.xdr.ContractDataDurability.persistent(),
    }),
  )
  return (await soroban.getLedgerEntries(key)).entries.length > 0
}
const usdcOf = async (contractId: string) => {
  const balance = await soroban.getSACBalance(
    contractId,
    new Stellar.Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'),
    Stellar.Networks.TESTNET,
  )
  return balance.balanceEntry?.amount ?? '0'
}
void USDC_SAC

// 1. The sender connects, as Claude would.
const mcpUrl = new URL('/mcp', BASE)
const sender = await ownerBrowser(dir)
const callback = loopback()
const provider = new MemoryAuthProvider(callback.redirect, 'Claim link run')
const authUrl = await startAuthorization(mcpUrl, provider, fetch)
const redirected = callback.next()
await perform(
  sender.page,
  [
    { do: 'goto', url: '{{auth_url}}' },
    { do: 'click', selector: '[data-testid="passkey-create"], [data-testid="passkey-signin"]', optional: true },
    { do: 'waitFor', selector: '[data-testid="consent-allow"], button[value=approve]', timeoutMs: 120_000 },
    { do: 'fill', selector: '[data-testid="allowance"], input[name=allowance]', value: '5', optional: true },
    { do: 'shot', name: 'sender-consent' },
    { do: 'click', selector: '[data-testid="consent-allow"], button[value=approve]', timeoutMs: 120_000 },
  ],
  { auth_url: authUrl.href },
  name => sender.shot(name),
  line => step('sender browser', { line }),
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
  const content = Reflect.get(result, 'content')
  const text = Array.isArray(content) ? at(content, 0, 'text') : ''
  return { structured: Reflect.get(result, 'structuredContent'), text, isError: Reflect.get(result, 'isError') === true }
}
const overview = await call('wallet_overview', {})
const senderWallet = at(overview.structured, 'wallet', 'contract_id')
step('sender connected', {
  wallet: senderWallet,
  balance: at(overview.structured, 'balances', 'usdc'),
  allowance_left: at(overview.structured, 'grant_remaining'),
  explorer: `${EXPLORER}/contract/${senderWallet}`,
})

// 2. The AI app sends Jan a claim link.
const prepared = await call('payment_prepare', {
  recipient: 'new',
  recipient_name: 'Jan',
  amount: AMOUNT,
  reason: 'Lunch on Sunday',
  idempotency_key: `claim-run-${stamp}`,
})
const linkId = at(prepared.structured, 'payment_id')
const claimUrl = at(prepared.structured, 'claim_url')
step('payment_prepare recipient new', {
  is_error: prepared.isError,
  sentence: prepared.text,
  payment_id: linkId,
  claim_url: claimUrl,
  status: at(prepared.structured, 'status'),
  lane: at(prepared.structured, 'lane'),
})
if (claimUrl === '') throw new Error('no claim_url')

// 3. Jan opens it in another browser and creates a Nod wallet with a passkey.
const jan = await ownerBrowser(dir)
await jan.page.goto(claimUrl, { waitUntil: 'load' })
await jan.shot('jan-claim-open')
await jan.page.locator('[data-testid="claim-name"]').fill('Jan')
await jan.page.locator('[data-testid="claim-new-wallet"]').click()
await jan.page.locator('[data-testid="claim-link-done"], [data-testid="claim-link-waiting"]').first().waitFor({ timeout: 120_000 })
await jan.shot('jan-claim-after')
const janPasskeys = await jan.credentials()
step('jan claimed', { page: jan.page.url(), passkeys: janPasskeys.length })
// Jan is signed in on the claim page: Jan's own overview names the deploy of the planned C (trigger: the claim).
const janOverview: unknown = await jan.page.evaluate(() => fetch('/api/overview').then(response => response.json()))
step('jan overview', {
  account_status: at(janOverview, 'wallet', 'account_status'),
  deploy_tx: at(janOverview, 'wallet', 'deploy_tx') === '' ? null : `${EXPLORER}/tx/${at(janOverview, 'wallet', 'deploy_tx')}`,
})

// 4. The receipt, and the chain.
const status = await call('payment_status', { payment_id: linkId })
const janWallet = at(status.structured, 'recipient', 'address')
const tx = at(status.structured, 'receipt', 'tx_hash')
const deployedAt = Date.now()
let deployed = await contractExists(janWallet)
while (!deployed && Date.now() - deployedAt < 90_000) {
  await new Promise(resolve => setTimeout(resolve, 5_000))
  deployed = await contractExists(janWallet)
}
step('payment_status on the link', {
  sentence: status.text,
  status: at(status.structured, 'status'),
  lane: at(status.structured, 'lane'),
  recipient: janWallet,
  tx: tx === '' ? null : `${EXPLORER}/tx/${tx}`,
  jan_wallet: `${EXPLORER}/contract/${janWallet}`,
  jan_contract_onchain: deployed,
  jan_usdc_stroops: await usdcOf(janWallet),
})
// Jan's own Home after the claim (signed in by the claim page's passkey ceremony).
await jan.page.goto(`${BASE}/`, { waitUntil: 'load' })
await jan.page.waitForTimeout(4_000)
await jan.shot('jan-home')

writeFileSync(join(dir, 'run.json'), `${JSON.stringify({ base: BASE, steps: log }, null, 2)}\n`)
console.log(`wrote ${join(dir, 'run.json')}`)
await client.close()
await sender.close()
await jan.close()
callback.stop()
