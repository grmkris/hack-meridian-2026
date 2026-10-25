import { Effect, Schema } from 'effect'

import { Assertion } from '@hm/api'
import { Chain, fromStroops, PreparedLinkTransfer, PreparedOwnerAuth, type Wallet } from '@hm/protocol'

import { chrome, DestinationBody, messageOf, type RouteError, statusOf } from './claim-link-page.ts'
import { afterPaid, type ClaimLink, claimLinkById, ClaimError, readinessOf } from './claims.ts'
import { isoIn, millisOf, nowIso, nowMillis } from './clock.ts'
import { DbError } from './db.ts'
import { activateWallet } from './deposit.ts'
import { Ledger } from './ledger.ts'
import { Network, transferFeeCeiling } from './network.ts'
import { checkAssertion, OwnerError, requireWallet, sessionToken, walletOfSession } from './owner.ts'
import { type Chrome, escape, html, messagePage, page, utcTime } from './pages.ts'
import { query, sql, write } from './rows.ts'
import type { AppRuntime, AppServices } from './runtime.ts'
import { createPendingGrant, pendingGrant, putScratch, toolResult, walletById } from './store.ts'
import { siteOf } from './wallet-settings.ts'

/**
 * Person links: an allowance for a person (Kristjan, 2026-10-25 20:20 UTC). When the sender nods, a claim link is not
 * a payment but a rule on the sender's own account: a spending-limit policy for exactly the amount, valid seven days,
 * whose only signer is an Ed25519 key the sender's browser made. Its secret lives only in the link's URL fragment
 * (`/claim/<id>#k=<seed>.<public>`), which browsers never send to a server; Nod stores the public key and the rule id.
 * Whoever opens the link chooses where the money goes (a new Nod wallet, theirs, or a G… with a USDC trustline), and
 * their browser signs the transfer's auth digest with the fragment key; Nod checks the signature, enforce-simulates
 * and relays, paying the fee. Nod never holds the key or the money; nothing leaves the sender's wallet until someone
 * claims; a leaked link can take the amount at most, once, before the expiry; the sender can remove the rule early.
 */

export const PERSON_LINK_SECONDS = 7 * 86_400

const bad = (message: string) => new OwnerError({ kind: 'bad_request', message })
const conflict = (message: string) => new ClaimError({ reason: 'taken', message })

const fromB64 = (text: string) =>
  Effect.try({
    try: () => Uint8Array.from(atob(text.replace(/-/gu, '+').replace(/_/gu, '/')), char => char.charCodeAt(0)),
    catch: () => bad('not base64url'),
  })

const readJson = (request: Request) =>
  Effect.tryPromise({ try: () => request.json(), catch: () => bad('expected JSON') })

const toInput = (assertion: typeof Assertion.Type) => ({
  credentialId: assertion.credential_id,
  clientDataJSON: assertion.client_data_json,
  authenticatorData: assertion.authenticator_data,
  signature: assertion.signature,
})

/** The sender's own person link (signed in as its wallet). */
const ownLink = (wallet: Wallet, linkId: string) =>
  Effect.gen(function* () {
    const link = yield* claimLinkById(linkId)
    if (link === undefined || link.wallet_id !== wallet.id || link.kind !== 'person')
      return yield* bad(`no link ${linkId} in this wallet`)
    return link
  })

// The sender's nod: /approve/link/<id>

/** Step 1: the browser's public link key → the rule install prepared for the passkey (nothing onchain yet). */
const approvePrepare = (request: Request, linkId: string) =>
  Effect.gen(function* () {
    const wallet = yield* requireWallet(request)
    const link = yield* ownLink(wallet, linkId)
    if (link.status !== 'awaiting_nod')
      return yield* bad(`this link is ${link.status === 'open' ? 'already set up' : link.status}`)
    const body = yield* Schema.decodeUnknownEffect(Schema.Struct({ public_key: Schema.String }))(
      yield* readJson(request),
    ).pipe(Effect.mapError(() => bad('the link key is missing')))
    const publicKey = yield* fromB64(body.public_key)
    if (publicKey.length !== 32) return yield* bad('the link key must be a 32-byte Ed25519 public key')
    if (!(yield* Network).caps.paymentsEnabled)
      return yield* new OwnerError({ kind: 'unavailable', message: 'Payments are paused on Nod right now.' })
    yield* activateWallet(wallet, 'allowance').pipe(
      Effect.catchTag('DepositError', error =>
        Effect.fail(new OwnerError({ kind: 'unavailable', message: error.message })),
      ),
    )
    const prepared = yield* Chain.use(chain =>
      chain.prepareInstallGrant(wallet.contract_id, publicKey, link.amount, PERSON_LINK_SECONDS),
    )
    const encoded = yield* Schema.encodeEffect(PreparedOwnerAuth)(prepared).pipe(
      Effect.mapError(() => new OwnerError({ kind: 'unavailable', message: 'could not store the prepared install' })),
    )
    const pendingId = yield* createPendingGrant({
      owner_id: wallet.owner_id,
      wallet_id: wallet.id,
      signer_public_key: body.public_key,
      // No vault key: the link key's secret never reaches Nod.
      signer_key_ref: `link:${link.id}`,
      total: link.amount,
      nod_above: link.amount,
      valid_until: yield* isoIn(PERSON_LINK_SECONDS * 1000),
      lifetime_seconds: PERSON_LINK_SECONDS,
      prepared: JSON.stringify(encoded),
    })
    yield* write(
      sql(
        "UPDATE claim_links SET pending_grant_id = ?, signer_public_key = ? WHERE id = ? AND status = 'awaiting_nod'",
        pendingId,
        body.public_key,
        link.id,
      ),
    )
    return { challenge: prepared.challenge }
  })

/** Step 2: the passkey signed; the rule is installed and the link opens (its key is still only in the browser). */
const approveInstall = (request: Request, linkId: string) =>
  Effect.gen(function* () {
    const wallet = yield* requireWallet(request)
    const site = yield* siteOf(request)
    const link = yield* ownLink(wallet, linkId)
    if (link.status !== 'awaiting_nod' || (link.pending_grant_id ?? null) === null)
      return yield* bad('press Approve again: nothing is prepared')
    const body = yield* Schema.decodeUnknownEffect(Schema.Struct({ assertion: Assertion }))(
      yield* readJson(request),
    ).pipe(Effect.mapError(() => bad('the passkey answer is missing')))
    const pending = yield* pendingGrant(link.pending_grant_id ?? '', wallet.owner_id)
    if (pending === undefined) return yield* bad('this approval expired; open the link again')
    const prepared = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PreparedOwnerAuth))(pending.prepared).pipe(
      Effect.mapError(() => bad('the prepared install is unreadable')),
    )
    const assertion = yield* checkAssertion(site, wallet, toInput(body.assertion), prepared.challenge)
    const installed = yield* Chain.use(chain => chain.installGrant(prepared, assertion))
    yield* write(
      sql(
        `UPDATE claim_links SET status = 'open', rule_id = ?, valid_until_ledger = ?, install_tx = ?, expires_at = ?
           WHERE id = ? AND status = 'awaiting_nod'`,
        installed.ruleId,
        installed.validUntilLedger,
        installed.tx,
        pending.valid_until,
        link.id,
      ),
    )
    const network = yield* Network
    return {
      claim_path: `/claim/${link.id}`,
      expires_at: pending.valid_until,
      install_tx: installed.tx,
      explorer_url: `${network.explorerBase}/tx/${installed.tx}`,
    }
  })

export const approveLinkPage = (
  c: Chrome,
  view: { readonly link: ClaimLink; readonly signedIn: boolean; readonly rpId: string; readonly nowMs: number },
) => {
  const { link } = view
  const amount = escape(fromStroops(link.amount))
  const name = escape(link.recipient_name)
  const lapsed = millisOf(link.expires_at) <= view.nowMs
  const back = '<p><a href="/">Back to Nod</a></p>'
  const state =
    link.status === 'awaiting_nod'
      ? view.signedIn
        ? `<div class="thumb"><button class="nod wide" id="approve" data-testid="link-approve">Approve with your passkey</button></div>`
        : `<div class="thumb"><button class="primary wide" id="signin" data-testid="link-signin">Sign in with your passkey</button></div>`
      : link.status === 'open' && !lapsed
        ? `<section class="card" data-testid="link-ready"><p>The link is on your account until ${escape(utcTime(link.expires_at))}. It was shown once, on the device that approved it.</p><p id="stored" class="muted">If you lost it, take it back in <a href="/connections">Connections</a> and make a new one.</p></section>${back}`
        : link.status === 'claimed'
          ? `<section class="card" data-testid="link-claimed"><p class="ok">${name} claimed it.</p></section>${back}`
          : `<section class="card"><p>This link is ${escape(lapsed ? 'expired' : link.status)}.</p></section>${back}`
  return page(
    `Send ${link.recipient_name} ${fromStroops(link.amount)} USDC`,
    c,
    `<h1 data-testid="link-title">Send ${name} ${amount} USDC with a link</h1>
<section class="card pay" aria-label="Link"><p class="amount">${amount}<span class="unit"> USDC</span></p>
<p class="to">for <strong>${name}</strong></p>
<figure class="ask"><figcaption>Asked by <strong>${escape(link.requester)}</strong></figcaption>${link.reason === null ? '' : `<blockquote>“${escape(link.reason)}”</blockquote><figcaption>The AI app’s own words; Nod has not checked them.</figcaption>`}</figure>
<p class="fee"><strong>Nothing leaves your wallet until ${name} claims it.</strong></p>
<p class="muted">Your passkey sets ${amount} USDC aside on your own account for seven days, for whoever holds the link. Unclaimed, it lapses by itself, and you can take it back from Connections before then. The link’s key is made on this device and never reaches Nod.</p></section>
<div id="steps">${state}</div>
<section class="card" id="done" hidden data-testid="link-done"><h2 class="ok">Send ${name} this link</h2>
<p><code id="link" data-testid="link-url" class="addr"></code></p>
<p class="actions"><button class="primary" id="copy" data-testid="link-copy">Copy the link</button><button id="share" data-testid="link-share" hidden>Share…</button></p>
<p class="muted">Anyone with this link can claim ${amount} USDC once, until it expires. Send it to ${name} only. It is not shown again.</p>
<p class="muted" id="install" hidden><a id="install-link" rel="noreferrer" data-testid="link-install-tx">Rule installed ↗</a></p></section>
<p id="status" class="muted" role="status"></p>`,
    `const ctx=JSON.parse(document.getElementById('ctx').textContent);
const on=(id,f)=>{const el=document.getElementById(id);if(el)el.onclick=f};
function reveal(url){document.getElementById('steps').hidden=true;document.getElementById('done').hidden=false;document.getElementById('link').textContent=url;
on('copy',async e=>{try{await navigator.clipboard.writeText(url);e.target.textContent='Copied'}catch{show('status','Copying is blocked here; select the link and copy it.')}});
if(navigator.share){const s=document.getElementById('share');s.hidden=false;s.onclick=()=>navigator.share({title:'USDC for you',url}).catch(()=>{})}}
try{const kept=sessionStorage.getItem('nod-link-'+ctx.id);if(kept&&ctx.status==='open')reveal(kept)}catch{}
on('signin',async e=>{const done=busy(e.target,'Waiting for your passkey…');try{await signIn();location.reload()}catch(x){done();show('status',x.message)}});
on('approve',async e=>{const done=busy(e.target,'Making the link key…');try{
const pair=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);const jwk=await crypto.subtle.exportKey('jwk',pair.privateKey);
const p=await post(ctx.base+'/prepare',{public_key:jwk.x});e.target.textContent='Waiting for your passkey…';
const a=await assertion(p.challenge,ctx.rpId,[]);e.target.textContent='Setting it aside on Stellar (about 15 s)…';
const r=await post(ctx.base,{assertion:a});const url=location.origin+r.claim_path+'#k='+jwk.d+'.'+jwk.x;
try{sessionStorage.setItem('nod-link-'+ctx.id,url)}catch{}reveal(url);document.getElementById('install-link').href=r.explorer_url;document.getElementById('install').hidden=false}catch(x){done();show('status',x.message)}});`,
    { id: link.id, base: `/approve/link/${link.id}`, rpId: view.rpId, status: link.status },
  )
}

const approveGet = (runtime: AppRuntime, request: Request, linkId: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const n = yield* chrome
      const link = yield* claimLinkById(linkId)
      if (link === undefined || link.kind !== 'person')
        return html(n, messagePage(n, 'Not found', 'No such link.'), { status: 404 })
      const wallet = yield* walletOfSession(sessionToken(request))
      const site = yield* siteOf(request)
      return html(
        n,
        approveLinkPage(n, {
          link,
          signedIn: wallet !== undefined && wallet.id === link.wallet_id,
          rpId: site.rpId,
          nowMs: yield* nowMillis,
        }),
      )
    }).pipe(
      Effect.catch(error =>
        Effect.map(chrome, n =>
          html(n, messagePage(n, 'Not available', messageOf(error)), { status: statusOf(error) }),
        ),
      ),
    ),
  )

// The recipient: /claim/<id>/prepare and /claim/<id>/sign (the page is claim-link-page.ts)

/** Where it goes, bound to the link (first choice wins), and the transfer prepared for the link key to sign. */
const claimPrepare = (request: Request, linkId: string) =>
  Effect.gen(function* () {
    const link = yield* claimLinkById(linkId)
    if (link === undefined || link.kind !== 'person')
      return yield* new ClaimError({ reason: 'not_found', message: 'This claim link is not valid.' })
    const now = yield* nowIso
    if (link.status === 'revoked')
      return yield* new ClaimError({ reason: 'expired', message: 'The sender took this link back.' })
    if (link.status === 'awaiting_nod')
      return yield* new ClaimError({ reason: 'not_found', message: 'The sender has not approved this link yet.' })
    if (millisOf(link.expires_at) <= millisOf(now))
      return yield* new ClaimError({ reason: 'expired', message: 'This link expired; nothing was paid.' })
    if ((link.claim_tx ?? null) !== null) return yield* conflict('This link was already claimed.')
    const body = yield* Schema.decodeUnknownEffect(DestinationBody)(yield* readJson(request)).pipe(
      Effect.mapError(() => bad('say where the money goes')),
    )
    const sender = yield* walletById(link.wallet_id)
    if (sender === undefined || link.rule_id === null || link.rule_id === undefined || !link.signer_public_key)
      return yield* new ClaimError({ reason: 'not_found', message: 'This link is not set up.' })
    // The destination: chosen now, or (again) the one chosen before the signing stopped.
    const chosen =
      body.kind === 'again'
        ? link.destination_address === null
          ? yield* bad('choose where the money goes first')
          : {
              address: link.destination_address,
              kind: link.destination_kind ?? 'address',
              walletId: link.destination_wallet_id,
            }
        : body.kind === 'address'
          ? { address: body.address.trim(), kind: 'address' as const, walletId: null }
          : yield* Effect.map(requireWallet(request), wallet => ({
              address: wallet.contract_id,
              kind: body.new === true ? ('new_wallet' as const) : ('wallet' as const),
              walletId: wallet.id,
            }))
    const address = chosen.address
    if (!/^(?:[CG][A-Z2-7]{55})$/u.test(address))
      return yield* new ClaimError({ reason: 'bad_destination', message: 'That is not a Stellar address (G… or C…).' })
    if (address === sender.contract_id)
      return yield* new ClaimError({ reason: 'bad_destination', message: 'That is the sender’s own wallet.' })
    const readiness = chosen.walletId !== null ? 'usdc_ready' : yield* readinessOf({ kind: 'address', address })
    if (readiness === 'trustline_required')
      return yield* new ClaimError({
        reason: 'bad_destination',
        message: 'That account has no USDC trustline. Add one in its wallet, or create a Nod wallet here instead.',
      })
    const kind = chosen.kind
    yield* write(
      sql(
        `UPDATE claim_links SET status = 'claimed', destination_kind = ?, destination_address = ?, destination_wallet_id = ?,
           claimed_at = ? WHERE id = ? AND status = 'open'`,
        kind,
        address,
        chosen.walletId,
        now,
        link.id,
      ),
    )
    const bound = yield* claimLinkById(link.id)
    if (bound === undefined || bound.destination_address !== address)
      return yield* conflict('This link was already claimed.')
    const publicKey = yield* fromB64(link.signer_public_key)
    const prepared = yield* Chain.use(chain =>
      chain.prepareLinkTransfer(sender.contract_id, link.rule_id ?? 0, publicKey, address, link.amount),
    )
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(PreparedLinkTransfer))(prepared).pipe(
      Effect.mapError(() => new OwnerError({ kind: 'unavailable', message: 'could not store the prepared transfer' })),
    )
    yield* write(sql('UPDATE claim_links SET transfer_prepared = ? WHERE id = ?', encoded, link.id))
    return { digest: prepared.digest, to: address }
  })

/** The link key signed in the browser: check, relay, record (the sender's receipt and events), deploy a new wallet. */
const claimSign = (request: Request, linkId: string) =>
  Effect.gen(function* () {
    const link = yield* claimLinkById(linkId)
    if (link === undefined || link.kind !== 'person')
      return yield* new ClaimError({ reason: 'not_found', message: 'This claim link is not valid.' })
    if ((link.claim_tx ?? null) !== null) return yield* conflict('This link was already claimed.')
    if (link.status !== 'claimed' || (link.transfer_prepared ?? null) === null || link.destination_address === null)
      return yield* bad('choose where the money goes first')
    const body = yield* Schema.decodeUnknownEffect(Schema.Struct({ signature: Schema.String }))(
      yield* readJson(request),
    ).pipe(Effect.mapError(() => bad('the signature is missing')))
    const signature = yield* fromB64(body.signature)
    const prepared = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PreparedLinkTransfer))(
      link.transfer_prepared ?? '',
    ).pipe(Effect.mapError(() => bad('the prepared transfer is unreadable; choose again')))
    const sender = yield* walletById(link.wallet_id)
    if (sender === undefined) return yield* bad('the sender is gone')
    const network = yield* Network
    // The first transfer under a new rule pays its rent, like an AI app's first payment.
    const receipt = yield* Chain.use(chain =>
      Effect.flatMap(transferFeeCeiling(network, false), ceiling =>
        chain.finalizeLinkTransfer(prepared, signature, ceiling),
      ),
    )
    yield* write(sql('UPDATE claim_links SET claim_tx = ? WHERE id = ?', receipt.tx, link.id))
    const intent = yield* Ledger.use(ledger =>
      ledger.recordLinkPayment(sender.id, {
        linkId: link.id,
        scope: link.scope,
        connectionId: link.connection_id,
        requester: link.requester,
        reason: link.reason,
        recipientName: link.recipient_name,
        recipientAddress: link.destination_address ?? prepared.to,
        amount: link.amount,
        network: network.caip,
        settlement: receipt,
      }),
    )
    yield* write(sql('UPDATE claim_links SET intent_id = ? WHERE id = ?', intent.id, link.id))
    const recipient = link.destination_wallet_id === null ? undefined : yield* walletById(link.destination_wallet_id)
    yield* afterPaid(
      sender,
      link,
      recipient === undefined
        ? { kind: 'address', address: prepared.to }
        : { kind: 'wallet', wallet: recipient, created: false },
      prepared.to,
      'usdc_ready',
    )
    return { status: 'paid', tx: receipt.tx, explorer_url: receipt.explorer }
  })

// Revoke: /approve/revoke-link/<id> (the passkey removes the rule; there is no pocket)

const revokePrepare = (request: Request, linkId: string) =>
  Effect.gen(function* () {
    const wallet = yield* requireWallet(request)
    const link = yield* ownLink(wallet, linkId)
    if (link.rule_id === null || link.rule_id === undefined) return yield* bad('this link has no rule on the account')
    if (link.status === 'revoked') return yield* bad('this link is already taken back')
    const prepared = yield* Chain.use(chain => chain.prepareRemoveGrant(wallet.contract_id, link.rule_id ?? 0))
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(PreparedOwnerAuth))(prepared).pipe(
      Effect.mapError(() => new OwnerError({ kind: 'unavailable', message: 'could not store the prepared removal' })),
    )
    yield* putScratch('link-remove', link.id, encoded)
    return { challenge: prepared.challenge }
  })

const revokePost = (request: Request, linkId: string) =>
  Effect.gen(function* () {
    const wallet = yield* requireWallet(request)
    const site = yield* siteOf(request)
    const link = yield* ownLink(wallet, linkId)
    const body = yield* Schema.decodeUnknownEffect(Schema.Struct({ assertion: Assertion }))(
      yield* readJson(request),
    ).pipe(Effect.mapError(() => bad('the passkey answer is missing')))
    const saved = yield* toolResult('link-remove', link.id)
    if (saved === undefined) return yield* bad('press Take back again: nothing is prepared')
    const prepared = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PreparedOwnerAuth))(saved.result).pipe(
      Effect.mapError(() => bad('the prepared removal is unreadable')),
    )
    const assertion = yield* checkAssertion(site, wallet, toInput(body.assertion), prepared.challenge)
    const removed = yield* Chain.use(chain => chain.removeGrant(prepared, assertion))
    const now = yield* nowIso
    yield* write(
      sql(
        `UPDATE claim_links SET status = CASE WHEN claim_tx IS NULL THEN 'revoked' ELSE status END, remove_tx = ?,
           revoked_at = CASE WHEN claim_tx IS NULL THEN ? ELSE revoked_at END WHERE id = ?`,
        removed.tx,
        now,
        link.id,
      ),
    )
    const network = yield* Network
    return { tx: removed.tx, explorer_url: `${network.explorerBase}/tx/${removed.tx}` }
  })

const revokePage = (c: Chrome, link: ClaimLink, signedIn: boolean, rpId: string) =>
  page(
    'Take back a link',
    c,
    `<h1 data-testid="link-revoke-title">Take back the link for ${escape(link.recipient_name)}</h1>
<section class="card pay"><p class="amount">${escape(fromStroops(link.amount))}<span class="unit"> USDC</span></p>
<p class="muted">Set aside until ${escape(utcTime(link.expires_at))}. Taking it back removes the rule from your account with one passkey tap; the link stops working.</p></section>
${
  link.status === 'revoked' || (link.remove_tx ?? null) !== null
    ? `<section class="card" data-testid="link-revoked"><p class="ok">Taken back.</p>${(link.remove_tx ?? null) === null ? '' : `<p class="muted">Transaction <a href="${escape(`${c.explorerBase}/tx/${link.remove_tx ?? ''}`)}" rel="noreferrer"><code>${escape(link.remove_tx ?? '')}</code></a></p>`}</section><p><a href="/">Back to Nod</a></p>`
    : signedIn
      ? '<div class="thumb"><button class="primary wide" id="revoke" data-testid="link-revoke-confirm">Take it back with your passkey</button></div>'
      : '<div class="thumb"><button class="primary wide" id="signin" data-testid="link-signin">Sign in with your passkey</button></div>'
}${
      link.status === 'revoked' || (link.remove_tx ?? null) !== null
        ? ''
        : `<section class="card" id="revoked-now" hidden data-testid="link-revoked"><p class="ok">Taken back.</p><p class="muted">Transaction <a id="remove-tx" rel="noreferrer"><code id="remove-tx-hash"></code></a></p></section>
<p id="back" hidden><a href="/">Back to Nod</a></p>`
    }
<p id="status" class="muted" role="status"></p>`,
    `const ctx=JSON.parse(document.getElementById('ctx').textContent);
const on=(id,f)=>{const el=document.getElementById(id);if(el)el.onclick=f};
on('signin',async e=>{const done=busy(e.target,'Waiting for your passkey…');try{await signIn();location.reload()}catch(x){done();show('status',x.message)}});
on('revoke',async e=>{const done=busy(e.target,'Preparing…');try{const p=await post(ctx.base+'/prepare',{});e.target.textContent='Waiting for your passkey…';
const a=await assertion(p.challenge,ctx.rpId,[]);e.target.textContent='Removing it on Stellar…';const r=await post(ctx.base,{assertion:a});
e.target.closest('.thumb').remove();document.getElementById('revoked-now').hidden=false;document.getElementById('back').hidden=false;
const l=document.getElementById('remove-tx');l.href=r.explorer_url;document.getElementById('remove-tx-hash').textContent=r.tx}catch(x){done();show('status',x.message)}});`,
    { base: `/approve/revoke-link/${link.id}`, rpId },
  )

const revokeGet = (runtime: AppRuntime, request: Request, linkId: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const n = yield* chrome
      const link = yield* claimLinkById(linkId)
      if (link === undefined || link.kind !== 'person')
        return html(n, messagePage(n, 'Not found', 'No such link.'), { status: 404 })
      const wallet = yield* walletOfSession(sessionToken(request))
      const site = yield* siteOf(request)
      return html(n, revokePage(n, link, wallet !== undefined && wallet.id === link.wallet_id, site.rpId))
    }).pipe(
      Effect.catch(error =>
        Effect.map(chrome, n =>
          html(n, messagePage(n, 'Not available', messageOf(error)), { status: statusOf(error) }),
        ),
      ),
    ),
  )

// The sender's links, for Connections (GET /api/links, app.ts)

export interface LinkRow {
  readonly id: string
  readonly recipient_name: string
  readonly amount: string
  readonly status: 'open' | 'paid' | 'revoked' | 'expired'
  readonly expires_at: string
  readonly revoke_url: string | null
  readonly paid_at: string | null
  readonly tx_hash: string | null
  readonly install_tx: string | null
}

const LinkDbRow = Schema.Struct({
  id: Schema.String,
  recipient_name: Schema.String,
  amount: Schema.String,
  status: Schema.String,
  expires_at: Schema.String,
  claim_tx: Schema.NullOr(Schema.String),
  claimed_at: Schema.NullOr(Schema.String),
  install_tx: Schema.NullOr(Schema.String),
})

/** Person links with a rule on the account (approved), newest first, at most 50. */
export const linksOfWallet = (walletId: string, origin: string) =>
  Effect.gen(function* () {
    const nowMs = yield* nowMillis
    const rows = yield* query(
      sql(
        `SELECT id, recipient_name, amount, status, expires_at, claim_tx, claimed_at, install_tx FROM claim_links
           WHERE wallet_id = ? AND kind = 'person' AND status <> 'awaiting_nod' ORDER BY created_at DESC LIMIT 50`,
        walletId,
      ),
      row =>
        Schema.decodeUnknownEffect(LinkDbRow)(row).pipe(
          Effect.mapError(error => new DbError({ operation: 'decode claim_links', message: String(error) })),
        ),
    )
    return rows.map((row): LinkRow => {
      const status =
        row.claim_tx !== null
          ? ('paid' as const)
          : row.status === 'revoked'
            ? ('revoked' as const)
            : millisOf(row.expires_at) <= nowMs
              ? ('expired' as const)
              : ('open' as const)
      return {
        id: row.id,
        recipient_name: row.recipient_name,
        amount: row.amount,
        status,
        expires_at: row.expires_at,
        revoke_url: status === 'open' ? `${origin}/approve/revoke-link/${row.id}` : null,
        paid_at: row.claim_tx === null ? null : row.claimed_at,
        tx_hash: row.claim_tx,
        install_tx: row.install_tx,
      }
    })
  })

// Routes

const json = (runtime: AppRuntime, effect: Effect.Effect<unknown, RouteError, AppServices>) =>
  runtime.runPromise(
    effect.pipe(
      Effect.map(value => Response.json(value)),
      Effect.catch(error => Effect.succeed(Response.json({ error: messageOf(error) }, { status: statusOf(error) }))),
    ),
  )

/** /approve/link/cl_…, /approve/revoke-link/cl_…, and a person link's /claim/cl_…/prepare and /sign. */
export const personLinkRoute = (runtime: AppRuntime, request: Request, path: string): Promise<Response> | undefined => {
  const approve = /^\/approve\/(link|revoke-link)\/(cl_[0-9a-f]{32})(\/prepare)?$/u.exec(path)
  if (approve !== null) {
    const [, which, id = '', prepare] = approve
    if (request.method === 'GET' && prepare === undefined)
      return which === 'link' ? approveGet(runtime, request, id) : revokeGet(runtime, request, id)
    if (request.method !== 'POST') return Promise.resolve(new Response('Method Not Allowed', { status: 405 }))
    if (which === 'link')
      return json(runtime, prepare === undefined ? approveInstall(request, id) : approvePrepare(request, id))
    return json(runtime, prepare === undefined ? revokePost(request, id) : revokePrepare(request, id))
  }
  const claim = /^\/claim\/(cl_[0-9a-f]{32})\/(prepare|sign)$/u.exec(path)
  if (claim !== null) {
    if (request.method !== 'POST') return Promise.resolve(new Response('Method Not Allowed', { status: 405 }))
    const id = claim[1] ?? ''
    return json(runtime, claim[2] === 'prepare' ? claimPrepare(request, id) : claimSign(request, id))
  }
  return undefined
}
