import { DateTime, Effect } from 'effect'

import type { WalletTopupQuoteInput } from '@hm/protocol'

import { toolError } from './tool-errors.ts'
import { scope, type ToolContext } from './tools.ts'
import {
  assetFor,
  createTopup,
  type TopupError,
  topupStatusOf,
  topupTokens,
  type TopupView,
  topupView,
} from './topup.ts'
import { grantRemaining } from './views.ts'

/**
 * wallet_topup_quote and wallet_topup_status (appended after the first twenty-one): the agent asks NEAR Intents for a
 * way to top the wallet up from another chain (topup.ts) and follows it. Nothing moves until the user sends it.
 */

const CHAIN_NAMES: Readonly<Record<string, string>> = {
  base: 'Base',
  sol: 'Solana',
  eth: 'Ethereum',
  arb: 'Arbitrum',
  pol: 'Polygon',
}
const chainName = (blockchain: string) => CHAIN_NAMES[blockchain] ?? blockchain

const toToolError = (error: TopupError) =>
  error.reason === 'topup_unavailable'
    ? toolError(
        'topup_unavailable',
        `${error.message.startsWith('topup_unavailable') ? error.message : `topup_unavailable: ${error.message}`}. Nothing was quoted; the user can still add money from an exchange or another wallet on Nod's Add money card.`,
      )
    : toolError(error.reason === 'not_found' ? 'not_found' : 'invalid_input', error.message)

const minutesLeft = (view: TopupView, nowMs: number) =>
  Math.max(0, Math.round((Date.parse(view.deadline) - nowMs) / 60_000))

export const walletTopupQuote = (ctx: ToolContext, input: WalletTopupQuoteInput) =>
  Effect.gen(function* () {
    const { connection, wallet, grant } = yield* scope(ctx, true)
    const tokens = yield* topupTokens
    const token = assetFor(tokens, input.origin_chain, input.asset)
    if (token === undefined)
      return yield* toolError(
        'invalid_input',
        `${input.asset} on ${input.origin_chain} cannot top the wallet up; use USDC or that chain's own coin.`,
      )
    const row = yield* createTopup(wallet, {
      originAsset: token.assetId,
      amount: input.amount,
      refundTo: input.refund_address,
      connectionId: connection.id,
      idempotencyKey: input.idempotency_key,
    })
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
    const view = topupView(row, nowMs)
    const sentence = `Send ${view.amount_in} ${view.asset} on ${chainName(view.origin_chain)} to ${view.pay_to} within ${minutesLeft(view, nowMs)} minutes; it arrives as about ${view.amount_out} USDC in your Nod wallet. Follow it with wallet_topup_status (id ${view.id}), or on Nod's Add money card at ${ctx.origin}/.`
    return {
      sentence,
      value: {
        ...view,
        add_money_url: `${ctx.origin}/`,
        message: sentence,
        grant_remaining: grantRemaining(grant, nowMs),
      },
    }
  }).pipe(Effect.catchTag('TopupError', error => Effect.fail(toToolError(error))))

export const walletTopupStatus = (ctx: ToolContext, id: string) =>
  Effect.gen(function* () {
    const { wallet, grant } = yield* scope(ctx, false)
    const row = yield* topupStatusOf(wallet, id)
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
    const view = topupView(row, nowMs)
    const sentence = {
      pending: `Waiting for ${view.amount_in} ${view.asset} on ${chainName(view.origin_chain)} at ${view.pay_to}, for ${minutesLeft(view, nowMs)} more minutes.`,
      processing: `NEAR Intents saw the ${view.asset} on ${chainName(view.origin_chain)} and is swapping it; about ${view.amount_out} USDC arrives in the Nod wallet shortly.`,
      arrived: `Arrived: ${row.arrived_amount ?? view.amount_out} USDC landed in the Nod wallet (sweep ${view.sweep_tx ?? ''}).`,
      failed: `NEAR Intents could not complete it; the deposit goes back to ${row.refund_to}. Nothing reached the wallet.`,
      expired:
        'Expired: no deposit arrived before the deadline, and nothing was sent. Ask for a new quote if the user still wants to top up.',
    }[view.status]
    return {
      sentence,
      value: { ...view, arrived_amount: row.arrived_amount, grant_remaining: grantRemaining(grant, nowMs) },
    }
  }).pipe(Effect.catchTag('TopupError', error => Effect.fail(toToolError(error))))
