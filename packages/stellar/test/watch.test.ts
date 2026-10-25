import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'

import { Address, nativeToScVal, type rpc, xdr } from '@stellar/stellar-sdk'

import { parseTransfer, transferAmount, transfersTo, transferToFilter } from '../src/watch.ts'

/** The SAC transfer shape the testnet spike recorded (2026-10-25), parsed back; getEvents faked. */

const SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const WALLET = 'CCHECHASMG7C4QOPTD5EBSWF632JJRUZS6VABC6ADFCKPHGJH4T3SO4Q'
const PAYER = 'CA357ZQSG54XPLIZF4NTNOYUU7R3IBOKZ7UALM5WVZCT5C2GJZWD45W2'
const TREASURY = 'GB4F3NUAD2NIRNOHNB36QS7ONEPWMPVSI5IRT6NY5FMMONLGTDQ4CIU5'
const ASSET = 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

const event = (from: string, to: string, value: xdr.ScVal, id = '0023122085287067648-0000000001') =>
  ({
    id,
    type: 'contract',
    ledger: 5_383_530,
    ledgerClosedAt: '2026-10-25T15:13:20Z',
    transactionIndex: 1,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: 'fb77bd0f01aeb515b967e7bf5f7d0b1f8ec5c4c6af7889263ed3172a0a8ebefe',
    topic: [
      nativeToScVal('transfer', { type: 'symbol' }),
      Address.fromString(from).toScVal(),
      Address.fromString(to).toScVal(),
      nativeToScVal(ASSET, { type: 'string' }),
    ],
    value,
  }) satisfies rpc.Api.EventResponse

const i128 = (stroops: bigint) => nativeToScVal(stroops, { type: 'i128' })

describe('the USDC transfer watcher', () => {
  test('the topic filter is [transfer, *, <to>, *]', () => {
    const filter = transferToFilter(WALLET)
    expect(filter[0]).toBe('AAAADwAAAAh0cmFuc2Zlcg==')
    expect(filter[1]).toBe('*')
    expect(filter[2]).toBe('AAAAEgAAAAGOQRwSYb4uQc+Y+kDKxfb0lMaZl6oAi8AZRKecyT8nuQ==')
    expect(filter[3]).toBe('*')
  })

  test('an i128 transfer from a contract or an account parses; another recipient does not', () => {
    expect(parseTransfer(event(PAYER, WALLET, i128(20_000_000n)), WALLET)).toMatchObject({
      from: PAYER,
      to: WALLET,
      amount: 20_000_000n,
      ledger: 5_383_530,
      tx: 'fb77bd0f01aeb515b967e7bf5f7d0b1f8ec5c4c6af7889263ed3172a0a8ebefe',
    })
    expect(parseTransfer(event(TREASURY, WALLET, i128(100_000n)), WALLET)?.from).toBe(TREASURY)
    expect(parseTransfer(event(PAYER, WALLET, i128(1n)), PAYER)).toBeUndefined()
  })

  test('a muxed recipient carries { amount, to_muxed_id }', () => {
    const map = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: nativeToScVal('amount', { type: 'symbol' }), val: i128(5_000_000n) }),
      new xdr.ScMapEntry({
        key: nativeToScVal('to_muxed_id', { type: 'symbol' }),
        val: nativeToScVal(7n, { type: 'u64' }),
      }),
    ])
    expect(transferAmount(map)).toBe(5_000_000n)
    expect(parseTransfer(event(PAYER, WALLET, map), WALLET)?.amount).toBe(5_000_000n)
  })

  test('transfersTo asks from a ledger first, then after the cursor, and keeps only transfers to the wallet', async () => {
    const requests: Array<rpc.Api.GetEventsRequest> = []
    const server = {
      getEvents: async (request: rpc.Api.GetEventsRequest) => {
        requests.push(request)
        return {
          events: [event(PAYER, WALLET, i128(20_000_000n)), event(PAYER, PAYER, i128(1n), 'other')],
          cursor: 'c-2',
          latestLedger: 5_384_190,
          oldestLedger: 5_263_231,
          latestLedgerCloseTime: '',
          oldestLedgerCloseTime: '',
        }
      },
    }
    const soroban = {
      read: <A>(_label: string, f: (s: rpc.Server) => Promise<A>) =>
        // SAFETY: the fake implements the one rpc.Server method transfersTo calls.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        Effect.promise(() => f(server as unknown as rpc.Server)),
    }
    const first = await Effect.runPromise(
      transfersTo(soroban, { sac: SAC, to: WALLET, from: { startLedger: 5_384_000 } }),
    )
    expect(first.transfers).toHaveLength(1)
    expect(first.cursor).toBe('c-2')
    await Effect.runPromise(transfersTo(soroban, { sac: SAC, to: WALLET, from: { cursor: first.cursor } }))
    expect(requests[0]).toMatchObject({ startLedger: 5_384_000, filters: [{ type: 'contract', contractIds: [SAC] }] })
    expect(requests[1]).toMatchObject({ cursor: 'c-2' })
    expect(requests[1]).not.toHaveProperty('startLedger')
  })
})
