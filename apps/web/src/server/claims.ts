import { Effect, Schema } from 'effect'

import {
  Chain,
  fromStroops,
  type PaymentIntent,
  type PaymentView,
  type Readiness,
  type SpendingGrant,
  Stroops,
  type Wallet,
} from '@hm/protocol'

import { isoIn, millisOf, nowIso, randomId } from './clock.ts'
import { DbError } from './db.ts'
import { activateWallet } from './deposit.ts'
import { feeCeilingFor, laneDecision, Ledger, type Outcome } from './ledger.ts'
import { Network, transferFeeCeiling } from './network.ts'
import { logFailure } from './observe/log.ts'
import { first, insert, sql, toIntent, write } from './rows.ts'
import { createContact, grantOfConnection, receiptOfIntent, searchContacts, walletById } from './store.ts'
import { grantRemaining, paymentView } from './views.ts'

/**
 * Claim link v2 (K2, 2026-10-25 18:05 UTC). "1 USDC for Jan" is an intent without a destination: payment_prepare with
 * recipient "new" stores the link, and nothing moves. Whoever opens it chooses where the money goes (a new Nod wallet,
 * deposit-first; their own Nod wallet; or a Stellar address, today's CAP-73 path when it has no USDC trustline). Only
 * then does Nod create the payment intent, and it takes the normal lanes: inside what is left of the allowance the AI
 * app's key pays alone, at once; past it the sender's passkey nods on the approval page. Nod never holds the money,
 * and an unclaimed link pays nothing and expires.
 */

/** How long a link can be claimed. The payment intent it then creates has the usual 30 minutes for a nod. */
export const CLAIM_LINK_TTL_MS = 7 * 24 * 3600 * 1000

export const claimLinkUrl = (origin: string, id: string) => `${origin}/claim/${id}`
export const isClaimLinkId = (id: string) => /^cl_[0-9a-f]{32}$/u.test(id)

const ADDRESS = /^(?:[CG][A-Z2-7]{55}|M[A-Z2-7]{68})$/u

export const ClaimLink = Schema.Struct({
  id: Schema.String,
  wallet_id: Schema.String,
  connection_id: Schema.NullOr(Schema.String),
  scope: Schema.String,
  idempotency_key: Schema.String,
  request_fingerprint: Schema.String,
  requester: Schema.String,
  recipient_name: Schema.String,
  reason: Schema.NullOr(Schema.String),
  amount: Stroops,
  network: Schema.Literals(['stellar:testnet', 'stellar:pubnet']),
  /** open, claimed (a destination is set); a person link (kind person) also awaiting_nod and revoked. */
  status: Schema.Literals(['open', 'claimed', 'awaiting_nod', 'revoked']),
  destination_kind: Schema.NullOr(Schema.Literals(['new_wallet', 'wallet', 'address'])),
  destination_address: Schema.NullOr(Schema.String),
  destination_wallet_id: Schema.NullOr(Schema.String),
  intent_id: Schema.NullOr(Schema.String),
  expires_at: Schema.String,
  claimed_at: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  // 0011: a person link (person-link.ts), an allowance for a person on the sender's account.
  kind: Schema.optionalKey(Schema.NullOr(Schema.Literal('person'))),
  signer_public_key: Schema.optionalKey(Schema.NullOr(Schema.String)),
  rule_id: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  valid_until_ledger: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  install_tx: Schema.optionalKey(Schema.NullOr(Schema.String)),
  pending_grant_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  transfer_prepared: Schema.optionalKey(Schema.NullOr(Schema.String)),
  claim_tx: Schema.optionalKey(Schema.NullOr(Schema.String)),
  remove_tx: Schema.optionalKey(Schema.NullOr(Schema.String)),
  revoked_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type ClaimLink = typeof ClaimLink.Type

export class ClaimError extends Schema.TaggedError<ClaimError>()('ClaimError', {
  /**
   * not_found, expired; taken (claimed for another destination); conflict (the idempotency key named another link);
   * bad_destination (no such account, the sender's own wallet, not an address); unavailable (chain or storage).
   */
  reason: Schema.Literals(['not_found', 'expired', 'taken', 'conflict', 'bad_destination', 'unavailable']),
  message: Schema.String,
}) {}

const toLink = (row: Record<string, unknown>) =>
  Schema.decodeUnknownEffect(ClaimLink)(row).pipe(
    Effect.mapError(error => new DbError({ operation: 'decode claim_links', message: String(error) })),
  )

export const claimLinkById = (id: string) => first(sql('SELECT * FROM claim_links WHERE id = ?', id), toLink)

const linkByKey = (walletId: string, scope: string, key: string) =>
  first(
    sql('SELECT * FROM claim_links WHERE wallet_id = ? AND scope = ? AND idempotency_key = ?', walletId, scope, key),
    toLink,
  )

const intentOf = (link: ClaimLink) =>
  link.intent_id === null
    ? Effect.succeed(undefined)
    : first(sql('SELECT * FROM payment_intents WHERE id = ?', link.intent_id), toIntent)

/** Open and past its expiry: nobody can claim it any more (no write on read). */
export const linkExpired = (link: ClaimLink, nowMs: number) =>
  link.status === 'open' && millisOf(link.expires_at) <= nowMs

export interface NewClaimLink {
  readonly walletId: string
  readonly connectionId: string | null
  readonly scope: string
  readonly idempotencyKey: string
  readonly requester: string
  readonly recipientName: string
  readonly reason: string | null
  readonly amount: bigint
  readonly network: 'stellar:testnet' | 'stellar:pubnet'
  /** person: the sender nods; the link becomes a rule on their account (person-link.ts). */
  readonly kind?: 'person' | undefined
}

/** Store the link (nothing onchain). The same idempotency key returns the same link; another request under it fails. */
export const createClaimLink = (input: NewClaimLink) =>
  Effect.gen(function* () {
    const fingerprint = `claim_link|${input.recipientName.trim().toLowerCase()}|${input.amount}`
    const existing = yield* linkByKey(input.walletId, input.scope, input.idempotencyKey)
    if (existing !== undefined)
      return existing.request_fingerprint === fingerprint
        ? { link: existing, created: false }
        : yield* new ClaimError({
            reason: 'conflict',
            message: `idempotency key ${input.idempotencyKey} was used for a different request; use a new key`,
          })
    const id = yield* randomId('cl')
    yield* write(
      insert('claim_links', {
        id,
        wallet_id: input.walletId,
        connection_id: input.connectionId,
        scope: input.scope,
        idempotency_key: input.idempotencyKey,
        request_fingerprint: fingerprint,
        requester: input.requester,
        recipient_name: input.recipientName.trim(),
        reason: input.reason,
        amount: input.amount,
        network: input.network,
        status: input.kind === 'person' ? 'awaiting_nod' : 'open',
        ...(input.kind === 'person' ? { kind: 'person' } : {}),
        destination_kind: null,
        destination_address: null,
        destination_wallet_id: null,
        intent_id: null,
        expires_at: yield* isoIn(CLAIM_LINK_TTL_MS),
        claimed_at: null,
        created_at: yield* nowIso,
      }),
    )
    const link = yield* claimLinkById(id)
    if (link === undefined) return yield* new DbError({ operation: 'claim_links', message: 'link vanished' })
    return { link, created: true }
  })

const nextStepOpen = (link: ClaimLink, url: string) =>
  `Send ${link.recipient_name} this link: ${url}. When ${link.recipient_name} opens it and picks where the money goes (a new Nod wallet, their Nod wallet or a Stellar address), Nod pays from this AI app's allowance, or asks the user for a nod if it is past what is left. Poll payment_status with payment_id ${link.id}.`

/**
 * The link as payment_prepare and payment_status show it, in PaymentView's shape. Open: `status` prepared, the lane it
 * would take now (the allowance decides when it is claimed), `recipient.address` empty, `claim_url` the link. Claimed:
 * the payment intent's own view, with the link still as `claim_url` until it is confirmed.
 */
export const claimLinkView = (input: {
  readonly link: ClaimLink
  readonly intent: PaymentIntent | undefined
  readonly grant: SpendingGrant | undefined
  readonly origin: string
  readonly nowMs: number
  readonly fees?: { readonly firstXlm: number; readonly laterXlm: number; readonly ownerXlm: number }
}) =>
  Effect.gen(function* () {
    const { link, intent, grant, origin, nowMs } = input
    const url = claimLinkUrl(origin, link.id)
    if (intent !== undefined) {
      const view = paymentView(intent, yield* receiptOfIntent(intent.id), grant, origin, nowMs)
      return {
        ...view,
        // A person link's URL carries its key: only the sender's page ever shows it.
        claim_url: view.status === 'confirmed' || link.kind === 'person' ? null : (view.claim_url ?? url),
        claim_link_id: link.id,
      } satisfies PaymentView & { readonly claim_link_id: string }
    }
    if (link.kind === 'person') return personLinkView(link, grant, origin, nowMs)
    const expired = linkExpired(link, nowMs)
    const decision = laneDecision({
      grant,
      kind: 'payment',
      amount: link.amount,
      readiness: 'usdc_ready',
      nowMs,
      forceOwner: false,
    })
    return {
      payment_id: link.id,
      kind: 'payment' as const,
      status: expired ? ('expired' as const) : ('prepared' as const),
      lane: decision.lane,
      approval_reason: decision.reason,
      amount: fromStroops(link.amount),
      asset: 'USDC' as const,
      network: link.network,
      recipient: { name: link.recipient_name, address: '', readiness: 'unverified' as const },
      fee_ceiling_xlm: feeCeilingFor(decision.lane, grant, input.fees),
      reason: link.reason,
      expires_at: link.expires_at,
      approval_url: null,
      claim_url: expired ? null : url,
      receipt: null,
      failure: null,
      next_step: expired
        ? `${link.recipient_name} did not claim it in time; nothing was paid. Prepare a new one if it should still be sent.`
        : nextStepOpen(link, url),
      grant_remaining: grantRemaining(grant, nowMs),
      claim_link_id: link.id,
    } satisfies PaymentView & { readonly claim_link_id: string }
  })

/**
 * A person link before its payment, in PaymentView's shape. Waiting for the sender's nod: awaiting_approval with the
 * approval page; approved: the sender has the link (its key never reaches Nod or the AI app); revoked: failed;
 * past its expiry: expired. `claim_url` is always null here.
 */
const personLinkView = (link: ClaimLink, grant: SpendingGrant | undefined, origin: string, nowMs: number) => {
  const name = link.recipient_name
  const lapsed = millisOf(link.expires_at) <= nowMs
  const status =
    link.status === 'revoked'
      ? ('failed' as const)
      : lapsed
        ? ('expired' as const)
        : link.status === 'awaiting_nod'
          ? ('awaiting_approval' as const)
          : ('approved' as const)
  const approvalUrl = `${origin}/approve/link/${link.id}`
  const until = link.expires_at.slice(0, 16).replace('T', ' ')
  const nextStep = {
    awaiting_approval: `Ask the user to open ${approvalUrl} and approve on Nod's page: it creates a link they send ${name}, and nothing leaves their wallet until ${name} claims it. Then poll payment_status with payment_id ${link.id}.`,
    approved: `The user approved and has the link to send ${name}; it carries its own key, so neither Nod nor this app sees it. Nothing leaves the wallet until ${name} claims it, by ${until} UTC. Poll payment_status with payment_id ${link.id}.`,
    failed: `The user took the link back; nothing was paid.`,
    expired: `${name} did not claim it in time; nothing was paid.`,
  }[status]
  return {
    payment_id: link.id,
    kind: 'payment' as const,
    status,
    lane: 'owner' as const,
    approval_reason:
      laneDecision({ grant, kind: 'payment', amount: link.amount, readiness: 'usdc_ready', nowMs, forceOwner: false })
        .reason ?? 'owner_only',
    amount: fromStroops(link.amount),
    asset: 'USDC' as const,
    network: link.network,
    recipient: { name, address: '', readiness: 'unverified' as const },
    fee_ceiling_xlm: 0,
    reason: link.reason,
    expires_at: link.expires_at,
    approval_url: status === 'awaiting_approval' ? approvalUrl : null,
    claim_url: null,
    receipt: null,
    failure: status === 'failed' ? 'the user took the link back' : null,
    next_step: nextStep,
    grant_remaining: grantRemaining(grant, nowMs),
    claim_link_id: link.id,
  } satisfies PaymentView & { readonly claim_link_id: string }
}

/** Where the person who opened the link wants the money: their (new or existing) Nod wallet, or a pasted address. */
export type Destination =
  | { readonly kind: 'wallet'; readonly wallet: Wallet; readonly created: boolean }
  | { readonly kind: 'address'; readonly address: string }

const badDestination = (message: string) => new ClaimError({ reason: 'bad_destination', message })

/** A Nod wallet on this stage (deployed, or deposit-first and planned: SAC transfers reach a planned C too). */
const walletIdOfContract = (address: string) =>
  first(sql('SELECT id FROM wallets WHERE contract_id = ?', address), row => Effect.succeed(String(row['id'])))

export const readinessOf = (destination: Destination) =>
  Effect.gen(function* () {
    if (destination.kind === 'wallet') return 'usdc_ready' as const
    if ((yield* walletIdOfContract(destination.address)) !== undefined) return 'usdc_ready' as const
    const readiness = yield* Chain.use(chain => chain.readiness(destination.address)).pipe(
      Effect.mapError(
        error => new ClaimError({ reason: 'unavailable', message: `could not check the address: ${error.message}` }),
      ),
    )
    if (readiness === 'account_missing')
      return yield* badDestination('That account does not exist on Stellar yet, so it cannot receive USDC.')
    return readiness === 'contract' ? ('usdc_ready' as const) : readiness
  })

/** The inside-the-allowance lane, as payment_execute runs it: claim the submit, the connection key pays, record. */
const payAlone = (sender: Wallet, intent: PaymentIntent) =>
  Effect.gen(function* () {
    if (intent.connection_id === null) return intent
    const ledger = yield* Ledger
    const claim = yield* ledger.claimAutonomous(sender.id, { intentId: intent.id, connectionId: intent.connection_id })
    if (claim._tag === 'NotClaimed' || claim.grant === undefined) return claim.intent
    const grant = claim.grant
    const ceiling = yield* transferFeeCeiling(yield* Network, grant.first_payment_done)
    // Never after a failed enforce simulation: the chain package simulates in enforce mode before it submits.
    const outcome: Outcome = yield* Chain.use(chain =>
      chain.delegatedTransfer(
        sender.contract_id,
        grant.rule_id,
        grant.signer_key_ref,
        intent.recipient_address,
        intent.amount,
        ceiling,
      ),
    ).pipe(
      Effect.map((settlement): Outcome => ({
        _tag: 'Confirmed',
        settlement,
        feePaidBy: 'relayer',
        pull: null,
        pulled: intent.amount,
      })),
      Effect.catchTag('ChainError', error =>
        Effect.succeed<Outcome>(
          error.kind === 'unknown'
            ? { _tag: 'Unknown', message: error.message, tx: error.tx ?? null }
            : { _tag: 'Failed', kind: error.kind, message: error.message, pull: null, pulled: 0n },
        ),
      ),
    )
    return yield* ledger.settle(sender.id, { intentId: intent.id, operationId: claim.operationId, outcome })
  })

/**
 * The person who opened the link chose a destination: bind it to the link (first choice wins), create the payment
 * intent under the link's idempotency key, and in the allowance lane pay at once. A repeat with the same destination
 * continues where the first stopped; another destination is refused. A deposit-first wallet that just got paid deploys.
 */
export const claimLink = (linkId: string, destination: Destination) =>
  Effect.gen(function* () {
    const found = yield* claimLinkById(linkId)
    if (found === undefined)
      return yield* new ClaimError({ reason: 'not_found', message: 'This claim link is not valid.' })
    if (found.kind === 'person')
      return yield* new ClaimError({
        reason: 'bad_destination',
        message: 'This link is received by signing with it: open the whole link the sender gave you.',
      })
    const now = yield* nowIso
    if (linkExpired(found, millisOf(now)))
      return yield* new ClaimError({ reason: 'expired', message: 'This link expired; nothing was paid.' })
    const sender = yield* walletById(found.wallet_id)
    if (sender === undefined) return yield* new ClaimError({ reason: 'not_found', message: 'The sender is gone.' })
    const address = destination.kind === 'wallet' ? destination.wallet.contract_id : destination.address.trim()
    if (!ADDRESS.test(address)) return yield* badDestination('That is not a Stellar address (G…, C… or M…).')
    if (address === sender.contract_id) return yield* badDestination('That is the sender’s own wallet.')
    const readiness: Readiness = yield* readinessOf(destination)
    const kind = destination.kind === 'address' ? 'address' : destination.created ? 'new_wallet' : 'wallet'
    yield* write(
      sql(
        `UPDATE claim_links SET status = 'claimed', destination_kind = ?, destination_address = ?,
           destination_wallet_id = ?, claimed_at = ? WHERE id = ? AND status = 'open' AND expires_at > ?`,
        kind,
        address,
        destination.kind === 'wallet' ? destination.wallet.id : null,
        now,
        linkId,
        now,
      ),
    )
    const link = yield* claimLinkById(linkId)
    if (link === undefined || link.destination_address !== address)
      return yield* new ClaimError({ reason: 'taken', message: 'This link was already claimed.' })
    const network = yield* Network
    const grant = link.connection_id === null ? undefined : yield* grantOfConnection(link.connection_id)
    const ledger = yield* Ledger
    const prepared = yield* ledger.prepareIntent(sender.id, {
      scope: link.scope,
      idempotencyKey: `claim:${link.id}`,
      fingerprint: `claim|${link.id}|${address}|${link.amount}`,
      kind: 'payment',
      connectionId: link.connection_id,
      grantId: grant?.id ?? null,
      requester: link.requester,
      reason: link.reason,
      contactId: null,
      recipientName: link.recipient_name,
      recipientAddress: address,
      recipientReadiness: readiness,
      resource: null,
      amount: link.amount,
      forceOwner: false,
      claim: false,
      operationKind: 'transfer',
      pocketBalance: null,
      network: network.caip,
      feeCeilings: network.fees,
    })
    if (link.intent_id === null)
      yield* write(sql('UPDATE claim_links SET intent_id = ? WHERE id = ?', prepared.intent.id, link.id))
    const intent =
      prepared.intent.lane === 'autonomous' && prepared.intent.status === 'prepared'
        ? yield* payAlone(sender, prepared.intent)
        : prepared.intent
    if (intent.status === 'confirmed') yield* afterPaid(sender, link, destination, address, readiness)
    return { link: (yield* claimLinkById(link.id)) ?? link, intent }
  })

/**
 * A paid claim: the sender's owner keeps the person as a contact (an address from a claim link counts as known), and
 * a deposit-first wallet that just received its first USDC deploys. Neither failure undoes the payment.
 */
export const afterPaid = (
  sender: Wallet,
  link: ClaimLink,
  destination: Destination,
  address: string,
  readiness: Readiness,
) =>
  Effect.gen(function* () {
    const known = yield* searchContacts(sender.owner_id, address)
    if (known.length === 0)
      yield* createContact({
        ownerId: sender.owner_id,
        displayName: link.recipient_name,
        aliases: ['claim link'],
        address,
        memo: null,
        readiness,
      })
    if (destination.kind === 'wallet') yield* activateWallet(destination.wallet, 'claim')
  }).pipe(Effect.catch(error => logFailure('warn', 'claim.after_paid_failed', error, { intent_id: link.id })))

/** The link and its payment intent, for the page and payment_status. */
export const claimLinkState = (linkId: string) =>
  Effect.gen(function* () {
    const link = yield* claimLinkById(linkId)
    if (link === undefined) return undefined
    return { link, intent: yield* intentOf(link) }
  })
