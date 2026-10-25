import { Clock, DateTime, Effect, Option, Random, type Redacted } from 'effect'

import type { ChainError } from '@hm/protocol'
import type { IncomingTransfer } from '@hm/stellar'

import { Db, type SqlStatement } from '../db.ts'
import { matchesArguments } from './catalog.ts'
import { eventRetryDecision, postEventWebhook } from './delivery.ts'
import { paymentReceived } from './emit.ts'
import { McpEventError, eventWireError } from './errors.ts'
import { eventCursor, journalStatement, occurrenceOf } from './journal.ts'
import { EVENT_LIMITS } from './schemas.ts'
import { openEventSecret } from './secrets.ts'
import {
  advanceCursor,
  contactNameOf,
  hasActiveSubscription,
  journalAfter,
  journalHead,
  pruneJournal,
  recordFailure,
  setTerminated,
  type SubscriptionRow,
  subscriptionsToDrive,
  walletForWatch,
} from './store.ts'
import type { EventSigningSecrets } from './webhooks.ts'

/**
 * One wallet's events work, run by its Durable Object's alarm (never under the ledger permit): (1) on the real chain,
 * while someone listens for `payment.received`, read the USDC transfers to the wallet since the last look and journal
 * them; (2) for each active subscription, POST the journal rows after its cursor that match its arguments, one by
 * one, signed, advancing the cursor on 2xx, backing off on failure, a `gap` when abandoned, `terminated` when revoked;
 * (3) prune the journal past 7 days. It never fails: the next alarm time comes back (or none).
 */

/** How often a wallet with payment.received listeners looks at the chain. */
export const WATCH_INTERVAL_MS = 10_000
/** Webhooks per subscription per run; more waits a second. */
const SENDS_PER_RUN = 20
const PAGE = 50

/** Incoming transfers to a wallet: after `cursor`, or from now when there is none. */
export interface WatchSource {
  readonly transfers: (
    to: string,
    cursor: string | null,
  ) => Effect.Effect<{ readonly transfers: ReadonlyArray<IncomingTransfer>; readonly cursor: string }, ChainError>
  readonly explorerTx: (hash: string) => string
}

export interface DriverInput {
  readonly walletId: string
  readonly vaultKey: Option.Option<Redacted.Redacted>
  /** STAGE=local: http callbacks allowed. */
  readonly local: boolean
  /** The real chain's watcher; none on the fixture chain. */
  readonly watch: WatchSource | undefined
  readonly watchCursor: string | null
  readonly pruneDue: boolean
}

export interface DriverResult {
  readonly nextAt: number | null
  readonly watchCursor: string | null
}

const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms))

/** Journal the transfers to the wallet since `cursor`; the cursor to continue from. */
const watchOnce = Effect.fnUntraced(function* (walletId: string, watch: WatchSource, cursor: string | null) {
  const wallet = yield* walletForWatch(walletId)
  if (wallet === undefined) return cursor
  const page = yield* watch.transfers(wallet.contractId, cursor)
  const statements: Array<SqlStatement> = []
  for (const transfer of page.transfers) {
    if (wallet.pockets.includes(transfer.from) || transfer.from === wallet.contractId) continue
    const closed = DateTime.make(transfer.closedAt)
    statements.push(
      journalStatement(
        paymentReceived({
          walletId,
          network: wallet.network,
          amount: transfer.amount,
          from: { address: transfer.from, contact_name: yield* contactNameOf(wallet.ownerId, transfer.from) },
          tx: transfer.tx,
          explorer: watch.explorerTx(transfer.tx),
          occurredAt: Option.isSome(closed) ? DateTime.formatIso(closed.value) : isoOf(yield* Clock.currentTimeMillis),
        }),
      ),
    )
  }
  yield* Db.use(db => db.batch(statements))
  return page.cursor
})

/** The current secret, and the previous one while its rotation grace lasts. */
const secretsOf = Effect.fnUntraced(function* (sub: SubscriptionRow, input: DriverInput, nowMs: number) {
  const current = yield* openEventSecret(input.vaultKey, sub.sealedSecret, sub.id)
  const previous =
    sub.previousSecret !== null && sub.previousUntil !== null && sub.previousUntil > nowMs
      ? yield* openEventSecret(input.vaultKey, sub.previousSecret, sub.id).pipe(Effect.option)
      : Option.none()
  const secrets: EventSigningSecrets = Option.match(previous, {
    onNone: () => ({ current }),
    onSome: secret => ({ current, previous: { secret, expiresAtMs: sub.previousUntil ?? 0 } }),
  })
  return secrets
})

const control = (sub: SubscriptionRow, input: DriverInput, secrets: EventSigningSecrets, id: string, body: object) =>
  postEventWebhook({
    url: sub.url,
    local: input.local,
    webhookId: id,
    subscriptionId: sub.id,
    body: JSON.stringify(body),
    secrets,
  })

/** Deliver one subscription's due rows; when it needs to run again (backoff, more work), or null. */
const driveSubscription = Effect.fnUntraced(function* (
  sub: SubscriptionRow,
  head: number,
  input: DriverInput,
  nowMs: number,
) {
  const opened = yield* secretsOf(sub, input, nowMs).pipe(Effect.option)
  if (Option.isNone(opened)) {
    yield* setTerminated(sub.id, 'secret unreadable', nowMs)
    return null
  }
  const secrets = opened.value
  if (sub.state === 'terminating' || !sub.connectionActive) {
    const error = eventWireError(new McpEventError({ reason: 'forbidden', data: { reason: 'revoked' } }))
    yield* control(sub, input, secrets, `msg_terminated_${sub.id.slice(4, 36)}`, { type: 'terminated', error })
    yield* setTerminated(sub.id, 'revoked', nowMs)
    return null
  }
  if (sub.expiresAt <= nowMs) {
    // A lapsed lease ends quietly: the subscriber may still refresh it, which revives it from its cursor.
    yield* setTerminated(sub.id, 'expired', nowMs)
    return null
  }
  if (sub.nextAttemptAt !== null && sub.nextAttemptAt > nowMs) return sub.nextAttemptAt
  let cursor = sub.cursor
  let saved = sub.cursor
  let attempts = sub.attempts
  let failedSince = sub.failedSince
  let sent = 0
  for (;;) {
    const rows = yield* journalAfter(sub.walletId, sub.name, cursor, head, PAGE)
    for (const row of rows) {
      if (!matchesArguments(sub.name, sub.arguments, row.data)) {
        cursor = row.seq
        continue
      }
      if (sent >= SENDS_PER_RUN) {
        if (cursor > saved) yield* advanceCursor(sub.id, sub.revision, cursor, nowMs)
        return nowMs + 1_000
      }
      sent += 1
      const result = yield* postEventWebhook({
        url: sub.url,
        local: input.local,
        webhookId: row.eventId,
        subscriptionId: sub.id,
        body: JSON.stringify(occurrenceOf(row, sub.origin)),
        secrets,
      })
      const at = yield* Clock.currentTimeMillis
      if (result.ok) {
        cursor = row.seq
        saved = row.seq
        attempts = 0
        failedSince = null
        yield* advanceCursor(sub.id, sub.revision, cursor, at)
        continue
      }
      attempts += 1
      const decision = eventRetryDecision({
        status: result.status,
        reason: result.reason,
        attempts,
        firstAttemptMs: failedSince ?? at,
        nowMs: at,
        jitter: yield* Random.next,
      })
      if (decision.state === 'retry') {
        yield* recordFailure(
          sub.id,
          sub.revision,
          { cursor, attempts, nextAttemptAt: decision.atMs, failedSince: failedSince ?? at, reason: decision.reason },
          at,
        )
        return decision.atMs
      }
      // Abandoned: say where the subscriber can poll from, then move past the backlog.
      yield* control(sub, input, secrets, `msg_gap_${String(row.seq)}_${sub.id.slice(4, 20)}`, {
        type: 'gap',
        cursor: eventCursor(cursor),
      })
      yield* advanceCursor(sub.id, sub.revision, head, at)
      return null
    }
    if (rows.length < PAGE) break
  }
  if (cursor > saved) yield* advanceCursor(sub.id, sub.revision, cursor, nowMs)
  return null
})

export const driveWallet = Effect.fnUntraced(function* (input: DriverInput) {
  const nowMs = yield* Clock.currentTimeMillis
  let nextAt: number | null = null
  const soon = (at: number | null) => {
    if (at !== null) nextAt = nextAt === null ? at : Math.min(nextAt, at)
  }
  let watchCursor = input.watchCursor
  const watch = input.watch
  if (watch !== undefined && (yield* hasActiveSubscription(input.walletId, 'payment.received', nowMs))) {
    watchCursor = yield* watchOnce(input.walletId, watch, watchCursor).pipe(
      Effect.catch(error => Effect.as(Effect.logWarning('events watcher', String(error)), watchCursor)),
    )
    soon(nowMs + WATCH_INTERVAL_MS)
  } else watchCursor = null
  const { head } = yield* journalHead
  for (const sub of yield* subscriptionsToDrive(input.walletId))
    soon(
      yield* driveSubscription(sub, head, input, nowMs).pipe(
        Effect.catch(error => Effect.as(Effect.logWarning('events delivery', sub.id, String(error)), nowMs + 60_000)),
      ),
    )
  if (input.pruneDue) yield* pruneJournal(isoOf(nowMs - EVENT_LIMITS.sourceRetentionMs))
  const result: DriverResult = { nextAt, watchCursor }
  return result
})

/** The storage a wallet's Durable Object gives the scheduler (its `ctx.storage`). */
export interface WakeStorage {
  readonly getAlarm: () => Promise<number | null>
  readonly setAlarm: (at: number) => Promise<void>
  readonly get: (key: string) => Promise<unknown>
  readonly put: (key: string, value: string | number) => Promise<void>
}

const WALLET_KEY = 'events:wallet'
const WATCH_KEY = 'events:watch-cursor'
const PRUNED_KEY = 'events:pruned-at'
const PRUNE_EVERY_MS = 3_600_000
const RETRY_AFTER_ERROR_MS = 60_000

/**
 * When a wallet's object runs its events work: armed now on a poke (or a ledger operation that journaled), at the
 * time the driver asks for after a run, never later than an alarm already set. A poke during a run makes the run go
 * round again, and arms the alarm in case the object is evicted. The wallet id is kept in storage: `alarm()` is not
 * told which wallet it belongs to.
 */
export class EventsWake {
  private walletId: string | undefined
  private running = false
  private again = false

  constructor(
    private readonly storage: WakeStorage,
    private readonly now: () => number,
  ) {}

  async remember(walletId: string): Promise<void> {
    if (this.walletId === walletId) return
    this.walletId = walletId
    if ((await this.storage.get(WALLET_KEY)) !== walletId) await this.storage.put(WALLET_KEY, walletId)
  }

  async armAt(at: number): Promise<void> {
    const current = await this.storage.getAlarm()
    if (current === null || at < current) await this.storage.setAlarm(at)
  }

  async poke(walletId: string): Promise<void> {
    await this.remember(walletId)
    if (this.running) this.again = true
    await this.armAt(this.now())
  }

  /** The alarm: run `drive` for the remembered wallet until no poke came in meanwhile; never throws. */
  async run(
    drive: (input: { walletId: string; watchCursor: string | null; pruneDue: boolean }) => Promise<DriverResult>,
  ) {
    try {
      const stored = await this.storage.get(WALLET_KEY)
      if (typeof stored !== 'string') return
      this.walletId = stored
      this.running = true
      let result: DriverResult
      do {
        this.again = false
        const cursor = await this.storage.get(WATCH_KEY)
        const prunedAt = await this.storage.get(PRUNED_KEY)
        const pruneDue = typeof prunedAt !== 'number' || this.now() - prunedAt >= PRUNE_EVERY_MS
        result = await drive({
          walletId: stored,
          watchCursor: typeof cursor === 'string' && cursor !== '' ? cursor : null,
          pruneDue,
        })
        await this.storage.put(WATCH_KEY, result.watchCursor ?? '')
        if (pruneDue) await this.storage.put(PRUNED_KEY, this.now())
      } while (this.again)
      if (result.nextAt !== null) await this.armAt(result.nextAt)
    } catch {
      // Cloudflare retries an alarm that throws; this one decides its own retry instead.
      await this.armAt(this.now() + RETRY_AFTER_ERROR_MS).catch(() => undefined)
    } finally {
      this.running = false
    }
  }
}
