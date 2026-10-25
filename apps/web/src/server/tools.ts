import { Effect, Ref, Schema } from 'effect'

import {
  Chain,
  ChainError,
  type ChainReadiness,
  type Contact,
  type ContactView,
  fromStroops,
  type PaidMcpCallInput,
  type PaidResourceFetchInput,
  type PaymentIntent,
  type PaymentPrepareInput,
  type Readiness,
  type Receipt,
  type SpendingGrant,
  toStroops,
  type Wallet,
  type X402Quote,
  type X402QuoteHook,
} from '@hm/protocol'

import { claimLinkState, claimLinkUrl, claimLinkView, createClaimLink, isClaimLinkId } from './claims.ts'
import { nowMillis, randomId } from './clock.ts'
import type { DbError } from './db.ts'
import { Ledger, type LedgerError, type Outcome } from './ledger.ts'
import { Network, transferFeeCeiling } from './network.ts'
import type { ConnectionProps } from './props.ts'
import { revokeConnection } from './revoke.ts'
import {
  connectionById,
  contactById,
  fingerprintOf,
  grantOfConnection,
  intentById,
  intentByKey,
  knownAddress,
  pendingOfWallet,
  receiptOfIntent,
  receiptsOfWallet,
  saveToolResult,
  searchContacts,
  toolResult,
  walletById,
} from './store.ts'
import { grantRemaining, paymentView, receiptView, revokeUrl, toolGrantView } from './views.ts'

/**
 * The ten MCP tools as Effects over the services, independent of the MCP transport (mcp.ts registers them; tests call
 * them directly against the FixtureChain). Every write references a frozen intent; every result carries
 * grant_remaining; the approval URL is both in the sentence and in the structured result.
 */

export class ToolError extends Schema.TaggedError<ToolError>()('ToolError', { message: Schema.String }) {}

export interface ToolContext {
  readonly props: ConnectionProps
  /** The public origin of this deployment (approval links). */
  readonly origin: string
}

export interface ToolResult<A> {
  /** One plain sentence first: hosts that do not render structured content still show it. */
  readonly sentence: string
  readonly value: A
}

const fail = (message: string) => Effect.fail(new ToolError({ message }))

/**
 * Payments go to the address alone: no transaction Nod builds carries a memo. An exchange deposit address that needs one
 * would lose the funds, so a memo is refused, never dropped (K5).
 */
export const MEMO_UNSUPPORTED = 'Nod cannot pay exchange deposit addresses that need a memo yet.'
const storage = (error: DbError | LedgerError) =>
  new ToolError({
    message:
      error._tag === 'LedgerError' && error.reason === 'idempotency_conflict'
        ? error.message
        : `The wallet service could not complete this (${error._tag === 'DbError' ? error.operation : error.message}). Retry with the same idempotency key.`,
  })

const ADDRESS = /^(?:[CG][A-Z2-7]{55}|M[A-Z2-7]{68})$/u

/** PAYMENTS_ENABLED=false: every tool that could move money answers this instead (revoke still works). */
const requirePayments = Effect.gen(function* () {
  const network = yield* Network
  if (!network.caps.paymentsEnabled)
    return yield* fail('Payments are paused on Nod right now. Nothing was paid; try again later.')
  return network
})

/** The connection, its wallet and its allowance; refuses a revoked connection for writes. */
export const scope = (ctx: ToolContext, write: boolean) =>
  Effect.gen(function* () {
    const connection = yield* connectionById(ctx.props.connection_id)
    if (connection === undefined || connection.wallet_id !== ctx.props.wallet_id)
      return yield* fail('Nod does not know this AI app any more. Reconnect it.')
    if (write && connection.status === 'revoked')
      return yield* fail('The user revoked this AI app in Nod. It can no longer pay; reconnect to ask again.')
    const wallet = yield* walletById(connection.wallet_id)
    if (wallet === undefined) return yield* fail('The wallet of this connection is gone.')
    const grant = yield* grantOfConnection(connection.id)
    return { connection, wallet, grant, nowMs: yield* nowMillis }
  })

const toReadiness = (readiness: ChainReadiness): Readiness => (readiness === 'contract' ? 'usdc_ready' : readiness)

// 1. wallet_overview

export const walletOverview = (ctx: ToolContext) =>
  Effect.gen(function* () {
    const { connection, wallet, grant, nowMs } = yield* scope(ctx, false)
    const chain = yield* Chain
    const network = yield* Network
    const balances = yield* chain.balances(wallet.contract_id).pipe(
      Effect.map(b => ({ usdc: fromStroops(b.usdc), xlm: fromStroops(b.xlm) })),
      Effect.catchTag('ChainError', () => Effect.succeed({ usdc: 'unavailable', xlm: 'unavailable' })),
    )
    const pending = yield* pendingOfWallet(wallet.id, connection.id)
    const receipts = yield* receiptsOfWallet(wallet.id, 5, connection.id)
    const remaining = grantRemaining(grant, nowMs)
    return {
      sentence: `Nod wallet ${wallet.name} (Stellar ${network.label}) holds ${balances.usdc} USDC. This AI app may still spend ${remaining} USDC on its own${grant === undefined ? '' : ` until ${grant.valid_until}`}; anything bigger needs the user's nod.`,
      value: {
        network: network.caip,
        explorer_base: network.explorerBase,
        wallet: {
          id: wallet.id,
          name: wallet.name,
          contract_id: wallet.contract_id,
          network: wallet.network,
          deploy_tx: wallet.deploy_tx ?? null,
          fund_tx: wallet.fund_tx ?? null,
        },
        balances,
        grant: grant === undefined ? null : toolGrantView(grant, nowMs),
        pending_approvals: pending.map(intent => paymentView(intent, undefined, grant, ctx.origin, nowMs)),
        recent_receipts: receipts.map(receiptView),
        connection: { id: connection.id, client_name: connection.oauth_client_name, status: connection.status },
        grant_remaining: remaining,
      },
    }
  })

// 2. contacts_search

const contactView = (contact: Contact): ContactView => ({
  contact_id: contact.id,
  name: contact.display_name,
  aliases: contact.aliases,
  destinations: contact.destinations.map(destination => ({
    address: destination.address,
    network: destination.network,
    memo: destination.memo,
    readiness: destination.last_paid_at === null ? [destination.readiness] : [destination.readiness, 'paid_before'],
    last_paid_at: destination.last_paid_at,
  })),
  added_by: contact.added_by ?? null,
})

export const contactsSearch = (ctx: ToolContext, query: string) =>
  Effect.gen(function* () {
    const { grant, nowMs } = yield* scope(ctx, false)
    const contacts = yield* searchContacts(ctx.props.owner_id, query)
    return {
      sentence:
        contacts.length === 0
          ? `No saved contact matches "${query}".`
          : `${contacts.length} contact(s): ${contacts.map(contact => contact.display_name).join(', ')}.`,
      value: { contacts: contacts.map(contactView), grant_remaining: grantRemaining(grant, nowMs) },
    }
  })

// 3. payment_prepare

/** A contact name, alias, id or address → the destination to pay. */
export const resolveRecipient = (ownerId: string, recipient: string) =>
  Effect.gen(function* () {
    const text = recipient.trim()
    if (ADDRESS.test(text)) {
      const contacts = yield* searchContacts(ownerId, text)
      const contact = contacts[0]
      return { address: text, name: contact?.display_name ?? null, contactId: contact?.id ?? null }
    }
    const all = yield* searchContacts(ownerId, '')
    const needle = text.toLowerCase()
    const exact = all.filter(
      contact =>
        contact.id === text ||
        contact.display_name.toLowerCase() === needle ||
        contact.aliases.some(alias => alias.toLowerCase() === needle),
    )
    const matches = exact.length > 0 ? exact : yield* searchContacts(ownerId, text)
    if (matches.length === 0)
      return yield* fail(`No saved contact matches "${text}". Use contacts_search, or give a Stellar address.`)
    if (matches.length > 1)
      return yield* fail(`"${text}" matches ${matches.map(c => c.display_name).join(', ')}. Be more specific.`)
    const contact = matches[0]
    const destination = contact?.destinations[0]
    if (contact === undefined || destination === undefined)
      return yield* fail(`Contact "${text}" has no address saved.`)
    return { address: destination.address, name: contact.display_name, contactId: contact.id }
  })

/**
 * Claim link v2 (claims.ts): recipient "new" with a name stores a link and pays nothing; the person who opens it picks
 * the destination, and the payment then takes the normal lanes.
 */
const claimLinkPrepare = (ctx: ToolContext, input: PaymentPrepareInput, amount: bigint) =>
  Effect.gen(function* () {
    const { connection, wallet, grant } = yield* scope(ctx, true)
    const network = yield* Network
    const name = input.recipient_name?.trim() ?? ''
    if (name === '')
      return yield* fail('With recipient "new", give recipient_name: who the claim link is for (e.g. "Jan").')
    const created = yield* createClaimLink({
      walletId: wallet.id,
      connectionId: connection.id,
      scope: connection.id,
      idempotencyKey: input.idempotency_key,
      requester: connection.oauth_client_name,
      recipientName: name,
      reason: input.reason ?? null,
      amount,
      network: network.caip,
    }).pipe(Effect.catchTag('ClaimError', error => fail(error.message)))
    const view = yield* claimLinkView({
      link: created.link,
      intent: undefined,
      grant,
      origin: ctx.origin,
      nowMs: yield* nowMillis,
      fees: network.fees,
    })
    const url = claimLinkUrl(ctx.origin, created.link.id)
    return {
      sentence: `Claim link for ${name}: ${url} (${view.amount} USDC). Nothing is paid yet: send ${name} the link; when ${name} opens it and picks where the money goes, Nod pays${view.lane === 'autonomous' ? " from this AI app's allowance" : ", after the user's nod (it is past what this AI app may spend alone)"}. Poll payment_status with payment_id ${created.link.id}.`,
      value: { ...view, outcome: 'claim_link' },
    }
  })

/** payment_status / payment_execute / payment_approve_url on a claim link id: the link, or its payment once claimed. */
const claimLinkStatus = (ctx: ToolContext, linkId: string) =>
  Effect.gen(function* () {
    const { grant, nowMs } = yield* scope(ctx, false)
    const state = yield* claimLinkState(linkId)
    if (state === undefined || state.link.connection_id !== ctx.props.connection_id)
      return yield* fail(`No payment ${linkId} for this connection.`)
    const view = yield* claimLinkView({ link: state.link, intent: state.intent, grant, origin: ctx.origin, nowMs })
    const name = state.link.recipient_name
    const sentence =
      state.intent === undefined
        ? view.status === 'expired'
          ? `${name} did not claim the link in time; nothing was paid.`
          : `${name} has not opened the claim link yet: ${view.claim_url ?? ''}. Nothing is paid until then.`
        : view.status === 'confirmed' && view.receipt !== null
          ? `${name} claimed it: paid ${view.amount} USDC to ${view.recipient.address}. Transaction ${view.receipt.tx_hash} (${view.receipt.explorer_url}).`
          : view.approval_url !== null
            ? `${name} claimed it to ${view.recipient.address}; the payment needs the user's nod at ${view.approval_url}.`
            : `${name} claimed it to ${view.recipient.address}. ${view.next_step}`
    return { sentence, value: view }
  })

/**
 * The first payment to an address an AI app saved (contact_add, contact_update) takes the owner lane whatever the
 * amount, unless the wallet already knows the address (paid it, met it on a claim link, or a paid request).
 */
export const firstPaymentToAiContact = (
  walletId: string,
  ownerId: string,
  recipient: { readonly address: string; readonly contactId: string | null },
) =>
  Effect.gen(function* () {
    if (recipient.contactId === null) return false
    const contact = yield* contactById(ownerId, recipient.contactId)
    const destination = contact?.destinations.find(candidate => candidate.address === recipient.address)
    if (destination === undefined || destination.source !== 'ai' || destination.last_paid_at !== null) return false
    return !(yield* knownAddress(walletId, recipient.address))
  })

/** `forceOwner`: the owner lane whatever the allowance (request_pay to a requester outside the payer's contacts). */
export const paymentPrepare = (
  ctx: ToolContext,
  input: PaymentPrepareInput,
  options: { readonly forceOwner?: boolean } = {},
) =>
  Effect.gen(function* () {
    const { connection, wallet, grant } = yield* scope(ctx, true)
    const network = yield* requirePayments
    const amount = toStroops(input.amount)
    if (amount <= 0n) return yield* fail('The amount must be more than zero.')
    if (input.memo !== undefined && input.memo.trim() !== '')
      return yield* fail(
        `${MEMO_UNSUPPORTED} Nothing was prepared. If this address needs no memo, prepare the payment again without one.`,
      )
    if (input.recipient.trim().toLowerCase() === 'new' && !options.forceOwner)
      return yield* claimLinkPrepare(ctx, input, amount)
    const recipient = yield* resolveRecipient(ctx.props.owner_id, input.recipient)
    if (recipient.address === wallet.contract_id) return yield* fail('That is this wallet itself.')
    const chain = yield* Chain
    const readiness = yield* chain.readiness(recipient.address).pipe(
      Effect.map(toReadiness),
      Effect.catchTag('ChainError', error =>
        fail(`Could not check the recipient on Stellar (${error.message}). Retry with the same idempotency key.`),
      ),
    )
    if (readiness === 'account_missing')
      return yield* fail(
        `${recipient.address} does not exist on Stellar ${network.label} yet, so it cannot receive USDC.`,
      )
    const newContact = yield* firstPaymentToAiContact(wallet.id, ctx.props.owner_id, recipient)
    const ledger = yield* Ledger
    const prepared = yield* ledger.prepareIntent(wallet.id, {
      scope: connection.id,
      idempotencyKey: input.idempotency_key,
      fingerprint: `payment|${recipient.address}|${amount}|${input.memo ?? ''}`,
      kind: 'payment',
      connectionId: connection.id,
      grantId: grant?.id ?? null,
      requester: connection.oauth_client_name,
      reason: input.reason ?? null,
      contactId: recipient.contactId,
      recipientName: recipient.name,
      recipientAddress: recipient.address,
      recipientReadiness: readiness,
      resource: null,
      amount,
      forceOwner: (options.forceOwner ?? false) || newContact,
      ownerReason: options.forceOwner === true ? undefined : newContact ? 'new_contact' : undefined,
      claim: false,
      operationKind: 'transfer',
      pocketBalance: null,
      network: network.caip,
      feeCeilings: network.fees,
    })
    const view = paymentView(
      prepared.intent,
      yield* receiptOfIntent(prepared.intent.id),
      prepared.grant,
      ctx.origin,
      yield* nowMillis,
    )
    const status = view.status === 'awaiting_approval' ? 'requires_approval' : view.status
    return {
      sentence:
        view.approval_url !== null
          ? `This payment of ${view.amount} USDC to ${recipient.name ?? recipient.address} ${view.approval_reason === 'new_contact' ? 'goes to an address an AI app saved and the user never paid, so the first payment' : 'is above what this AI app may spend on its own, so it'} needs the user's nod. Ask the user to open ${view.approval_url} and approve it with their passkey, then call payment_status with payment_id ${view.payment_id}.${view.claim_url === null ? '' : ` ${recipient.name ?? 'The recipient'} has no USDC trustline yet: they accept at ${view.claim_url}.`}`
          : view.next_step,
      value: { ...view, outcome: status === 'prepared' ? 'ready_to_execute' : status },
    }
  })

// 4. payment_execute

const outcomeOf = (error: ChainError, pull: Receipt | null, pulled: bigint): Outcome =>
  error.kind === 'unknown'
    ? { _tag: 'Unknown', message: error.message, tx: error.tx ?? null }
    : { _tag: 'Failed', kind: error.kind, message: error.message, pull, pulled }

export const paymentExecute = (ctx: ToolContext, paymentId: string) =>
  Effect.gen(function* () {
    if (isClaimLinkId(paymentId)) return yield* claimLinkStatus(ctx, paymentId)
    const { connection, wallet } = yield* scope(ctx, true)
    const network = yield* requirePayments
    const ledger = yield* Ledger
    const claim = yield* ledger
      .claimAutonomous(wallet.id, { intentId: paymentId, connectionId: connection.id })
      .pipe(
        Effect.catchTag('LedgerError', (error): Effect.Effect<never, ToolError | LedgerError> =>
          error.reason === 'not_found' ? fail(`No payment ${paymentId} for this connection.`) : Effect.fail(error),
        ),
      )
    let intent = claim.intent
    if (claim._tag === 'Claimed') {
      const grant = claim.grant
      if (grant === undefined) return yield* fail('This connection has no spending grant.')
      const chain = yield* Chain
      // Never after a failed enforce simulation: the chain package simulates in enforce mode before it submits.
      const outcome: Outcome = yield* chain
        .delegatedTransfer(
          wallet.contract_id,
          grant.rule_id,
          grant.signer_key_ref,
          intent.recipient_address,
          intent.amount,
          yield* transferFeeCeiling(network, grant.first_payment_done),
        )
        .pipe(
          Effect.map((settlement): Outcome => ({
            _tag: 'Confirmed',
            settlement,
            feePaidBy: 'relayer',
            pull: null,
            pulled: intent.amount,
          })),
          Effect.catchTag('ChainError', error => Effect.succeed(outcomeOf(error, null, 0n))),
        )
      intent = yield* ledger.settle(wallet.id, { intentId: intent.id, operationId: claim.operationId, outcome })
    }
    const nowMs = yield* nowMillis
    const grant = yield* grantOfConnection(connection.id)
    const view = paymentView(intent, yield* receiptOfIntent(intent.id), grant, ctx.origin, nowMs)
    const sentence =
      view.status === 'confirmed' && view.receipt !== null
        ? `Paid ${view.amount} USDC to ${view.recipient.name ?? view.recipient.address} from the allowance; Nod paid the network fee. Transaction ${view.receipt.tx_hash} (${view.receipt.explorer_url}). This AI app may still spend ${view.grant_remaining} USDC.`
        : view.approval_url !== null
          ? `Not paid: this needs the user's nod. Ask the user to open ${view.approval_url} and approve it with their passkey, then call payment_status with payment_id ${view.payment_id}.`
          : view.next_step
    return { sentence, value: view }
  })

// 5. payment_approve_url / 6. payment_status

const ownIntent = (ctx: ToolContext, paymentId: string) =>
  Effect.gen(function* () {
    const intent = yield* intentById(paymentId)
    if (intent === undefined || intent.connection_id !== ctx.props.connection_id)
      return yield* fail(`No payment ${paymentId} for this connection.`)
    return intent
  })

export const paymentStatus = (ctx: ToolContext, paymentId: string) =>
  Effect.gen(function* () {
    if (isClaimLinkId(paymentId)) return yield* claimLinkStatus(ctx, paymentId)
    const { grant, nowMs } = yield* scope(ctx, false)
    const intent = yield* ownIntent(ctx, paymentId)
    const view = paymentView(intent, yield* receiptOfIntent(intent.id), grant, ctx.origin, nowMs)
    const sentence =
      view.status === 'confirmed' && view.receipt !== null
        ? `Confirmed. Transaction ${view.receipt.tx_hash} in ledger ${view.receipt.ledger} (${view.receipt.explorer_url}). ${view.next_step}`
        : view.approval_url !== null
          ? `Still waiting for the user's nod at ${view.approval_url}.`
          : view.next_step
    return { sentence, value: view }
  })

export const paymentApproveUrl = (ctx: ToolContext, paymentId: string) =>
  Effect.gen(function* () {
    if (isClaimLinkId(paymentId)) {
      const status = yield* claimLinkStatus(ctx, paymentId)
      return {
        sentence: status.sentence,
        value: {
          payment_id: status.value.payment_id,
          status: status.value.status,
          approval_url: status.value.approval_url,
          expires_at: status.value.expires_at,
          grant_remaining: status.value.grant_remaining,
        },
      }
    }
    const { grant, nowMs } = yield* scope(ctx, false)
    const intent = yield* ownIntent(ctx, paymentId)
    const view = paymentView(intent, undefined, grant, ctx.origin, nowMs)
    return {
      sentence:
        view.approval_url !== null
          ? `Ask the user to open ${view.approval_url} and approve it with their passkey, then call payment_status.`
          : `Payment ${paymentId} is ${view.status}; there is nothing to approve.`,
      value: {
        payment_id: intent.id,
        status: view.status,
        approval_url: view.approval_url,
        expires_at: intent.expires_at,
        grant_remaining: view.grant_remaining,
      },
    }
  })

// 7. paid_resource_fetch / 8. paid_mcp_call: the pocket model (docs/spikes/s5.md)

interface PaidState {
  readonly intentId: string | null
  readonly operationId: string | null
  readonly pull: Receipt | null
  readonly pulled: bigint
  readonly quote: X402Quote | null
  readonly ownerLane: boolean
}

const MAX_BODY = 64 * 1024
const decline = (message: string) => Effect.fail(new ChainError({ kind: 'declined', message }))

/**
 * The quote hook the chain calls with the seller's terms before anything is signed: validate them, freeze the intent
 * (idempotency key → intent, under the wallet's permit), reserve, and pull the shortfall into the pocket under the
 * rule. Declines (nothing signed) when the terms are wrong, the price does not fit, or the key is already in flight.
 */
const quoteHook =
  (input: {
    readonly ctx: ToolContext
    readonly wallet: Wallet
    readonly grant: SpendingGrant
    readonly connectionName: string
    readonly kind: 'x402_fetch' | 'x402_mcp'
    readonly key: string
    readonly fingerprint: string
    readonly resource: string
    readonly reason: string | null
    readonly maxAmount: bigint
    readonly intentId: string
    readonly state: Ref.Ref<PaidState>
  }) =>
  (quote: X402Quote) =>
    Effect.gen(function* () {
      const network = yield* Network
      if (quote.network !== network.caip)
        return yield* decline(`the seller wants ${quote.network}, but this wallet is on ${network.caip}`)
      if (quote.asset !== network.usdcSac) return yield* decline(`the seller wants asset ${quote.asset}, not USDC`)
      if (quote.amountStroops > network.caps.maxX402PriceStroops)
        return yield* decline(
          `the price ${fromStroops(quote.amountStroops)} USDC is above Nod's cap of ${fromStroops(network.caps.maxX402PriceStroops)} USDC per purchase`,
        )
      if (!ADDRESS.test(quote.payTo)) return yield* decline('the seller gave no Stellar address to pay')
      if (quote.amountStroops > input.maxAmount)
        return yield* decline(
          `the price ${fromStroops(quote.amountStroops)} USDC is above max_amount ${fromStroops(input.maxAmount)}`,
        )
      yield* Ref.update(input.state, s => ({ ...s, quote }))
      const chain = yield* Chain
      const pocket = input.grant.pocket_address
      const pocketBalance =
        pocket === null
          ? null
          : yield* chain.balances(pocket).pipe(
              Effect.map(b => b.usdc),
              Effect.catchTag('ChainError', () => Effect.succeed(null)),
            )
      const ledger = yield* Ledger
      const prepared = yield* ledger
        .prepareIntent(input.wallet.id, {
          id: input.intentId,
          scope: input.ctx.props.connection_id,
          idempotencyKey: input.key,
          fingerprint: input.fingerprint,
          kind: input.kind,
          connectionId: input.ctx.props.connection_id,
          grantId: input.grant.id,
          requester: input.connectionName,
          reason: input.reason,
          contactId: null,
          recipientName: null,
          recipientAddress: quote.payTo,
          recipientReadiness: 'usdc_ready',
          resource: input.resource,
          amount: quote.amountStroops,
          forceOwner: pocket === null,
          claim: true,
          operationKind: 'x402_settlement',
          pocketBalance,
          network: network.caip,
          feeCeilings: network.fees,
        })
        .pipe(Effect.mapError(error => new ChainError({ kind: 'declined', message: error.message })))
      yield* Ref.update(input.state, s => ({ ...s, intentId: prepared.intent.id }))
      if (!prepared.created) return yield* decline('this idempotency key is already being paid')
      if (prepared.intent.lane === 'owner' || prepared.operationId === null) {
        yield* Ref.update(input.state, s => ({ ...s, ownerLane: true }))
        return yield* decline('the price does not fit the remaining allowance')
      }
      yield* Ref.update(input.state, s => ({ ...s, operationId: prepared.operationId }))
      if (prepared.pullAmount > 0n && pocket !== null) {
        const pull = yield* chain.delegatedTransfer(
          input.wallet.contract_id,
          input.grant.rule_id,
          input.grant.signer_key_ref,
          pocket,
          prepared.pullAmount,
          yield* transferFeeCeiling(network, prepared.grant?.first_payment_done ?? false),
        )
        yield* Ref.update(input.state, s => ({ ...s, pull, pulled: prepared.pullAmount }))
        return pull
      }
      return null
    })

const bodyText = (response: Response) =>
  Effect.promise(async () => {
    const text = await response.text().catch(() => '')
    return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n…(truncated)` : text
  })

/**
 * The retry after the owner approved an over-allowance purchase: their passkey already moved the price into the pocket.
 * Check the seller asks no more than was approved, claim the submit, and pay from the pocket without a pull.
 */
const fundedHook =
  (input: {
    readonly ctx: ToolContext
    readonly wallet: Wallet
    readonly intent: PaymentIntent
    readonly state: Ref.Ref<PaidState>
  }) =>
  (quote: X402Quote) =>
    Effect.gen(function* () {
      const network = yield* Network
      if (quote.network !== network.caip || quote.asset !== network.usdcSac)
        return yield* decline('the seller changed its terms since the approval')
      if (quote.amountStroops > input.intent.amount)
        return yield* decline(
          `the seller now asks ${fromStroops(quote.amountStroops)} USDC, more than the ${fromStroops(input.intent.amount)} USDC the user approved`,
        )
      yield* Ref.update(input.state, s => ({ ...s, quote, intentId: input.intent.id }))
      const claim = yield* Ledger.use(ledger =>
        ledger.claimFunded(input.wallet.id, { intentId: input.intent.id, connectionId: input.ctx.props.connection_id }),
      ).pipe(Effect.mapError(error => new ChainError({ kind: 'declined', message: error.message })))
      if (claim._tag === 'NotClaimed') return yield* decline('this purchase is already being paid')
      yield* Ref.update(input.state, s => ({ ...s, operationId: claim.operationId }))
      return null
    })

/** The repeat of a paid call whose key already has an intent: report it, never pay again. */
const existingPaid = (ctx: ToolContext, intentId: string, grant: SpendingGrant | undefined, nowMs: number) =>
  Effect.gen(function* () {
    const intent = yield* intentById(intentId)
    if (intent === undefined) return yield* fail('The earlier intent for this key vanished.')
    const receipt = yield* receiptOfIntent(intent.id)
    const view = paymentView(intent, receipt, grant, ctx.origin, nowMs)
    return {
      status:
        view.status === 'confirmed'
          ? ('paid' as const)
          : view.status === 'awaiting_approval'
            ? ('requires_approval' as const)
            : view.status === 'failed' || view.status === 'expired'
              ? ('failed' as const)
              : ('paid' as const),
      payment_id: intent.id,
      price: fromStroops(intent.amount),
      receipt: view.receipt,
      approval_url: view.approval_url,
      approval_reason: view.approval_reason ?? null,
      message:
        view.status === 'confirmed'
          ? 'Already paid with this idempotency key; nothing was paid again. The content was returned by the first call.'
          : view.next_step,
      grant_remaining: view.grant_remaining,
    }
  })

const paid = <Body>(
  ctx: ToolContext,
  request: {
    readonly kind: 'x402_fetch' | 'x402_mcp'
    readonly key: string
    readonly fingerprint: string
    readonly resource: string
    readonly reason: string | null
    readonly maxAmount: string | undefined
  },
  pay: (
    grant: SpendingGrant,
    paymentId: string,
    maxAmount: bigint,
    onQuote: X402QuoteHook,
  ) => Effect.Effect<{ readonly body: Body; readonly settlement: Receipt | null }, ChainError>,
) =>
  Effect.gen(function* () {
    const { connection, wallet, grant, nowMs } = yield* scope(ctx, true)
    yield* requirePayments
    const existing = yield* intentByKey(wallet.id, connection.id, request.key)
    if (existing !== undefined) {
      if ((yield* fingerprintOf(existing.id)) !== request.fingerprint)
        return yield* fail(`Idempotency key ${request.key} was used for a different request; use a new key.`)
      // Funded by the owner's nod: this retry completes the purchase. Anything else is reported as it stands.
      if (existing.status !== 'approved')
        return { body: null, ...(yield* existingPaid(ctx, existing.id, grant, nowMs)) }
    }
    if (grant === undefined || (existing === undefined && grant.status !== 'active'))
      return yield* fail('This AI app has no live allowance; ask the user to set one (connection_grant_create).')
    // The chain's per-payment belt: what the user approved, the agent's own max_amount, else Nod's x402 price cap.
    // Whether the price fits the allowance is the quote hook's call (it routes a bigger one to the user's nod).
    const network = yield* Network
    const maxAmount =
      existing !== undefined
        ? existing.amount
        : request.maxAmount === undefined
          ? network.caps.maxX402PriceStroops
          : toStroops(request.maxAmount)
    const intentId = existing?.id ?? (yield* randomId('pi'))
    const state = yield* Ref.make<PaidState>({
      intentId: null,
      operationId: null,
      pull: null,
      pulled: 0n,
      quote: null,
      ownerLane: false,
    })
    const services = yield* Effect.context<Chain | Ledger | Network>()
    const hook =
      existing !== undefined
        ? fundedHook({ ctx, wallet, intent: existing, state })
        : quoteHook({
            ctx,
            wallet,
            grant,
            connectionName: connection.oauth_client_name,
            kind: request.kind,
            key: request.key,
            fingerprint: request.fingerprint,
            resource: request.resource,
            reason: request.reason,
            maxAmount,
            intentId,
            state,
          })
    const result = yield* Effect.result(pay(grant, intentId, maxAmount, quote => Effect.provide(hook(quote), services)))
    const after = yield* Ref.get(state)
    const ledger = yield* Ledger
    if (result._tag === 'Success') {
      const { body, settlement } = result.success
      if (settlement === null || after.operationId === null)
        return {
          body,
          status: 'free' as const,
          payment_id: null,
          price: null,
          receipt: null,
          approval_url: null,
          message: 'The resource answered without asking for payment.',
          grant_remaining: grantRemaining(grant, nowMs),
        }
      const intent = yield* ledger.settle(wallet.id, {
        intentId,
        operationId: after.operationId,
        outcome: { _tag: 'Confirmed', settlement, feePaidBy: 'facilitator', pull: after.pull, pulled: after.pulled },
      })
      const receipt = yield* receiptOfIntent(intent.id)
      const fresh = yield* grantOfConnection(connection.id)
      return {
        body,
        status: 'paid' as const,
        payment_id: intent.id,
        price: fromStroops(intent.amount),
        receipt: receipt === undefined ? null : receiptView(receipt),
        approval_url: null,
        message: `Paid ${fromStroops(intent.amount)} USDC from this AI app's allowance; the facilitator paid the network fee.`,
        grant_remaining: grantRemaining(fresh, yield* nowMillis),
      }
    }
    const error = result.failure
    if (after.operationId !== null)
      yield* ledger.settle(wallet.id, {
        intentId,
        operationId: after.operationId,
        outcome: outcomeOf(error, after.pull, after.pulled),
      })
    const fresh = yield* grantOfConnection(connection.id)
    if (after.intentId !== null && (after.ownerLane || error.kind === 'limit_exhausted')) {
      const intent = yield* intentById(after.intentId)
      const view =
        intent === undefined ? undefined : paymentView(intent, undefined, fresh, ctx.origin, yield* nowMillis)
      const reason = view?.approval_reason ?? 'over_allowance'
      return {
        body: null,
        status: 'requires_approval' as const,
        payment_id: after.intentId,
        price: after.quote === null ? null : fromStroops(after.quote.amountStroops),
        receipt: null,
        approval_url: view?.approval_url ?? null,
        approval_reason: reason,
        message: `The price is more than this AI app's allowance has left, so it needs the user's nod. Nothing was paid. Ask the user to open ${view?.approval_url ?? 'Nod'} and approve it with their passkey, then call this tool again with the same idempotency key.`,
        grant_remaining: grantRemaining(fresh, yield* nowMillis),
      }
    }
    return {
      body: null,
      status: error.kind === 'declined' ? ('refused' as const) : ('failed' as const),
      payment_id: after.intentId,
      price: after.quote === null ? null : fromStroops(after.quote.amountStroops),
      receipt: null,
      approval_url: null,
      message: `Not paid: ${error.message}.${after.pull === null ? '' : ` ${fromStroops(after.pulled)} USDC was pulled into this AI app's pocket (transaction ${after.pull.tx}, ${after.pull.explorer}) and stays there for the next purchase.`}`,
      pull:
        after.pull === null
          ? null
          : { tx_hash: after.pull.tx, explorer_url: after.pull.explorer, amount: fromStroops(after.pulled) },
      facilitator_message: error.kind === 'declined' ? null : error.message,
      grant_remaining: grantRemaining(fresh, yield* nowMillis),
    }
  })

export const paidResourceFetch = (ctx: ToolContext, input: PaidResourceFetchInput) =>
  Effect.gen(function* () {
    const chain = yield* Chain
    const outcome = yield* paid(
      ctx,
      {
        kind: 'x402_fetch',
        key: input.idempotency_key,
        fingerprint: `x402|${input.url}|${input.max_amount ?? ''}`,
        resource: input.url,
        reason: input.reason ?? null,
        maxAmount: input.max_amount,
      },
      (grant, paymentId, maxAmount, onQuote) =>
        Effect.map(chain.payX402(grant.signer_key_ref, input.url, maxAmount, paymentId, onQuote), result => ({
          body: result.body,
          settlement: result.settlement,
        })),
    )
    const body = outcome.body === null ? null : yield* bodyText(outcome.body)
    return {
      sentence:
        outcome.status === 'paid' && outcome.receipt !== null
          ? `Paid ${outcome.price ?? ''} USDC for ${input.url}; settlement ${outcome.receipt.tx_hash}${outcome.receipt.pull_tx_hash === null ? '' : `, pocket pull ${outcome.receipt.pull_tx_hash}`}. ${outcome.grant_remaining} USDC left.`
          : outcome.message,
      value: {
        status: outcome.status,
        payment_id: outcome.payment_id,
        http_status: outcome.body === null ? null : outcome.body.status,
        content_type: outcome.body === null ? null : outcome.body.headers.get('content-type'),
        body,
        price: outcome.price,
        receipt: outcome.receipt,
        approval_url: outcome.approval_url,
        approval_reason: 'approval_reason' in outcome ? outcome.approval_reason : null,
        message: outcome.message,
        pull: 'pull' in outcome ? outcome.pull : null,
        facilitator_message: 'facilitator_message' in outcome ? outcome.facilitator_message : null,
        grant_remaining: outcome.grant_remaining,
      },
    }
  })

export const paidMcpCall = (ctx: ToolContext, input: PaidMcpCallInput) =>
  Effect.gen(function* () {
    const chain = yield* Chain
    const args = input.arguments ?? {}
    const outcome = yield* paid(
      ctx,
      {
        kind: 'x402_mcp',
        key: input.idempotency_key,
        fingerprint: `mcp|${input.server_url}|${input.tool}|${JSON.stringify(args)}|${input.max_amount ?? ''}`,
        resource: `${input.server_url}#${input.tool}`,
        reason: input.reason ?? null,
        maxAmount: input.max_amount,
      },
      (grant, paymentId, maxAmount, onQuote) =>
        Effect.map(
          chain.payX402Mcp(grant.signer_key_ref, input.server_url, input.tool, args, maxAmount, paymentId, onQuote),
          result => ({ body: result.result, settlement: result.settlement }),
        ),
    )
    return {
      sentence:
        outcome.status === 'paid' && outcome.receipt !== null
          ? `Paid ${outcome.price ?? ''} USDC for ${input.tool}; settlement ${outcome.receipt.tx_hash}. ${outcome.grant_remaining} USDC left.`
          : outcome.message,
      value: {
        status: outcome.status,
        payment_id: outcome.payment_id,
        result: outcome.body,
        price: outcome.price,
        receipt: outcome.receipt,
        approval_url: outcome.approval_url,
        approval_reason: 'approval_reason' in outcome ? outcome.approval_reason : null,
        message: outcome.message,
        pull: 'pull' in outcome ? outcome.pull : null,
        facilitator_message: 'facilitator_message' in outcome ? outcome.facilitator_message : null,
        grant_remaining: outcome.grant_remaining,
      },
    }
  })

// 9. connection_grant_create / 10. connection_grant_revoke

export const connectionGrantCreate = (ctx: ToolContext, key: string) =>
  Effect.gen(function* () {
    const { grant, nowMs } = yield* scope(ctx, false)
    const url = `${ctx.origin}/connections`
    const value = {
      url,
      grant: grant === undefined ? null : toolGrantView(grant, nowMs),
      message:
        'This tool never grants anything itself. The user raises or renews the allowance by reconnecting this AI app to Nod: the consent page asks for an amount and an expiry, and their passkey signs it.',
      grant_remaining: grantRemaining(grant, nowMs),
    }
    yield* saveToolResult(ctx.props.connection_id, key, 'connection_grant_create', JSON.stringify(value))
    return { sentence: `Ask the user to open ${url} to change this AI app's allowance.`, value }
  })

export const connectionGrantRevoke = (ctx: ToolContext, key: string) =>
  Effect.gen(function* () {
    const saved = yield* toolResult(ctx.props.connection_id, key)
    const { wallet } = yield* scope(ctx, false)
    if (saved === undefined) {
      yield* revokeConnection(wallet.id, wallet.contract_id, ctx.props.connection_id)
    }
    const grant = yield* grantOfConnection(ctx.props.connection_id)
    const removed = grant?.rule_status === 'removed'
    const url = revokeUrl(ctx.origin, ctx.props.connection_id)
    const value = {
      status: 'revoked' as const,
      onchain: removed ? ('removed' as const) : ('pending_owner' as const),
      approval_url: removed ? null : url,
      sweep_tx: grant?.sweep_tx ?? null,
      removal_tx: grant?.remove_tx ?? null,
      message: removed
        ? 'Revoked: Nod stopped paying for this AI app and its allowance is gone from the Stellar account.'
        : `Revoked: Nod stops paying for this AI app now. The user removes the allowance from their Stellar account with their passkey at ${url}.`,
      grant_remaining: '0.00',
    }
    if (saved === undefined)
      yield* saveToolResult(ctx.props.connection_id, key, 'connection_grant_revoke', JSON.stringify(value))
    return { sentence: value.message, value }
  })

/** Storage failures become a retryable tool error. */
export const asToolError = <A, R>(effect: Effect.Effect<A, ToolError | DbError | LedgerError, R>) =>
  Effect.catchTags(effect, {
    DbError: error => Effect.fail(storage(error)),
    LedgerError: error => Effect.fail(storage(error)),
  })
