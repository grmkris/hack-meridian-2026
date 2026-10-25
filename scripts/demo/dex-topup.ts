import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { Stellar } from '../../apps/seller/demo-deps.ts'
import { PRESETS } from '../../packages/stellar/src/network.ts'

/**
 * Tops the testnet treasury up with USDC bought on the testnet DEX, when Circle's faucet rate-limits:
 *
 *   bun scripts/demo/dex-topup.ts [--target 250] [--chunk 100] [--ceiling-factor 1.25] [--merge-into G…]
 *
 * Loop: friendbot a fresh account (10,000 XLM); buy USDC with its XLM by path payments (strict receive) straight to
 * the treasury, `--chunk` USDC each, never above `--ceiling-factor` × the mid price (the XLM/USDC pool's reserve ratio,
 * or the best ask without a pool), so junk orders far up the book are never swept; merge the account's leftover XLM
 * into a relayer (default: the public testnet stage's first relayer). Stops at `--target` USDC on the treasury, or
 * when the book has nothing at or under the ceiling. Testnet only: it refuses any other network. No secret is read;
 * the throwaway accounts' keys live only in this process. Receipt: evidence/probe/dex-topup-<ts>.json.
 */

const NET = PRESETS.testnet
if (process.argv.includes('--network') && process.argv[process.argv.indexOf('--network') + 1] !== 'testnet') {
  console.error('dex-topup is testnet only: friendbot and the testnet DEX')
  process.exit(2)
}
const arg = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name)
  return index > 0 ? (process.argv[index + 1] ?? fallback) : fallback
}
const TREASURY = 'GB4F3NUAD2NIRNOHNB36QS7ONEPWMPVSI5IRT6NY5FMMONLGTDQ4CIU5'
const TARGET = Number(arg('--target', '250'))
const CHUNK = Number(arg('--chunk', '100'))
const CEILING_FACTOR = Number(arg('--ceiling-factor', '1.25'))
const HORIZON = 'https://horizon-testnet.stellar.org'
const EXPLORER = 'https://stellar.expert/explorer/testnet'
const USDC = new Stellar.Asset('USDC', NET.usdcIssuer)
const horizon = new Stellar.Horizon.Server(HORIZON)
/** XLM kept on a throwaway account for its reserve and fees until it is merged. */
const KEEP_XLM = 5

const getJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} → ${response.status}`)
  return response.json()
}
const field = (value: unknown, ...path: ReadonlyArray<string | number>): unknown => {
  let current: unknown = value
  for (const key of path)
    current = typeof current === 'object' && current !== null ? Reflect.get(current, key) : undefined
  return current
}
const text = (value: unknown, ...path: ReadonlyArray<string | number>): string => {
  const found = field(value, ...path)
  return typeof found === 'string' || typeof found === 'number' ? String(found) : ''
}
const list = (value: unknown, ...path: ReadonlyArray<string | number>): ReadonlyArray<unknown> => {
  const found = field(value, ...path)
  return Array.isArray(found) ? found : []
}

const usdcOf = async (address: string) => {
  const account = await getJson(`${HORIZON}/accounts/${address}`)
  const line = list(account, 'balances').find(
    b => text(b, 'asset_code') === 'USDC' && text(b, 'asset_issuer') === NET.usdcIssuer,
  )
  return Number(text(line, 'balance') || '0')
}
const xlmOf = async (address: string) => {
  const account = await getJson(`${HORIZON}/accounts/${address}`)
  return Number(
    text(
      list(account, 'balances').find(b => text(b, 'asset_type') === 'native'),
      'balance',
    ) || '0',
  )
}

/** The liquidity on offer: the XLM/USDC pool's reserves (its ratio is the mid) and the asks on the order book. */
const market = async () => {
  const pools = await getJson(`${HORIZON}/liquidity_pools?reserves=native,USDC:${NET.usdcIssuer}&limit=10`)
  const pool = list(pools, '_embedded', 'records')[0]
  const reserves = list(pool, 'reserves')
  const xlm = Number(
    text(
      reserves.find(r => text(r, 'asset') === 'native'),
      'amount',
    ) || '0',
  )
  const usdc = Number(
    text(
      reserves.find(r => text(r, 'asset') !== 'native'),
      'amount',
    ) || '0',
  )
  const book = await getJson(
    `${HORIZON}/order_book?selling_asset_type=credit_alphanum4&selling_asset_code=USDC&selling_asset_issuer=${NET.usdcIssuer}&buying_asset_type=native&limit=200`,
  )
  const asks = list(book, 'asks').map(a => ({ price: Number(text(a, 'price')), amount: Number(text(a, 'amount')) }))
  const bestAsk = asks[0]?.price ?? Number.POSITIVE_INFINITY
  const mid = xlm > 0 && usdc > 0 ? xlm / usdc : bestAsk
  return { pool: { id: text(pool, 'id'), xlm, usdc, fee_bp: text(pool, 'fee_bp') }, asks, mid }
}

/** What `amount` USDC costs in XLM right now (Horizon's best strict-receive path), or undefined when none. */
const quote = async (amount: string) => {
  const paths = await getJson(
    `${HORIZON}/paths/strict-receive?source_assets=native&destination_asset_type=credit_alphanum4&destination_asset_code=USDC&destination_asset_issuer=${NET.usdcIssuer}&destination_amount=${amount}`,
  )
  const costs = list(paths, '_embedded', 'records').map(r => Number(text(r, 'source_amount')))
  return costs.length === 0 ? undefined : Math.min(...costs)
}

const submit = async (source: Stellar.Keypair, operation: Stellar.xdr.Operation) => {
  const account = await horizon.loadAccount(source.publicKey())
  const tx = new Stellar.TransactionBuilder(account, { fee: '1000', networkPassphrase: NET.passphrase })
    .addOperation(operation)
    .setTimeout(120)
    .build()
  tx.sign(source)
  return (await horizon.submitTransaction(tx)).hash
}

const mergeInto =
  arg('--merge-into', '') ||
  text(await getJson('https://testnet.trynod.si/api/health'), 'chain', 'relayers', 0, 'address')
const started = new Date()
const before = await usdcOf(TREASURY)
const opening = await market()
const ceiling = opening.mid * CEILING_FACTOR
console.log(
  `treasury ${TREASURY}: ${before.toFixed(2)} USDC; target ${TARGET}. Pool ${opening.pool.xlm.toFixed(0)} XLM / ${opening.pool.usdc.toFixed(0)} USDC, mid ${opening.mid.toFixed(4)} XLM per USDC, ceiling ${ceiling.toFixed(4)}; ${opening.asks.length} asks on the book from ${opening.asks[0]?.price ?? '-'}`,
)
const buys: Array<Record<string, unknown>> = []
const merges: Array<Record<string, unknown>> = []
let stop = ''
let treasury = before
while (stop === '') {
  if (treasury >= TARGET) {
    stop = 'target reached'
    break
  }
  const account = Stellar.Keypair.random()
  const funded = await fetch(`https://friendbot.stellar.org/?addr=${account.publicKey()}`)
  if (!funded.ok) {
    stop = `friendbot answered ${funded.status}`
    break
  }
  for (;;) {
    if (treasury >= TARGET) break
    const need = Math.min(CHUNK, Math.ceil((TARGET - treasury) * 1e7) / 1e7)
    const amount = need.toFixed(7)
    const cost = await quote(amount)
    if (cost === undefined) {
      stop = 'no path: the book ran dry'
      break
    }
    const price = cost / need
    if (price > ceiling) {
      stop = `the next ${amount} USDC costs ${price.toFixed(4)} XLM each, above the ceiling ${ceiling.toFixed(4)}`
      break
    }
    const spendable = (await xlmOf(account.publicKey())) - KEEP_XLM
    const sendMax = Math.min(need * ceiling, spendable)
    if (sendMax < cost) break
    const hash = await submit(
      account,
      Stellar.Operation.pathPaymentStrictReceive({
        sendAsset: Stellar.Asset.native(),
        sendMax: sendMax.toFixed(7),
        destination: TREASURY,
        destAsset: USDC,
        destAmount: amount,
        path: [],
      }),
    )
    treasury = await usdcOf(TREASURY)
    buys.push({
      account: account.publicKey(),
      usdc: amount,
      xlm_quoted: cost.toFixed(7),
      price: price.toFixed(4),
      tx: hash,
    })
    console.log(
      `bought ${amount} USDC at ${price.toFixed(4)} XLM each → treasury ${treasury.toFixed(2)} USDC  ${EXPLORER}/tx/${hash}`,
    )
  }
  const left = await xlmOf(account.publicKey())
  if (mergeInto !== '') {
    const hash = await submit(account, Stellar.Operation.accountMerge({ destination: mergeInto }))
    merges.push({ account: account.publicKey(), xlm: left.toFixed(7), into: mergeInto, tx: hash })
    console.log(`merged ${left.toFixed(2)} XLM into ${mergeInto}  ${EXPLORER}/tx/${hash}`)
  }
}
const closing = await market()
const receipt = {
  started_at: started.toISOString(),
  network: 'stellar:testnet',
  treasury: TREASURY,
  treasury_usdc_before: before.toFixed(7),
  treasury_usdc_after: treasury.toFixed(7),
  target: TARGET,
  mid_xlm_per_usdc: opening.mid,
  ceiling_xlm_per_usdc: ceiling,
  stop,
  liquidity: { before: { pool: opening.pool, asks: opening.asks }, after: { pool: closing.pool } },
  buys,
  merges,
}
const dir = resolve(import.meta.dir, '../../evidence/probe')
mkdirSync(dir, { recursive: true })
const file = join(dir, `dex-topup-${started.toISOString().replace(/[:.]/gu, '-')}.json`)
writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`)
console.log(`${stop}. Treasury ${before.toFixed(2)} → ${treasury.toFixed(2)} USDC. Receipt ${file}`)
