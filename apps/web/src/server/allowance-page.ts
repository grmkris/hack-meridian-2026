import { Effect, Schema } from 'effect'

import { Assertion } from '@hm/api'
import {
  Chain,
  type ChainError,
  type Connection,
  fromStroops,
  PreparedOwnerAuth,
  type SpendingGrant,
  toStroops,
} from '@hm/protocol'

import { isoIn, nowMillis, randomId } from './clock.ts'
import type { DbError } from './db.ts'
import { activateWallet } from './deposit.ts'
import { Ledger, type LedgerError, remainingOf } from './ledger.ts'
import { Network } from './network.ts'
import { checkAssertion, OwnerError, requireWallet, sessionToken, walletOfSession } from './owner.ts'
import { type Chrome, escape, html, messagePage, page } from './pages.ts'
import type { AppRuntime, AppServices } from './runtime.ts'
import { connectionById, createPendingGrant, grantOfConnection, pendingGrant, putScratch, toolResult } from './store.ts'
import { siteOf } from './wallet-settings.ts'

/**
 * /approve/allowance/<connection>?amount=…&hours=… (connection_grant_update): the owner gives an AI app a new allowance
 * or expiry with the passkey, through the consent page's install path: a new connection key K', `add_context_rule`
 * with the spending-limit policy (the passkey signs), a new pocket, and the connection's grant moves to it (Ledger
 * replaceGrant: counters from zero; refused while a payment is in flight). The old rule then stays on the account
 * with a key Nod no longer uses; a second passkey tap on the same page removes it. GET never changes anything.
 */

const MAX_HOURS = 720
const AMOUNT = /^\d{1,7}(\.\d{1,7})?$/u

const chrome = Effect.gen(function* () {
  const id = yield* randomId('n')
  const network = yield* Network
  return { nonce: id.slice(2), network: network.label, explorerBase: network.explorerBase } satisfies Chrome
})

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
      : error._tag === 'LedgerError' && error.reason === 'invalid_state'
        ? 409
        : 503

const messageOf = (error: RouteError) =>
  error._tag === 'DbError'
    ? 'storage failed; retry'
    : error._tag === 'ChainError'
      ? `chain: ${error.message}`
      : error.message

const bad = (message: string) => new OwnerError({ kind: 'bad_request', message })

/** The requested allowance from the link: an amount and hours within Nod's caps. */
const requested = (amountText: string | null, hoursText: string | null) =>
  Effect.gen(function* () {
    const network = yield* Network
    if (amountText === null || !AMOUNT.test(amountText)) return yield* bad('the link has no allowance amount')
    const total = toStroops(amountText)
    if (total <= 0n) return yield* bad('the allowance must be more than zero')
    if (total > network.caps.maxGrantStroops)
      return yield* bad(`Nod caps an allowance at ${fromStroops(network.caps.maxGrantStroops)} USDC`)
    const hours = Number(hoursText ?? '24')
    if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS) return yield* bad('hours must be 1 to 720')
    return { total, hours }
  })

const ownConnection = (connectionId: string, walletId: string) =>
  Effect.gen(function* () {
    const connection = yield* connectionById(connectionId)
    if (connection === undefined || connection.wallet_id !== walletId)
      return yield* bad(`no connection ${connectionId} in this wallet`)
    if (connection.status !== 'active') return yield* bad('this AI app was revoked; connect it again instead')
    const grant = yield* grantOfConnection(connectionId)
    if (grant === undefined) return yield* bad('this AI app has no allowance to change')
    return { connection, grant }
  })

export interface AllowancePageView {
  readonly connection: Connection
  readonly grant: SpendingGrant | undefined
  readonly total: bigint
  readonly hours: number
  readonly signedIn: boolean
  readonly nowMs: number
  readonly rpId: string
}

export const allowancePage = (c: Chrome, view: AllowancePageView) => {
  const name = escape(view.connection.oauth_client_name)
  const current =
    view.grant === undefined
      ? '<p class="muted">No allowance yet.</p>'
      : `<dl><dt>Now</dt><dd>${escape(fromStroops(view.grant.status === 'active' && Date.parse(view.grant.valid_until) > view.nowMs ? remainingOf(view.grant) : 0n))} of ${escape(fromStroops(view.grant.total))} USDC left, until ${escape(view.grant.valid_until.slice(0, 16).replace('T', ' '))} UTC</dd></dl>`
  return page(
    `Change ${view.connection.oauth_client_name}'s allowance`,
    c,
    `<h1 data-testid="allowance-title">Change ${name}’s allowance</h1>
<section class="card"><p class="to">${name} may spend up to <strong data-testid="allowance-amount">${escape(fromStroops(view.total))} USDC</strong> on its own for <strong>${view.hours} hours</strong> from when you sign.</p>
<p class="muted">Anything past it needs your passkey, every time. This replaces the current allowance and starts from zero spent.</p>${current}</section>
<div id="steps">${
      view.signedIn
        ? `<p class="actions"><button class="nod" id="approve" data-testid="allowance-approve">Approve with your passkey</button></p>`
        : `<p class="actions"><button class="primary" id="signin" data-testid="allowance-signin">Sign in with your passkey</button></p>`
    }</div>
<section class="card" id="done" hidden data-testid="allowance-done"><h2 class="ok">The new allowance is on your account</h2><p id="done-tx" class="muted"></p>
<p>The old one is still on your account with a key Nod no longer uses. <button id="remove-old" data-testid="allowance-remove-old">Remove the old one (one more passkey tap)</button></p></section>
<p id="status" class="muted" role="status"></p>`,
    `const ctx=JSON.parse(document.getElementById('ctx').textContent);
const on=(id,f)=>{const el=document.getElementById(id);if(el)el.onclick=f};
on('signin',async e=>{const done=busy(e.target,'Waiting for your passkey…');try{await signIn();location.reload()}catch(x){done();show('status',x.message)}});
on('approve',async e=>{const done=busy(e.target,'Preparing…');try{const p=await post(ctx.base+'/prepare',{amount:ctx.amount,hours:ctx.hours});
e.target.textContent='Waiting for your passkey…';const a=await assertion(p.challenge,ctx.rpId,[]);e.target.textContent='Installing on Stellar (about 15 s)…';
const r=await post(ctx.base,{pending_id:p.pending_id,assertion:a});document.getElementById('steps').hidden=true;document.getElementById('done').hidden=false;
document.getElementById('done-tx').textContent='Transaction '+r.tx;show('status','Done.','ok')}catch(x){done();show('status',x.message)}});
on('remove-old',async e=>{const done=busy(e.target,'Preparing…');try{const p=await post(ctx.base+'/remove-old/prepare',{});
e.target.textContent='Waiting for your passkey…';const a=await assertion(p.challenge,ctx.rpId,[]);e.target.textContent='Removing on Stellar…';
const r=await post(ctx.base+'/remove-old',{assertion:a});e.target.parentElement.textContent='The old allowance is removed from your account.';show('status','The old allowance is removed: '+r.tx,'ok')}catch(x){done();show('status',x.message)}});`,
    {
      base: `/approve/allowance/${view.connection.id}`,
      amount: fromStroops(view.total),
      hours: view.hours,
      rpId: view.rpId,
    },
  )
}

const allowanceGet = (runtime: AppRuntime, request: Request, connectionId: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const n = yield* chrome
      const url = new URL(request.url)
      const want = yield* requested(url.searchParams.get('amount'), url.searchParams.get('hours'))
      const connection = yield* connectionById(connectionId)
      if (connection === undefined)
        return html(n, messagePage(n, 'Not found', `No connection ${connectionId}.`), { status: 404 })
      const wallet = yield* walletOfSession(sessionToken(request))
      const site = yield* siteOf(request)
      const body = allowancePage(n, {
        connection,
        grant: yield* grantOfConnection(connectionId),
        total: want.total,
        hours: want.hours,
        signedIn: wallet !== undefined && wallet.id === connection.wallet_id,
        nowMs: yield* nowMillis,
        rpId: site.rpId,
      })
      return html(n, body)
    }).pipe(
      Effect.catch(error =>
        Effect.map(chrome, n =>
          html(n, messagePage(n, 'Not available', messageOf(error)), { status: statusOf(error) }),
        ),
      ),
    ),
  )

const readJson = (request: Request) =>
  Effect.tryPromise({ try: () => request.json(), catch: () => bad('expected JSON') })

const toInput = (assertion: typeof Assertion.Type) => ({
  credentialId: assertion.credential_id,
  clientDataJSON: assertion.client_data_json,
  authenticatorData: assertion.authenticator_data,
  signature: assertion.signature,
})

/** Step 1: a new key and its rule install, prepared for the passkey (nothing onchain yet). */
const prepareInstall = (request: Request, connectionId: string) =>
  Effect.gen(function* () {
    const wallet = yield* requireWallet(request)
    const body = yield* Schema.decodeUnknownEffect(Schema.Struct({ amount: Schema.String, hours: Schema.Finite }))(
      yield* readJson(request),
    ).pipe(Effect.mapError(() => bad('amount and hours are required')))
    const want = yield* requested(body.amount, String(body.hours))
    const { grant } = yield* ownConnection(connectionId, wallet.id)
    if (grant.reserved > 0n) return yield* bad('a payment is in flight; try again in a minute')
    if (!(yield* Network).caps.paymentsEnabled)
      return yield* new OwnerError({ kind: 'unavailable', message: 'Payments are paused on Nod right now.' })
    yield* activateWallet(wallet, 'allowance').pipe(
      Effect.catchTag('DepositError', error =>
        Effect.fail(new OwnerError({ kind: 'unavailable', message: error.message })),
      ),
    )
    const chain = yield* Chain
    const signer = yield* chain.newSigner
    const lifetime = want.hours * 3600
    const prepared = yield* chain.prepareInstallGrant(wallet.contract_id, signer.publicKey, want.total, lifetime)
    const encoded = yield* Schema.encodeEffect(PreparedOwnerAuth)(prepared).pipe(
      Effect.mapError(() => new OwnerError({ kind: 'unavailable', message: 'could not store the prepared install' })),
    )
    const pendingId = yield* createPendingGrant({
      owner_id: wallet.owner_id,
      wallet_id: wallet.id,
      signer_public_key: signer.address,
      signer_key_ref: signer.signerKeyRef,
      total: want.total,
      nod_above: want.total,
      valid_until: yield* isoIn(lifetime * 1000),
      lifetime_seconds: lifetime,
      prepared: JSON.stringify(encoded),
    })
    return { pending_id: pendingId, challenge: prepared.challenge }
  })

const decodePrepared = (text: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(PreparedOwnerAuth))(text).pipe(
    Effect.mapError(() => bad('the prepared change is unreadable; open the link again')),
  )

/** Step 2: the passkey signed; install, give the new key its pocket, move the grant, sweep the old pocket back. */
const install = (request: Request, connectionId: string) =>
  Effect.gen(function* () {
    const wallet = yield* requireWallet(request)
    const site = yield* siteOf(request)
    const body = yield* Schema.decodeUnknownEffect(Schema.Struct({ pending_id: Schema.String, assertion: Assertion }))(
      yield* readJson(request),
    ).pipe(Effect.mapError(() => bad('the passkey answer is missing')))
    const { grant } = yield* ownConnection(connectionId, wallet.id)
    const pending = yield* pendingGrant(body.pending_id, wallet.owner_id)
    if (pending === undefined) return yield* bad('this change expired; open the link again')
    const prepared = yield* decodePrepared(pending.prepared)
    const assertion = yield* checkAssertion(site, wallet, toInput(body.assertion), prepared.challenge)
    const chain = yield* Chain
    // The old pocket's float goes back first: its key is about to leave the grant.
    if (grant.pocket_address !== null)
      yield* chain.balances(grant.pocket_address).pipe(
        Effect.flatMap(held =>
          held.usdc > 0n ? Effect.asVoid(chain.sweepPocket(grant.signer_key_ref, wallet.contract_id)) : Effect.void,
        ),
        Effect.catchTag('ChainError', error => Effect.logWarning('old pocket not swept', error.message)),
      )
    const installed = yield* chain.installGrant(prepared, assertion)
    const pocket = yield* chain.createPocket(pending.signer_key_ref).pipe(
      Effect.map(created => created.address),
      Effect.catchTag('ChainError', error => Effect.as(Effect.logWarning('pocket not created', error.message), null)),
    )
    const replaced = yield* Ledger.use(ledger =>
      ledger.replaceGrant(wallet.id, {
        grantId: grant.id,
        expectRuleId: grant.rule_id,
        ruleId: installed.ruleId,
        signerPublicKey: pending.signer_public_key,
        signerKeyRef: pending.signer_key_ref,
        total: pending.total,
        validUntil: pending.valid_until,
        validUntilLedger: installed.validUntilLedger,
        installTx: installed.tx,
        pocketAddress: pocket,
      }),
    )
    yield* putScratch('allowance-old', connectionId, JSON.stringify({ rule_id: grant.rule_id }))
    const network = yield* Network
    return {
      tx: installed.tx,
      explorer_url: `${network.explorerBase}/tx/${installed.tx}`,
      rule_id: replaced.rule_id,
      old_rule_id: grant.rule_id,
      allowance: fromStroops(replaced.total),
      valid_until: replaced.valid_until,
    }
  })

const OldRule = Schema.fromJsonString(Schema.Struct({ rule_id: Schema.Int }))

/** Step 3 (optional): remove the rule the grant left, with one more passkey tap. */
const prepareRemoveOld = (request: Request, connectionId: string) =>
  Effect.gen(function* () {
    const wallet = yield* requireWallet(request)
    const { grant } = yield* ownConnection(connectionId, wallet.id)
    const saved = yield* toolResult('allowance-old', connectionId)
    if (saved === undefined) return yield* bad('there is no old allowance to remove')
    const old = yield* Schema.decodeUnknownEffect(OldRule)(saved.result).pipe(Effect.mapError(() => bad('unreadable')))
    if (old.rule_id === grant.rule_id) return yield* bad('that is the current allowance')
    const prepared = yield* Chain.use(chain => chain.prepareRemoveGrant(wallet.contract_id, old.rule_id))
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(PreparedOwnerAuth))(prepared).pipe(
      Effect.mapError(() => new OwnerError({ kind: 'unavailable', message: 'could not store the prepared removal' })),
    )
    yield* putScratch('allowance-remove', connectionId, encoded)
    return { challenge: prepared.challenge }
  })

const removeOld = (request: Request, connectionId: string) =>
  Effect.gen(function* () {
    const wallet = yield* requireWallet(request)
    const site = yield* siteOf(request)
    yield* ownConnection(connectionId, wallet.id)
    const body = yield* Schema.decodeUnknownEffect(Schema.Struct({ assertion: Assertion }))(
      yield* readJson(request),
    ).pipe(Effect.mapError(() => bad('the passkey answer is missing')))
    const saved = yield* toolResult('allowance-remove', connectionId)
    if (saved === undefined) return yield* bad('press Remove again: nothing is prepared')
    const prepared = yield* decodePrepared(saved.result)
    const assertion = yield* checkAssertion(site, wallet, toInput(body.assertion), prepared.challenge)
    const removed = yield* Chain.use(chain => chain.removeGrant(prepared, assertion))
    const network = yield* Network
    return { tx: removed.tx, explorer_url: `${network.explorerBase}/tx/${removed.tx}` }
  })

const json = (runtime: AppRuntime, effect: Effect.Effect<unknown, RouteError, AppServices>) =>
  runtime.runPromise(
    effect.pipe(
      Effect.map(value => Response.json(value)),
      Effect.catch(error => Effect.succeed(Response.json({ error: messageOf(error) }, { status: statusOf(error) }))),
    ),
  )

/** /approve/allowance/con_…[/prepare|/remove-old[/prepare]]; undefined for any other path. */
export const allowanceRoute = (runtime: AppRuntime, request: Request, path: string): Promise<Response> | undefined => {
  const match = /^\/approve\/allowance\/(con_[0-9a-f]{32})(\/prepare|\/remove-old\/prepare|\/remove-old)?$/u.exec(path)
  const id = match?.[1]
  if (match === null || id === undefined) return undefined
  const tail = match[2]
  if (request.method === 'GET' && tail === undefined) return allowanceGet(runtime, request, id)
  if (request.method !== 'POST') return Promise.resolve(new Response('Method Not Allowed', { status: 405 }))
  return tail === undefined
    ? json(runtime, install(request, id))
    : tail === '/prepare'
      ? json(runtime, prepareInstall(request, id))
      : tail === '/remove-old/prepare'
        ? json(runtime, prepareRemoveOld(request, id))
        : json(runtime, removeOld(request, id))
}
