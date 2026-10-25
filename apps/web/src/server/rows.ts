import { Effect, Schema } from 'effect'

import {
  Connection,
  Contact,
  Destination,
  PaymentIntent,
  PaymentReservation,
  ReceiptRecord,
  SpendingGrant,
  Wallet,
} from '@hm/protocol'

import { Db, DbError, sql, type SqlStatement } from './db.ts'

/** D1 rows → entities, decoded with the protocol schemas (amount TEXT → bigint, 0/1 → boolean, JSON → arrays). */
const decodeRow =
  <S extends Schema.Constraint & { readonly DecodingServices: never }>(schema: S, table: string) =>
  (row: Record<string, unknown>) =>
    Schema.decodeUnknownEffect(schema)(row).pipe(
      Effect.mapError(error => new DbError({ operation: `decode ${table}`, message: String(error) })),
    )

export const toWallet = decodeRow(Wallet, 'wallets')
export const toConnection = decodeRow(Connection, 'connections')
export const toGrant = (row: Record<string, unknown>) =>
  decodeRow(SpendingGrant, 'spending_grants')({ ...row, first_payment_done: row['first_payment_done'] === 1 })
export const toIntent = decodeRow(PaymentIntent, 'payment_intents')
export const toReservation = decodeRow(PaymentReservation, 'payment_reservations')
export const toReceipt = decodeRow(ReceiptRecord, 'receipts')
const toDestination = decodeRow(Destination, 'contact_destinations')
const toContactRow = decodeRow(Contact, 'contacts')

const parseAliases = (value: unknown): ReadonlyArray<string> => {
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((alias): alias is string => typeof alias === 'string') : []
  } catch {
    return []
  }
}

export const toContact = (row: Record<string, unknown>, destinations: ReadonlyArray<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const decoded = yield* Effect.forEach(destinations, toDestination)
    return yield* toContactRow({ ...row, aliases: parseAliases(row['aliases']), destinations: decoded })
  })

/** Run a read and decode every row; `first` takes the first or undefined. */
export const query = <A, E>(
  statement: SqlStatement,
  decode: (row: Record<string, unknown>) => Effect.Effect<A, E>,
): Effect.Effect<ReadonlyArray<A>, DbError | E, Db> =>
  Db.use(db => Effect.flatMap(db.all(statement), rows => Effect.forEach(rows, decode)))

export const first = <A, E>(statement: SqlStatement, decode: (row: Record<string, unknown>) => Effect.Effect<A, E>) =>
  Effect.map(query(statement, decode), rows => rows[0])

export const write = (...statements: ReadonlyArray<SqlStatement>) => Db.use(db => db.batch(statements))

export { sql }

/** Insert an entity-shaped row (column names = keys). */
export const insert = (table: string, row: Record<string, string | number | boolean | bigint | null>) => {
  const keys = Object.keys(row)
  return sql(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    ...keys.map(key => {
      const value = row[key]
      return typeof value === 'bigint'
        ? value.toString()
        : typeof value === 'boolean'
          ? value
            ? 1
            : 0
          : (value ?? null)
    }),
  )
}
