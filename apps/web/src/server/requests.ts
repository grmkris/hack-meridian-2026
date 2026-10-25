import { Effect, Schema } from 'effect'

import {
  fromStroops,
  Network as NetworkId,
  type RequestCreateInput,
  type RequestPayOutput,
  type RequestsListInput,
  type RequestStatus,
  type RequestView,
  Stroops,
  toStroops,
  type Wallet,
} from '@hm/protocol'

import { isoIn, millisOf, nowIso, nowMillis, randomId } from './clock.ts'
import { DbError, sql } from './db.ts'
import { requestAnswered, requestReceived } from './events/emit.ts'
import { EventsHost } from './events/host.ts'
import { journalStatement } from './events/journal.ts'
import { Network } from './network.ts'
import type { RequestPageView } from './pages.ts'
import { first, insert, query, write } from './rows.ts'
import { intentById, receiptOfIntent, searchContacts } from './store.ts'
import { paymentPrepare, resolveRecipient, scope, ToolError, type ToolContext, type ToolResult } from './tools.ts'
import { grantRemaining, receiptView } from './views.ts'

/**
 * Payment requests between Nod wallets (plan Phase 3). A request is a row; it is paid when the payment its payer
 * prepared with request_pay confirms, and declined when the payer says no. Statuses beyond the row (paid, expired) are
 * read from the linked intent and the clock, so no money path writes here.
 *
 * Safety: a request is never authority to pay. Paying one from a requester outside the payer's contacts always takes
 * the owner lane (the payer's passkey), whatever the amount, so a stranger cannot drain an allowance with small
 * requests. The note is the requester's words: shown as theirs, never placed in an event payload.
 */

const DEFAULT_TTL_HOURS = 168

const fail = (message: string) => Effect.fail(new ToolError({ message }))

const RequestRow = Schema.Struct({
  id: Schema.String,
  requester_wallet_id: Schema.String,
  requester_connection_id: Schema.NullOr(Schema.String),
  requester_address: Schema.String,
  payer_wallet_id: Schema.NullOr(Schema.String),
  payer_address: Schema.String,
  amount: Stroops,
  asset: Schema.Literal('USDC'),
  network: NetworkId,
  note: Schema.NullOr(Schema.String),
  status: Schema.Literals(['open', 'paid', 'declined']),
  intent_id: Schema.NullOr(Schema.String),
  idempotency_key: Schema.String,
  request_fingerprint: Schema.String,
  expires_at: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
})
type RequestRow = typeof RequestRow.Type

const toRow = (row: Record<string, unknown>) =>
  Schema.decodeUnknownEffect(RequestRow)(row).pipe(
    Effect.mapError(error => new DbError({ operation: 'decode payment_requests', message: String(error) })),
  )

export const requestById = (id: string) => first(sql('SELECT * FROM payment_requests WHERE id = ?', id), toRow)

const requestByKey = (walletId: string, connectionId: string, key: string) =>
  first(
    sql(
      'SELECT * FROM payment_requests WHERE requester_wallet_id = ? AND requester_connection_id = ? AND idempotency_key = ?',
      walletId,
      connectionId,
      key,
    ),
    toRow,
  )

const walletOfAddress = (address: string) =>
  first(sql('SELECT id, owner_id FROM wallets WHERE contract_id = ?', address), row =>
    Effect.succeed({ id: String(row['id']), ownerId: String(row['owner_id']) }),
  )

const requestPath = (requestId: string) => `/approve/request/${requestId}`
export const requestUrl = (origin: string, requestId: string) => `${origin}${requestPath(requestId)}`

/** The row's status at `nowMs`: paid once its intent confirmed, expired once past its time and still open. */
const statusOf = (row: RequestRow, intentStatus: string | undefined, nowMs: number): RequestStatus => {
  if (row.status === 'declined') return 'declined'
  if (row.status === 'paid' || intentStatus === 'confirmed') return 'paid'
  return millisOf(row.expires_at) <= nowMs ? 'expired' : 'open'
}

/** The name the viewer saved an address under, or null. */
const contactNameOf = (ownerId: string, address: string) =>
  Effect.map(searchContacts(ownerId, address), contacts => contacts[0]?.display_name ?? null)

const viewOf = (ctx: ToolContext, walletId: string, row: RequestRow) =>
  Effect.gen(function* () {
    const intent = row.intent_id === null ? undefined : yield* intentById(row.intent_id)
    const receipt = intent === undefined ? undefined : yield* receiptOfIntent(intent.id)
    const status = statusOf(row, intent?.status, yield* nowMillis)
    const direction = row.payer_wallet_id === walletId ? 'incoming' : 'outgoing'
    const requesterName = yield* contactNameOf(ctx.props.owner_id, row.requester_address)
    const payerName = yield* contactNameOf(ctx.props.owner_id, row.payer_address)
    const amount = fromStroops(row.amount)
    const who = requesterName ?? 'an unknown Nod wallet'
    const next_step =
      direction === 'incoming'
        ? status === 'open'
          ? `Ask the user whether to pay ${amount} USDC to ${who}; if yes, call request_pay with request_id ${row.id}${requesterName === null ? ' (they are not a saved contact, so it will need the user’s nod)' : ''}, or request_decline.`
          : `This request is ${status}; nothing to do.`
        : status === 'open'
          ? `Wait for ${payerName ?? 'the payer'} to pay; call requests_list later, or share ${requestUrl(ctx.origin, row.id)}.`
          : `This request is ${status}.`
    const view: RequestView = {
      request_id: row.id,
      direction,
      status,
      amount,
      asset: row.asset,
      network: row.network,
      requester: { address: row.requester_address, contact_name: requesterName, is_you: direction === 'outgoing' },
      payer: { address: row.payer_address, contact_name: payerName, is_you: direction === 'incoming' },
      payer_is_nod_wallet: row.payer_wallet_id !== null,
      note: row.note,
      request_url: requestUrl(ctx.origin, row.id),
      payment_id: row.intent_id,
      receipt: receipt === undefined ? null : receiptView(receipt),
      expires_at: row.expires_at,
      created_at: row.created_at,
      next_step,
    }
    return view
  })

// request_create

export const requestCreate = (ctx: ToolContext, input: RequestCreateInput) =>
  Effect.gen(function* () {
    const { connection, wallet } = yield* scope(ctx, true)
    const network = yield* Network
    const amount = toStroops(input.amount)
    if (amount <= 0n) return yield* fail('The amount must be more than zero.')
    if (amount > network.caps.maxOwnerPaymentStroops)
      return yield* fail(`Nod caps a request at ${fromStroops(network.caps.maxOwnerPaymentStroops)} USDC.`)
    const payer = yield* resolveRecipient(ctx.props.owner_id, input.payer)
    if (payer.address === wallet.contract_id) return yield* fail('That is this wallet itself.')
    const fingerprint = `request|${payer.address}|${amount}|${input.note ?? ''}`
    const existing = yield* requestByKey(wallet.id, connection.id, input.idempotency_key)
    const row =
      existing ??
      (yield* Effect.gen(function* () {
        const now = yield* nowIso
        const id = yield* randomId('rq')
        const payerWallet = yield* walletOfAddress(payer.address)
        const expiresAt = yield* isoIn((input.expires_in_hours ?? DEFAULT_TTL_HOURS) * 3_600_000)
        const received =
          payerWallet === undefined
            ? []
            : [
                journalStatement(
                  requestReceived({
                    walletId: payerWallet.id,
                    network: network.caip,
                    requestId: id,
                    amount,
                    // How the payer saved the requester, never the requester's own wallet name.
                    from: {
                      address: wallet.contract_id,
                      contact_name: yield* contactNameOf(payerWallet.ownerId, wallet.contract_id),
                    },
                    expiresAt,
                    url: requestPath(id),
                    occurredAt: now,
                  }),
                ),
              ]
        yield* write(
          insert('payment_requests', {
            id,
            requester_wallet_id: wallet.id,
            requester_connection_id: connection.id,
            requester_address: wallet.contract_id,
            payer_wallet_id: payerWallet?.id ?? null,
            payer_address: payer.address,
            amount,
            asset: 'USDC',
            network: network.caip,
            note: input.note ?? null,
            status: 'open',
            intent_id: null,
            idempotency_key: input.idempotency_key,
            request_fingerprint: fingerprint,
            expires_at: expiresAt,
            created_at: now,
            updated_at: now,
          }),
          ...received,
        )
        if (payerWallet !== undefined) yield* EventsHost.use(host => host.poke(payerWallet.id))
        const created = yield* requestById(id)
        if (created === undefined)
          return yield* fail('The request was not stored; retry with the same idempotency key.')
        return created
      }))
    if (row.request_fingerprint !== fingerprint)
      return yield* fail(
        `idempotency_key ${input.idempotency_key} was already used for a different request; use a fresh key.`,
      )
    const view = yield* viewOf(ctx, wallet.id, row)
    const who = payer.name ?? payer.address
    const result: ToolResult<RequestView> = {
      sentence: `Asked ${who} for ${view.amount} USDC on Stellar ${network.label}${view.payer_is_nod_wallet ? '; it is in their Nod inbox' : ''}. They can also open ${view.request_url}.`,
      value: view,
    }
    return result
  })

// requests_list

export const requestsList = (ctx: ToolContext, input: RequestsListInput) =>
  Effect.gen(function* () {
    const { wallet, grant, nowMs } = yield* scope(ctx, false)
    const direction = input.direction ?? 'all'
    const rows = yield* query(
      sql(
        direction === 'incoming'
          ? 'SELECT * FROM payment_requests WHERE payer_wallet_id = ? ORDER BY created_at DESC LIMIT 50'
          : direction === 'outgoing'
            ? 'SELECT * FROM payment_requests WHERE requester_wallet_id = ? ORDER BY created_at DESC LIMIT 50'
            : 'SELECT * FROM payment_requests WHERE payer_wallet_id = ?1 OR requester_wallet_id = ?1 ORDER BY created_at DESC LIMIT 50',
        wallet.id,
      ),
      toRow,
    )
    const views = yield* Effect.forEach(rows, row => viewOf(ctx, wallet.id, row))
    const wanted = input.status ?? 'all'
    const requests = wanted === 'all' ? views : views.filter(view => view.status === wanted)
    const open = requests.filter(view => view.status === 'open' && view.direction === 'incoming').length
    return {
      sentence:
        requests.length === 0
          ? 'No payment requests.'
          : `${requests.length} payment request${requests.length === 1 ? '' : 's'}${open > 0 ? `; ${open} waiting for this wallet to pay` : ''}.`,
      value: { requests, grant_remaining: grantRemaining(grant, nowMs) },
    }
  })

// request_pay

export const requestPay = (ctx: ToolContext, requestId: string, idempotencyKey: string) =>
  Effect.gen(function* () {
    const { wallet } = yield* scope(ctx, true)
    const row = yield* requestById(requestId)
    if (row === undefined || (row.payer_wallet_id !== wallet.id && row.payer_address !== wallet.contract_id))
      return yield* fail(`No payment request ${requestId} is addressed to this wallet.`)
    const intent = row.intent_id === null ? undefined : yield* intentById(row.intent_id)
    const status = statusOf(row, intent?.status, yield* nowMillis)
    if (status === 'declined' || status === 'expired')
      return yield* fail(`Request ${requestId} is ${status}; nothing was paid.`)
    // A requester outside the payer's contacts never gets the autonomous lane: the payer's nod is always needed.
    const requester = yield* resolveRecipient(ctx.props.owner_id, row.requester_address)
    const prepared = yield* paymentPrepare(
      ctx,
      {
        recipient: row.requester_address,
        amount: fromStroops(row.amount),
        reason: `Payment request ${row.id} from ${requester.name ?? 'an unknown Nod wallet'}`,
        idempotency_key: idempotencyKey,
      },
      { forceOwner: requester.contactId === null },
    )
    if (row.intent_id === null)
      yield* write(
        sql(
          'UPDATE payment_requests SET intent_id = ?, updated_at = ? WHERE id = ? AND intent_id IS NULL',
          prepared.value.payment_id,
          yield* nowIso,
          row.id,
        ),
      )
    else if (row.intent_id !== prepared.value.payment_id)
      return yield* fail(
        `Request ${requestId} is already being paid by payment ${row.intent_id}; call payment_status with that payment_id.`,
      )
    const value: RequestPayOutput = { ...prepared.value, request_id: row.id }
    return { sentence: prepared.sentence, value }
  })

// request_decline

export const requestDecline = (ctx: ToolContext, requestId: string) =>
  Effect.gen(function* () {
    const { wallet } = yield* scope(ctx, true)
    const row = yield* requestById(requestId)
    if (row === undefined || (row.payer_wallet_id !== wallet.id && row.payer_address !== wallet.contract_id))
      return yield* fail(`No payment request ${requestId} is addressed to this wallet.`)
    const intent = row.intent_id === null ? undefined : yield* intentById(row.intent_id)
    const status = statusOf(row, intent?.status, yield* nowMillis)
    if (status === 'open' && (intent === undefined || intent.status === 'expired' || intent.status === 'failed')) {
      const now = yield* nowIso
      const requester = yield* walletOfAddress(row.requester_address)
      yield* write(
        sql(
          "UPDATE payment_requests SET status = 'declined', updated_at = ? WHERE id = ? AND status = 'open'",
          now,
          row.id,
        ),
        ...(requester === undefined
          ? []
          : [
              journalStatement(
                requestAnswered({
                  walletId: requester.id,
                  network: row.network,
                  requestId: row.id,
                  status: 'declined',
                  amount: row.amount,
                  by: {
                    address: wallet.contract_id,
                    contact_name: yield* contactNameOf(requester.ownerId, wallet.contract_id),
                  },
                  tx: null,
                  explorer: null,
                  url: requestPath(row.id),
                  occurredAt: now,
                }),
              ),
            ]),
      )
      if (requester !== undefined) yield* EventsHost.use(host => host.poke(requester.id))
    } else if (status === 'open')
      return yield* fail(`Request ${requestId} already has payment ${row.intent_id} in progress; it can't be declined.`)
    const updated = yield* requestById(requestId)
    if (updated === undefined) return yield* fail(`Request ${requestId} is gone.`)
    const view = yield* viewOf(ctx, wallet.id, updated)
    return { sentence: `Request ${requestId} is ${view.status}.`, value: view }
  })

/** The request page's view for whoever is signed in (or nobody): names come from the viewer's own contacts. */
export const requestPageView = (requestId: string, viewer: Wallet | undefined) =>
  Effect.gen(function* () {
    const row = yield* requestById(requestId)
    if (row === undefined) return undefined
    const intent = row.intent_id === null ? undefined : yield* intentById(row.intent_id)
    const receipt = intent === undefined ? undefined : yield* receiptOfIntent(intent.id)
    const who =
      viewer === undefined
        ? 'other'
        : viewer.id === row.payer_wallet_id || viewer.contract_id === row.payer_address
          ? 'payer'
          : viewer.id === row.requester_wallet_id
            ? 'requester'
            : 'other'
    const nameOf = (address: string) =>
      viewer === undefined ? Effect.succeed(null) : contactNameOf(viewer.owner_id, address)
    const view: RequestPageView = {
      id: row.id,
      status: statusOf(row, intent?.status, yield* nowMillis),
      amount: row.amount,
      requesterAddress: row.requester_address,
      requesterName: yield* nameOf(row.requester_address),
      payerAddress: row.payer_address,
      payerName: yield* nameOf(row.payer_address),
      viewer: who,
      // The note is shown only to the two parties.
      note: who === 'other' ? null : row.note,
      expiresAt: row.expires_at,
      paymentId: row.intent_id,
      paidTx: receipt?.tx_hash ?? null,
    }
    return view
  })
