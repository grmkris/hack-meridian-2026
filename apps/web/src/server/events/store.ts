import { Effect, Predicate, Schema } from 'effect'

import { Db, sql } from '../db.ts'

/**
 * Events storage on the wallet database (migrations/0004_events.sql): journal reads and the subscription rows. Every
 * write is one statement or one batch; a delivery advances a cursor only for the revision it read.
 */

export interface JournalRow {
  readonly seq: number
  readonly eventId: string
  readonly name: string
  readonly data: Schema.JsonObject
  readonly occurredAt: string
}

export type SubscriptionState = 'pending' | 'active' | 'terminating' | 'terminated'

export interface SubscriptionRow {
  readonly id: string
  readonly connectionId: string
  readonly walletId: string
  readonly name: string
  readonly arguments: Schema.JsonObject
  readonly argumentsJson: string
  readonly url: string
  readonly origin: string
  readonly sealedSecret: string
  readonly previousSecret: string | null
  readonly previousUntil: number | null
  readonly state: SubscriptionState
  readonly cursor: number
  readonly revision: number
  readonly attempts: number
  readonly nextAttemptAt: number | null
  readonly failedSince: number | null
  readonly lastError: string | null
  readonly verifiedAt: number | null
  readonly expiresAt: number
}

const parseObject = (text: unknown): Schema.JsonObject => {
  if (typeof text !== 'string') return {}
  try {
    const value: unknown = JSON.parse(text)
    return Schema.is(Schema.JsonObject)(value) ? value : {}
  } catch {
    return {}
  }
}
const numberOr = <A>(value: unknown, fallback: A): number | A => (typeof value === 'number' ? value : fallback)
const stringOr = <A>(value: unknown, fallback: A): string | A => (typeof value === 'string' ? value : fallback)
const STATES: ReadonlyArray<SubscriptionState> = ['pending', 'active', 'terminating', 'terminated']
const stateOf = (value: unknown): SubscriptionState => STATES.find(state => state === value) ?? 'terminated'

const toJournalRow = (row: Record<string, unknown>): JournalRow => ({
  seq: numberOr(row['seq'], 0),
  eventId: stringOr(row['event_id'], ''),
  name: stringOr(row['name'], ''),
  data: parseObject(row['data']),
  occurredAt: stringOr(row['occurred_at'], ''),
})

const toSubscription = (row: Record<string, unknown>): SubscriptionRow => ({
  id: stringOr(row['id'], ''),
  connectionId: stringOr(row['connection_id'], ''),
  walletId: stringOr(row['wallet_id'], ''),
  name: stringOr(row['name'], ''),
  arguments: parseObject(row['arguments']),
  argumentsJson: stringOr(row['arguments'], '{}'),
  url: stringOr(row['url'], ''),
  origin: stringOr(row['origin'], ''),
  sealedSecret: stringOr(row['sealed_secret'], ''),
  previousSecret: stringOr(row['previous_secret'], null),
  previousUntil: numberOr(row['previous_until'], null),
  state: stateOf(row['state']),
  cursor: numberOr(row['cursor'], 0),
  revision: numberOr(row['revision'], 0),
  attempts: numberOr(row['attempts'], 0),
  nextAttemptAt: numberOr(row['next_attempt_at'], null),
  failedSince: numberOr(row['failed_since'], null),
  lastError: stringOr(row['last_error'], null),
  verifiedAt: numberOr(row['verified_at'], null),
  expiresAt: numberOr(row['expires_at'], 0),
})

const all = (statement: ReturnType<typeof sql>) => Db.use(db => db.all(statement))

/** The newest seq ever written (pruned rows included) and the newest seq retention removed. */
export const journalHead = Effect.map(
  all(
    sql(
      `SELECT COALESCE((SELECT MAX(seq) FROM event_journal), 0) AS head,
         COALESCE((SELECT value FROM event_meta WHERE key = 'pruned_through'), 0) AS pruned`,
    ),
  ),
  rows => {
    const head = numberOr(rows[0]?.['head'], 0)
    const pruned = numberOr(rows[0]?.['pruned'], 0)
    return { head: Math.max(head, pruned), pruned }
  },
)

/** One wallet's rows of one event after `after`, up to `upTo`, oldest first. */
export const journalAfter = (walletId: string, name: string, after: number, upTo: number, limit: number) =>
  Effect.map(
    all(
      sql(
        `SELECT seq, event_id, name, data, occurred_at FROM event_journal
           WHERE wallet_id = ? AND name = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?`,
        walletId,
        name,
        after,
        upTo,
        limit,
      ),
    ),
    rows => rows.map(toJournalRow),
  )

/** Wallets with journal rows after `seq`: whose objects a Nod→Nod payment must wake. */
export const walletsWithEventsAfter = (seq: number) =>
  Effect.map(all(sql('SELECT DISTINCT wallet_id FROM event_journal WHERE seq > ? LIMIT 50', seq)), rows =>
    rows.map(row => row['wallet_id']).filter(Predicate.isString),
  )

export const journalMaxSeq = Effect.map(all(sql('SELECT COALESCE(MAX(seq), 0) AS seq FROM event_journal')), rows =>
  numberOr(rows[0]?.['seq'], 0),
)

/** Drop rows older than `beforeIso`, remembering the newest dropped seq. */
export const pruneJournal = (beforeIso: string) =>
  Db.use(db =>
    db.batch([
      sql(
        `INSERT INTO event_meta (key, value)
           SELECT 'pruned_through', MAX(seq) FROM event_journal WHERE occurred_at < ? HAVING MAX(seq) IS NOT NULL
           ON CONFLICT(key) DO UPDATE SET value = MAX(event_meta.value, excluded.value)`,
        beforeIso,
      ),
      sql('DELETE FROM event_journal WHERE occurred_at < ?', beforeIso),
    ]),
  )

export const subscriptionById = (id: string) =>
  Effect.map(all(sql('SELECT * FROM event_subscriptions WHERE id = ?', id)), rows =>
    rows[0] === undefined ? undefined : toSubscription(rows[0]),
  )

/** Live (pending or active, unexpired) subscriptions of a connection, this one aside. */
export const liveSubscriptionCount = (connectionId: string, exceptId: string, nowMs: number) =>
  Effect.map(
    all(
      sql(
        `SELECT COUNT(*) AS n FROM event_subscriptions
           WHERE connection_id = ? AND id != ? AND state IN ('pending', 'active') AND expires_at > ?`,
        connectionId,
        exceptId,
        nowMs,
      ),
    ),
    rows => numberOr(rows[0]?.['n'], 0),
  )

/** Subscriptions of a wallet the driver works on: active and terminating ones. */
export const subscriptionsToDrive = (walletId: string) =>
  Effect.map(
    all(
      sql(
        `SELECT * FROM event_subscriptions WHERE wallet_id = ? AND state IN ('active', 'terminating')
           ORDER BY created_at, id LIMIT 64`,
        walletId,
      ),
    ),
    rows => rows.map(toSubscription),
  )

export const hasActiveSubscription = (walletId: string, name: string, nowMs: number) =>
  Effect.map(
    all(
      sql(
        `SELECT 1 AS one FROM event_subscriptions WHERE wallet_id = ? AND name = ? AND state = 'active' AND expires_at > ?
           LIMIT 1`,
        walletId,
        name,
        nowMs,
      ),
    ),
    rows => rows.length > 0,
  )

export interface NewSubscription {
  readonly id: string
  readonly connectionId: string
  readonly walletId: string
  readonly name: string
  readonly argumentsJson: string
  readonly url: string
  readonly origin: string
  readonly sealedSecret: string
  readonly expiresAt: number
  /** Where a new (or revived) subscription starts. */
  readonly cursor: number
  readonly nowMs: number
}

/**
 * Create or refresh a subscription as `pending` (verified before it is active). A live one keeps its cursor, and its
 * old secret signs beside the new one for the rotation grace; a new or ended one starts at `cursor` with a new
 * revision, so a delivery still in flight for the old one cannot move it.
 */
export const upsertSubscription = (input: NewSubscription, graceMs: number) =>
  Db.use(db =>
    db.batch([
      sql(
        `INSERT INTO event_subscriptions (id, connection_id, wallet_id, name, arguments, url, origin, sealed_secret,
           previous_secret, previous_until, state, cursor, revision, attempts, next_attempt_at, failed_since, last_error,
           verified_at, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending', ?, 0, 0, NULL, NULL, NULL, NULL, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           previous_secret = CASE WHEN event_subscriptions.state IN ('pending', 'active')
             THEN event_subscriptions.sealed_secret ELSE NULL END,
           previous_until = CASE WHEN event_subscriptions.state IN ('pending', 'active') THEN ? ELSE NULL END,
           sealed_secret = excluded.sealed_secret,
           origin = excluded.origin,
           expires_at = excluded.expires_at,
           state = 'pending',
           verified_at = NULL,
           last_error = NULL,
           revision = CASE WHEN event_subscriptions.state IN ('pending', 'active')
             THEN event_subscriptions.revision ELSE event_subscriptions.revision + 1 END,
           cursor = CASE WHEN event_subscriptions.state IN ('pending', 'active')
             THEN event_subscriptions.cursor ELSE excluded.cursor END,
           attempts = CASE WHEN event_subscriptions.state IN ('pending', 'active')
             THEN event_subscriptions.attempts ELSE 0 END,
           next_attempt_at = CASE WHEN event_subscriptions.state IN ('pending', 'active')
             THEN event_subscriptions.next_attempt_at ELSE NULL END,
           failed_since = CASE WHEN event_subscriptions.state IN ('pending', 'active')
             THEN event_subscriptions.failed_since ELSE NULL END,
           updated_at = excluded.updated_at
         WHERE event_subscriptions.connection_id = excluded.connection_id`,
        input.id,
        input.connectionId,
        input.walletId,
        input.name,
        input.argumentsJson,
        input.url,
        input.origin,
        input.sealedSecret,
        input.cursor,
        input.expiresAt,
        input.nowMs,
        input.nowMs,
        input.nowMs + graceMs,
      ),
    ]),
  )

/** The challenge came back: active, unless a newer subscribe replaced the secret meanwhile. */
export const activateSubscription = (id: string, sealedSecret: string, nowMs: number) =>
  Db.use(db =>
    db.batch([
      sql(
        `UPDATE event_subscriptions SET state = 'active', verified_at = ?, updated_at = ?
           WHERE id = ? AND sealed_secret = ? AND state = 'pending'`,
        nowMs,
        nowMs,
        id,
        sealedSecret,
      ),
    ]),
  )

export const failVerification = (id: string, sealedSecret: string, reason: string, nowMs: number) =>
  Db.use(db =>
    db.batch([
      sql(
        `UPDATE event_subscriptions SET last_error = ?, updated_at = ? WHERE id = ? AND sealed_secret = ?`,
        reason,
        nowMs,
        id,
        sealedSecret,
      ),
    ]),
  )

/** End a connection's subscription by its exact selector and URL (idempotent). */
export const removeSubscription = (
  connectionId: string,
  name: string,
  argumentsJson: string,
  url: string,
  nowMs: number,
) =>
  Db.use(db =>
    db.batch([
      sql(
        `UPDATE event_subscriptions SET state = 'terminated', last_error = 'unsubscribed', updated_at = ?
           WHERE connection_id = ? AND name = ? AND arguments = ? AND url = ? AND state IN ('pending', 'active')`,
        nowMs,
        connectionId,
        name,
        argumentsJson,
        url,
      ),
    ]),
  )

/** Revoke: append to the revoke batch, so the subscriptions stop with the connection (the driver says goodbye). */
export const terminateConnectionStatement = (connectionId: string, nowMs: number) =>
  sql(
    `UPDATE event_subscriptions SET state = 'terminating', last_error = 'revoked', updated_at = ?
       WHERE connection_id = ? AND state IN ('pending', 'active')`,
    nowMs,
    connectionId,
  )

/** A delivery got through (or the rows up to `cursor` did not match): advance, if the revision is still `revision`. */
export const advanceCursor = (id: string, revision: number, cursor: number, nowMs: number) =>
  Db.use(db =>
    db.batch([
      sql(
        `UPDATE event_subscriptions SET cursor = MAX(cursor, ?), attempts = 0, next_attempt_at = NULL,
           failed_since = NULL, last_error = NULL, updated_at = ?
           WHERE id = ? AND revision = ? AND state = 'active'`,
        cursor,
        nowMs,
        id,
        revision,
      ),
    ]),
  )

export const recordFailure = (
  id: string,
  revision: number,
  input: {
    readonly attempts: number
    readonly nextAttemptAt: number
    readonly failedSince: number
    readonly reason: string
  },
  nowMs: number,
) =>
  Db.use(db =>
    db.batch([
      sql(
        `UPDATE event_subscriptions SET attempts = ?, next_attempt_at = ?, failed_since = ?, last_error = ?, updated_at = ?
           WHERE id = ? AND revision = ? AND state = 'active'`,
        input.attempts,
        input.nextAttemptAt,
        input.failedSince,
        input.reason,
        nowMs,
        id,
        revision,
      ),
    ]),
  )

export const setTerminated = (id: string, reason: string, nowMs: number) =>
  Db.use(db =>
    db.batch([
      sql(
        `UPDATE event_subscriptions SET state = 'terminated', last_error = ?, updated_at = ? WHERE id = ?`,
        reason,
        nowMs,
        id,
      ),
    ]),
  )
