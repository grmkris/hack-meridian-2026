import { Effect, Schema } from 'effect'

import { Assertion } from '@hm/api'
import { Chain, type ChainError, fromStroops, PreparedClaim, PreparedOwnerAuth } from '@hm/protocol'

import { nowMillis, randomId } from './clock.ts'
import type { DbError } from './db.ts'
import { effectiveStatus, Ledger, type LedgerError, type Outcome } from './ledger.ts'
import { Network } from './network.ts'
import { checkAssertion, OwnerError, requireWallet, sessionToken, walletOfSession } from './owner.ts'
import { approvalPage, claimPage, html, messagePage, revokePage } from './pages.ts'
import { revokeConnection } from './revoke.ts'
import type { AppRuntime, AppServices } from './runtime.ts'
import {
  approvalPreparedOf,
  claimPreparedOf,
  connectionById,
  grantById,
  grantOfConnection,
  intentById,
  putScratch,
  receiptOfIntent,
  toolResult,
} from './store.ts'
import { claimUrl } from './views.ts'
import { siteOf, WalletSettings } from './wallet-settings.ts'
import { b64urlDecode } from './webauthn.ts'

/**
 * The owner's pages outside the SPA: /approve/<intent> (one exact payment, signed by the passkey), /approve/revoke/
 * <connection> (rule removal) and /claim/<intent> (CAP-73 acceptance). GETs never change anything; each action is a
 * prepare (the chain builds the invocation and its challenge) followed by a POST with the passkey's assertion over it.
 */

/** This response's script nonce and the network label every page shows. */
const chrome = Effect.gen(function* () {
  const id = yield* randomId('n')
  const network = yield* Network
  return { nonce: id.slice(2), network: network.label }
})
/** Owner auth for ≈ 400 ledgers (≈ 33 min): the approval page's validity. */
const OWNER_AUTH_LEDGERS = 400

type RouteError = OwnerError | DbError | LedgerError | ChainError

const statusOf = (error: RouteError) =>
  error._tag === 'OwnerError'
    ? error.kind === 'unauthorized'
      ? 401
      : error.kind === 'bad_request'
        ? 400
        : 503
    : error._tag === 'ChainError'
      ? 502
      : error._tag === 'LedgerError' && error.reason === 'not_found'
        ? 404
        : error._tag === 'LedgerError' && error.reason === 'invalid_state'
          ? 409
          : 503

const messageOf = (error: RouteError) =>
  error._tag === 'DbError'
    ? 'storage failed; retry'
    : error._tag === 'ChainError'
      ? `chain: ${error.message}`
      : error.message

const json = (runtime: AppRuntime, effect: Effect.Effect<unknown, RouteError, AppServices>) =>
  runtime.runPromise(
    effect.pipe(
      Effect.map(value => Response.json(value)),
      Effect.catch(error => Effect.succeed(Response.json({ error: messageOf(error) }, { status: statusOf(error) }))),
    ),
  )

const page = (runtime: AppRuntime, effect: Effect.Effect<Response, RouteError, AppServices>) =>
  runtime.runPromise(
    effect.pipe(
      Effect.catch(error =>
        Effect.map(chrome, n =>
          html(n, messagePage(n, 'Not available', messageOf(error)), { status: statusOf(error) }),
        ),
      ),
    ),
  )

/** The passkey answer as the page POSTs it: `{ assertion: { credential_id, client_data_json, … } }`, base64url. */
const readAssertionJson = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => new OwnerError({ kind: 'bad_request', message: 'expected JSON' }),
  }).pipe(
    Effect.flatMap(body => Schema.decodeUnknownEffect(Schema.Struct({ assertion: Assertion }))(body)),
    Effect.map(({ assertion }) => assertion),
    Effect.mapError(error =>
      error instanceof OwnerError
        ? error
        : new OwnerError({ kind: 'bad_request', message: 'the passkey answer is missing' }),
    ),
  )

const toAssertionInput = (assertion: typeof Assertion.Type) => ({
  credentialId: assertion.credential_id,
  clientDataJSON: assertion.client_data_json,
  authenticatorData: assertion.authenticator_data,
  signature: assertion.signature,
})

const readAssertion = (request: Request) => Effect.map(readAssertionJson(request), toAssertionInput)

const decodeClaim = (text: string | null) =>
  text === null
    ? Effect.fail(new OwnerError({ kind: 'bad_request', message: 'the owner has not approved this payment yet' }))
    : Schema.decodeUnknownEffect(Schema.fromJsonString(PreparedClaim))(text).pipe(
        Effect.mapError(() => new OwnerError({ kind: 'bad_request', message: 'the prepared claim is unreadable' })),
      )

const decodePrepared = (text: string | null) =>
  text === null
    ? Effect.fail(new OwnerError({ kind: 'bad_request', message: 'press Approve again: nothing is prepared' }))
    : Schema.decodeUnknownEffect(Schema.fromJsonString(PreparedOwnerAuth))(text).pipe(
        Effect.mapError(() => new OwnerError({ kind: 'bad_request', message: 'the prepared payment is unreadable' })),
      )

/** The kill switch and the per-payment cap, checked before the chain prepares or submits anything. */
const paymentsAllowed = (amount: bigint) =>
  Effect.gen(function* () {
    const network = yield* Network
    if (!network.caps.paymentsEnabled)
      return yield* new OwnerError({ kind: 'unavailable', message: 'Payments are paused on Nod right now.' })
    if (amount > network.caps.maxOwnerPaymentStroops)
      return yield* new OwnerError({
        kind: 'bad_request',
        message: `Nod caps a single payment at ${fromStroops(network.caps.maxOwnerPaymentStroops)} USDC on ${network.label}.`,
      })
    return undefined
  })

const ownedIntent = (intentId: string, walletId: string) =>
  Effect.flatMap(intentById(intentId), intent =>
    intent === undefined || intent.wallet_id !== walletId
      ? Effect.fail(new OwnerError({ kind: 'bad_request', message: `no payment ${intentId} in this wallet` }))
      : Effect.succeed(intent),
  )

// /approve/<intent>

const approvalGet = (runtime: AppRuntime, request: Request, intentId: string) =>
  page(
    runtime,
    Effect.gen(function* () {
      const n = yield* chrome
      const site = yield* siteOf(request)
      const intent = yield* intentById(intentId)
      if (intent === undefined) return html(n, messagePage(n, 'Not found', `No payment ${intentId}.`), { status: 404 })
      const wallet = yield* walletOfSession(sessionToken(request))
      const connection = intent.connection_id === null ? undefined : yield* connectionById(intent.connection_id)
      return html(
        n,
        approvalPage(n, {
          intent,
          status: effectiveStatus(intent, yield* nowMillis),
          receipt: yield* receiptOfIntent(intent.id),
          signedIn: wallet !== undefined && wallet.id === intent.wallet_id ? wallet : undefined,
          connectionName:
            connection === undefined ? null : `${connection.oauth_client_name} · ${connection.id.slice(4, 12)}`,
          rpId: site.rpId,
          ...(intent.recipient_readiness === 'trustline_required'
            ? { claimUrl: claimUrl(site.origin, intent.id) }
            : {}),
          ...(intent.kind !== 'payment'
            ? {
                notice:
                  'This is an x402 purchase above the allowance. Approving sends the price to the connection’s pocket; the agent then retries with the same key.',
              }
            : intent.recipient_readiness === 'trustline_required'
              ? {
                  notice:
                    'The recipient has no USDC trustline yet: they accept on the claim link first, then this approval pays in one transaction.',
                }
              : {}),
        }),
      )
    }),
  )

/** The owner pressed Approve: the chain prepares exactly this transfer and its passkey challenge. */
const approvalPrepare = (runtime: AppRuntime, request: Request, intentId: string) =>
  json(
    runtime,
    Effect.gen(function* () {
      const wallet = yield* requireWallet(request)
      const intent = yield* ownedIntent(intentId, wallet.id)
      yield* paymentsAllowed(intent.amount)
      if (effectiveStatus(intent, yield* nowMillis) !== 'awaiting_approval')
        return yield* new OwnerError({ kind: 'bad_request', message: `this payment is ${intent.status}` })
      if (intent.kind === 'payment' && intent.recipient_readiness === 'trustline_required') {
        // CAP-73: the owner signs the sender side of the router call now; the recipient accepts on the claim link.
        const prepared = yield* Chain.use(chain =>
          chain.prepareClaim(wallet.contract_id, intent.recipient_address, intent.amount, OWNER_AUTH_LEDGERS),
        )
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(PreparedClaim))(prepared).pipe(
          Effect.mapError(() => new OwnerError({ kind: 'unavailable', message: 'could not store the prepared claim' })),
        )
        yield* Ledger.use(ledger => ledger.setClaimPrepared(wallet.id, { intentId, prepared: encoded }))
        return { challenge: prepared.senderChallenge, valid_until_ledger: prepared.validUntilLedger }
      }
      const grant = intent.grant_id === null ? undefined : yield* grantById(intent.grant_id)
      const to = intent.kind === 'payment' ? intent.recipient_address : grant?.pocket_address
      if (to === undefined || to === null)
        return yield* new OwnerError({ kind: 'bad_request', message: 'this purchase has no pocket to fund' })
      const chain = yield* Chain
      const prepared = yield* chain.prepareOwnerTransfer(wallet.contract_id, to, intent.amount, OWNER_AUTH_LEDGERS)
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(PreparedOwnerAuth))(prepared).pipe(
        Effect.mapError(() => new OwnerError({ kind: 'unavailable', message: 'could not store the prepared payment' })),
      )
      yield* Ledger.use(ledger => ledger.setApprovalPrepared(wallet.id, { intentId, prepared: encoded }))
      return { challenge: prepared.challenge, valid_until_ledger: prepared.validUntilLedger }
    }),
  )

/** The passkey signed the prepared transfer: verify, claim, submit, record. */
const approvalPost = (runtime: AppRuntime, request: Request, intentId: string) =>
  json(
    runtime,
    Effect.gen(function* () {
      const wallet = yield* requireWallet(request)
      const site = yield* siteOf(request)
      const intent = yield* ownedIntent(intentId, wallet.id)
      yield* paymentsAllowed(intent.amount)
      if (intent.kind === 'payment' && intent.recipient_readiness === 'trustline_required') {
        const claimPrepared = yield* decodeClaim((yield* claimPreparedOf(intent.id)) ?? null)
        const raw = yield* readAssertionJson(request)
        yield* checkAssertion(site, wallet, toAssertionInput(raw), claimPrepared.senderChallenge)
        const approved = yield* Ledger.use(ledger =>
          ledger.approveClaim(wallet.id, { intentId, assertion: JSON.stringify(raw) }),
        )
        return { status: approved.intent.status }
      }
      const prepared = yield* decodePrepared((yield* approvalPreparedOf(intent.id)) ?? null)
      const assertion = yield* checkAssertion(site, wallet, yield* readAssertion(request), prepared.challenge)
      const ledger = yield* Ledger
      const claim = yield* ledger.claimOwner(wallet.id, { intentId })
      if (claim._tag === 'NotClaimed') return { status: claim.intent.status }
      const chain = yield* Chain
      const outcome: Outcome = yield* chain.finalizeOwnerTransfer(prepared, assertion).pipe(
        Effect.map((settlement): Outcome => ({
          _tag: 'Confirmed',
          settlement,
          feePaidBy: 'relayer',
          pull: null,
          pulled: 0n,
        })),
        Effect.catchTag('ChainError', error =>
          Effect.succeed<Outcome>(
            error.kind === 'unknown'
              ? { _tag: 'Unknown', message: error.message, tx: error.tx ?? null }
              : { _tag: 'Failed', kind: error.kind, message: error.message, pull: null, pulled: 0n },
          ),
        ),
      )
      const settled = yield* ledger.settle(wallet.id, { intentId, operationId: claim.operationId, outcome })
      return { status: settled.status, failure: settled.failure }
    }),
  )

// /approve/revoke/<connection>

const revokeGet = (runtime: AppRuntime, request: Request, connectionId: string) =>
  page(
    runtime,
    Effect.gen(function* () {
      const n = yield* chrome
      const site = yield* siteOf(request)
      const connection = yield* connectionById(connectionId)
      if (connection === undefined)
        return html(n, messagePage(n, 'Not found', `No connection ${connectionId}.`), { status: 404 })
      const wallet = yield* walletOfSession(sessionToken(request))
      return html(
        n,
        revokePage(n, {
          clientName: connection.oauth_client_name,
          connectionId,
          grant: yield* grantOfConnection(connectionId),
          connectionStatus: connection.status,
          signedIn: wallet !== undefined && wallet.id === connection.wallet_id ? wallet : undefined,
          rpId: site.rpId,
        }),
      )
    }),
  )

const revokePrepare = (runtime: AppRuntime, request: Request, connectionId: string) =>
  json(
    runtime,
    Effect.gen(function* () {
      const wallet = yield* requireWallet(request)
      const result = yield* revokeConnection(wallet.id, wallet.contract_id, connectionId)
      const grant = result?.grant
      if (grant === undefined)
        return yield* new OwnerError({ kind: 'bad_request', message: `no connection ${connectionId} in this wallet` })
      if (grant.rule_status === 'removed') return { done: true }
      const prepared = yield* Chain.use(chain => chain.prepareRemoveGrant(wallet.contract_id, grant.rule_id))
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(PreparedOwnerAuth))(prepared).pipe(
        Effect.mapError(() => new OwnerError({ kind: 'unavailable', message: 'could not store the prepared removal' })),
      )
      yield* putScratch('revoke', connectionId, encoded)
      return { challenge: prepared.challenge }
    }),
  )

const revokePost = (runtime: AppRuntime, request: Request, connectionId: string) =>
  json(
    runtime,
    Effect.gen(function* () {
      const wallet = yield* requireWallet(request)
      const site = yield* siteOf(request)
      const grant = yield* grantOfConnection(connectionId)
      if (grant === undefined || grant.wallet_id !== wallet.id)
        return yield* new OwnerError({ kind: 'bad_request', message: `no connection ${connectionId} in this wallet` })
      if (grant.rule_status === 'removed') return { rule_status: 'removed' }
      const stored = yield* toolResult('revoke', connectionId)
      const prepared = yield* decodePrepared(stored?.result ?? null)
      const assertion = yield* checkAssertion(site, wallet, yield* readAssertion(request), prepared.challenge)
      const removed = yield* Chain.use(chain => chain.removeGrant(prepared, assertion))
      const after = yield* Ledger.use(ledger =>
        ledger.recordRuleRemoved(wallet.id, { grantId: grant.id, tx: removed.tx }),
      )
      return { rule_status: after.rule_status, tx: removed.tx }
    }),
  )

// /claim/<intent>: CAP-73 acceptance (the recipient signs `trust`, the transfer rides along)

/** The seeded demo recipient (testnet) signs on the server: for the demo contact without a trustline, or ?demo=1. */
const isDemo = (request: Request, recipient: string) =>
  WalletSettings.useSync(
    settings =>
      new URL(request.url).searchParams.get('demo') === '1' ||
      settings.demoContacts.some(contact => contact.trustline_required && contact.address === recipient),
  )

const claimGet = (runtime: AppRuntime, request: Request, intentId: string) =>
  page(
    runtime,
    Effect.gen(function* () {
      const n = yield* chrome
      const intent = yield* intentById(intentId)
      if (intent === undefined || intent.recipient_readiness !== 'trustline_required')
        return html(n, messagePage(n, 'Not found', 'This claim link is not valid.'), { status: 404 })
      const prepared = intent.status === 'approved' ? yield* claimPreparedOf(intent.id) : null
      const claim = prepared === null || prepared === undefined ? undefined : yield* decodeClaim(prepared)
      const status = effectiveStatus(intent, yield* nowMillis)
      return html(
        n,
        claimPage(n, {
          intent,
          status,
          demo: n.network === 'Testnet' && (yield* isDemo(request, intent.recipient_address)),
          recipientEntryXdr: claim?.recipientEntryXdr ?? null,
          receipt: yield* receiptOfIntent(intent.id),
          ...(status === 'awaiting_approval'
            ? {
                notice: `This opens once ${intent.requester === 'owner' ? 'the sender' : 'the wallet owner'} approves the payment.`,
              }
            : {}),
        }),
      )
    }),
  )

/** The recipient signed (or the demo key signs): claim the submit, run the router call, record the receipt. */
const claimPost = (runtime: AppRuntime, request: Request, intentId: string) =>
  json(
    runtime,
    Effect.gen(function* () {
      const intent = yield* intentById(intentId)
      if (intent === undefined || intent.recipient_readiness !== 'trustline_required')
        return yield* new OwnerError({ kind: 'bad_request', message: 'This claim link is not valid.' })
      if (intent.status === 'confirmed') return { status: 'confirmed' }
      if (intent.status !== 'approved')
        return yield* new OwnerError({ kind: 'bad_request', message: `this payment is ${intent.status}` })
      const network = yield* Network
      if (!network.caps.paymentsEnabled)
        return yield* new OwnerError({ kind: 'unavailable', message: 'Payments are paused on Nod right now.' })
      const prepared = yield* decodeClaim((yield* claimPreparedOf(intent.id)) ?? null)
      const chain = yield* Chain
      const body = yield* Effect.tryPromise({
        try: () => request.json(),
        catch: () => new OwnerError({ kind: 'bad_request', message: 'expected JSON' }),
      })
      const given = Schema.decodeUnknownOption(Schema.Struct({ signed_entry: Schema.NullOr(Schema.String) }))(body)
      const demo = network.name === 'testnet' && (yield* isDemo(request, intent.recipient_address))
      const signed =
        given._tag === 'Some' && given.value.signed_entry !== null
          ? given.value.signed_entry
          : demo
            ? yield* chain.signClaimAsDemoRecipient(prepared)
            : yield* new OwnerError({ kind: 'bad_request', message: 'sign the authorization with your wallet first' })
      const ownerRaw = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Assertion))(
        (yield* approvalPreparedOf(intent.id)) ?? '',
      ).pipe(Effect.mapError(() => new OwnerError({ kind: 'bad_request', message: 'the approval is missing' })))
      const assertion = yield* Effect.all({
        authenticatorData: b64urlDecode(ownerRaw.authenticator_data),
        clientDataJSON: b64urlDecode(ownerRaw.client_data_json),
        signature: b64urlDecode(ownerRaw.signature),
      }).pipe(Effect.mapError(() => new OwnerError({ kind: 'bad_request', message: 'the approval is unreadable' })))
      const ledger = yield* Ledger
      const claimed = yield* ledger.claimApproved(intent.wallet_id, { intentId })
      if (claimed._tag === 'NotClaimed') return { status: claimed.intent.status }
      const outcome: Outcome = yield* chain.finalizeClaim(prepared, signed, { _tag: 'Owner', assertion }).pipe(
        Effect.map((settlement): Outcome => ({
          _tag: 'Confirmed',
          settlement,
          feePaidBy: 'relayer',
          pull: null,
          pulled: 0n,
        })),
        Effect.catchTag('ChainError', error =>
          Effect.succeed<Outcome>(
            error.kind === 'unknown'
              ? { _tag: 'Unknown', message: error.message, tx: error.tx ?? null }
              : { _tag: 'Failed', kind: error.kind, message: error.message, pull: null, pulled: 0n },
          ),
        ),
      )
      const settled = yield* ledger.settle(intent.wallet_id, { intentId, operationId: claimed.operationId, outcome })
      return { status: settled.status, failure: settled.failure }
    }),
  )

/** Route the owner pages; undefined when the path is not one of them. */
export const ownerRoute = (runtime: AppRuntime, request: Request, path: string): Promise<Response> | undefined => {
  const revoke = /^\/approve\/revoke\/(con_[0-9a-f]{32})(\/prepare)?$/u.exec(path)
  if (revoke !== null) {
    const id = revoke[1] ?? ''
    if (request.method === 'GET' && revoke[2] === undefined) return revokeGet(runtime, request, id)
    if (request.method === 'POST')
      return revoke[2] === undefined ? revokePost(runtime, request, id) : revokePrepare(runtime, request, id)
    return Promise.resolve(new Response('Method Not Allowed', { status: 405 }))
  }
  const approve = /^\/approve\/(pi_[0-9a-f]{32})(\/prepare)?$/u.exec(path)
  if (approve !== null) {
    const id = approve[1] ?? ''
    if (request.method === 'GET' && approve[2] === undefined) return approvalGet(runtime, request, id)
    if (request.method === 'POST')
      return approve[2] === undefined ? approvalPost(runtime, request, id) : approvalPrepare(runtime, request, id)
    return Promise.resolve(new Response('Method Not Allowed', { status: 405 }))
  }
  const claim = /^\/claim\/(pi_[0-9a-f]{32})$/u.exec(path)
  if (claim !== null && request.method === 'GET') return claimGet(runtime, request, claim[1] ?? '')
  if (claim !== null && request.method === 'POST') return claimPost(runtime, request, claim[1] ?? '')
  return undefined
}
