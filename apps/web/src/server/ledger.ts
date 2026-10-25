import { Context, Effect, Schema, Semaphore } from 'effect'

import {
  type ApprovalReason,
  type ChainErrorKind,
  FEE_CEILING_FIRST_PAYMENT_XLM,
  FEE_CEILING_LATER_PAYMENT_XLM,
  FEE_CEILING_OWNER_PAYMENT_XLM,
  type IntentKind,
  type Lane,
  type PaymentIntent,
  POCKET_CHUNK_STROOPS,
  type Readiness,
  type Receipt,
  type SpendingGrant,
} from '@hm/protocol'

import { isoIn, millisOf, nowIso, nowMillis, randomId } from './clock.ts'
import { Db, DbError, type SqlStatement } from './db.ts'
import { allowanceChanged, approvalNeeded, paymentReceived, paymentSettled, requestAnswered } from './events/emit.ts'
import { journalStatement } from './events/journal.ts'
import { terminateConnectionStatement } from './events/store.ts'
import { first, insert, sql, toGrant, toIntent, toReservation, write } from './rows.ts'

/**
 * The wallet's money state machine: payment intents, reservations against the connection's grant, the submit claim
 * and the outcome. Every operation runs under one permit per wallet (the wallet's Durable Object hosts one instance),
 * so "look up the idempotency key, check the remaining allowance, reserve, claim the submit" is atomic with respect to
 * every other operation on that wallet, and each operation's writes commit in one D1 batch. A lost response never pays
 * twice: the claim moves the intent to `submitted` before the chain is called, and a retry finds it there.
 */

/** Intents that wait (to be executed, or for the owner) expire after 30 minutes (≈ 400 ledgers). */
export const INTENT_TTL_MS = 30 * 60 * 1000

/** What the onchain policy still allows, less what is held for payments in flight. */
export const policyFreeOf = (grant: SpendingGrant): bigint => grant.total - grant.spent - grant.reserved

/** What the connection can still spend: policy free plus the pocket's float (docs/spikes/s5.md). */
export const remainingOf = (grant: SpendingGrant): bigint => policyFreeOf(grant) + grant.pocket_balance

/** S5 chunk policy: pull min(policy free, max(shortfall, 1.00 USDC)); nothing when the pocket covers the price. */
export const pullFor = (grant: SpendingGrant, price: bigint): bigint => {
  const shortfall = price - grant.pocket_balance
  if (shortfall <= 0n) return 0n
  const chunk = shortfall > POCKET_CHUNK_STROOPS ? shortfall : POCKET_CHUNK_STROOPS
  const free = policyFreeOf(grant)
  return chunk < free ? chunk : free
}

export const grantLive = (grant: SpendingGrant, nowMs: number): boolean =>
  grant.status === 'active' && millisOf(grant.valid_until) > nowMs

/** Status as a reader should see it: a waiting intent past its expiry reads `expired` (no write on read). */
export const effectiveStatus = (intent: PaymentIntent, nowMs: number): PaymentIntent['status'] =>
  (intent.status === 'prepared' || intent.status === 'awaiting_approval') && millisOf(intent.expires_at) <= nowMs
    ? 'expired'
    : intent.status

/**
 * The lane rule (docs/SPEC.md): autonomous only inside a live grant, for a ready recipient, within what is left of the
 * allowance; anything else takes the owner lane (the passkey, no upper limit). One number, the allowance (Kristjan,
 * 2026-10-25 18:20 UTC: the per-payment nod line is gone; grants keep the column, unused). A direct payment comes from the smart account under the rule, so only the policy's free
 * amount counts; an x402 purchase is paid from the pocket, so its float counts too. The owner lane carries its reason.
 */
const owner = (reason: ApprovalReason) => ({ lane: 'owner' as const, reason })

export const laneDecision = (input: {
  readonly grant: SpendingGrant | undefined
  readonly kind: IntentKind
  readonly amount: bigint
  readonly readiness: Readiness
  readonly nowMs: number
  readonly forceOwner: boolean
  /** Why `forceOwner` sends it to the owner (default owner_only), e.g. new_contact. */
  readonly ownerReason?: ApprovalReason | undefined
}): { readonly lane: Lane; readonly reason: ApprovalReason | null } => {
  if (input.forceOwner) return owner(input.ownerReason ?? 'owner_only')
  if (input.amount <= 0n) return owner('owner_only')
  if (input.grant === undefined || !grantLive(input.grant, input.nowMs)) return owner('no_allowance')
  if (input.readiness !== 'usdc_ready') return owner('recipient_not_ready')
  if (input.amount > (input.kind === 'payment' ? policyFreeOf(input.grant) : remainingOf(input.grant)))
    return owner('over_allowance')
  return { lane: 'autonomous', reason: null }
}

/** XLM fee ceilings for an intent, from the network preset (defaults: the protocol's testnet numbers). */
export interface FeeCeilings {
  readonly firstXlm: number
  readonly laterXlm: number
  readonly ownerXlm: number
}
export const DEFAULT_FEE_CEILINGS: FeeCeilings = {
  firstXlm: FEE_CEILING_FIRST_PAYMENT_XLM,
  laterXlm: FEE_CEILING_LATER_PAYMENT_XLM,
  ownerXlm: FEE_CEILING_OWNER_PAYMENT_XLM,
}

export const feeCeilingFor = (
  lane: Lane,
  grant: SpendingGrant | undefined,
  fees: FeeCeilings = DEFAULT_FEE_CEILINGS,
) => (lane === 'owner' ? fees.ownerXlm : grant?.first_payment_done === true ? fees.laterXlm : fees.firstXlm)

export class LedgerError extends Schema.TaggedError<LedgerError>()('LedgerError', {
  reason: Schema.Literals(['not_found', 'idempotency_conflict', 'invalid_state', 'storage']),
  message: Schema.String,
}) {}

export interface NewIntent {
  /** A caller-chosen id (x402 uses it as the payment identifier before the intent exists); random otherwise. */
  readonly id?: string
  readonly scope: string
  readonly idempotencyKey: string
  /** What the caller asked for; the same key with a different fingerprint is refused. */
  readonly fingerprint: string
  readonly kind: IntentKind
  readonly connectionId: string | null
  readonly grantId: string | null
  readonly requester: string
  readonly reason: string | null
  readonly contactId: string | null
  readonly recipientName: string | null
  readonly recipientAddress: string
  readonly recipientReadiness: Readiness
  readonly resource: string | null
  readonly amount: bigint
  /** Route to the owner whatever the grant says. */
  readonly forceOwner: boolean
  /** The reason the owner lane carries when `forceOwner` (default owner_only). */
  readonly ownerReason?: ApprovalReason | undefined
  /** In the autonomous lane, reserve and claim the submit in the same step (x402: the quote is the go-ahead). */
  readonly claim: boolean
  /** The operation kind the claim records. */
  readonly operationKind: 'transfer' | 'x402_settlement'
  /** x402: the pocket's USDC balance as the chain reports it now; reconciles the stored float before the lane check. */
  readonly pocketBalance: bigint | null
  /** CAIP-2 network of the stage (default stellar:testnet). */
  readonly network?: 'stellar:testnet' | 'stellar:pubnet'
  readonly feeCeilings?: FeeCeilings
}

export interface Prepared {
  readonly intent: PaymentIntent
  readonly grant: SpendingGrant | undefined
  /** False when the idempotency key already had this intent. */
  readonly created: boolean
  /** Set when this call reserved and claimed the submit: the caller must call the chain, then `settle`. */
  readonly operationId: string | null
  /** x402: how much to pull into the pocket before paying (0 when the pocket covers the price). */
  readonly pullAmount: bigint
}

export type Claim =
  | {
      readonly _tag: 'Claimed'
      readonly intent: PaymentIntent
      readonly grant: SpendingGrant | undefined
      readonly operationId: string
    }
  | {
      readonly _tag: 'NotClaimed'
      readonly intent: PaymentIntent
      readonly why: 'already' | 'owner_lane' | 'expired' | 'rerouted'
    }

/** What the chain did with a claimed intent. `pulled` is what the onchain policy counted against the grant. */
export type Outcome =
  | {
      readonly _tag: 'Confirmed'
      readonly settlement: Receipt
      readonly feePaidBy: 'relayer' | 'facilitator'
      readonly pull: Receipt | null
      readonly pulled: bigint
    }
  | {
      readonly _tag: 'Failed'
      readonly kind: ChainErrorKind
      readonly message: string
      readonly pull: Receipt | null
      readonly pulled: bigint
    }
  /** The chain did not say (timeout after submit): keep the claim and the reservation, never resubmit. */
  | { readonly _tag: 'Unknown'; readonly message: string; readonly tx: string | null }

export interface LedgerShape {
  readonly prepareIntent: (walletId: string, input: NewIntent) => Effect.Effect<Prepared, LedgerError>
  readonly claimAutonomous: (
    walletId: string,
    input: { readonly intentId: string; readonly connectionId: string },
  ) => Effect.Effect<Claim, LedgerError>
  readonly claimOwner: (walletId: string, input: { readonly intentId: string }) => Effect.Effect<Claim, LedgerError>
  readonly settle: (
    walletId: string,
    input: { readonly intentId: string; readonly operationId: string; readonly outcome: Outcome },
  ) => Effect.Effect<PaymentIntent, LedgerError>
  /** Remember the owner-lane invocation the approval page prepared (only while awaiting approval). */
  readonly setApprovalPrepared: (
    walletId: string,
    input: { readonly intentId: string; readonly prepared: string },
  ) => Effect.Effect<PaymentIntent, LedgerError>
  /** x402 the owner funded: approved → submitted for the purchase from the pocket (the agent's retry). */
  readonly claimFunded: (
    walletId: string,
    input: { readonly intentId: string; readonly connectionId: string },
  ) => Effect.Effect<Claim, LedgerError>
  /** CAP-73 claim: remember the prepared router invocation (only while awaiting approval). */
  readonly setClaimPrepared: (
    walletId: string,
    input: { readonly intentId: string; readonly prepared: string },
  ) => Effect.Effect<PaymentIntent, LedgerError>
  /** The owner's passkey signed the sender side of a claim: awaiting_approval → approved, the assertion kept. */
  readonly approveClaim: (
    walletId: string,
    input: { readonly intentId: string; readonly assertion: string },
  ) => Effect.Effect<Claim, LedgerError>
  /** The recipient signed: approved → submitted (the submit claim); returns the stored owner assertion. */
  readonly claimApproved: (walletId: string, input: { readonly intentId: string }) => Effect.Effect<Claim, LedgerError>
  /** Service-side revoke: the connection and its grant stop at once; the rule's removal is pending. */
  readonly revokeConnection: (
    walletId: string,
    input: { readonly connectionId: string },
  ) => Effect.Effect<SpendingGrant | undefined, LedgerError>
  readonly recordRuleRemoved: (
    walletId: string,
    input: { readonly grantId: string; readonly tx: string },
  ) => Effect.Effect<SpendingGrant, LedgerError>
  readonly recordSweep: (
    walletId: string,
    input: { readonly grantId: string; readonly receipt: Receipt },
  ) => Effect.Effect<void, LedgerError>
  /**
   * connection_grant_update: the owner's passkey installed a new rule for the connection; its grant now points at it
   * (new key, new allowance and expiry, counters from zero). Refused while a payment holds a reservation, or when the
   * grant moved to another rule meanwhile. The old rule stays on the account until the owner removes it.
   */
  readonly replaceGrant: (walletId: string, input: ReplaceGrant) => Effect.Effect<SpendingGrant, LedgerError>
  /**
   * A person link was claimed (person-link.ts): the link key moved the amount under the link's own rule, which the
   * owner's passkey installed. Records it as a confirmed owner-lane payment (intent, operation, receipt) with its
   * events, once per link.
   */
  readonly recordLinkPayment: (walletId: string, input: LinkPayment) => Effect.Effect<PaymentIntent, LedgerError>
}

export interface LinkPayment {
  readonly linkId: string
  readonly scope: string
  readonly connectionId: string | null
  readonly requester: string
  readonly reason: string | null
  readonly recipientName: string
  readonly recipientAddress: string
  readonly amount: bigint
  readonly network: 'stellar:testnet' | 'stellar:pubnet'
  readonly settlement: Receipt
}

export interface ReplaceGrant {
  readonly grantId: string
  /** The rule the grant pointed at when the owner opened the page. */
  readonly expectRuleId: number
  readonly ruleId: number
  readonly signerPublicKey: string
  readonly signerKeyRef: string
  readonly total: bigint
  readonly validUntil: string
  readonly validUntilLedger: number
  readonly installTx: string
  readonly pocketAddress: string | null
}

export class Ledger extends Context.Service<Ledger, LedgerShape>()('hm/Ledger') {}

const storage = (error: DbError) =>
  new LedgerError({ reason: 'storage', message: `${error.operation}: ${error.message}` })
const notFound = (what: string) => new LedgerError({ reason: 'not_found', message: what })

const loadIntent = (intentId: string) =>
  first(sql('SELECT * FROM payment_intents WHERE id = ?', intentId), toIntent).pipe(
    Effect.flatMap(intent =>
      intent === undefined ? Effect.fail(notFound(`no payment ${intentId}`)) : Effect.succeed(intent),
    ),
  )
const loadGrant = (grantId: string | null) =>
  grantId === null
    ? Effect.succeed(undefined)
    : first(sql('SELECT * FROM spending_grants WHERE id = ?', grantId), toGrant)
const loadGrantOfConnection = (connectionId: string) =>
  first(sql('SELECT * FROM spending_grants WHERE connection_id = ?', connectionId), toGrant)

const setGrantCounters = (
  grant: SpendingGrant,
  changes: { spent?: bigint; reserved?: bigint; first?: boolean; pocket?: bigint },
) =>
  sql(
    'UPDATE spending_grants SET spent = ?, reserved = ?, first_payment_done = ?, pocket_balance = ? WHERE id = ?',
    (changes.spent ?? grant.spent).toString(),
    (changes.reserved ?? grant.reserved).toString(),
    (changes.first ?? grant.first_payment_done) ? 1 : 0,
    (changes.pocket ?? grant.pocket_balance).toString(),
    grant.id,
  )

const setIntentStatus = (
  intentId: string,
  fields: {
    status: PaymentIntent['status']
    lane?: Lane
    approvalReason?: ApprovalReason
    failure?: string | null
    expiresAt?: string
    feeCeiling?: number
    now: string
  },
) =>
  sql(
    `UPDATE payment_intents SET status = ?, lane = COALESCE(?, lane), approval_reason = COALESCE(?, approval_reason),
       failure = ?, expires_at = COALESCE(?, expires_at), fee_ceiling_xlm = COALESCE(?, fee_ceiling_xlm), updated_at = ?
       WHERE id = ?`,
    fields.status,
    fields.lane ?? null,
    fields.approvalReason ?? null,
    fields.failure ?? null,
    fields.expiresAt ?? null,
    fields.feeCeiling ?? null,
    fields.now,
    intentId,
  )

const reserveAndClaim = (
  intent: { id: string; amount: bigint },
  grant: SpendingGrant,
  operationKind: string,
  now: string,
) =>
  Effect.map(randomId('op'), operationId => ({
    operationId,
    statements: [
      insert('payment_reservations', {
        intent_id: intent.id,
        grant_id: grant.id,
        amount: intent.amount,
        state: 'held',
        created_at: now,
        updated_at: now,
      }),
      setGrantCounters(grant, { reserved: grant.reserved + intent.amount }),
      insert('operations', {
        id: operationId,
        intent_id: intent.id,
        kind: operationKind,
        tx_hash: null,
        submitted_at: now,
        ledger: null,
        status: 'submitted',
        raw_result: null,
      }),
    ],
  }))

// MCP Events: journal rows appended to the batches below, so an event exists exactly when its state change does.

/** approval.needed for an intent that now waits for the owner (events/emit.ts). */
const approvalEvent = (
  walletId: string,
  intent: {
    readonly id: string
    readonly kind: IntentKind
    readonly network: string
    readonly amount: bigint
    readonly recipient_address: string
    readonly recipient_name: string | null
  },
  expiresAt: string,
  now: string,
) =>
  journalStatement(
    approvalNeeded({
      walletId,
      network: intent.network,
      paymentId: intent.id,
      purchase: intent.kind !== 'payment',
      amount: intent.amount,
      to: { address: intent.recipient_address, contact_name: intent.recipient_name },
      expiresAt,
      occurredAt: now,
    }),
  )

/** The owner's saved name for `address`, if any. */
const contactNameOf = (ownerId: string, address: string) =>
  first(
    sql(
      `SELECT c.display_name AS name FROM contacts c JOIN contact_destinations d ON d.contact_id = c.id
         WHERE c.owner_id = ? AND d.address = ? ORDER BY c.created_at LIMIT 1`,
      ownerId,
      address,
    ),
    row => Effect.succeed(String(row['name'])),
  ).pipe(Effect.map(name => name ?? null))

/**
 * The events of a confirmed payment, read before its batch: payment.settled for this wallet; payment.received for
 * the recipient when it is another Nod wallet (named as that owner saved the payer, never by this wallet's name);
 * allowance.changed once the grant has less than a fifth left.
 */
const confirmedEvents = Effect.fnUntraced(function* (
  walletId: string,
  intent: PaymentIntent,
  settlement: Receipt,
  grantAfter: SpendingGrant | undefined,
  now: string,
) {
  const statements: Array<SqlStatement> = [
    journalStatement(
      paymentSettled({
        walletId,
        network: intent.network,
        paymentId: intent.id,
        status: 'confirmed',
        amount: intent.amount,
        to: { address: intent.recipient_address, contact_name: intent.recipient_name },
        tx: settlement.tx,
        explorer: settlement.explorer,
        occurredAt: now,
      }),
    ),
  ]
  if (intent.kind === 'payment') {
    const payer = yield* first(sql('SELECT contract_id FROM wallets WHERE id = ?', walletId), row =>
      Effect.succeed(String(row['contract_id'])),
    )
    const recipient = yield* first(
      sql('SELECT id, owner_id, network FROM wallets WHERE contract_id = ?', intent.recipient_address),
      row =>
        Effect.succeed({ id: String(row['id']), ownerId: String(row['owner_id']), network: String(row['network']) }),
    )
    if (payer !== undefined && recipient !== undefined)
      statements.push(
        journalStatement(
          paymentReceived({
            walletId: recipient.id,
            network: recipient.network,
            amount: intent.amount,
            from: { address: payer, contact_name: yield* contactNameOf(recipient.ownerId, payer) },
            tx: settlement.tx,
            explorer: settlement.explorer,
            occurredAt: now,
          }),
        ),
      )
    // A payment request this payment answers (request_pay linked it): paid, and its requester hears about it.
    const request = yield* first(
      sql(
        `SELECT r.id, r.requester_wallet_id, w.owner_id FROM payment_requests r JOIN wallets w ON w.id = r.requester_wallet_id
           WHERE r.intent_id = ? AND r.status = 'open'`,
        intent.id,
      ),
      row =>
        Effect.succeed({
          id: String(row['id']),
          requesterWalletId: String(row['requester_wallet_id']),
          requesterOwnerId: String(row['owner_id']),
        }),
    )
    if (request !== undefined && payer !== undefined)
      statements.push(
        sql(
          "UPDATE payment_requests SET status = 'paid', updated_at = ? WHERE id = ? AND status = 'open'",
          now,
          request.id,
        ),
        journalStatement(
          requestAnswered({
            walletId: request.requesterWalletId,
            network: intent.network,
            requestId: request.id,
            status: 'paid',
            amount: intent.amount,
            by: { address: payer, contact_name: yield* contactNameOf(request.requesterOwnerId, payer) },
            tx: settlement.tx,
            explorer: settlement.explorer,
            url: `/approve/request/${request.id}`,
            occurredAt: now,
          }),
        ),
      )
  }
  if (grantAfter !== undefined && grantAfter.total > 0n && remainingOf(grantAfter) * 5n < grantAfter.total)
    statements.push(
      journalStatement(
        allowanceChanged({
          walletId,
          network: intent.network,
          connectionId: grantAfter.connection_id,
          grantId: grantAfter.id,
          change: 'low',
          allowance: grantAfter.total,
          remaining: remainingOf(grantAfter),
          validUntil: grantAfter.valid_until,
          occurredAt: now,
        }),
      ),
    )
  return statements
})

const prepareIntent = Effect.fnUntraced(function* (walletId: string, input: NewIntent) {
  const existing = yield* first(
    sql(
      'SELECT * FROM payment_intents WHERE wallet_id = ? AND scope = ? AND idempotency_key = ?',
      walletId,
      input.scope,
      input.idempotencyKey,
    ),
    toIntent,
  )
  if (existing !== undefined) {
    const fingerprint = yield* first(
      sql('SELECT request_fingerprint FROM payment_intents WHERE id = ?', existing.id),
      row => Effect.succeed(String(row['request_fingerprint'])),
    )
    if (fingerprint !== input.fingerprint)
      return yield* new LedgerError({
        reason: 'idempotency_conflict',
        message: `idempotency key ${input.idempotencyKey} was used for a different request`,
      })
    return {
      intent: existing,
      grant: yield* loadGrant(existing.grant_id),
      created: false,
      operationId: null,
      pullAmount: 0n,
    }
  }
  if (input.pocketBalance !== null && input.grantId !== null)
    yield* write(
      sql('UPDATE spending_grants SET pocket_balance = ? WHERE id = ?', input.pocketBalance.toString(), input.grantId),
    )
  const grant = yield* loadGrant(input.grantId)
  const nowMs = yield* nowMillis
  const now = yield* nowIso
  const { lane, reason: approvalReason } = laneDecision({
    grant,
    kind: input.kind,
    amount: input.amount,
    readiness: input.recipientReadiness,
    nowMs,
    forceOwner: input.forceOwner,
    ownerReason: input.ownerReason,
  })
  const id = input.id ?? (yield* randomId('pi'))
  const claim = lane === 'autonomous' && input.claim && grant !== undefined
  const status: PaymentIntent['status'] = lane === 'owner' ? 'awaiting_approval' : claim ? 'submitted' : 'prepared'
  const row = {
    id,
    scope: input.scope,
    idempotency_key: input.idempotencyKey,
    request_fingerprint: input.fingerprint,
    kind: input.kind,
    wallet_id: walletId,
    connection_id: input.connectionId,
    grant_id: input.grantId,
    requester: input.requester,
    reason: input.reason,
    contact_id: input.contactId,
    recipient_name: input.recipientName,
    recipient_address: input.recipientAddress,
    recipient_readiness: input.recipientReadiness,
    resource: input.resource,
    asset: 'USDC',
    network: input.network ?? 'stellar:testnet',
    amount: input.amount,
    fee_ceiling_xlm: feeCeilingFor(lane, grant, input.feeCeilings),
    lane,
    approval_reason: approvalReason,
    status,
    failure: null,
    approval_prepared: null,
    claim_prepared: null,
    recipient_signed_entry: null,
    expires_at: yield* isoIn(INTENT_TTL_MS),
    created_at: now,
    updated_at: now,
  }
  const claimed = claim ? yield* reserveAndClaim({ id, amount: input.amount }, grant, input.operationKind, now) : null
  yield* write(
    insert('payment_intents', row),
    ...(claimed?.statements ?? []),
    ...(status === 'awaiting_approval'
      ? [
          approvalEvent(
            walletId,
            { ...row, kind: input.kind, recipient_name: input.recipientName },
            row.expires_at,
            now,
          ),
        ]
      : []),
  )
  return {
    intent: yield* loadIntent(id),
    grant: yield* loadGrant(input.grantId),
    created: true,
    operationId: claimed?.operationId ?? null,
    pullAmount: claim && input.kind !== 'payment' ? pullFor(grant, input.amount) : 0n,
  }
})

const claimAutonomous = Effect.fnUntraced(function* (
  _walletId: string,
  input: { readonly intentId: string; readonly connectionId: string },
) {
  const intent = yield* loadIntent(input.intentId)
  if (intent.connection_id !== input.connectionId) return yield* notFound(`no payment ${input.intentId}`)
  const nowMs = yield* nowMillis
  const now = yield* nowIso
  if (intent.status !== 'prepared') return { _tag: 'NotClaimed' as const, intent, why: 'already' as const }
  if (effectiveStatus(intent, nowMs) === 'expired') {
    yield* write(setIntentStatus(intent.id, { status: 'expired', now }))
    return { _tag: 'NotClaimed' as const, intent: yield* loadIntent(intent.id), why: 'expired' as const }
  }
  if (intent.lane === 'owner') return { _tag: 'NotClaimed' as const, intent, why: 'owner_lane' as const }
  const grant = yield* loadGrant(intent.grant_id)
  const { lane, reason } = laneDecision({
    grant,
    kind: intent.kind,
    amount: intent.amount,
    readiness: intent.recipient_readiness,
    nowMs,
    forceOwner: false,
  })
  if (lane === 'owner' || grant === undefined) {
    // The grant changed since prepare (spent elsewhere, revoked, expired): the owner decides now.
    const expiresAt = yield* isoIn(INTENT_TTL_MS)
    yield* write(
      setIntentStatus(intent.id, {
        status: 'awaiting_approval',
        lane: 'owner',
        approvalReason: reason ?? 'no_allowance',
        failure: 'the allowance no longer covers this payment',
        expiresAt,
        feeCeiling: FEE_CEILING_OWNER_PAYMENT_XLM,
        now,
      }),
      approvalEvent(intent.wallet_id, intent, expiresAt, now),
    )
    return { _tag: 'NotClaimed' as const, intent: yield* loadIntent(intent.id), why: 'rerouted' as const }
  }
  const claimed = yield* reserveAndClaim(intent, grant, 'transfer', now)
  yield* write(setIntentStatus(intent.id, { status: 'submitted', now }), ...claimed.statements)
  return {
    _tag: 'Claimed' as const,
    intent: yield* loadIntent(intent.id),
    grant: yield* loadGrant(intent.grant_id),
    operationId: claimed.operationId,
  }
})

const claimOwner = Effect.fnUntraced(function* (_walletId: string, input: { readonly intentId: string }) {
  const intent = yield* loadIntent(input.intentId)
  const nowMs = yield* nowMillis
  const now = yield* nowIso
  if (intent.status !== 'awaiting_approval') return { _tag: 'NotClaimed' as const, intent, why: 'already' as const }
  if (effectiveStatus(intent, nowMs) === 'expired') {
    yield* write(setIntentStatus(intent.id, { status: 'expired', now }))
    return { _tag: 'NotClaimed' as const, intent: yield* loadIntent(intent.id), why: 'expired' as const }
  }
  const operationId = yield* randomId('op')
  yield* write(
    setIntentStatus(intent.id, { status: 'submitted', now }),
    insert('operations', {
      id: operationId,
      intent_id: intent.id,
      kind: 'owner_transfer',
      tx_hash: null,
      submitted_at: now,
      ledger: null,
      status: 'submitted',
      raw_result: null,
    }),
  )
  return {
    _tag: 'Claimed' as const,
    intent: yield* loadIntent(intent.id),
    grant: yield* loadGrant(intent.grant_id),
    operationId,
  }
})

const pullOperation = (intentId: string, pull: Receipt, now: string) =>
  Effect.map(randomId('op'), id =>
    insert('operations', {
      id,
      intent_id: intentId,
      kind: 'pocket_pull',
      tx_hash: pull.tx,
      submitted_at: now,
      ledger: pull.ledger,
      status: 'confirmed',
      raw_result: JSON.stringify({ feeStroops: pull.feeStroops.toString(), feePayer: pull.feePayer }),
    }),
  )

const settle = Effect.fnUntraced(function* (
  walletId: string,
  input: { readonly intentId: string; readonly operationId: string; readonly outcome: Outcome },
) {
  const intent = yield* loadIntent(input.intentId)
  if (intent.status !== 'submitted') return intent
  const now = yield* nowIso
  const grant = yield* loadGrant(intent.grant_id)
  const reservation = yield* first(
    sql("SELECT * FROM payment_reservations WHERE intent_id = ? AND state = 'held'", intent.id),
    toReservation,
  )
  const held = reservation?.amount ?? 0n
  const outcome = input.outcome
  if (outcome._tag === 'Unknown') {
    yield* write(
      sql(
        "UPDATE operations SET status = 'unknown', tx_hash = COALESCE(?, tx_hash), raw_result = ? WHERE id = ?",
        outcome.tx,
        JSON.stringify({ message: outcome.message }),
        input.operationId,
      ),
    )
    return intent
  }
  const operationKind = yield* first(sql('SELECT kind FROM operations WHERE id = ?', input.operationId), row =>
    Effect.succeed(String(row['kind'])),
  )
  // An over-allowance x402 purchase the owner approved: their passkey sent the price into the pocket (outside the
  // policy). The purchase itself happens when the agent retries with the same key.
  if (intent.kind !== 'payment' && operationKind === 'owner_transfer' && outcome._tag === 'Confirmed') {
    yield* write(
      sql(
        "UPDATE operations SET status = 'confirmed', tx_hash = ?, ledger = ?, raw_result = ? WHERE id = ?",
        outcome.settlement.tx,
        outcome.settlement.ledger,
        JSON.stringify({ funded_pocket: true, feeStroops: outcome.settlement.feeStroops.toString() }),
        input.operationId,
      ),
      sql(
        "UPDATE payment_intents SET status = 'approved', failure = NULL, updated_at = ? WHERE id = ?",
        now,
        intent.id,
      ),
      ...(grant === undefined ? [] : [setGrantCounters(grant, { pocket: grant.pocket_balance + intent.amount })]),
    )
    return yield* loadIntent(intent.id)
  }
  // The funded purchase failed at the seller or facilitator: the price is still in the pocket, retry later.
  if (
    intent.kind !== 'payment' &&
    operationKind === 'x402_settlement' &&
    intent.lane === 'owner' &&
    outcome._tag === 'Failed'
  ) {
    yield* write(
      sql(
        "UPDATE operations SET status = 'failed', raw_result = ? WHERE id = ?",
        JSON.stringify({ kind: outcome.kind, message: outcome.message }),
        input.operationId,
      ),
      sql(
        "UPDATE payment_intents SET status = 'approved', failure = ?, updated_at = ? WHERE id = ?",
        `${outcome.kind}: ${outcome.message}`,
        now,
        intent.id,
      ),
    )
    return yield* loadIntent(intent.id)
  }
  const pulled = outcome.pulled
  // x402: the pull lands in the pocket, the settlement takes the price out of it.
  const pocketDelta = intent.kind === 'payment' ? 0n : pulled - (outcome._tag === 'Confirmed' ? intent.amount : 0n)
  const counters =
    grant === undefined || (held === 0n && pulled === 0n && pocketDelta === 0n)
      ? []
      : [
          setGrantCounters(grant, {
            spent: grant.spent + pulled,
            reserved: grant.reserved - held,
            first: grant.first_payment_done || pulled > 0n,
            pocket: grant.pocket_balance + pocketDelta,
          }),
        ]
  const release =
    reservation === undefined
      ? []
      : [
          sql(
            'UPDATE payment_reservations SET state = ?, updated_at = ? WHERE intent_id = ?',
            outcome._tag === 'Confirmed' ? 'consumed' : 'released',
            now,
            intent.id,
          ),
        ]
  const pullOp = outcome.pull === null ? [] : [yield* pullOperation(intent.id, outcome.pull, now)]
  if (outcome._tag === 'Confirmed') {
    const settlement = outcome.settlement
    const receiptId = yield* randomId('rc')
    const events = yield* confirmedEvents(
      walletId,
      intent,
      settlement,
      grant === undefined
        ? undefined
        : {
            ...grant,
            spent: grant.spent + pulled,
            reserved: grant.reserved - held,
            pocket_balance: grant.pocket_balance + pocketDelta,
          },
      now,
    )
    yield* write(
      ...counters,
      ...release,
      ...pullOp,
      sql(
        "UPDATE operations SET status = 'confirmed', tx_hash = ?, ledger = ?, raw_result = ? WHERE id = ?",
        settlement.tx,
        settlement.ledger,
        JSON.stringify({ feeStroops: settlement.feeStroops.toString(), feePayer: settlement.feePayer }),
        input.operationId,
      ),
      setIntentStatus(intent.id, { status: 'confirmed', now }),
      insert('receipts', {
        id: receiptId,
        operation_id: input.operationId,
        intent_id: intent.id,
        wallet_id: walletId,
        connection_id: intent.connection_id,
        kind: intent.kind,
        amount: intent.amount,
        asset: intent.asset,
        fee_stroops: settlement.feeStroops + (outcome.pull?.feeStroops ?? 0n),
        fee_paid_by: outcome.feePaidBy,
        fee_payer: settlement.feePayer,
        recipient_name: intent.recipient_name,
        recipient_address: intent.recipient_address,
        tx_hash: settlement.tx,
        ledger: settlement.ledger,
        confirmed_at: now,
        explorer_url: settlement.explorer,
        pull_tx_hash: outcome.pull?.tx ?? null,
        pull_explorer_url: outcome.pull?.explorer ?? null,
        requester: intent.requester,
        lane: intent.lane,
        resource: intent.resource,
      }),
      ...(intent.contact_id === null
        ? []
        : [
            sql(
              'UPDATE contact_destinations SET last_paid_at = ? WHERE contact_id = ? AND address = ?',
              now,
              intent.contact_id,
              intent.recipient_address,
            ),
          ]),
      ...events,
    )
    return yield* loadIntent(intent.id)
  }
  // Failed. The policy refusing (#3221) in the autonomous lane sends the intent to the owner: nothing was submitted.
  // An owner-lane failure goes back to awaiting approval, so the owner can try again until the intent expires.
  const toOwner = outcome.kind === 'limit_exhausted' || intent.lane === 'owner'
  const grantStatus =
    grant !== undefined && (outcome.kind === 'removed' || outcome.kind === 'expired')
      ? [
          sql(
            'UPDATE spending_grants SET status = ? WHERE id = ?',
            outcome.kind === 'removed' ? 'revoked' : 'expired',
            grant.id,
          ),
        ]
      : []
  const ownerExpiry = intent.lane === 'owner' ? intent.expires_at : yield* isoIn(INTENT_TTL_MS)
  yield* write(
    ...counters,
    ...release,
    ...pullOp,
    ...grantStatus,
    sql(
      "UPDATE operations SET status = 'failed', raw_result = ? WHERE id = ?",
      JSON.stringify({ kind: outcome.kind, message: outcome.message }),
      input.operationId,
    ),
    toOwner
      ? setIntentStatus(intent.id, {
          status: 'awaiting_approval',
          lane: 'owner',
          failure: `${outcome.kind}: ${outcome.message}`,
          expiresAt: ownerExpiry,
          feeCeiling: FEE_CEILING_OWNER_PAYMENT_XLM,
          now,
        })
      : setIntentStatus(intent.id, { status: 'failed', failure: `${outcome.kind}: ${outcome.message}`, now }),
    toOwner
      ? approvalEvent(walletId, intent, ownerExpiry, now)
      : journalStatement(
          paymentSettled({
            walletId,
            network: intent.network,
            paymentId: intent.id,
            status: 'failed',
            amount: intent.amount,
            to: { address: intent.recipient_address, contact_name: intent.recipient_name },
            tx: null,
            explorer: null,
            occurredAt: now,
          }),
        ),
  )
  return yield* loadIntent(intent.id)
})

const setApprovalPrepared = Effect.fnUntraced(function* (
  _walletId: string,
  input: { readonly intentId: string; readonly prepared: string },
) {
  const intent = yield* loadIntent(input.intentId)
  if (intent.status !== 'awaiting_approval')
    return yield* new LedgerError({ reason: 'invalid_state', message: `payment ${intent.id} is ${intent.status}` })
  yield* write(
    sql(
      'UPDATE payment_intents SET approval_prepared = ?, updated_at = ? WHERE id = ?',
      input.prepared,
      yield* nowIso,
      intent.id,
    ),
  )
  return intent
})

const setClaimPrepared = Effect.fnUntraced(function* (
  _walletId: string,
  input: { readonly intentId: string; readonly prepared: string },
) {
  const intent = yield* loadIntent(input.intentId)
  if (intent.status !== 'awaiting_approval')
    return yield* new LedgerError({ reason: 'invalid_state', message: `payment ${intent.id} is ${intent.status}` })
  yield* write(
    sql(
      'UPDATE payment_intents SET claim_prepared = ?, updated_at = ? WHERE id = ?',
      input.prepared,
      yield* nowIso,
      intent.id,
    ),
  )
  return intent
})

const approveClaim = Effect.fnUntraced(function* (
  _walletId: string,
  input: { readonly intentId: string; readonly assertion: string },
) {
  const intent = yield* loadIntent(input.intentId)
  const nowMs = yield* nowMillis
  const now = yield* nowIso
  if (intent.status !== 'awaiting_approval') return { _tag: 'NotClaimed' as const, intent, why: 'already' as const }
  if (effectiveStatus(intent, nowMs) === 'expired') {
    yield* write(setIntentStatus(intent.id, { status: 'expired', now }))
    return { _tag: 'NotClaimed' as const, intent: yield* loadIntent(intent.id), why: 'expired' as const }
  }
  yield* write(
    sql(
      "UPDATE payment_intents SET status = 'approved', approval_prepared = ?, failure = NULL, updated_at = ? WHERE id = ?",
      input.assertion,
      now,
      intent.id,
    ),
  )
  return { _tag: 'Claimed' as const, intent: yield* loadIntent(intent.id), grant: undefined, operationId: '' }
})

const claimFunded = Effect.fnUntraced(function* (
  _walletId: string,
  input: { readonly intentId: string; readonly connectionId: string },
) {
  const intent = yield* loadIntent(input.intentId)
  if (intent.connection_id !== input.connectionId) return yield* notFound(`no payment ${input.intentId}`)
  if (intent.status !== 'approved' || intent.kind === 'payment')
    return { _tag: 'NotClaimed' as const, intent, why: 'already' as const }
  const now = yield* nowIso
  const operationId = yield* randomId('op')
  yield* write(
    setIntentStatus(intent.id, { status: 'submitted', now }),
    insert('operations', {
      id: operationId,
      intent_id: intent.id,
      kind: 'x402_settlement',
      tx_hash: null,
      submitted_at: now,
      ledger: null,
      status: 'submitted',
      raw_result: null,
    }),
  )
  return {
    _tag: 'Claimed' as const,
    intent: yield* loadIntent(intent.id),
    grant: yield* loadGrant(intent.grant_id),
    operationId,
  }
})

const claimApproved = Effect.fnUntraced(function* (_walletId: string, input: { readonly intentId: string }) {
  const intent = yield* loadIntent(input.intentId)
  if (intent.status !== 'approved') return { _tag: 'NotClaimed' as const, intent, why: 'already' as const }
  const now = yield* nowIso
  const operationId = yield* randomId('op')
  yield* write(
    setIntentStatus(intent.id, { status: 'submitted', now }),
    insert('operations', {
      id: operationId,
      intent_id: intent.id,
      kind: 'claim',
      tx_hash: null,
      submitted_at: now,
      ledger: null,
      status: 'submitted',
      raw_result: null,
    }),
  )
  return { _tag: 'Claimed' as const, intent: yield* loadIntent(intent.id), grant: undefined, operationId }
})

const revokeConnection = Effect.fnUntraced(function* (walletId: string, input: { readonly connectionId: string }) {
  const now = yield* nowIso
  const grant = yield* loadGrantOfConnection(input.connectionId)
  const network = yield* first(sql('SELECT network FROM wallets WHERE id = ?', walletId), row =>
    Effect.succeed(String(row['network'])),
  )
  const nowMs = yield* nowMillis
  yield* write(
    sql(
      "UPDATE connections SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?) WHERE id = ?",
      now,
      input.connectionId,
    ),
    ...(grant === undefined
      ? []
      : [
          sql(
            `UPDATE spending_grants SET status = 'revoked',
               rule_status = CASE rule_status WHEN 'removed' THEN 'removed' ELSE 'removal_pending' END WHERE id = ?`,
            grant.id,
          ),
          sql(
            `UPDATE payment_intents SET status = 'failed', failure = 'connection revoked', updated_at = ?
               WHERE grant_id = ? AND status = 'prepared'`,
            now,
            grant.id,
          ),
          journalStatement(
            allowanceChanged({
              walletId,
              network: network ?? 'stellar:testnet',
              connectionId: input.connectionId,
              grantId: grant.id,
              change: 'revoked',
              allowance: grant.total,
              remaining: 0n,
              validUntil: grant.valid_until,
              occurredAt: now,
            }),
          ),
        ]),
    terminateConnectionStatement(input.connectionId, nowMs),
  )
  return yield* loadGrantOfConnection(input.connectionId)
})

const recordRuleRemoved = Effect.fnUntraced(function* (
  _walletId: string,
  input: { readonly grantId: string; readonly tx: string },
) {
  const now = yield* nowIso
  const id = yield* randomId('op')
  yield* write(
    sql(
      "UPDATE spending_grants SET rule_status = 'removed', status = 'revoked', remove_tx = ? WHERE id = ?",
      input.tx,
      input.grantId,
    ),
    insert('operations', {
      id,
      intent_id: null,
      kind: 'rule_remove',
      tx_hash: input.tx,
      submitted_at: now,
      ledger: null,
      status: 'confirmed',
      raw_result: JSON.stringify({ grant_id: input.grantId }),
    }),
  )
  const grant = yield* loadGrant(input.grantId)
  return grant === undefined ? yield* notFound(`no grant ${input.grantId}`) : grant
})

const recordSweep = Effect.fnUntraced(function* (
  _walletId: string,
  input: { readonly grantId: string; readonly receipt: Receipt },
) {
  const id = yield* randomId('op')
  yield* write(
    insert('operations', {
      id,
      intent_id: null,
      kind: 'pocket_sweep',
      tx_hash: input.receipt.tx,
      submitted_at: yield* nowIso,
      ledger: input.receipt.ledger,
      status: 'confirmed',
      raw_result: JSON.stringify({ grant_id: input.grantId, feeStroops: input.receipt.feeStroops.toString() }),
    }),
    sql("UPDATE spending_grants SET pocket_balance = '0', sweep_tx = ? WHERE id = ?", input.receipt.tx, input.grantId),
  )
})

const recordLinkPayment = Effect.fnUntraced(function* (walletId: string, input: LinkPayment) {
  const key = `link:${input.linkId}`
  const existing = yield* first(
    sql(
      'SELECT * FROM payment_intents WHERE wallet_id = ? AND scope = ? AND idempotency_key = ?',
      walletId,
      input.scope,
      key,
    ),
    toIntent,
  )
  if (existing !== undefined) return existing
  const now = yield* nowIso
  const id = yield* randomId('pi')
  const operationId = yield* randomId('op')
  const intent: PaymentIntent = {
    id,
    idempotency_key: key,
    kind: 'payment',
    wallet_id: walletId,
    connection_id: input.connectionId,
    grant_id: null,
    requester: input.requester,
    reason: input.reason,
    contact_id: null,
    recipient_name: input.recipientName,
    recipient_address: input.recipientAddress,
    recipient_readiness: 'usdc_ready',
    resource: null,
    asset: 'USDC',
    network: input.network,
    amount: input.amount,
    fee_ceiling_xlm: 0,
    lane: 'owner',
    approval_reason: 'owner_only',
    status: 'confirmed',
    failure: null,
    expires_at: now,
    created_at: now,
    updated_at: now,
  }
  const settlement = input.settlement
  yield* write(
    insert('payment_intents', {
      ...intent,
      scope: input.scope,
      request_fingerprint: `link|${input.linkId}`,
      approval_prepared: null,
      claim_prepared: null,
      recipient_signed_entry: null,
    }),
    insert('operations', {
      id: operationId,
      intent_id: id,
      kind: 'claim',
      tx_hash: settlement.tx,
      submitted_at: now,
      ledger: settlement.ledger,
      status: 'confirmed',
      raw_result: JSON.stringify({ link_id: input.linkId, feeStroops: settlement.feeStroops.toString() }),
    }),
    insert('receipts', {
      id: yield* randomId('rc'),
      operation_id: operationId,
      intent_id: id,
      wallet_id: walletId,
      connection_id: input.connectionId,
      kind: 'payment',
      amount: input.amount,
      asset: 'USDC',
      fee_stroops: settlement.feeStroops,
      fee_paid_by: 'relayer',
      fee_payer: settlement.feePayer,
      recipient_name: input.recipientName,
      recipient_address: input.recipientAddress,
      tx_hash: settlement.tx,
      ledger: settlement.ledger,
      confirmed_at: now,
      explorer_url: settlement.explorer,
      pull_tx_hash: null,
      pull_explorer_url: null,
      requester: input.requester,
      lane: 'owner',
      resource: null,
    }),
    ...(yield* confirmedEvents(walletId, intent, settlement, undefined, now)),
  )
  return yield* loadIntent(id)
})

const replaceGrant = Effect.fnUntraced(function* (_walletId: string, input: ReplaceGrant) {
  const grant = yield* loadGrant(input.grantId)
  if (grant === undefined) return yield* notFound(`no grant ${input.grantId}`)
  if (grant.rule_id !== input.expectRuleId || grant.status !== 'active')
    return yield* new LedgerError({
      reason: 'invalid_state',
      message: 'the allowance changed meanwhile; open the link again',
    })
  if (grant.reserved > 0n)
    return yield* new LedgerError({ reason: 'invalid_state', message: 'a payment is in flight; try again in a minute' })
  const now = yield* nowIso
  yield* write(
    sql(
      `UPDATE spending_grants SET signer_public_key = ?, signer_key_ref = ?, total = ?, spent = '0', reserved = '0',
         valid_until = ?, valid_until_ledger = ?, rule_id = ?, rule_status = 'installed', pocket_address = ?,
         pocket_balance = '0', first_payment_done = 0, status = 'active', install_tx = ?, nod_above = ?,
         remove_tx = NULL, sweep_tx = NULL WHERE id = ?`,
      input.signerPublicKey,
      input.signerKeyRef,
      input.total.toString(),
      input.validUntil,
      input.validUntilLedger,
      input.ruleId,
      input.pocketAddress,
      input.installTx,
      input.total.toString(),
      input.grantId,
    ),
    insert('operations', {
      id: yield* randomId('op'),
      intent_id: null,
      kind: 'rule_install',
      tx_hash: input.installTx,
      submitted_at: now,
      ledger: null,
      status: 'confirmed',
      raw_result: JSON.stringify({ grant_id: input.grantId, replaced_rule_id: grant.rule_id }),
    }),
  )
  const replaced = yield* loadGrant(input.grantId)
  return replaced === undefined ? yield* notFound(`no grant ${input.grantId}`) : replaced
})

/**
 * The ledger over the Db in scope, every operation under one permit: what the wallet's Durable Object hosts, and what
 * tests run directly against SQLite.
 */
export const makeLocalLedger = Effect.gen(function* () {
  const db = yield* Db
  const permit = yield* Semaphore.make(1)
  const serialized =
    <I, A>(op: (walletId: string, input: I) => Effect.Effect<A, LedgerError | DbError, Db>) =>
    (walletId: string, input: I): Effect.Effect<A, LedgerError> =>
      op(walletId, input).pipe(
        Effect.catchTag('DbError', error => Effect.fail(storage(error))),
        Effect.provideService(Db, db),
        Semaphore.withPermits(permit, 1),
      )
  return Ledger.of({
    prepareIntent: serialized(prepareIntent),
    claimAutonomous: serialized(claimAutonomous),
    claimOwner: serialized(claimOwner),
    settle: serialized(settle),
    setApprovalPrepared: serialized(setApprovalPrepared),
    claimFunded: serialized(claimFunded),
    setClaimPrepared: serialized(setClaimPrepared),
    approveClaim: serialized(approveClaim),
    claimApproved: serialized(claimApproved),
    revokeConnection: serialized(revokeConnection),
    recordRuleRemoved: serialized(recordRuleRemoved),
    recordSweep: serialized(recordSweep),
    replaceGrant: serialized(replaceGrant),
    recordLinkPayment: serialized(recordLinkPayment),
  })
})
