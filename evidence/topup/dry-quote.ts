/**
 * Nod's own 1Click client (apps/web/src/server/topup.ts makeLiveOneClick) against the hosted NEAR Intents API, no
 * money: the token list, then dry quotes (`dry: true`) of the tool's offers into a mainnet Stellar G that holds the USDC
 * trustline (Nod's mainnet treasury stands in for a wallet's deposit address; a dry quote moves nothing).
 *
 *   bun evidence/topup/dry-quote.ts
 *
 * Writes evidence/topup/dry-quote-<ts>.json.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Effect } from 'effect'

import { assetFor, assetsByChain, makeLiveOneClick, TOOL_CHAINS, toBaseUnits } from '../../apps/web/src/server/topup.ts'

const RECIPIENT = 'GBJOFDKUKPHIPG34NEMVINELO36TS3QVVLNTXRO3SRUPEK5CPMYBVSPI'
const REFUND = { base: '0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97', solana: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' }
const client = makeLiveOneClick((input, init) => fetch(input, init))
const started = Date.now()
const tokens = await Effect.runPromise(client.tokens)
const chains = assetsByChain(tokens)
console.log(`tokens: ${tokens.length}; offered chains: ${chains.length}`)
const offers = [
  { chain: 'base', asset: 'USDC', amount: '5', refund: REFUND.base },
  { chain: 'solana', asset: 'USDC', amount: '5', refund: REFUND.solana },
  { chain: 'base', asset: 'ETH', amount: '0.002', refund: REFUND.base },
] as const
const quotes: Array<Record<string, unknown>> = []
for (const offer of offers) {
  const token = assetFor(tokens, offer.chain, offer.asset)
  if (token === undefined) throw new Error(`${offer.asset} on ${offer.chain} is not listed`)
  const t0 = Date.now()
  const result = await Effect.runPromise(
    Effect.result(
      client.quote({
        originAsset: token.assetId,
        amount: toBaseUnits(offer.amount, token.decimals) ?? '0',
        refundTo: offer.refund,
        recipient: RECIPIENT,
        deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
        dry: true,
      }),
    ),
  )
  const entry =
    result._tag === 'Success'
      ? {
          offer,
          origin_asset: token.assetId,
          ok: true,
          amount_in: result.success.quote.amountInFormatted,
          amount_out_usdc: result.success.quote.amountOutFormatted,
          time_estimate_s: result.success.quote.timeEstimate,
          ms: Date.now() - t0,
        }
      : { offer, origin_asset: token.assetId, ok: false, error: result.failure.message, ms: Date.now() - t0 }
  quotes.push(entry)
  console.log(JSON.stringify(entry))
}
const unknown = await Effect.runPromise(Effect.result(client.status('0x0000000000000000000000000000000000000001')))
const file = join(import.meta.dir, `dry-quote-${new Date(started).toISOString().replace(/[:.]/gu, '-')}.json`)
writeFileSync(
  file,
  `${JSON.stringify(
    {
      api: 'https://1click.chaindefuser.com',
      client: 'apps/web/src/server/topup.ts makeLiveOneClick',
      recipient: RECIPIENT,
      tokens: tokens.length,
      offered: chains.map(chain => ({ chain: chain.chain, assets: chain.assets.map(asset => asset.symbol) })),
      tool_chains: Object.keys(TOOL_CHAINS),
      quotes,
      status_of_an_unknown_address: unknown._tag === 'Success' ? unknown.success : { error: unknown.failure.message },
    },
    null,
    2,
  )}\n`,
)
console.log(`wrote ${file}`)
