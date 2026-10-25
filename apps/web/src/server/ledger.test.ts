import { Effect } from 'effect'
import { describe, expect } from 'vitest'

import { it } from '@effect/vitest'
import { type Receipt, toStroops } from '@hm/protocol'

import { Ledger, type NewIntent, makeLocalLedger, remainingOf } from './ledger.ts'
import { first, sql, toGrant } from './rows.ts'
import { WALLET_ID, BOB, seedWallet } from './test/seed.ts'
import { sqliteDb } from './test/sqlite.ts'

const intent = (overrides: Partial<NewIntent> = {}): NewIntent => ({
  scope: 'con_a',
  idempotencyKey: 'key-1',
  fingerprint: 'payment|BOB|2',
  kind: 'payment',
  connectionId: 'con_a',
  grantId: 'gr_a',
  requester: 'Claude Code',
  reason: null,
  contactId: null,
  recipientName: 'Bob',
  recipientAddress: BOB,
  recipientReadiness: 'usdc_ready',
  resource: null,
  amount: toStroops('2'),
  forceOwner: false,
  claim: false,
  operationKind: 'transfer',
  pocketBalance: null,
  ...overrides,
})

const receipt = (tx: string): Receipt => ({
  tx,
  ledger: 100,
  feeStroops: 15_000_000n,
  feePayer: 'GRELAYER',
  explorer: `https://stellar.expert/explorer/testnet/tx/${tx}`,
})

const grant = first(sql("SELECT * FROM spending_grants WHERE id = 'gr_a'"), toGrant)

const withLedger = <A, E, R>(body: (ledger: Ledger['Service']) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* seedWallet()
    const ledger = yield* makeLocalLedger
    return yield* body(ledger)
  })

describe('the wallet ledger', () => {
  it.effect('prepares within the allowance in the autonomous lane, over it in the owner lane', () =>
    withLedger(ledger =>
      Effect.gen(function* () {
        const small = yield* ledger.prepareIntent(WALLET_ID, intent())
        expect(small.intent.lane).toBe('autonomous')
        expect(small.intent.status).toBe('prepared')
        expect(small.intent.fee_ceiling_xlm).toBe(20)
        const big = yield* ledger.prepareIntent(
          WALLET_ID,
          intent({ idempotencyKey: 'key-2', amount: toStroops('100'), fingerprint: 'payment|BOB|100' }),
        )
        expect(big.intent.lane).toBe('owner')
        expect(big.intent.status).toBe('awaiting_approval')
      }),
    ).pipe(Effect.provide(sqliteDb)),
  )

  it.effect('returns the same intent for the same idempotency key and refuses the key for another request', () =>
    withLedger(ledger =>
      Effect.gen(function* () {
        const a = yield* ledger.prepareIntent(WALLET_ID, intent())
        const b = yield* ledger.prepareIntent(WALLET_ID, intent())
        expect(b.intent.id).toBe(a.intent.id)
        expect(b.created).toBe(false)
        const conflict = yield* Effect.flip(
          ledger.prepareIntent(WALLET_ID, intent({ amount: toStroops('3'), fingerprint: 'payment|BOB|3' })),
        )
        expect(conflict.reason).toBe('idempotency_conflict')
      }),
    ).pipe(Effect.provide(sqliteDb)),
  )

  it.effect(
    'serializes concurrent claims: two 3 USDC payments against 5 USDC, one claims and one goes to the owner',
    () =>
      withLedger(ledger =>
        Effect.gen(function* () {
          const a = yield* ledger.prepareIntent(WALLET_ID, intent({ idempotencyKey: 'a', amount: toStroops('3') }))
          const b = yield* ledger.prepareIntent(WALLET_ID, intent({ idempotencyKey: 'b', amount: toStroops('3') }))
          const claims = yield* Effect.all(
            [
              ledger.claimAutonomous(WALLET_ID, { intentId: a.intent.id, connectionId: 'con_a' }),
              ledger.claimAutonomous(WALLET_ID, { intentId: b.intent.id, connectionId: 'con_a' }),
            ],
            { concurrency: 'unbounded' },
          )
          expect(claims.map(claim => claim._tag).toSorted()).toEqual(['Claimed', 'NotClaimed'])
          const after = yield* grant
          expect(after?.reserved).toBe(toStroops('3'))
        }),
      ).pipe(Effect.provide(sqliteDb)),
  )

  it.effect('a repeated execute after the claim never claims again (a lost response does not pay twice)', () =>
    withLedger(ledger =>
      Effect.gen(function* () {
        const { intent: prepared } = yield* ledger.prepareIntent(WALLET_ID, intent())
        const once = yield* ledger.claimAutonomous(WALLET_ID, { intentId: prepared.id, connectionId: 'con_a' })
        const again = yield* ledger.claimAutonomous(WALLET_ID, { intentId: prepared.id, connectionId: 'con_a' })
        expect(once._tag).toBe('Claimed')
        expect(again._tag).toBe('NotClaimed')
        expect(again.intent.status).toBe('submitted')
      }),
    ).pipe(Effect.provide(sqliteDb)),
  )

  it.effect('confirms: consumes the reservation, counts the spend, writes the receipt', () =>
    withLedger(ledger =>
      Effect.gen(function* () {
        const { intent: prepared } = yield* ledger.prepareIntent(WALLET_ID, intent())
        const claim = yield* ledger.claimAutonomous(WALLET_ID, { intentId: prepared.id, connectionId: 'con_a' })
        if (claim._tag !== 'Claimed') return expect.unreachable('expected a claim')
        const settled = yield* ledger.settle(WALLET_ID, {
          intentId: prepared.id,
          operationId: claim.operationId,
          outcome: {
            _tag: 'Confirmed',
            settlement: receipt('tx1'),
            feePaidBy: 'relayer',
            pull: null,
            pulled: toStroops('2'),
          },
        })
        expect(settled.status).toBe('confirmed')
        const after = yield* grant
        expect(after?.spent).toBe(toStroops('2'))
        expect(after?.reserved).toBe(0n)
        expect(after?.first_payment_done).toBe(true)
        expect(after === undefined ? 0n : remainingOf(after)).toBe(toStroops('3'))
        const next = yield* ledger.prepareIntent(WALLET_ID, intent({ idempotencyKey: 'key-9' }))
        expect(next.intent.fee_ceiling_xlm).toBe(3)
        return undefined
      }),
    ).pipe(Effect.provide(sqliteDb)),
  )

  it.effect('the policy refusing (#3221) routes the intent to the owner and releases the hold', () =>
    withLedger(ledger =>
      Effect.gen(function* () {
        const { intent: prepared } = yield* ledger.prepareIntent(WALLET_ID, intent())
        const claim = yield* ledger.claimAutonomous(WALLET_ID, { intentId: prepared.id, connectionId: 'con_a' })
        if (claim._tag !== 'Claimed') return expect.unreachable('expected a claim')
        const settled = yield* ledger.settle(WALLET_ID, {
          intentId: prepared.id,
          operationId: claim.operationId,
          outcome: { _tag: 'Failed', kind: 'limit_exhausted', message: '#3221', pull: null, pulled: 0n },
        })
        expect(settled.status).toBe('awaiting_approval')
        expect(settled.lane).toBe('owner')
        expect((yield* grant)?.reserved).toBe(0n)
        return undefined
      }),
    ).pipe(Effect.provide(sqliteDb)),
  )

  it.effect('a revoked connection cannot claim: the intent goes to the owner', () =>
    withLedger(ledger =>
      Effect.gen(function* () {
        const { intent: prepared } = yield* ledger.prepareIntent(WALLET_ID, intent())
        yield* ledger.revokeConnection(WALLET_ID, { connectionId: 'con_a' })
        const claim = yield* ledger.claimAutonomous(WALLET_ID, { intentId: prepared.id, connectionId: 'con_a' })
        expect(claim._tag).toBe('NotClaimed')
        expect((yield* grant)?.status).toBe('revoked')
        expect((yield* grant)?.rule_status).toBe('removal_pending')
      }),
    ).pipe(Effect.provide(sqliteDb)),
  )
})
