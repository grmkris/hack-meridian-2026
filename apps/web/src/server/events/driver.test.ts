import { Effect, Option } from 'effect'
import { describe, expect, test } from 'vitest'

import { it } from '@effect/vitest'

import { query, sql, write } from '../rows.ts'
import { CONTRACT_ID, SIGNER, WALLET_ID, seedWallet } from '../test/seed.ts'
import { sqliteDb } from '../test/sqlite.ts'
import { EventEgress } from './delivery.ts'
import { type DriverInput, driveWallet, EventsWake, type WakeStorage, WATCH_INTERVAL_MS } from './driver.ts'
import { approvalNeeded, paymentSettled } from './emit.ts'
import { journalStatement } from './journal.ts'
import type { EventEnvelope } from './schemas.ts'
import { sealEventSecret } from './secrets.ts'
import { verifyEventWebhook } from './webhooks.ts'

/**
 * The delivery driver on SQLite with a fake subscriber that checks every request the way Goblin's webhook route does
 * (headers, ±5 min timestamp, signature, 256 KiB), and the scheduler around it.
 */

const HOOK = 'https://hooks.example.com/mcp-events/ws/con/token'
const SECRET = `whsec_${btoa('0123456789abcdef0123456789abcdef')}`
const TREASURY = 'GB4F3NUAD2NIRNOHNB36QS7ONEPWMPVSI5IRT6NY5FMMONLGTDQ4CIU5'

interface Delivery {
  readonly envelope: EventEnvelope
  readonly id: string
  readonly subscription: string
}

const subscriber = (statuses: ReadonlyArray<number> = []) => {
  const received: Array<Delivery> = []
  let call = 0
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    expect(url).toBe(HOOK)
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('manual')
    const headers = new Headers(init.headers)
    const body = new Uint8Array(await new Response(init.body).arrayBuffer())
    expect(body.byteLength).toBeLessThanOrEqual(262_144)
    expect(headers.get('content-type')).toBe('application/json')
    const envelope = await verifyEventWebhook(body, headers, { current: SECRET }, Math.floor(Date.now() / 1000))
    received.push({
      envelope,
      id: headers.get('webhook-id') ?? '',
      subscription: headers.get('x-mcp-subscription-id') ?? '',
    })
    const status = statuses[call] ?? 204
    call += 1
    return new Response(null, { status })
  }
  return { received, egress: { fetch } }
}

const subscribe = (
  id: string,
  name: string,
  options: {
    readonly args?: string
    readonly state?: string
    readonly expiresAt?: number
    readonly attempts?: number
  } = {},
) =>
  Effect.gen(function* () {
    const sealed = yield* sealEventSecret(Option.none(), SECRET, id)
    yield* write(
      sql(
        `INSERT INTO event_subscriptions (id, connection_id, wallet_id, name, arguments, url, origin, sealed_secret,
           state, cursor, attempts, failed_since, expires_at, created_at, updated_at)
         VALUES (?, 'con_a', ?, ?, ?, ?, 'https://wallet.test', ?, ?, 0, ?, ?, ?, 0, 0)`,
        id,
        WALLET_ID,
        name,
        options.args ?? '{}',
        HOOK,
        sealed,
        options.state ?? 'active',
        options.attempts ?? 0,
        (options.attempts ?? 0) > 0 ? Date.now() - 60_000 : null,
        options.expiresAt ?? Date.now() + 3_600_000,
      ),
    )
  })

const needNod = (paymentId: string) =>
  write(
    journalStatement(
      approvalNeeded({
        walletId: WALLET_ID,
        network: 'stellar:testnet',
        paymentId,
        purchase: false,
        amount: 250_000_000n,
        to: { address: CONTRACT_ID, contact_name: 'Bob' },
        expiresAt: '2099-01-01T00:00:00.000Z',
        occurredAt: new Date().toISOString(),
      }),
    ),
  )

const settled = (paymentId: string) =>
  write(
    journalStatement(
      paymentSettled({
        walletId: WALLET_ID,
        network: 'stellar:testnet',
        paymentId,
        status: 'confirmed',
        amount: 20_000_000n,
        to: { address: CONTRACT_ID, contact_name: null },
        tx: `tx-${paymentId}`,
        explorer: `https://stellar.expert/explorer/testnet/tx/tx-${paymentId}`,
        occurredAt: new Date().toISOString(),
      }),
    ),
  )

const input = (overrides: Partial<DriverInput> = {}): DriverInput => ({
  walletId: WALLET_ID,
  vaultKey: Option.none(),
  local: false,
  watch: undefined,
  watchCursor: null,
  pruneDue: false,
  ...overrides,
})

const subscription = (id: string) =>
  Effect.map(
    query(sql('SELECT state, cursor, attempts, next_attempt_at FROM event_subscriptions WHERE id = ?', id), row =>
      Effect.succeed({
        state: String(row['state']),
        cursor: Number(row['cursor']),
        attempts: Number(row['attempts']),
        nextAttemptAt: row['next_attempt_at'] === null ? null : Number(row['next_attempt_at']),
      }),
    ),
    rows => rows[0],
  )

const maxSeq = Effect.map(
  query(sql('SELECT MAX(seq) AS seq FROM event_journal'), row => Effect.succeed(Number(row['seq']))),
  rows => rows[0] ?? 0,
)

describe('the events driver', () => {
  it.live('delivers the journal in order, signed, with the headers Goblin checks, and advances the cursor', () =>
    Effect.gen(function* () {
      yield* seedWallet()
      yield* subscribe('sub_order', 'approval.needed')
      yield* needNod('pi_1')
      yield* settled('pi_x')
      yield* needNod('pi_2')
      const { received, egress } = subscriber()
      const result = yield* driveWallet(input()).pipe(Effect.provideService(EventEgress, egress))
      expect(result.nextAt).toBeNull()
      expect(received.map(delivery => delivery.id)).toEqual(['approval.needed:pi_1', 'approval.needed:pi_2'])
      expect(received.every(delivery => delivery.subscription === 'sub_order')).toBe(true)
      expect(received[0]?.envelope).toMatchObject({
        eventId: 'approval.needed:pi_1',
        name: 'approval.needed',
        data: { url: 'https://wallet.test/approve/pi_1', title: 'Needs your nod: 25.00 USDC to Bob' },
      })
      expect((yield* subscription('sub_order'))?.cursor).toBe(yield* maxSeq)
      const again = subscriber()
      yield* driveWallet(input()).pipe(Effect.provideService(EventEgress, again.egress))
      expect(again.received).toEqual([])
    }).pipe(Effect.provide(sqliteDb)),
  )

  it.live('passes rows its arguments do not match without sending them', () =>
    Effect.gen(function* () {
      yield* seedWallet()
      yield* subscribe('sub_one', 'payment.settled', { args: '{"payment_id":"pi_b"}' })
      yield* settled('pi_a')
      yield* settled('pi_b')
      yield* settled('pi_c')
      const { received, egress } = subscriber()
      yield* driveWallet(input()).pipe(Effect.provideService(EventEgress, egress))
      expect(received.map(delivery => delivery.id)).toEqual(['payment.settled:pi_b:confirmed'])
      expect((yield* subscription('sub_one'))?.cursor).toBe(yield* maxSeq)
    }).pipe(Effect.provide(sqliteDb)),
  )

  it.live('a failing endpoint backs off (15 s ± 25 %), keeps the event, and gets it on the next run', () =>
    Effect.gen(function* () {
      yield* seedWallet()
      yield* subscribe('sub_down', 'approval.needed')
      yield* needNod('pi_1')
      const down = subscriber([503])
      const before = Date.now()
      const first = yield* driveWallet(input()).pipe(Effect.provideService(EventEgress, down.egress))
      expect(down.received).toHaveLength(1)
      const row = yield* subscription('sub_down')
      expect(row).toMatchObject({ cursor: 0, attempts: 1, state: 'active' })
      expect(row?.nextAttemptAt).toBe(first.nextAt)
      expect(first.nextAt).toBeGreaterThanOrEqual(before + 11_250)
      expect(first.nextAt).toBeLessThanOrEqual(Date.now() + 18_750)
      const early = subscriber()
      expect((yield* driveWallet(input()).pipe(Effect.provideService(EventEgress, early.egress))).nextAt).toBe(
        first.nextAt,
      )
      expect(early.received).toEqual([])
      yield* write(sql("UPDATE event_subscriptions SET next_attempt_at = 1 WHERE id = 'sub_down'"))
      const up = subscriber()
      yield* driveWallet(input()).pipe(Effect.provideService(EventEgress, up.egress))
      expect(up.received.map(delivery => delivery.id)).toEqual(['approval.needed:pi_1'])
      expect(yield* subscription('sub_down')).toMatchObject({ attempts: 0, nextAttemptAt: null })
    }).pipe(Effect.provide(sqliteDb)),
  )

  it.live(
    'after the fifth failure (or a 410) it is abandoned: a gap says where to poll from, the backlog is passed',
    () =>
      Effect.gen(function* () {
        yield* seedWallet()
        yield* subscribe('sub_gap', 'approval.needed', { attempts: 4 })
        yield* needNod('pi_1')
        yield* needNod('pi_2')
        const { received, egress } = subscriber([500, 204])
        const result = yield* driveWallet(input()).pipe(Effect.provideService(EventEgress, egress))
        expect(result.nextAt).toBeNull()
        expect(received.map(delivery => delivery.envelope)).toEqual([
          expect.objectContaining({ eventId: 'approval.needed:pi_1' }),
          { type: 'gap', cursor: '0000000000000000' },
        ])
        expect(received[1]?.id).toMatch(/^msg_gap_/u)
        expect(yield* subscription('sub_gap')).toMatchObject({ cursor: yield* maxSeq, attempts: 0 })
      }).pipe(Effect.provide(sqliteDb)),
  )

  it.live('a revoked connection gets terminated (-32012); a lapsed lease ends quietly', () =>
    Effect.gen(function* () {
      yield* seedWallet()
      yield* subscribe('sub_revoked', 'approval.needed', { state: 'terminating' })
      yield* subscribe('sub_lapsed', 'payment.settled', { expiresAt: Date.now() - 1 })
      yield* needNod('pi_1')
      yield* settled('pi_1')
      const { received, egress } = subscriber()
      yield* driveWallet(input()).pipe(Effect.provideService(EventEgress, egress))
      expect(received).toHaveLength(1)
      expect(received[0]?.id).toMatch(/^msg_terminated_/u)
      expect(received[0]?.envelope).toMatchObject({ type: 'terminated', error: { code: -32012 } })
      expect((yield* subscription('sub_revoked'))?.state).toBe('terminated')
      expect((yield* subscription('sub_lapsed'))?.state).toBe('terminated')
    }).pipe(Effect.provide(sqliteDb)),
  )

  it.live(
    'the watcher journals transfers to the wallet (not pocket sweeps) and delivers them; looks again in 10 s',
    () =>
      Effect.gen(function* () {
        yield* seedWallet()
        yield* subscribe('sub_money', 'payment.received', { args: '{"min_amount":"0.50"}' })
        const asked: Array<string | null> = []
        const watch = {
          transfers: (to: string, cursor: string | null) => {
            expect(to).toBe(CONTRACT_ID)
            asked.push(cursor)
            return Effect.succeed({
              transfers: [
                {
                  id: 'e1',
                  tx: 'tx-treasury',
                  ledger: 5,
                  closedAt: '2026-10-25T15:13:20Z',
                  from: TREASURY,
                  to,
                  amount: 10_000_000n,
                },
                {
                  id: 'e2',
                  tx: 'tx-sweep',
                  ledger: 5,
                  closedAt: '2026-10-25T15:13:20Z',
                  from: SIGNER,
                  to,
                  amount: 30_000_000n,
                },
                {
                  id: 'e3',
                  tx: 'tx-dust',
                  ledger: 6,
                  closedAt: '2026-10-25T15:13:25Z',
                  from: TREASURY,
                  to,
                  amount: 1_000n,
                },
              ],
              cursor: 'rpc-cursor-1',
            })
          },
          explorerTx: (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`,
        }
        const { received, egress } = subscriber()
        const before = Date.now()
        const result = yield* driveWallet(input({ watch, watchCursor: 'rpc-cursor-0' })).pipe(
          Effect.provideService(EventEgress, egress),
        )
        expect(asked).toEqual(['rpc-cursor-0'])
        expect(result.watchCursor).toBe('rpc-cursor-1')
        expect(result.nextAt).toBeGreaterThanOrEqual(before + WATCH_INTERVAL_MS)
        const journal = yield* query(sql('SELECT event_id FROM event_journal ORDER BY seq'), row =>
          Effect.succeed(String(row['event_id'])),
        )
        expect(journal).toEqual([`payment.received:tx-treasury:${WALLET_ID}`, `payment.received:tx-dust:${WALLET_ID}`])
        expect(received.map(delivery => delivery.envelope)).toEqual([
          expect.objectContaining({
            eventId: `payment.received:tx-treasury:${WALLET_ID}`,
            timestamp: '2026-10-25T15:13:20.000Z',
            data: expect.objectContaining({
              title: 'Received 1.00 USDC from GB4F…CIU5',
              amount: '1.00',
              counterparty: { address: TREASURY, contact_name: null },
              url: 'https://stellar.expert/explorer/testnet/tx/tx-treasury',
            }),
          }),
        ])
      }).pipe(Effect.provide(sqliteDb)),
  )

  it.live('without payment.received listeners the watcher is idle and forgets its cursor', () =>
    Effect.gen(function* () {
      yield* seedWallet()
      const watch = {
        transfers: () => Effect.die(new Error('the watcher should not run')),
        explorerTx: (hash: string) => hash,
      }
      const result = yield* driveWallet(input({ watch, watchCursor: 'old' }))
      expect(result).toEqual({ nextAt: null, watchCursor: null })
    }).pipe(Effect.provide(sqliteDb)),
  )
})

/** An in-memory Durable Object storage with an alarm. */
const memoryStorage = () => {
  const values = new Map<string, unknown>()
  const state = { alarm: null as number | null, sets: 0 }
  const storage: WakeStorage = {
    getAlarm: async () => state.alarm,
    setAlarm: async at => {
      state.alarm = at
      state.sets += 1
    },
    get: async key => values.get(key),
    put: async (key, value) => {
      values.set(key, value)
    },
  }
  return { storage, state, values }
}

describe('the events scheduler', () => {
  test('a poke remembers the wallet and arms the alarm now, never later than one already set', async () => {
    const { storage, state, values } = memoryStorage()
    let now = 1_000
    const wake = new EventsWake(storage, () => now)
    await wake.poke('wal_a')
    expect(values.get('events:wallet')).toBe('wal_a')
    expect(state.alarm).toBe(1_000)
    now = 2_000
    await wake.poke('wal_a')
    expect(state.alarm).toBe(1_000)
  })

  test('a poke during a run makes it go round again; the asked-for time is armed after', async () => {
    const { storage, state } = memoryStorage()
    const wake = new EventsWake(storage, () => 5_000)
    await wake.poke('wal_a')
    state.alarm = null
    const runs: Array<string> = []
    await wake.run(async run => {
      runs.push(run.walletId)
      if (runs.length === 1) await wake.poke('wal_a')
      return { nextAt: runs.length === 1 ? null : 15_000, watchCursor: 'c' }
    })
    expect(runs).toEqual(['wal_a', 'wal_a'])
    expect(state.alarm).toBe(5_000)
  })

  test('the watch cursor and the prune clock persist between runs', async () => {
    const { storage } = memoryStorage()
    let now = 0
    const wake = new EventsWake(storage, () => now)
    await wake.poke('wal_a')
    const seen: Array<{ cursor: string | null; prune: boolean }> = []
    const drive = async (run: { watchCursor: string | null; pruneDue: boolean }) => {
      seen.push({ cursor: run.watchCursor, prune: run.pruneDue })
      return { nextAt: null, watchCursor: `c${String(seen.length)}` }
    }
    await wake.run(drive)
    now = 60_000
    await wake.run(drive)
    now = 3_700_000
    await wake.run(drive)
    expect(seen).toEqual([
      { cursor: null, prune: true },
      { cursor: 'c1', prune: false },
      { cursor: 'c2', prune: true },
    ])
  })

  test('a run that throws never throws out of the alarm; it retries in a minute', async () => {
    const { storage, state } = memoryStorage()
    const wake = new EventsWake(storage, () => 10_000)
    await wake.poke('wal_a')
    state.alarm = null
    await expect(wake.run(() => Promise.reject(new Error('D1 down')))).resolves.toBeUndefined()
    expect(state.alarm).toBe(70_000)
  })

  test('an object that never had a wallet does nothing', async () => {
    const { storage, state } = memoryStorage()
    const wake = new EventsWake(storage, () => 0)
    let ran = false
    await wake.run(async () => {
      ran = true
      return { nextAt: null, watchCursor: null }
    })
    expect(ran).toBe(false)
    expect(state.sets).toBe(0)
  })
})
