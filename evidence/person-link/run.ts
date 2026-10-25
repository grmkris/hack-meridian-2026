/**
 * Person links (an allowance for a person) against a running stage on the real chain (testnet), end to end:
 *
 *   bun evidence/person-link/run.ts [--base http://localhost:18960] [--amount 6]
 *
 * 1. The sender's AI app connects (OAuth, consent with a virtual-authenticator passkey; the testnet wallet gets its 10
 *    welcome USDC and a 5 USDC allowance) and asks payment_prepare for a person with no wallet, past the allowance.
 * 2. The sender opens the approval page: the browser makes the link key, the passkey installs the rule (one tap), the
 *    page shows the link with the key in its fragment. Nothing has moved.
 * 3. The amount boundary onchain, with the link key (this script holds the link, as Jan's browser would): a transfer of
 *    the amount plus one stroop fails the enforcing simulation; exactly the amount passes it (not submitted).
 * 4. Jan opens the link in a second browser with a fresh passkey, creates a deposit-first Nod wallet; the page signs
 *    the transfer with the fragment key; Nod relays it. payment_status gives the receipt; Jan's C deploys.
 * 5. The same claim again: refused by Nod, and the rule refuses one more stroop onchain.
 * 6. A second link is taken back from Connections (remove_context_rule with the passkey); claiming it is refused.
 *
 * `--dex-funded`: no treasury USDC. The sender's wallet is made deposit-first in the sender's browser, a fresh
 * friendbot account buys testnet USDC on the DEX and pays it to the wallet's deposit address, and the consent page then
 * signs in with that passkey instead of creating a funded wallet.
 *
 * Evidence (run.json, screenshots) in evidence/person-link/<timestamp>/. Testnet only. The link key is printed nowhere.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Stellar } from '../../apps/seller/demo-deps.ts'
import { authorizeWithEd25519, entryAddress } from '../../packages/stellar/src/auth.ts'
import { PRESETS } from '../../packages/stellar/src/network.ts'
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
const AMOUNT = arg('--amount', '6')
const DEX_FUNDED = process.argv.includes('--dex-funded')
const NET = PRESETS.testnet
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
const stroops = (decimal: string) => {
  const [whole = '0', fraction = ''] = decimal.split('.')
  return BigInt(whole) * 10_000_000n + BigInt((fraction + '0000000').slice(0, 7))
}

const soroban = new Stellar.rpc.Server(NET.rpcUrl)

/** The rule id add_context_rule returned in the install transaction. */
const ruleIdOf = async (installTx: string) => {
  const result = await soroban.getTransaction(installTx)
  if (result.status !== Stellar.rpc.Api.GetTransactionStatus.SUCCESS || result.returnValue === undefined) throw new Error(`install ${installTx} not found`)
  const entry = (result.returnValue.map() ?? []).find(item => item.key().sym().toString() === 'id')
  return entry?.val().u32() ?? -1
}

/**
 * What the link key alone can do onchain: build USDC.transfer(sender → `to`, amount), sign the sender's auth entry
 * with the link key under its rule, and simulate in enforcing mode (never submitted).
 */
const enforce = async (linkSeed: Uint8Array, sender: string, ruleId: number, to: string, amount: bigint) => {
  const key = Stellar.Keypair.fromRawEd25519Seed(Buffer.from(linkSeed))
  const account = await soroban.getAccount(probeSource)
  const func = Stellar.xdr.HostFunction.hostFunctionTypeInvokeContract(
    new Stellar.xdr.InvokeContractArgs({
      contractAddress: new Stellar.Address(NET.contracts.usdcSac).toScAddress(),
      functionName: 'transfer',
      args: [
        new Stellar.Address(sender).toScVal(),
        new Stellar.Address(to).toScVal(),
        Stellar.nativeToScVal(amount, { type: 'i128' }),
      ],
    }),
  )
  const build = (auth: Array<Stellar.xdr.SorobanAuthorizationEntry>) =>
    new Stellar.TransactionBuilder(account, { fee: '100', networkPassphrase: NET.passphrase })
      .addOperation(Stellar.Operation.invokeHostFunction({ func, auth }))
      .setTimeout(60)
      .build()
  const recorded = await soroban.simulateTransaction(build([]))
  if (!Stellar.rpc.Api.isSimulationSuccess(recorded)) return { ok: false, codes: [], error: recorded.error }
  const latest = recorded.latestLedger
  const signed = await Promise.all(
    (recorded.result?.auth ?? []).map(entry =>
      entryAddress(entry) === sender
        ? authorizeWithEd25519(entry, key, [ruleId], latest + 60, NET.passphrase, NET.contracts.ed25519Verifier)
        : Promise.resolve(entry),
    ),
  )
  const enforced = await soroban.simulateTransaction(build(signed), undefined, 'enforce')
  if (Stellar.rpc.Api.isSimulationSuccess(enforced)) return { ok: true, codes: [], error: null }
  const error = Stellar.rpc.Api.isSimulationError(enforced) ? enforced.error : 'failed'
  // The contract errors in the event log: #3221 is the spending-limit policy, #3000 a rule that is gone.
  const codes = [...new Set([...error.matchAll(/Error\(Contract, #(\d+)\)/gu)].map(match => Number(match[1])))]
  return { ok: false, codes, error: error.split('\n')[0] ?? error }
}
/** Any funded account can source a simulation; the stage's public relayer is one (read from /api/health). */
let probeSource = ''

// 1. The sender connects, as Claude would.
const health: unknown = await (await fetch(`${BASE}/api/health`)).json()
probeSource = at(health, 'chain', 'relayers', 0, 'address')
step('health', { release: at(health, 'release'), network: at(health, 'network') })
const mcpUrl = new URL('/mcp', BASE)
const sender = await ownerBrowser(dir)
const senderShot = (name: string) => sender.shot(name)
if (DEX_FUNDED) {
  // A deposit-first wallet made with the browser's passkey (no welcome USDC), funded from the testnet DEX.
  await sender.page.goto(`${BASE}/`, { waitUntil: 'load' })
  // Runs in the page (its own origin and virtual authenticator), as the claim page's "Create my wallet" does.
  const made: unknown = await sender.page.evaluate(`(async () => {
    const enc = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
    const dec = t => Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json())
    const o = await post('/api/wallets/options', { name: 'Sender' })
    const c = await navigator.credentials.create({ publicKey: { challenge: dec(o.challenge), rp: { id: o.rp_id, name: o.rp_name },
      user: { id: dec(o.user_id), name: o.user_name, displayName: o.user_name }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' } } })
    return post('/api/wallets', { name: 'Sender', credential_id: enc(c.rawId), public_key: enc(c.response.getPublicKey()),
      client_data_json: enc(c.response.clientDataJSON), attestation_object: enc(c.response.attestationObject), deposit_first: true })
  })()`)
  const deposit: unknown = await sender.page.evaluate(() =>
    fetch('/api/wallet/deposit-address').then(response => response.json()),
  )
  const exchange = Stellar.Keypair.random()
  await fetch(`https://friendbot.stellar.org/?addr=${exchange.publicKey()}`)
  const horizon = new Stellar.Horizon.Server('https://horizon-testnet.stellar.org')
  const pay = new Stellar.TransactionBuilder(await horizon.loadAccount(exchange.publicKey()), {
    fee: '1000',
    networkPassphrase: NET.passphrase,
  })
    .addOperation(
      Stellar.Operation.pathPaymentStrictReceive({
        sendAsset: Stellar.Asset.native(),
        sendMax: '2000',
        destination: at(deposit, 'address'),
        destAsset: new Stellar.Asset('USDC', NET.usdcIssuer),
        destAmount: '13',
        path: [],
      }),
    )
    .setTimeout(60)
    .build()
  pay.sign(exchange)
  const paid = await horizon.submitTransaction(pay)
  step('sender funded from the DEX', {
    wallet: at(made, 'wallet', 'contract_id'),
    deposit_address: at(deposit, 'address'),
    payment_tx: tx(paid.hash),
  })
  const started = Date.now()
  let funded: unknown = undefined
  while (Date.now() - started < 240_000) {
    funded = await sender.page.evaluate(() => fetch('/api/overview').then(response => response.json()))
    if (at(funded, 'wallet', 'account_status') === 'active' && at(funded, 'balances', 'usdc') !== '0') break
    await new Promise(resolve => setTimeout(resolve, 10_000))
  }
  step('sender wallet open', {
    account_status: at(funded, 'wallet', 'account_status'),
    usdc: at(funded, 'balances', 'usdc'),
    deploy_tx: tx(at(funded, 'wallet', 'deploy_tx')),
  })
}
const callback = loopback()
const provider = new MemoryAuthProvider(callback.redirect, 'Person link run')
const authUrl = await startAuthorization(mcpUrl, provider, fetch)
const redirected = callback.next()
const browse = (actions: Parameters<typeof perform>[1], vars: Record<string, string>) =>
  perform(sender.page, actions, vars, senderShot, line => step('sender browser', { line }))
await browse(
  [
    { do: 'goto', url: '{{auth_url}}' },
    // A DEX-funded sender is signed in already (never the funded create button then).
    {
      do: 'click',
      selector: DEX_FUNDED
        ? '[data-testid="passkey-signin"]'
        : '[data-testid="passkey-create"], [data-testid="passkey-signin"]',
      optional: true,
    },
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
const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })
  const content = Reflect.get(result, 'content')
  const out = {
    structured: Reflect.get(result, 'structuredContent'),
    text: Array.isArray(content) ? at(content, 0, 'text') : '',
  }
  step(name, { sentence: out.text })
  return out
}
const overview = await call('wallet_overview', {})
const senderWallet = at(overview.structured, 'wallet', 'contract_id')
step('sender', { wallet: senderWallet, usdc: at(overview.structured, 'balances', 'usdc') })

// 2. A person with no wallet, past the allowance: the sender nods on Nod's page, which makes the link.
const prepared = await call('payment_prepare', {
  recipient: 'new',
  recipient_name: 'Jan',
  amount: AMOUNT,
  reason: 'Concert tickets',
  idempotency_key: `person-${stamp}`,
})
const linkId = at(prepared.structured, 'payment_id')
step('payment_prepare person link', {
  outcome: at(prepared.structured, 'outcome'),
  status: at(prepared.structured, 'status'),
  approval_url: at(prepared.structured, 'approval_url'),
  claim_url: at(prepared.structured, 'claim_url') || null,
})
await browse(
  [
    { do: 'goto', url: '{{url}}' },
    { do: 'shot', name: 'sender-approval' },
    { do: 'click', selector: '[data-testid="link-approve"]', timeoutMs: 30_000 },
    { do: 'waitFor', selector: '[data-testid="link-done"]', timeoutMs: 120_000 },
  ],
  { url: at(prepared.structured, 'approval_url') },
)
const link = (await sender.page.locator('[data-testid="link-url"]').textContent()) ?? ''
const installTx = ((await sender.page.locator('#status').textContent()) ?? '').replace('Done: ', '').trim()
// Screenshot with the key blurred out of the picture: the evidence never shows a usable link.
await sender.page.evaluate(() => {
  const el = document.querySelector('[data-testid="link-url"]')
  if (el !== null) el.textContent = `${(el.textContent ?? '').split('#')[0] ?? ''}#k=••••••`
})
await senderShot('sender-link-ready')
const approved = await call('payment_status', { payment_id: linkId })
const ruleId = await ruleIdOf(installTx)
step('the nod: rule installed, nothing moved', {
  install_tx: tx(installTx),
  rule_id: ruleId,
  status: at(approved.structured, 'status'),
  sentence_has_no_key: !approved.text.includes('#k='),
  link_shape: `${link.split('#')[0] ?? ''}#k=<seed>.<public> (not recorded)`,
  sender_usdc: at((await call('wallet_overview', {})).structured, 'balances', 'usdc'),
})

// 3. The boundary onchain with the link key alone (enforcing simulation; nothing submitted).
const fragment = new URL(link).hash.replace(/^#k=/u, '')
const [seedText = ''] = fragment.split('.')
const seed = Uint8Array.from(Buffer.from(seedText, 'base64url'))
const probeTo = Stellar.StrKey.encodeContract(Buffer.from(crypto.getRandomValues(new Uint8Array(32))))
const over = await enforce(seed, senderWallet, ruleId, probeTo, stroops(AMOUNT) + 1n)
const exact = await enforce(seed, senderWallet, ruleId, probeTo, stroops(AMOUNT))
step('boundary onchain (enforcing simulation, link key)', {
  amount_plus_one_stroop: over,
  exactly_the_amount: exact,
})

// 4. Jan opens the link in another browser, makes a Nod wallet, and her page signs the transfer.
const jan = await ownerBrowser(dir)
await jan.page.goto(link, { waitUntil: 'load' })
await jan.shot('jan-link-open')
await jan.page.locator('[data-testid="claim-name"]').fill('Jan')
await jan.page.locator('[data-testid="claim-new-wallet"]').click()
await jan.page.locator('[data-testid="claim-link-done"]').waitFor({ timeout: 180_000 })
await jan.shot('jan-received')
const paid = await call('payment_status', { payment_id: linkId })
const janWallet = at(paid.structured, 'recipient', 'address')
const janOverview: unknown = await jan.page.evaluate(() => fetch('/api/overview').then(response => response.json()))
step('Jan claimed', {
  status: at(paid.structured, 'status'),
  claim_tx: tx(at(paid.structured, 'receipt', 'tx_hash')),
  jan_wallet: `${EXPLORER}/contract/${janWallet}`,
  jan_usdc: at(janOverview, 'balances', 'usdc'),
  jan_account_status: at(janOverview, 'wallet', 'account_status'),
  jan_deploy_tx: tx(at(janOverview, 'wallet', 'deploy_tx')),
})

// 5. The same claim a second time.
const second: unknown = await jan.page.evaluate(
  id =>
    fetch(`/claim/${id}/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'wallet' }),
    }).then(async response => ({ status: response.status, body: await response.text() })),
  linkId,
)
const spent = await enforce(seed, senderWallet, ruleId, probeTo, 1n)
step('the same claim again', { nod: second, onchain_one_more_stroop: spent })

// 6. A second link, taken back from Connections.
const another = await call('payment_prepare', {
  recipient: 'new',
  recipient_name: 'Ana',
  amount: '5.50',
  idempotency_key: `person-revoke-${stamp}`,
})
await browse(
  [
    { do: 'goto', url: '{{url}}' },
    { do: 'click', selector: '[data-testid="link-approve"]', timeoutMs: 30_000 },
    { do: 'waitFor', selector: '[data-testid="link-done"]', timeoutMs: 120_000 },
  ],
  { url: at(another.structured, 'approval_url') },
)
const anotherLink = (await sender.page.locator('[data-testid="link-url"]').textContent()) ?? ''
const anotherId = at(another.structured, 'payment_id')
await sender.page.goto(`${BASE}/connections`, { waitUntil: 'load' })
const fromConnections = await sender.page
  .locator(`[data-testid="link-revoke"]`)
  .first()
  .click({ timeout: 15_000 })
  .then(() => true)
  .catch(() => false)
if (!fromConnections) await sender.page.goto(`${BASE}/approve/revoke-link/${anotherId}`, { waitUntil: 'load' })
await sender.page.waitForLoadState('load')
await senderShot('revoke-page')
await sender.page.locator('[data-testid="link-revoke-confirm"]').click({ timeout: 30_000 })
await sender.page.locator('[data-testid="link-revoked-now"]').waitFor({ timeout: 120_000 })
const removal = ((await sender.page.locator('#remove-tx-hash').textContent()) ?? '').trim()
await senderShot('revoked')
const afterRevoke: unknown = await jan.page.evaluate(
  id =>
    fetch(`/claim/${id}/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'wallet' }),
    }).then(async response => ({ status: response.status, body: await response.text() })),
  anotherId,
)
const links: unknown = await sender.page.evaluate(() => fetch('/api/links').then(response => response.json()))
const anotherInstall = Array.isArray(links)
  ? at(links.find((row: unknown) => at(row, 'id') === anotherId), 'install_tx')
  : ''
const anotherRule = await ruleIdOf(anotherInstall).catch(() => -1)
const anotherSeed = Uint8Array.from(Buffer.from(new URL(anotherLink).hash.replace(/^#k=/u, '').split('.')[0] ?? '', 'base64url'))
step('taken back', {
  via_connections: fromConnections,
  remove_tx: tx(removal),
  claim_after_revoke: afterRevoke,
  onchain_after_revoke: await enforce(anotherSeed, senderWallet, anotherRule, probeTo, 1n),
  links,
})

writeFileSync(join(dir, 'run.json'), `${JSON.stringify({ base: BASE, amount: AMOUNT, steps: log }, null, 2)}\n`)
console.log(`wrote ${join(dir, 'run.json')}`)
await client.close()
await sender.close()
await jan.close()
callback.stop()
