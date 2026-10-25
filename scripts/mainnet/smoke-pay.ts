import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ExactStellarClientScheme,
  Stellar,
  appendPaymentIdentifierToExtensions,
  createEd25519Signer,
  decodePaymentRequiredHeader,
  generatePaymentId,
  wrapFetchWithPayment,
  x402Client,
  x402HTTPClient,
} from '../../apps/seller/demo-deps.ts'
import { NET, ROOT, accountState, announce, explorerTx, flag, keypair, publicKey, rpcRead, xlm } from './lib.ts'

/**
 * M4's proof: pay the mainnet seller 0.10 USDC once from the treasury's G account with the stock x402 client; the
 * seller settles through OpenZeppelin Channels (fees sponsored: the treasury spends no XLM). The 402's terms must be
 * stellar:pubnet, the USDC SAC CCW67…, exactly 0.10 USDC and payTo = our seller, or the client aborts before signing.
 * Afterwards the settlement is read back from mainnet and the balances compared; evidence/mainnet/smoke-pay-<time>.json
 * holds public data only.
 *
 *   bun scripts/mainnet/smoke-pay.ts --dry-run      the 402 terms, the client's selection and the balances; signs nothing
 *   HM26_MAINNET_GO=yes bun scripts/mainnet/smoke-pay.ts [--url <seller origin>]
 */
const SELLER = (flag('--url') ?? 'https://hm26-seller-mainnet.kristjan-grm11775.workers.dev').replace(/\/$/u, '')
const THIRD_PARTY = 'https://stellar.org/x402-demo/api/protected/mainnet'
const PRICE = '1000000'
const payTo = publicKey('seller')
const treasury = keypair('treasury')
const paymentId = `hm26_mainnet_${generatePaymentId().replace(/^pay_/u, '')}`

interface Terms {
  readonly network: string
  readonly asset: string
  readonly amount: string
  readonly payTo: string
}
const problemsOf = (t: Terms) => [
  ...(t.network === NET.x402Network ? [] : [`network ${t.network}`]),
  ...(t.asset === NET.contracts.usdcSac ? [] : [`asset ${t.asset}`]),
  ...(t.amount === PRICE ? [] : [`amount ${t.amount}`]),
  ...(t.payTo === payTo ? [] : [`payTo ${t.payTo}`]),
]

/** The 402 a GET answers, decoded; undefined when the URL does not answer 402. */
async function quote(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  const header = response.headers.get('payment-required')
  console.log(`  GET ${url} → ${response.status}`)
  return response.status === 402 && header !== null ? decodePaymentRequiredHeader(header) : undefined
}

/** The stock client on pubnet; `check` decides, before anything is signed, whether to go on. */
function client(check: (t: Terms) => { abort: true; reason: string } | undefined) {
  const scheme = new ExactStellarClientScheme(createEd25519Signer(treasury.secret(), 'stellar:pubnet'), {
    url: NET.rpcUrl,
  })
  const c = new x402Client().register('stellar:pubnet', scheme)
  c.setSpendControls({ maxAmountPerPayment: '$0.10' })
  c.onBeforePaymentCreation(async context => {
    const verdict = check(context.selectedRequirements)
    if (verdict !== undefined) return verdict
    context.paymentRequired.extensions ??= {}
    appendPaymentIdentifierToExtensions(context.paymentRequired.extensions, paymentId)
    return undefined
  })
  return c
}

const before = { treasury: await accountState(treasury.publicKey()), seller: await accountState(payTo) }
console.log(
  `treasury ${treasury.publicKey()}: ${before.treasury.exists ? `${xlm(before.treasury.xlm)} XLM, USDC ${before.treasury.usdc === null ? 'no trustline' : xlm(before.treasury.usdc)}` : 'not funded'}`,
)
console.log(
  `seller payTo ${payTo}: ${before.seller.usdc === null ? 'no USDC trustline' : `USDC ${xlm(before.seller.usdc)}`}`,
)

const mode = announce('M4 smoke payment', [
  {
    what: `0.10 USDC to our seller ${SELLER} (OpenZeppelin Channels pays the fee)`,
    payer: 'treasury',
    xlm: 0,
    usdc: 0.1,
  },
])

if (mode === 'dry-run') {
  const ours = await quote(`${SELLER}/api/market-brief`).catch(() => undefined)
  const required = ours ?? (await quote(THIRD_PARTY))
  if (required === undefined) throw new Error('no 402 from our seller nor the third-party mainnet seller')
  if (ours === undefined)
    console.log("  our mainnet seller is not deployed yet; checking the client on Stellar.org's mainnet demo")
  let selected: Terms | undefined
  await client(t => {
    selected = t
    return { abort: true, reason: 'dry run' }
  })
    .createPaymentPayload(required)
    .catch((error: unknown) => {
      if (!(error instanceof Error && error.message.includes('dry run'))) throw error
    })
  if (selected === undefined) throw new Error('the client selected no requirement')
  const problems = problemsOf(selected)
  console.log(
    `  client selects ${selected.network} ${selected.amount} of ${selected.asset} to ${selected.payTo}; for our seller: ${problems.length === 0 ? 'terms ok' : `would abort (${problems.join(', ')})`}`,
  )
  console.log('dry run done: nothing signed')
  process.exit(0)
}

if (before.treasury.usdc === null || before.treasury.usdc < BigInt(PRICE))
  throw new Error('the treasury holds < 0.10 USDC')
if (before.seller.usdc === null) throw new Error('the seller has no USDC trustline')
const paying = client(t => {
  const problems = problemsOf(t)
  return problems.length === 0 ? undefined : { abort: true, reason: `unexpected terms: ${problems.join(', ')}` }
})
const started = performance.now()
const response = await wrapFetchWithPayment(fetch, paying)(`${SELLER}/api/market-brief`)
const body = await response.text()
const settle =
  response.headers.get('payment-response') === null
    ? null
    : new x402HTTPClient(paying).getPaymentSettleResponse(name => response.headers.get(name))
console.log(`  paid GET /api/market-brief → ${response.status} in ${Math.round(performance.now() - started)} ms`)
const hash = settle?.transaction
if (response.status !== 200 || hash === undefined || hash === '')
  throw new Error(`no settlement: ${response.status} ${body.slice(0, 300)}`)
const tx = await rpcRead('getTransaction', s => s.getTransaction(hash))
const after = { treasury: await accountState(treasury.publicKey()), seller: await accountState(payTo) }
const delta = (a: bigint | null, b: bigint | null) => (a ?? 0n) - (b ?? 0n)
const record = {
  at: new Date().toISOString(),
  network: NET.x402Network,
  seller: SELLER,
  payer: treasury.publicKey(),
  pay_to: payTo,
  payment_id: paymentId,
  settle,
  transaction: {
    hash,
    status: tx.status,
    ledger: 'ledger' in tx ? tx.ledger : null,
    fee_charged_stroops: 'resultXdr' in tx ? tx.resultXdr.feeCharged().toString() : null,
    explorer: explorerTx(hash),
  },
  usdc_delta: {
    treasury: xlm(delta(after.treasury.usdc, before.treasury.usdc)),
    seller: xlm(delta(after.seller.usdc, before.seller.usdc)),
  },
  treasury_xlm_delta: xlm(after.treasury.xlm - before.treasury.xlm),
}
const dir = join(ROOT, 'evidence/mainnet')
mkdirSync(dir, { recursive: true })
const file = join(dir, `smoke-pay-${record.at.replace(/[:.]/gu, '-')}.json`)
writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
console.log(
  `settlement ${explorerTx(hash)} (${tx.status}); USDC treasury ${record.usdc_delta.treasury}, seller ${record.usdc_delta.seller}; treasury XLM ${record.treasury_xlm_delta}`,
)
console.log(`evidence → ${file}`)
if (tx.status !== Stellar.rpc.Api.GetTransactionStatus.SUCCESS) process.exitCode = 1
