import { Effect } from 'effect'

import type { Connection, Contact, PaymentIntent, ReceiptRecord, SpendingGrant, Wallet } from '@hm/protocol'

import { isoIn, nowIso, randomId, randomToken, sha256Hex } from './clock.ts'
import { allowanceChanged } from './events/emit.ts'
import { EventsHost } from './events/host.ts'
import { journalStatement } from './events/journal.ts'
import {
  first,
  insert,
  query,
  sql,
  toConnection,
  toContact,
  toGrant,
  toIntent,
  toReceipt,
  toWallet,
  write,
} from './rows.ts'

/**
 * Facts with one writer each that are not money state: owners and their wallets, sessions, WebAuthn challenges,
 * connections and the grants consent installed, contacts. Plus the bounded reads every surface needs. Money state
 * (intents, reservations, grant counters, operations, receipts) is written only through the Ledger.
 */

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000
const CHALLENGE_TTL_MS = 5 * 60 * 1000

// Owners and wallets

type NetworkId = 'stellar:testnet' | 'stellar:pubnet'

/**
 * A stage runs on one network and has its own database, so every wallet and contact row is on the stage's network.
 * Rows written before the column followed the stage (mainnet wallets said testnet) get it here, once per isolate.
 */
export const backfillNetwork = (network: NetworkId) =>
  write(
    sql('UPDATE wallets SET network = ? WHERE network <> ?', network, network),
    sql('UPDATE contact_destinations SET network = ? WHERE network <> ?', network, network),
  )

/** The network of the owner's wallet (the stage's), for rows that belong to the owner. */
const networkOfOwner = (ownerId: string) =>
  Effect.map(
    first(sql('SELECT network FROM wallets WHERE owner_id = ? LIMIT 1', ownerId), row =>
      Effect.succeed(String(row['network'])),
    ),
    network => network ?? 'stellar:testnet',
  )

export const createOwnerWallet = (input: {
  readonly network: NetworkId
  readonly name: string
  readonly contractId: string
  readonly credentialId: string
  readonly publicKey: string
  readonly deployTx: string
  readonly fundTx: string | null
}) =>
  Effect.gen(function* () {
    const ownerId = yield* randomId('own')
    const walletId = yield* randomId('wal')
    const now = yield* nowIso
    yield* write(
      insert('owners', { id: ownerId, created_at: now }),
      insert('wallets', {
        id: walletId,
        owner_id: ownerId,
        name: input.name,
        contract_id: input.contractId,
        passkey_credential_id: input.credentialId,
        passkey_public_key: input.publicKey,
        network: input.network,
        deploy_tx: input.deployTx,
        fund_tx: input.fundTx,
        created_at: now,
      }),
    )
    const wallet = yield* walletById(walletId)
    return wallet === undefined ? yield* Effect.die(new Error(`wallet ${walletId} vanished after insert`)) : wallet
  })

export const walletById = (walletId: string) => first(sql('SELECT * FROM wallets WHERE id = ?', walletId), toWallet)
export const walletOfOwner = (ownerId: string) =>
  first(sql('SELECT * FROM wallets WHERE owner_id = ? ORDER BY created_at LIMIT 1', ownerId), toWallet)
export const walletByCredential = (credentialId: string) =>
  first(sql('SELECT * FROM wallets WHERE passkey_credential_id = ?', credentialId), toWallet)

// Sessions: a random token in an HttpOnly cookie; only its hash is stored.

export const createSession = (ownerId: string) =>
  Effect.gen(function* () {
    const token = yield* randomToken
    yield* write(
      insert('owner_sessions', {
        token_hash: yield* sha256Hex(token),
        owner_id: ownerId,
        created_at: yield* nowIso,
        expires_at: yield* isoIn(SESSION_TTL_MS),
      }),
    )
    return token
  })

export const ownerOfSession = (token: string) =>
  Effect.gen(function* () {
    const hash = yield* sha256Hex(token)
    return yield* first(
      sql('SELECT owner_id FROM owner_sessions WHERE token_hash = ? AND expires_at > ?', hash, yield* nowIso),
      row => Effect.succeed(String(row['owner_id'])),
    )
  })

export const deleteSession = (token: string) =>
  Effect.flatMap(sha256Hex(token), hash => write(sql('DELETE FROM owner_sessions WHERE token_hash = ?', hash)))

// WebAuthn challenges: single use, five minutes.

export const createChallenge = (purpose: 'register' | 'login') =>
  Effect.gen(function* () {
    const challenge = yield* randomToken
    yield* write(
      insert('webauthn_challenges', {
        id: yield* randomId('ch'),
        challenge,
        purpose,
        expires_at: yield* isoIn(CHALLENGE_TTL_MS),
        used_at: null,
      }),
    )
    return challenge
  })

/** True once for a live challenge of that purpose; marks it used. */
export const consumeChallenge = (challenge: string, purpose: 'register' | 'login') =>
  Effect.gen(function* () {
    const now = yield* nowIso
    const live = yield* first(
      sql(
        'SELECT id FROM webauthn_challenges WHERE challenge = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?',
        challenge,
        purpose,
        now,
      ),
      row => Effect.succeed(String(row['id'])),
    )
    if (live === undefined) return false
    yield* write(sql('UPDATE webauthn_challenges SET used_at = ? WHERE id = ?', now, live))
    return true
  })

// Pending grants: prepared for the owner's passkey on the consent page, installed on Allow.

export interface PendingGrant {
  readonly id: string
  readonly owner_id: string
  readonly wallet_id: string
  readonly signer_public_key: string
  readonly signer_key_ref: string
  readonly total: bigint
  /** The nod line the owner set on the consent page (stroops). */
  readonly nod_above: bigint
  readonly valid_until: string
  readonly lifetime_seconds: number
  readonly prepared: string
}

export const createPendingGrant = (input: Omit<PendingGrant, 'id'>) =>
  Effect.gen(function* () {
    const id = yield* randomId('pg')
    yield* write(
      insert('pending_grants', {
        id,
        ...input,
        created_at: yield* nowIso,
        expires_at: yield* isoIn(30 * 60 * 1000),
      }),
    )
    return id
  })

export const pendingGrant = (id: string, ownerId: string) =>
  Effect.gen(function* () {
    return yield* first(
      sql('SELECT * FROM pending_grants WHERE id = ? AND owner_id = ? AND expires_at > ?', id, ownerId, yield* nowIso),
      (row): Effect.Effect<PendingGrant> =>
        Effect.succeed({
          id: String(row['id']),
          owner_id: String(row['owner_id']),
          wallet_id: String(row['wallet_id']),
          signer_public_key: String(row['signer_public_key']),
          signer_key_ref: String(row['signer_key_ref']),
          total: BigInt(String(row['total'])),
          nod_above: BigInt(String(row['nod_above'])),
          valid_until: String(row['valid_until']),
          lifetime_seconds: Number(row['lifetime_seconds']),
          prepared: String(row['prepared']),
        }),
    )
  })

// Connections and their grants (one consent = one OAuth grant = one connection = one spending grant).

export const createConnection = (input: {
  readonly connectionId: string
  readonly grantId: string
  readonly ownerId: string
  readonly walletId: string
  readonly clientId: string
  readonly clientName: string
  readonly clientDomain: string | null
  readonly oauthGrantId: string
  readonly pending: PendingGrant
  readonly ruleId: number
  readonly validUntilLedger: number
  readonly installTx: string
  readonly pocketAddress: string | null
}) =>
  Effect.gen(function* () {
    const now = yield* nowIso
    const network = yield* first(sql('SELECT network FROM wallets WHERE id = ?', input.walletId), row =>
      Effect.succeed(String(row['network'])),
    )
    yield* write(
      insert('connections', {
        id: input.connectionId,
        owner_id: input.ownerId,
        wallet_id: input.walletId,
        oauth_client_id: input.clientId,
        oauth_client_name: input.clientName,
        oauth_client_domain: input.clientDomain,
        oauth_grant_id: input.oauthGrantId,
        status: 'active',
        created_at: now,
        revoked_at: null,
      }),
      insert('spending_grants', {
        id: input.grantId,
        connection_id: input.connectionId,
        wallet_id: input.walletId,
        signer_public_key: input.pending.signer_public_key,
        signer_key_ref: input.pending.signer_key_ref,
        asset: 'USDC',
        total: input.pending.total,
        spent: 0n,
        reserved: 0n,
        valid_until: input.pending.valid_until,
        valid_until_ledger: input.validUntilLedger,
        nod_above: input.pending.nod_above,
        rule_id: input.ruleId,
        rule_status: 'installed',
        pocket_address: input.pocketAddress,
        pocket_balance: 0n,
        first_payment_done: false,
        status: 'active',
        install_tx: input.installTx,
        created_at: now,
      }),
      sql('DELETE FROM pending_grants WHERE id = ?', input.pending.id),
      journalStatement(
        allowanceChanged({
          walletId: input.walletId,
          network: network ?? 'stellar:testnet',
          connectionId: input.connectionId,
          grantId: input.grantId,
          change: 'installed',
          allowance: input.pending.total,
          remaining: input.pending.total,
          validUntil: input.pending.valid_until,
          occurredAt: now,
        }),
      ),
    )
    yield* EventsHost.use(host => host.poke(input.walletId))
  })

/** The OAuth grant id is known only after completeAuthorization; it is recorded right after. */
export const setOAuthGrantId = (connectionId: string, oauthGrantId: string) =>
  write(sql('UPDATE connections SET oauth_grant_id = ? WHERE id = ?', oauthGrantId, connectionId))

export const connectionById = (connectionId: string) =>
  first(sql('SELECT * FROM connections WHERE id = ?', connectionId), toConnection)
export const grantOfConnection = (connectionId: string) =>
  first(sql('SELECT * FROM spending_grants WHERE connection_id = ?', connectionId), toGrant)
export const grantById = (grantId: string) => first(sql('SELECT * FROM spending_grants WHERE id = ?', grantId), toGrant)

export interface ConnectionWithGrant {
  readonly connection: Connection
  readonly grant: SpendingGrant | undefined
}

/** Every connection of a wallet with its grant, newest first (at most 100). */
export const connectionsOfWallet = (walletId: string) =>
  Effect.gen(function* () {
    const connections = yield* query(
      sql('SELECT * FROM connections WHERE wallet_id = ? ORDER BY created_at DESC LIMIT 100', walletId),
      toConnection,
    )
    const grants = yield* query(sql('SELECT * FROM spending_grants WHERE wallet_id = ? LIMIT 100', walletId), toGrant)
    return connections.map((connection): ConnectionWithGrant => ({
      connection,
      grant: grants.find(grant => grant.connection_id === connection.id),
    }))
  })

// Contacts

const destinationsOf = (contactIds: ReadonlyArray<string>) =>
  contactIds.length === 0
    ? Effect.succeed([])
    : Effect.flatMap(
        query(
          sql(
            `SELECT * FROM contact_destinations WHERE contact_id IN (${contactIds.map(() => '?').join(', ')}) ORDER BY created_at`,
            ...contactIds,
          ),
          row => Effect.succeed(row),
        ),
        rows => Effect.succeed(rows),
      )

export const contactsOfOwner = (ownerId: string) =>
  Effect.gen(function* () {
    const rows = yield* query(
      sql('SELECT * FROM contacts WHERE owner_id = ? ORDER BY display_name LIMIT 200', ownerId),
      row => Effect.succeed(row),
    )
    const destinations = yield* destinationsOf(rows.map(row => String(row['id'])))
    return yield* Effect.forEach(rows, row =>
      toContact(
        row,
        destinations.filter(destination => destination['contact_id'] === row['id']),
      ),
    )
  })

export const contactById = (ownerId: string, contactId: string) =>
  Effect.map(contactsOfOwner(ownerId), contacts => contacts.find(contact => contact.id === contactId))

/** Case-insensitive match on name, alias or address; an empty query lists all. */
export const searchContacts = (ownerId: string, text: string) =>
  Effect.map(contactsOfOwner(ownerId), contacts => {
    const needle = text.trim().toLowerCase()
    if (needle === '') return contacts
    return contacts.filter(
      (contact: Contact) =>
        contact.display_name.toLowerCase().includes(needle) ||
        contact.aliases.some(alias => alias.toLowerCase().includes(needle)) ||
        contact.destinations.some(destination => destination.address.toLowerCase() === needle),
    )
  })

export const createContact = (input: {
  readonly ownerId: string
  readonly displayName: string
  readonly aliases: ReadonlyArray<string>
  readonly address: string
  readonly memo: string | null
  readonly readiness: Contact['destinations'][number]['readiness']
}) =>
  Effect.gen(function* () {
    const id = yield* randomId('ct')
    const now = yield* nowIso
    yield* write(
      insert('contacts', {
        id,
        owner_id: input.ownerId,
        display_name: input.displayName,
        aliases: JSON.stringify(input.aliases),
        created_at: now,
      }),
      insert('contact_destinations', {
        id: yield* randomId('cd'),
        contact_id: id,
        address: input.address,
        network: yield* networkOfOwner(input.ownerId),
        memo: input.memo,
        readiness: input.readiness,
        verified_at: now,
        last_paid_at: null,
        created_at: now,
      }),
    )
    const contact = yield* contactById(input.ownerId, id)
    return contact === undefined ? yield* Effect.die(new Error(`contact ${id} vanished after insert`)) : contact
  })

/** The owner confirmed a new address on the site: it replaces the contact's destinations, unpaid so far. */
export const replaceDestination = (input: {
  readonly ownerId: string
  readonly contactId: string
  readonly address: string
  readonly memo: string | null
  readonly readiness: Contact['destinations'][number]['readiness']
}) =>
  Effect.gen(function* () {
    const now = yield* nowIso
    yield* write(
      sql('DELETE FROM contact_destinations WHERE contact_id = ?', input.contactId),
      insert('contact_destinations', {
        id: yield* randomId('cd'),
        contact_id: input.contactId,
        address: input.address,
        network: yield* networkOfOwner(input.ownerId),
        memo: input.memo,
        readiness: input.readiness,
        verified_at: now,
        last_paid_at: null,
        created_at: now,
      }),
    )
    return yield* contactById(input.ownerId, input.contactId)
  })

// Intents and receipts (reads)

export const intentById = (intentId: string) =>
  first(sql('SELECT * FROM payment_intents WHERE id = ?', intentId), toIntent)
export const intentByKey = (walletId: string, scope: string, key: string) =>
  first(
    sql(
      'SELECT * FROM payment_intents WHERE wallet_id = ? AND scope = ? AND idempotency_key = ?',
      walletId,
      scope,
      key,
    ),
    toIntent,
  )
export const fingerprintOf = (intentId: string) =>
  first(sql('SELECT request_fingerprint FROM payment_intents WHERE id = ?', intentId), row =>
    Effect.succeed(String(row['request_fingerprint'])),
  )
export const approvalPreparedOf = (intentId: string) =>
  first(sql('SELECT approval_prepared FROM payment_intents WHERE id = ?', intentId), row =>
    Effect.succeed(typeof row['approval_prepared'] === 'string' ? row['approval_prepared'] : null),
  )

export const claimPreparedOf = (intentId: string) =>
  first(sql('SELECT claim_prepared FROM payment_intents WHERE id = ?', intentId), row =>
    Effect.succeed(typeof row['claim_prepared'] === 'string' ? row['claim_prepared'] : null),
  )

/** Intents waiting for the owner (not yet past their expiry), newest first. */
export const pendingOfWallet = (walletId: string, connectionId?: string) =>
  Effect.gen(function* () {
    const now = yield* nowIso
    return yield* query(
      connectionId === undefined
        ? sql(
            "SELECT * FROM payment_intents WHERE wallet_id = ? AND status = 'awaiting_approval' AND expires_at > ? ORDER BY created_at DESC LIMIT 50",
            walletId,
            now,
          )
        : sql(
            "SELECT * FROM payment_intents WHERE wallet_id = ? AND connection_id = ? AND status = 'awaiting_approval' AND expires_at > ? ORDER BY created_at DESC LIMIT 50",
            walletId,
            connectionId,
            now,
          ),
      toIntent,
    )
  })

export const receiptsOfWallet = (walletId: string, limit: number, connectionId?: string) =>
  query(
    connectionId === undefined
      ? sql('SELECT * FROM receipts WHERE wallet_id = ? ORDER BY confirmed_at DESC LIMIT ?', walletId, limit)
      : sql(
          'SELECT * FROM receipts WHERE wallet_id = ? AND connection_id = ? ORDER BY confirmed_at DESC LIMIT ?',
          walletId,
          connectionId,
          limit,
        ),
    toReceipt,
  )

export const receiptOfIntent = (intentId: string) =>
  first(sql('SELECT * FROM receipts WHERE intent_id = ?', intentId), toReceipt)

export type { PaymentIntent, ReceiptRecord, Wallet }

// Results of idempotent tools that freeze no intent.

export const toolResult = (scope: string, key: string) =>
  first(sql('SELECT tool, result FROM tool_results WHERE scope = ? AND idempotency_key = ?', scope, key), row =>
    Effect.succeed({ tool: String(row['tool']), result: String(row['result']) }),
  )
export const saveToolResult = (scope: string, key: string, tool: string, result: string) =>
  Effect.flatMap(nowIso, now =>
    write(
      sql(
        'INSERT OR IGNORE INTO tool_results (scope, idempotency_key, tool, result, created_at) VALUES (?, ?, ?, ?, ?)',
        scope,
        key,
        tool,
        result,
        now,
      ),
    ),
  )

/** Short-lived server-side state between a page's prepare and its passkey POST (e.g. a prepared rule removal). */
export const putScratch = (scope: string, key: string, value: string) =>
  Effect.flatMap(nowIso, now =>
    write(
      sql(
        "INSERT OR REPLACE INTO tool_results (scope, idempotency_key, tool, result, created_at) VALUES (?, ?, 'scratch', ?, ?)",
        scope,
        key,
        value,
        now,
      ),
    ),
  )
