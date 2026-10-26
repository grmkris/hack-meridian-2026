import { Effect, Schema } from 'effect'

import type { PaymentIntent } from '@hm/protocol'

import { randomId } from './clock.ts'
import { DbError, type SqlStatement } from './db.ts'
import { query, sql, write } from './rows.ts'

/**
 * Recipient memory (migration 0013): the name the user gives a raw Stellar address is remembered once the payment
 * confirms, and the address is saved as a contact (source 'paid', added by the AI app) unless a contact already holds
 * it. Later, "send 0.02 to Chris" resolves by contact first, then by these labels and the names on past receipts.
 */

/** payment_prepare named a raw address no contact holds: remember the name, unpaid until the ledger confirms it. */
export const labelAtPrepare = (walletId: string, address: string, label: string) =>
  write(
    sql(
      `INSERT INTO recipient_labels (wallet_id, address, label, source, first_paid_at) VALUES (?, ?, ?, 'paid', NULL)
         ON CONFLICT (wallet_id, address) DO UPDATE SET label = excluded.label`,
      walletId,
      address,
      label,
    ),
  ).pipe(Effect.asVoid)

/**
 * The statements the ledger adds to a confirmed payment's write: for a payment to a raw address the user named (an
 * unpaid label), save the contact if no contact of the owner holds the address, then mark the label paid. Claim-link
 * and x402 payments never write a label, so they never save a contact here.
 */
export const rememberOnConfirm = (walletId: string, intent: PaymentIntent, now: string) =>
  Effect.gen(function* () {
    if (intent.kind !== 'payment' || intent.contact_id !== null || intent.recipient_name === null)
      return [] satisfies ReadonlyArray<SqlStatement>
    const contactId = yield* randomId('ct')
    const destinationId = yield* randomId('cd')
    const unpaidLabel = `EXISTS (SELECT 1 FROM recipient_labels WHERE wallet_id = ? AND address = ? AND first_paid_at IS NULL)`
    return [
      sql(
        `INSERT INTO contacts (id, owner_id, display_name, aliases, created_at, added_by, added_by_connection)
           SELECT ?, w.owner_id, ?, '[]', ?, ?, ? FROM wallets w
           WHERE w.id = ? AND ${unpaidLabel}
             AND NOT EXISTS (SELECT 1 FROM contact_destinations d JOIN contacts c ON c.id = d.contact_id
                               WHERE c.owner_id = w.owner_id AND d.address = ?)`,
        contactId,
        intent.recipient_name,
        now,
        intent.requester,
        intent.connection_id,
        walletId,
        walletId,
        intent.recipient_address,
        intent.recipient_address,
      ),
      sql(
        `INSERT INTO contact_destinations
           (id, contact_id, address, network, memo, readiness, verified_at, last_paid_at, created_at, source)
           SELECT ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'paid' WHERE EXISTS (SELECT 1 FROM contacts WHERE id = ?)`,
        destinationId,
        contactId,
        intent.recipient_address,
        intent.network,
        intent.recipient_readiness,
        now,
        now,
        now,
        contactId,
      ),
      sql(
        'UPDATE recipient_labels SET first_paid_at = ?, label = ? WHERE wallet_id = ? AND address = ? AND first_paid_at IS NULL',
        now,
        intent.recipient_name,
        walletId,
        intent.recipient_address,
      ),
    ] satisfies ReadonlyArray<SqlStatement>
  })

const Named = Schema.Struct({ address: Schema.String, name: Schema.String })

/** A row decoder whose failure is a DbError, like the store's. */
const decodeAs =
  <S extends Schema.Constraint & { readonly DecodingServices: never }>(schema: S, what: string) =>
  (row: Record<string, unknown>) =>
    Schema.decodeUnknownEffect(schema)(row).pipe(
      Effect.mapError(error => new DbError({ operation: `decode ${what}`, message: String(error) })),
    )

/** The addresses a name means beyond contacts: paid labels and the names on past payments (case-insensitive, exact). */
export const namedRecipients = (walletId: string, name: string) =>
  Effect.map(
    query(
      sql(
        `SELECT address, label AS name FROM recipient_labels
           WHERE wallet_id = ? AND first_paid_at IS NOT NULL AND lower(label) = lower(?)
         UNION
         SELECT DISTINCT recipient_address AS address, recipient_name AS name FROM receipts
           WHERE wallet_id = ? AND kind = 'payment' AND recipient_name IS NOT NULL AND lower(recipient_name) = lower(?)`,
        walletId,
        name,
        walletId,
        name,
      ),
      decodeAs(Named, 'recipient names'),
    ),
    rows => [...new Map(rows.map(row => [row.address, row])).values()],
  )

const Recent = Schema.Struct({
  address: Schema.String,
  name: Schema.NullOr(Schema.String),
  last_paid_at: Schema.String,
})

/** wallet_overview's recent_recipients: the last five people paid (not x402 sellers), newest first. */
export const recentRecipients = (walletId: string) =>
  Effect.map(
    query(
      sql(
        `SELECT r.recipient_address AS address, MAX(r.confirmed_at) AS last_paid_at,
           COALESCE(
             (SELECT r2.recipient_name FROM receipts r2 WHERE r2.wallet_id = r.wallet_id
                AND r2.recipient_address = r.recipient_address AND r2.recipient_name IS NOT NULL
                ORDER BY r2.confirmed_at DESC LIMIT 1),
             (SELECT l.label FROM recipient_labels l WHERE l.wallet_id = r.wallet_id AND l.address = r.recipient_address)
           ) AS name
         FROM receipts r WHERE r.wallet_id = ? AND r.kind = 'payment'
         GROUP BY r.recipient_address ORDER BY last_paid_at DESC LIMIT 5`,
        walletId,
      ),
      decodeAs(Recent, 'recent recipients'),
    ),
    rows =>
      rows.map(row => ({ name: row.name, address_prefix: row.address.slice(0, 8), last_paid_at: row.last_paid_at })),
  )
