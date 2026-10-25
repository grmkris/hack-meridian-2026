import { Effect, Schema } from 'effect'
import { describe, expect } from 'vitest'

import { it } from '@effect/vitest'
import { type Receipt, toStroops } from '@hm/protocol'

import { Ledger, type NewIntent, makeLocalLedger, remainingOf } from './ledger.ts'
import { first, insert, query, sql, toGrant, write } from './rows.ts'
import { createConnection } from './store.ts'
import { WALLET_ID, BOB, ALICE, CONTRACT_ID, OWNER_ID, seedWallet } from './test/seed.ts'
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

/** The journal rows of a wallet, oldest first. */
const journal = (walletId = WALLET_ID) =>
  query(sql('SELECT event_id, name, data FROM event_journal WHERE wallet_id = ? ORDER BY seq', walletId), row =>
    Effect.succeed({
      id: String(row['event_id']),
      name: String(row['name']),
      data: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(JSON.parse(String(row['data']))),
    }),
  )

const confirm = (ledger: Ledger['Service'], intentId: string, tx: string, pulled: bigint) =>
  Effect.gen(function* () {
    const claim = yield* ledger.claimAutonomous(WALLET_ID, { intentId, connectionId: 'con_a' })
    if (claim._tag !== 'Claimed') return yield* Effect.die(new Error('expected a claim'))
    return yield* ledger.settle(WALLET_ID, {
      intentId,
      operationId: claim.operationId,
      outcome: { _tag: 'Confirmed', settlement: receipt(tx), feePaidBy: 'relayer', pull: null, pulled },
    })
  })

describe('the event journal, written in the same batch as the state it reports', () => {
  it.effect('an intent that waits for the owner journals approval.needed once; one inside the allowance does not', () =>
    withLedger(ledger =>
      Effect.gen(function* () {
        yield* ledger.prepareIntent(WALLET_ID, intent())
        expect(yield* journal()).toEqual([])
        const big = yield* ledger.prepareIntent(
          WALLET_ID,
          intent({
            idempotencyKey: 'key-2',
            amount: toStroops('100'),
            fingerprint: 'payment|BOB|100',
            reason: 'AI text',
          }),
        )
        yield* ledger.prepareIntent(
          WALLET_ID,
          intent({
            idempotencyKey: 'key-2',
            amount: toStroops('100'),
            fingerprint: 'payment|BOB|100',
            reason: 'AI text',
          }),
        )
        const rows = yield* journal()
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          id: `approval.needed:${big.intent.id}`,
          name: 'approval.needed',
          data: {
            title: 'Needs your nod: 100.00 USDC to Bob',
            url: `/approve/${big.intent.id}`,
            network: 'stellar:testnet',
            wallet_id: WALLET_ID,
            payment_id: big.intent.id,
            amount: '100.00',
            counterparty: { address: BOB, contact_name: 'Bob' },
            expires_at: big.intent.expires_at,
          },
        })
        expect(JSON.stringify(rows)).not.toContain('AI text')
      }),
    ).pipe(Effect.provide(sqliteDb)),
  )

  it.effect('a confirmed payment journals payment.settled, and allowance.changed once less than a fifth is left', () =>
    withLedger(ledger =>
      Effect.gen(function* () {
        const first2 = yield* ledger.prepareIntent(WALLET_ID, intent())
        yield* confirm(ledger, first2.intent.id, 'tx1', toStroops('2'))
        expect((yield* journal()).map(row => row.id)).toEqual([`payment.settled:${first2.intent.id}:confirmed`])
        expect((yield* journal())[0]?.data).toMatchObject({
          title: 'Paid 2.00 USDC to Bob',
          status: 'confirmed',
          tx: 'tx1',
          explorer: 'https://stellar.expert/explorer/testnet/tx/tx1',
          url: 'https://stellar.expert/explorer/testnet/tx/tx1',
        })
        const second = yield* ledger.prepareIntent(
          WALLET_ID,
          intent({ idempotencyKey: 'key-3', amount: toStroops('2.5'), fingerprint: 'payment|BOB|2.5' }),
        )
        yield* confirm(ledger, second.intent.id, 'tx2', toStroops('2.5'))
        const rows = yield* journal()
        expect(rows.map(row => row.name)).toEqual(['payment.settled', 'payment.settled', 'allowance.changed'])
        expect(rows[2]).toMatchObject({
          id: 'allowance.changed:low:gr_a',
          data: { change: 'low', allowance: '5.00', remaining: '0.50', connection_id: 'con_a', url: '/connections' },
        })
      }),
    ).pipe(Effect.provide(sqliteDb)),
  )

  it.effect(
    "paying another Nod wallet journals that wallet's payment.received, named as its owner saved the payer",
    () =>
      withLedger(ledger =>
        Effect.gen(function* () {
          const at = '2026-10-25T12:00:00.000Z'
          yield* write(
            insert('owners', { id: 'own_alice', created_at: at }),
            insert('wallets', {
              id: 'wal_alice',
              owner_id: 'own_alice',
              name: 'Alice private wallet name',
              contract_id: ALICE,
              passkey_credential_id: 'cred-alice',
              passkey_public_key: 'pub',
              network: 'stellar:testnet',
              deploy_tx: null,
              fund_tx: null,
              created_at: at,
            }),
            insert('contacts', {
              id: 'ct_payer',
              owner_id: 'own_alice',
              display_name: 'Kris',
              aliases: '[]',
              created_at: at,
            }),
            insert('contact_destinations', {
              id: 'cd_payer',
              contact_id: 'ct_payer',
              address: CONTRACT_ID,
              network: 'stellar:testnet',
              memo: null,
              readiness: 'usdc_ready',
              verified_at: null,
              last_paid_at: null,
              created_at: at,
            }),
          )
          const paid = yield* ledger.prepareIntent(
            WALLET_ID,
            intent({ recipientAddress: ALICE, recipientName: 'Alice', fingerprint: 'payment|ALICE|2' }),
          )
          yield* confirm(ledger, paid.intent.id, 'tx-nod', toStroops('2'))
          const received = yield* journal('wal_alice')
          expect(received).toEqual([
            {
              id: 'payment.received:tx-nod:wal_alice',
              name: 'payment.received',
              data: expect.objectContaining({
                title: 'Received 2.00 USDC from Kris',
                amount: '2.00',
                counterparty: { address: CONTRACT_ID, contact_name: 'Kris' },
                tx: 'tx-nod',
                wallet_id: 'wal_alice',
              }),
            },
          ])
          expect(JSON.stringify(received)).not.toContain('Personal')
        }),
      ).pipe(Effect.provide(sqliteDb)),
  )

  it.effect('the policy refusing journals approval.needed; any other failure journals payment.settled failed', () =>
    withLedger(ledger =>
      Effect.gen(function* () {
        const refused = yield* ledger.prepareIntent(WALLET_ID, intent())
        const claim = yield* ledger.claimAutonomous(WALLET_ID, { intentId: refused.intent.id, connectionId: 'con_a' })
        if (claim._tag !== 'Claimed') return expect.unreachable('expected a claim')
        yield* ledger.settle(WALLET_ID, {
          intentId: refused.intent.id,
          operationId: claim.operationId,
          outcome: { _tag: 'Failed', kind: 'limit_exhausted', message: '#3221', pull: null, pulled: 0n },
        })
        const failed = yield* ledger.prepareIntent(
          WALLET_ID,
          intent({ idempotencyKey: 'key-f', fingerprint: 'payment|BOB|2|f' }),
        )
        const claim2 = yield* ledger.claimAutonomous(WALLET_ID, { intentId: failed.intent.id, connectionId: 'con_a' })
        if (claim2._tag !== 'Claimed') return expect.unreachable('expected a claim')
        yield* ledger.settle(WALLET_ID, {
          intentId: failed.intent.id,
          operationId: claim2.operationId,
          outcome: { _tag: 'Failed', kind: 'simulation_failed', message: 'boom', pull: null, pulled: 0n },
        })
        const rows = yield* journal()
        expect(rows.map(row => row.id)).toEqual([
          `approval.needed:${refused.intent.id}`,
          `payment.settled:${failed.intent.id}:failed`,
        ])
        expect(rows[1]?.data).toMatchObject({ status: 'failed', tx: null, explorer: null, url: '/receipts' })
        return undefined
      }),
    ).pipe(Effect.provide(sqliteDb)),
  )

  it.effect('revoke journals allowance.changed and ends the connection subscriptions in the same batch', () =>
    withLedger(ledger =>
      Effect.gen(function* () {
        yield* write(
          sql(
            `INSERT INTO event_subscriptions (id, connection_id, wallet_id, name, arguments, url, origin, sealed_secret,
               state, cursor, expires_at, created_at, updated_at)
             VALUES ('sub_x', 'con_a', ?, 'payment.received', '{}', 'https://hooks.example.com/x', 'https://wallet.test',
               'ev1.x', 'active', 0, 9999999999999, 0, 0)`,
            WALLET_ID,
          ),
        )
        yield* ledger.revokeConnection(WALLET_ID, { connectionId: 'con_a' })
        expect(yield* journal()).toEqual([
          {
            id: 'allowance.changed:revoked:gr_a',
            name: 'allowance.changed',
            data: expect.objectContaining({ change: 'revoked', allowance: '5.00', remaining: '0.00' }),
          },
        ])
        const state = yield* first(sql("SELECT state FROM event_subscriptions WHERE id = 'sub_x'"), row =>
          Effect.succeed(String(row['state'])),
        )
        expect(state).toBe('terminating')
      }),
    ).pipe(Effect.provide(sqliteDb)),
  )

  it.effect('consent installing an allowance journals allowance.changed installed', () =>
    Effect.gen(function* () {
      yield* seedWallet()
      yield* createConnection({
        connectionId: 'con_new',
        grantId: 'gr_new',
        ownerId: OWNER_ID,
        walletId: WALLET_ID,
        clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
        clientName: 'Claude Code',
        clientDomain: 'claude.ai',
        oauthGrantId: 'con_new',
        pending: {
          id: 'pg_1',
          owner_id: OWNER_ID,
          wallet_id: WALLET_ID,
          signer_public_key: 'GSIGNER2',
          signer_key_ref: 'fixture:GSIGNER2',
          total: toStroops('10'),
          valid_until: '2099-01-01T00:00:00.000Z',
          lifetime_seconds: 86_400,
          prepared: '{}',
        },
        ruleId: 2,
        validUntilLedger: 9_999_999,
        installTx: 'tx-install-2',
        pocketAddress: null,
      })
      expect(yield* journal()).toEqual([
        {
          id: 'allowance.changed:installed:gr_new',
          name: 'allowance.changed',
          data: expect.objectContaining({
            title: 'Allowance of 10.00 USDC installed',
            change: 'installed',
            allowance: '10.00',
            remaining: '10.00',
            connection_id: 'con_new',
          }),
        },
      ])
    }).pipe(Effect.provide(sqliteDb)),
  )
})
