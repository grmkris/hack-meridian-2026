import { Effect } from 'effect'

import type { ChainError } from '@hm/protocol'
import { Address, nativeToScVal, type rpc, scValToNative, type xdr } from '@stellar/stellar-sdk'

import type { Soroban } from './soroban.ts'

/**
 * Incoming USDC for one address, read from the USDC SAC's `transfer` events with Soroban RPC `getEvents` (kept out of
 * `ChainShape`: only the wallet's Durable Object watcher uses it, for MCP Events' `payment.received`).
 *
 * Shape, checked live on testnet 2026-10-25 (spike: SAC CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA,
 * recipient CCHECHAS…SO4Q, ledgers 5383430–5383915; RPC retention ≈ 7 days):
 *   topic = [ScvSymbol "transfer", ScvAddress from (C… or G…), ScvAddress to, ScvString "USDC:GBBD47IF…LFLA5"]
 *   value = ScvI128 stroops (e.g. 20000000 = 2.00 USDC); a muxed recipient (CAP-67) gets
 *           ScvMap { amount: I128, to_muxed_id: u64 | bytes | string } instead.
 *   e.g. id "0023121655790366720-0000000001", txHash 42c8aa3b…727a, ledger 5383430.
 * The filter `[transfer, *, <to>, *]` selects the recipient by topic, so only its transfers come back.
 */

export interface IncomingTransfer {
  /** The RPC's event id (unique, ordered). */
  readonly id: string
  readonly tx: string
  readonly ledger: number
  readonly closedAt: string
  readonly from: string
  readonly to: string
  readonly amount: bigint
}

export interface TransferPage {
  readonly transfers: ReadonlyArray<IncomingTransfer>
  /** Pass back to continue after this page. */
  readonly cursor: string
  readonly latestLedger: number
}

/** The `getEvents` topic filter for USDC transfers to `to`: `[transfer, *, <to>, *]`, XDR base64. */
export const transferToFilter = (to: string): Array<string> => [
  nativeToScVal('transfer', { type: 'symbol' }).toXDR('base64'),
  '*',
  Address.fromString(to).toScVal().toXDR('base64'),
  '*',
]

const addressOf = (value: xdr.ScVal | undefined): string | undefined => {
  if (value?.switch().name !== 'scvAddress') return undefined
  return Address.fromScVal(value).toString()
}

/** i128, or `{ amount, to_muxed_id }` for a muxed recipient. */
export const transferAmount = (value: xdr.ScVal): bigint | undefined => {
  const native: unknown = scValToNative(value)
  if (typeof native === 'bigint') return native
  if (typeof native === 'object' && native !== null && 'amount' in native && typeof native.amount === 'bigint')
    return native.amount
  return undefined
}

/** One RPC event → a transfer to `to`, or undefined when it is not one (other topic, other recipient, odd value). */
export const parseTransfer = (event: rpc.Api.EventResponse, to: string): IncomingTransfer | undefined => {
  const [name, from, recipient] = event.topic
  if (name?.switch().name !== 'scvSymbol' || name.sym().toString() !== 'transfer') return undefined
  const fromAddress = addressOf(from)
  if (fromAddress === undefined || addressOf(recipient) !== to) return undefined
  const amount = transferAmount(event.value)
  if (amount === undefined || amount <= 0n) return undefined
  return {
    id: event.id,
    tx: event.txHash,
    ledger: event.ledger,
    closedAt: event.ledgerClosedAt,
    from: fromAddress,
    to,
    amount,
  }
}

/**
 * USDC transfers to `to` on the SAC `sac`, from a ledger (first call) or after a cursor (every next one), oldest
 * first, at most `limit` per page.
 */
export const transfersTo = (
  soroban: Pick<Soroban, 'read'>,
  input: {
    readonly sac: string
    readonly to: string
    readonly from: { readonly startLedger: number } | { readonly cursor: string }
    readonly limit?: number
  },
): Effect.Effect<TransferPage, ChainError> => {
  const filters: Array<rpc.Api.EventFilter> = [
    { type: 'contract', contractIds: [input.sac], topics: [transferToFilter(input.to)] },
  ]
  const limit = input.limit ?? 100
  return soroban
    .read('getEvents', server =>
      'cursor' in input.from
        ? server.getEvents({ filters, cursor: input.from.cursor, limit })
        : server.getEvents({ filters, startLedger: input.from.startLedger, limit }),
    )
    .pipe(
      Effect.map(response => ({
        transfers: response.events.flatMap(event => {
          const transfer = parseTransfer(event, input.to)
          return transfer === undefined ? [] : [transfer]
        }),
        cursor: response.cursor,
        latestLedger: response.latestLedger,
      })),
    )
}
