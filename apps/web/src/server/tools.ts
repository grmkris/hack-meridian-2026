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
  type PaymentPrepareInput,
  type Readiness,
  type Receipt,
  type SpendingGrant,
  toStroops,
  USDC_SAC,
  type Wallet,
  type X402Quote,
  type X402QuoteHook,
} from '@hm/protocol'

import { nowMillis, randomId } from './clock.ts'
import type { DbError } from './db.ts'
import { Ledger, type LedgerError, type Outcome } from './ledger.ts'
import type { ConnectionProps } from './props.ts'
import { revokeConnection } from './revoke.ts'
import {
  connectionById,
  fingerprintOf,
  grantOfConnection,
  intentById,
  intentByKey,
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
const storage = (error: DbError | LedgerError) =>
  new ToolError({
    message:
      error._tag === 'LedgerError' && error.reason === 'idempotency_conflict'
        ? error.message
        : `The wallet service could not complete this (${error._tag === 'DbError' ? error.operation : error.message}). Retry with the same idempotency key.`,
  })

const ADDRESS = /^(?:[CG][A-Z2-7]{55}|M[A-Z2-7]{68})$/u

/** The connection, its wallet and its grant; refuses a revoked connection for writes. */
const scope = (ctx: ToolContext, write: boolean) =>
  Effect.gen(function* () {
    const connection = yield* connectionById(ctx.props.connection_id)
    if (connection === undefined || connection.wallet_id !== ctx.props.wallet_id)
      return yield* fail('This connection is unknown to the wallet. Reconnect.')
    if (write && connection.status === 'revoked')
      return yield* fail(
        'This connection was revoked by the wallet owner. It can no longer pay; reconnect to ask again.',
      )
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
    const balances = yield* chain.balances(wallet.contract_id).pipe(
      Effect.map(b => ({ usdc: fromStroops(b.usdc), xlm: fromStroops(b.xlm) })),
      Effect.catchTag('ChainError', () => Effect.succeed({ usdc: 'unavailable', xlm: 'unavailable' })),
    )
    const pending = yield* pendingOfWallet(wallet.id, connection.id)
    const receipts = yield* receiptsOfWallet(wallet.id, 5, connection.id)
    const remaining = grantRemaining(grant, nowMs)
    return {
      sentence: `Wallet ${wallet.name} holds ${balances.usdc} USDC. This connection may still spend ${remaining} USDC${grant === undefined ? '' : ` until ${grant.valid_until}`}; larger payments need the owner's approval.`,
      value: {
        wallet: { id: wallet.id, name: wallet.name, contract_id: wallet.contract_id, network: wallet.network },
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
const resolveRecipient = (ownerId: string, recipient: string) =>
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

export const paymentPrepare = (ctx: ToolContext, input: PaymentPrepareInput) =>
  Effect.gen(function* () {
    const { connection, wallet, grant } = yield* scope(ctx, true)
    const amount = toStroops(input.amount)
    if (amount <= 0n) return yield* fail('The amount must be more than zero.')
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
      return yield* fail(`${recipient.address} does not exist on Stellar testnet yet, so it cannot receive USDC.`)
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
      forceOwner: false,
      claim: false,
      operationKind: 'transfer',
      pocketBalance: null,
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
          ? `This payment of ${view.amount} USDC to ${recipient.name ?? recipient.address} needs the wallet owner's approval. Ask the user to open ${view.approval_url} and approve it with their passkey, then call payment_status with payment_id ${view.payment_id}.`
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
    const { connection, wallet } = yield* scope(ctx, true)
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
        ? `Paid ${view.amount} USDC to ${view.recipient.name ?? view.recipient.address}. Transaction ${view.receipt.tx_hash} (${view.receipt.explorer_url}). The connection may still spend ${view.grant_remaining} USDC.`
        : view.approval_url !== null
          ? `Not paid: this needs the wallet owner's approval. Ask the user to open ${view.approval_url}, then call payment_status with payment_id ${view.payment_id}.`
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
    const { grant, nowMs } = yield* scope(ctx, false)
    const intent = yield* ownIntent(ctx, paymentId)
    const view = paymentView(intent, yield* receiptOfIntent(intent.id), grant, ctx.origin, nowMs)
    const sentence =
      view.status === 'confirmed' && view.receipt !== null
        ? `Confirmed. Transaction ${view.receipt.tx_hash} in ledger ${view.receipt.ledger} (${view.receipt.explorer_url}).`
        : view.approval_url !== null
          ? `Still waiting for the owner to approve at ${view.approval_url}.`
          : view.next_step
    return { sentence, value: view }
  })

export const paymentApproveUrl = (ctx: ToolContext, paymentId: string) =>
  Effect.gen(function* () {
    const { grant, nowMs } = yield* scope(ctx, false)
    const intent = yield* ownIntent(ctx, paymentId)
    const view = paymentView(intent, undefined, grant, ctx.origin, nowMs)
    return {
      sentence:
        view.approval_url !== null
          ? `Ask the user to open ${view.approval_url} and approve with their passkey, then call payment_status.`
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
      if (quote.network !== 'stellar:testnet')
        return yield* decline(`the seller wants ${quote.network}, not stellar:testnet`)
      if (quote.asset !== USDC_SAC) return yield* decline(`the seller wants asset ${quote.asset}, not testnet USDC`)
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
    const existing = yield* intentByKey(wallet.id, connection.id, request.key)
    if (existing !== undefined) {
      if ((yield* fingerprintOf(existing.id)) !== request.fingerprint)
        return yield* fail(`Idempotency key ${request.key} was used for a different request; use a new key.`)
      return { body: null, ...(yield* existingPaid(ctx, existing.id, grant, nowMs)) }
    }
    if (grant === undefined || grant.status !== 'active')
      return yield* fail('This connection has no live spending grant; ask the owner (connection_grant_create).')
    const remaining = grant.total - grant.spent - grant.reserved + grant.pocket_balance
    const maxAmount = request.maxAmount === undefined ? remaining : toStroops(request.maxAmount)
    const intentId = yield* randomId('pi')
    const state = yield* Ref.make<PaidState>({
      intentId: null,
      operationId: null,
      pull: null,
      pulled: 0n,
      quote: null,
      ownerLane: false,
    })
    const services = yield* Effect.context<Chain | Ledger>()
    const hook = quoteHook({
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
        message: `Paid ${fromStroops(intent.amount)} USDC from the connection's allowance.`,
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
      return {
        body: null,
        status: 'requires_approval' as const,
        payment_id: after.intentId,
        price: after.quote === null ? null : fromStroops(after.quote.amountStroops),
        receipt: null,
        approval_url: view?.approval_url ?? null,
        message: `The price does not fit this connection's remaining allowance. Nothing was paid. Ask the user to open ${view?.approval_url ?? 'the wallet'} to approve it, then call this tool again with the same idempotency key.`,
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
      message: `Not paid: ${error.message}.${after.pull === null ? '' : ` ${fromStroops(after.pulled)} USDC was pulled into the pocket and stays available for the next purchase.`}`,
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
        message: outcome.message,
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
        message: outcome.message,
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
      message:
        'This tool never grants anything itself. The owner raises or renews an allowance by reconnecting this client: the consent page asks for a new amount and expiry and their passkey signs it.',
      grant_remaining: grantRemaining(grant, nowMs),
    }
    yield* saveToolResult(ctx.props.connection_id, key, 'connection_grant_create', JSON.stringify(value))
    return { sentence: `Ask the user to open ${url} to change this connection's allowance.`, value }
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
      sweep_tx: null,
      message: removed
        ? 'Revoked: the service stopped signing and the onchain rule is gone.'
        : `Revoked in the service: this connection can no longer pay. Removing its rule onchain needs the owner's passkey at ${url}.`,
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
