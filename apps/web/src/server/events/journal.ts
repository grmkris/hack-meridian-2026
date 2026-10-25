import { Schema } from 'effect'

import { sql, type SqlStatement } from '../db.ts'
import type { EventName } from './catalog.ts'
import { McpEventError } from './errors.ts'

/**
 * The event journal: one row per event, appended in the same D1 batch as the state change it reports. `seq` is the
 * cursor: on the wire, 16 decimal digits (myapps `journal.ts`), so cursors compare as strings too.
 */

export interface JournalEvent {
  /** Deterministic: the same fact written twice is one row. */
  readonly eventId: string
  readonly walletId: string
  readonly name: EventName
  readonly data: Schema.JsonObject
  /** ISO-8601 UTC. */
  readonly occurredAt: string
}

/** Append `event` (no-op when its id is already there): add this statement to the batch that makes the change. */
export const journalStatement = (event: JournalEvent): SqlStatement =>
  sql(
    `INSERT INTO event_journal (event_id, wallet_id, name, data, occurred_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO NOTHING`,
    event.eventId,
    event.walletId,
    event.name,
    JSON.stringify(event.data),
    event.occurredAt,
  )

const WireCursor = Schema.String.check(Schema.isPattern(/^\d{16}$/u))

export const eventCursor = (seq: number): string => String(seq).padStart(16, '0')

/** A wire cursor → its seq; one this journal never reached (beyond `head`) or malformed is invalid params. */
export const decodeEventCursor = (cursor: string, head: number): number => {
  const seq = Number(cursor)
  if (!Schema.is(WireCursor)(cursor) || !Number.isSafeInteger(seq) || seq > head)
    throw new McpEventError({ reason: 'invalid_params', data: { field: 'cursor' } })
  return seq
}
