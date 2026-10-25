import { Effect, Schema } from 'effect'

import { type ChainError, fromStroops, type PaymentIntent, type ReceiptRecord } from '@hm/protocol'

import { type ClaimError, claimLink, claimLinkState, isClaimLinkId, linkExpired } from './claims.ts'
import { nowMillis, randomId } from './clock.ts'
import type { DbError } from './db.ts'
import { effectiveStatus, type LedgerError } from './ledger.ts'
import { Network } from './network.ts'
import { OwnerError, requireWallet, sessionToken, walletOfSession } from './owner.ts'
import { type Chrome, escape, html, messagePage, page } from './pages.ts'
import type { AppRuntime } from './runtime.ts'
import { receiptOfIntent } from './store.ts'
import { claimUrl } from './views.ts'
import { siteOf } from './wallet-settings.ts'

/**
 * /claim/cl_… (claims.ts): the link "1 USDC for Jan" as Jan sees it. Open, it offers three ways to receive: create a
 * Nod wallet with a passkey (deposit-first, no XLM), sign in to an existing one, or paste a Stellar address. Once Jan
 * chose, it shows the payment: paid with its transaction, waiting for the sender's nod, or (an address without a USDC
 * trustline) the CAP-73 claim page to accept with Freighter after the sender approved. GET never changes anything.
 */

export interface ClaimLinkPageView {
  readonly id: string
  readonly amount: bigint
  readonly recipientName: string
  readonly requester: string
  readonly reason: string | null
  readonly expiresAt: string
  readonly state: 'open' | 'expired' | 'claimed'
  readonly destination: { readonly kind: string; readonly address: string } | null
  readonly intent: Pick<PaymentIntent, 'id' | 'recipient_readiness' | 'failure'> | null
  /** The payment's status as a reader sees it (a wait past its expiry reads expired); null before the claim. */
  readonly paymentStatus: PaymentIntent['status'] | null
  readonly receipt: ReceiptRecord | undefined
  readonly signedIn: { readonly name: string; readonly contractId: string } | null
  /** /claim/pi_… once the sender approved a payment to an address without a USDC trustline. */
  readonly acceptUrl: string | null
}

const short = (address: string) => (address.length > 16 ? `${address.slice(0, 6)}…${address.slice(-6)}` : address)

const intro = (view: ClaimLinkPageView) => `<div class="card"><dl><dt>For</dt><dd>${escape(view.recipientName)}</dd>
<dt>Amount</dt><dd><span class="amount">${escape(fromStroops(view.amount))}</span> USDC</dd>
<dt>From</dt><dd>A Nod wallet, sent by ${escape(view.requester)}</dd></dl>
${view.reason === null ? '' : `<figure class="ask"><blockquote>${escape(view.reason)}</blockquote><figcaption><strong>${escape(view.requester)}</strong> says</figcaption></figure>`}</div>`

const choices = (view: ClaimLinkPageView) => `<section class="card" data-testid="claim-choice-new">
<h2>New to Stellar? Get a Nod wallet</h2>
<p class="muted">A passkey (your face, fingerprint or device lock) creates it. No app, no seed phrase, no XLM. The USDC lands in it.</p>
<label>Your name<input id="name" data-testid="claim-name" value="${escape(view.recipientName)}" maxlength="40" autocomplete="name"></label>
<p class="actions"><button class="primary" id="new-wallet" data-testid="claim-new-wallet">Create my wallet and receive</button></p></section>
<section class="card" data-testid="claim-choice-nod"><h2>Already on Nod?</h2>
${
  view.signedIn === null
    ? '<p class="actions"><button id="signin" data-testid="claim-signin">Sign in with my passkey and receive</button></p>'
    : `<p class="actions"><button class="primary" id="to-mine" data-testid="claim-to-mine">Receive in ${escape(view.signedIn.name)} (${escape(short(view.signedIn.contractId))})</button></p>`
}</section>
<details class="card more" data-testid="claim-choice-address"><summary>Send it to a Stellar address instead</summary>
<div style="padding:0 1.2rem 1.1rem"><label>Stellar address<input id="address" data-testid="claim-address" placeholder="G… or C…" autocomplete="off" spellcheck="false"></label>
<p class="muted">An account without a USDC trustline accepts with its own wallet (Freighter) once the sender approves.</p>
<p class="actions"><button id="to-address" data-testid="claim-to-address">Send it there</button></p></div></details>`

const claimed = (c: Chrome, view: ClaimLinkPageView, status: string) => {
  const to = view.destination === null ? '' : `<p class="muted">To <code>${escape(view.destination.address)}</code></p>`
  if (view.receipt !== undefined)
    return `<section class="card" data-testid="claim-link-paid"><h2 class="ok">Paid</h2>${to}<dl><dt>Transaction</dt><dd><a href="${escape(`${c.explorerBase}/tx/${view.receipt.tx_hash}`)}" rel="noreferrer" data-testid="claim-link-tx"><code>${escape(view.receipt.tx_hash)}</code></a></dd></dl>
${view.destination?.kind === 'address' ? '' : '<p><a href="/" data-testid="claim-open-nod">Open your Nod wallet</a></p>'}</section>`
  if (view.acceptUrl !== null)
    return `<section class="card">${to}<p>The sender approved. <a href="${escape(view.acceptUrl)}" data-testid="claim-link-accept">Accept it with your wallet</a>: the trustline and the payment land in one transaction.</p></section>`
  const sentence =
    status === 'awaiting_approval'
      ? 'Waiting for the sender to approve it with their passkey. This page refreshes itself.'
      : status === 'failed'
        ? `The payment failed: ${view.intent?.failure ?? 'unknown'}. Nothing left the sender’s wallet.`
        : status === 'expired'
          ? 'The sender did not approve it in time; nothing was paid.'
          : 'Paying. This page refreshes itself.'
  return `<section class="card" data-testid="claim-link-waiting">${to}<p>${escape(sentence)}</p></section>`
}

export const claimLinkPage = (c: Chrome, view: ClaimLinkPageView) => {
  const status = view.paymentStatus ?? view.state
  const title =
    view.receipt !== undefined
      ? 'USDC received'
      : view.state === 'expired'
        ? 'This link expired'
        : `${view.recipientName}, ${fromStroops(view.amount)} USDC for you`
  const body =
    view.state === 'expired'
      ? '<div class="card"><p>Nobody claimed it in time, so nothing was paid. Ask the sender for a new link.</p></div>'
      : view.state === 'open'
        ? choices(view)
        : claimed(c, view, status)
  const poll = view.state === 'claimed' && view.receipt === undefined && view.acceptUrl === null
  return page(
    title,
    c,
    `<h1 data-testid="${view.receipt === undefined ? 'claim-link-title' : 'claim-link-done'}">${escape(title)}</h1>${intro(view)}${body}<p id="status" class="muted" role="status"></p>`,
    view.state === 'open'
      ? `const ctx=JSON.parse(document.getElementById('ctx').textContent);
const choose=body=>post('/claim/'+ctx.id+'/destination',body);
async function newWallet(name){const o=await post('/api/wallets/options',{name});
const c=await navigator.credentials.create({publicKey:{challenge:b64u.dec(o.challenge),rp:{id:o.rp_id,name:o.rp_name},user:{id:b64u.dec(o.user_id),name:o.user_name,displayName:o.user_name},
pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{residentKey:'required',userVerification:'required'},attestation:'none',timeout:120000}});
return post('/api/wallets',{name,credential_id:b64u.enc(c.rawId),public_key:b64u.enc(c.response.getPublicKey()),client_data_json:b64u.enc(c.response.clientDataJSON),attestation_object:b64u.enc(c.response.attestationObject),deposit_first:true})}
const on=(id,f)=>{const el=document.getElementById(id);if(el)el.onclick=f};
on('new-wallet',async e=>{const done=busy(e.target,'Waiting for your passkey…');try{await newWallet(document.getElementById('name').value.trim()||ctx.name);e.target.textContent='Receiving (about 10 s)…';await choose({kind:'wallet',new:true});location.reload()}catch(x){done();show('status',x.message)}});
on('signin',async e=>{const done=busy(e.target,'Waiting for your passkey…');try{await signIn();e.target.textContent='Receiving (about 10 s)…';await choose({kind:'wallet'});location.reload()}catch(x){done();show('status',x.message)}});
on('to-mine',async e=>{const done=busy(e.target,'Receiving (about 10 s)…');try{await choose({kind:'wallet'});location.reload()}catch(x){done();show('status',x.message)}});
on('to-address',async e=>{const done=busy(e.target,'Sending…');try{await choose({kind:'address',address:document.getElementById('address').value.trim()});location.reload()}catch(x){done();show('status',x.message)}});`
      : poll
        ? 'setTimeout(()=>location.reload(),10000)'
        : '',
    { id: view.id, name: view.recipientName },
  )
}

// Routes

const chrome = Effect.gen(function* () {
  const id = yield* randomId('n')
  const network = yield* Network
  return { nonce: id.slice(2), network: network.label, explorerBase: network.explorerBase } satisfies Chrome
})

type RouteError = ClaimError | OwnerError | DbError | LedgerError | ChainError

const statusOf = (error: RouteError) =>
  error._tag === 'ClaimError'
    ? error.reason === 'not_found'
      ? 404
      : error.reason === 'expired'
        ? 410
        : error.reason === 'taken' || error.reason === 'conflict'
          ? 409
          : error.reason === 'bad_destination'
            ? 400
            : 503
    : error._tag === 'OwnerError'
      ? error.kind === 'unauthorized'
        ? 401
        : error.kind === 'bad_request'
          ? 400
          : 503
      : error._tag === 'ChainError'
        ? 502
        : 503

const messageOf = (error: RouteError) =>
  error._tag === 'DbError'
    ? 'storage failed; retry'
    : error._tag === 'ChainError'
      ? `chain: ${error.message}`
      : error.message

const pageView = (request: Request, linkId: string) =>
  Effect.gen(function* () {
    const state = yield* claimLinkState(linkId)
    if (state === undefined) return undefined
    const { link, intent } = state
    const nowMs = yield* nowMillis
    const viewer = yield* walletOfSession(sessionToken(request))
    const receipt = intent === undefined ? undefined : yield* receiptOfIntent(intent.id)
    const site = yield* siteOf(request)
    return {
      id: link.id,
      amount: link.amount,
      recipientName: link.recipient_name,
      requester: link.requester,
      reason: link.reason,
      expiresAt: intent?.expires_at ?? link.expires_at,
      state: link.status === 'claimed' ? 'claimed' : linkExpired(link, nowMs) ? 'expired' : 'open',
      destination:
        link.destination_address === null
          ? null
          : { kind: link.destination_kind ?? 'address', address: link.destination_address },
      intent: intent ?? null,
      paymentStatus: intent === undefined ? null : effectiveStatus(intent, nowMs),
      receipt,
      signedIn:
        viewer === undefined || viewer.id === link.wallet_id
          ? null
          : { name: viewer.name, contractId: viewer.contract_id },
      acceptUrl:
        intent !== undefined && intent.status === 'approved' && intent.recipient_readiness === 'trustline_required'
          ? claimUrl(site.origin, intent.id)
          : null,
    } satisfies ClaimLinkPageView
  })

const linkGet = (runtime: AppRuntime, request: Request, linkId: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const n = yield* chrome
      const view = yield* pageView(request, linkId)
      if (view === undefined)
        return html(n, messagePage(n, 'Not found', 'This claim link is not valid.'), { status: 404 })
      return html(n, claimLinkPage(n, view))
    }).pipe(
      Effect.catch(error =>
        Effect.map(chrome, n =>
          html(n, messagePage(n, 'Not available', messageOf(error)), { status: statusOf(error) }),
        ),
      ),
    ),
  )

const DestinationBody = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('wallet'), new: Schema.optionalKey(Schema.Boolean) }),
  Schema.Struct({ kind: Schema.Literal('address'), address: Schema.String.check(Schema.isMaxLength(69)) }),
])

/** Jan chose: their signed-in Nod wallet (just created, or existing), or an address. Then the payment's lanes run. */
const linkPost = (runtime: AppRuntime, request: Request, linkId: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const raw = yield* Effect.tryPromise({
        try: () => request.json(),
        catch: () => new OwnerError({ kind: 'bad_request', message: 'expected JSON' }),
      })
      const body = yield* Schema.decodeUnknownEffect(DestinationBody)(raw).pipe(
        Effect.mapError(() => new OwnerError({ kind: 'bad_request', message: 'say where the money goes' })),
      )
      const destination =
        body.kind === 'address'
          ? { kind: 'address' as const, address: body.address }
          : { kind: 'wallet' as const, wallet: yield* requireWallet(request), created: body.new === true }
      const result = yield* claimLink(linkId, destination)
      const receipt = yield* receiptOfIntent(result.intent.id)
      return Response.json({
        status: result.link.status,
        payment_id: result.intent.id,
        payment_status: effectiveStatus(result.intent, yield* nowMillis),
        tx: receipt?.tx_hash ?? null,
      })
    }).pipe(
      Effect.catch(error => Effect.succeed(Response.json({ error: messageOf(error) }, { status: statusOf(error) }))),
    ),
  )

/** /claim/cl_… and /claim/cl_…/destination; undefined for any other path (routes.ts tries the others). */
export const claimLinkRoute = (runtime: AppRuntime, request: Request, path: string): Promise<Response> | undefined => {
  const match = /^\/claim\/(cl_[0-9a-f]{32})(\/destination)?$/u.exec(path)
  const id = match?.[1]
  if (match === null || id === undefined || !isClaimLinkId(id)) return undefined
  if (match[2] === undefined)
    return request.method === 'GET'
      ? linkGet(runtime, request, id)
      : Promise.resolve(new Response('Method Not Allowed', { status: 405 }))
  return request.method === 'POST'
    ? linkPost(runtime, request, id)
    : Promise.resolve(new Response('Method Not Allowed', { status: 405 }))
}
