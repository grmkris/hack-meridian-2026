import { fromStroops } from '@hm/protocol'
import type { PaymentIntent, ReceiptRecord, SpendingGrant, Wallet } from '@hm/protocol'
import { PRESETS } from '@hm/stellar'

/**
 * The Worker's own pages: OAuth consent (sign-in or create wallet, then the grant ceremony), owner approval, claim
 * link and revoke confirmation. Server-rendered, every interpolated value escaped, scripts carry a per-response nonce,
 * and every response sends the S4 headers (frame-deny, no-store) plus a strict CSP.
 */

export const escape = (value: string) => value.replace(/[&<>"']/gu, char => `&#${char.charCodeAt(0)};`)

/** JSON for a `<script type="application/json">` block: `<` cannot close the element. */
const jsonBlock = (id: string, value: unknown) =>
  `<script type="application/json" id="${id}">${JSON.stringify(value).replace(/</gu, '\\u003c')}</script>`

const STYLE = `<style>
:root{color-scheme:light dark;--fg:#14171a;--muted:#5b6470;--line:#d8dde3;--card:#fff;--bg:#f5f7f9;--accent:#1f4fd8;--warn:#fff4d6;--warnline:#e5b638;--err:#b3261e;--ok:#146c2e}
@media (prefers-color-scheme:dark){:root{--fg:#e8ebee;--muted:#9aa3ad;--line:#2c333a;--card:#171b1f;--bg:#0f1215;--accent:#7aa2ff;--warn:#3a2f10;--warnline:#8a6d1c;--err:#ff8a80;--ok:#7bd88f}}
*{box-sizing:border-box}body{font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;max-width:36rem;margin:0 auto;padding:1.5rem 1rem 3rem;color:var(--fg);background:var(--bg)}
h1{font-size:1.4rem;line-height:1.25;margin:.5rem 0 1rem}h2{font-size:1.05rem;margin:0 0 .5rem}
.brand{color:var(--muted);font-size:.85rem}.brand .mark{font-weight:750;font-size:1.15rem;color:var(--fg);letter-spacing:-.01em}.brand .net{font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1rem 1.1rem;margin:0 0 1rem}
.warn{background:var(--warn);border-color:var(--warnline)}.muted{color:var(--muted);font-size:.9em}.err{color:var(--err)}.ok{color:var(--ok)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.35rem .9rem;margin:0}dt{color:var(--muted)}dd{margin:0;min-width:0}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;word-break:break-all}
.amount{font-size:1.6rem;font-weight:650;font-variant-numeric:tabular-nums}
button{font:inherit;font-weight:600;padding:.65rem 1.1rem;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;min-height:44px}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button:disabled{opacity:.55;cursor:progress}
.row{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center}
input,select{font:inherit;padding:.5rem .6rem;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);min-height:40px}
input[name=allowance],input[name=nod_above]{width:7rem;font-variant-numeric:tabular-nums}label{display:block;margin:.35rem 0}
.claim{font-size:.8rem;color:var(--muted)}
</style>`

/** The passkey helpers every page shares: base64url, create, sign in, sign a server challenge. */
const PASSKEY_JS = `
const b64u={enc:b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,''),
dec:s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((s.length+3)%4)),c=>c.charCodeAt(0))};
async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify(body??{})});
const t=await r.text();let j=null;try{j=t?JSON.parse(t):null}catch{};if(!r.ok)throw new Error(j&&j.error==='too_many_wallets'?tooManyWallets(j.retry_after_s):(j&&j.error)||t||r.statusText);return j}
function tooManyWallets(s){const m=Math.max(1,Math.ceil((Number(s)||3600)/60));return'Nod opens only a few new wallets each hour. Try again in '+m+' minute'+(m===1?'':'s')+'.'}
async function createWallet(name,invite){const o=await post('/api/wallets/options',invite?{name,invite_code:invite}:{name});
const c=await navigator.credentials.create({publicKey:{challenge:b64u.dec(o.challenge),rp:{id:o.rp_id,name:o.rp_name},user:{id:b64u.dec(o.user_id),name:o.user_name,displayName:o.user_name},
pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{residentKey:'required',userVerification:'required'},attestation:'none',timeout:120000}});
return post('/api/wallets',{name,...(invite?{invite_code:invite}:{}),credential_id:b64u.enc(c.rawId),public_key:b64u.enc(c.response.getPublicKey()),client_data_json:b64u.enc(c.response.clientDataJSON),attestation_object:b64u.enc(c.response.attestationObject)})}
async function assertion(challenge,rpId,allow){const c=await navigator.credentials.get({publicKey:{challenge:b64u.dec(challenge),rpId,userVerification:'required',timeout:120000,
allowCredentials:(allow||[]).map(id=>({type:'public-key',id:b64u.dec(id)}))}});
return{credential_id:b64u.enc(c.rawId),client_data_json:b64u.enc(c.response.clientDataJSON),authenticator_data:b64u.enc(c.response.authenticatorData),signature:b64u.enc(c.response.signature)}}
async function signIn(){const o=await post('/api/session/options');return post('/api/session',await assertion(o.challenge,o.rp_id,o.allow_credentials))}
function busy(button,text){button.disabled=true;const old=button.textContent;button.textContent=text;return()=>{button.disabled=false;button.textContent=old}}
function show(id,text,cls){const el=document.getElementById(id);el.textContent=text;el.className=cls||'err'}
`

export interface Page {
  readonly body: string
  readonly status?: number
  readonly headers?: HeadersInit
}

/** `data` becomes a JSON block the script reads as `document.getElementById('ctx')`. */
/** What every page carries: the script nonce and the network it runs on (always visible). */
export interface Chrome {
  readonly nonce: string
  readonly network: 'Testnet' | 'Mainnet'
  /** e.g. https://stellar.expert/explorer/testnet */
  readonly explorerBase: string
}

const txLink = (c: Chrome, hash: string, testid: string) =>
  `<a href="${escape(`${c.explorerBase}/tx/${hash}`)}" rel="noreferrer" data-testid="${testid}"><code>${escape(hash)}</code></a>`

const page = (title: string, c: Chrome, body: string, script = '', data?: unknown) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escape(title)} · Nod</title>${STYLE}<body><p class="brand"><span class="mark">nod</span> · <span class="net">Stellar ${escape(c.network)}</span></p>${body}${data === undefined ? '' : jsonBlock('ctx', data)}${script === '' ? '' : `<script nonce="${c.nonce}">${PASSKEY_JS}${script}</script>`}</body></html>`

/** S4's headers (frame-deny, no-store) and a CSP that only runs this response's scripts. */
export const html = (c: Chrome, body: string, init: { status?: number; headers?: HeadersInit } = {}) => {
  const nonce = c.nonce
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set('X-Frame-Options', 'DENY')
  headers.set(
    'Content-Security-Policy',
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'`,
  )
  headers.set('Cache-Control', 'no-store')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('X-Content-Type-Options', 'nosniff')
  return new Response(body, { status: init.status ?? 200, headers })
}

export const usdc = (stroops: bigint) => `${fromStroops(stroops)} USDC`
const shortAddress = (address: string) =>
  address.length > 16 ? `${address.slice(0, 6)}…${address.slice(-6)}` : address

export const messagePage = (c: Chrome, title: string, message: string) =>
  page(title, c, `<h1>${escape(title)}</h1><div class="card"><p>${escape(message)}</p></div>`)

// OAuth consent

export interface ConsentView {
  readonly handle: string
  readonly clientName: string
  readonly clientDomain: string | null
  readonly redirectHost: string
  readonly redirectIsLoopback: boolean
}

const consentHeader = (view: ConsentView) => {
  const publisher = view.clientDomain
    ? `Published by <strong>${escape(view.clientDomain)}</strong>.`
    : 'This app registered itself; its name is not verified.'
  return `<h1>Connect <em>${escape(view.clientName)}</em> to Nod?</h1>
<div class="card"><p>${publisher} Access will be sent to <strong>${escape(view.redirectHost)}</strong>.</p>
${view.redirectIsLoopback ? '<p class="card warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>' : ''}
<p class="muted">Connecting lets this AI app see your wallet. It can only spend the allowance you set next; anything bigger needs your nod.</p></div>`
}

/** Step 1 of /authorize when no owner is signed in: sign in with the passkey, or create a passkey wallet. */
export const consentSignInPage = (c: Chrome, view: ConsentView, inviteNeeded: boolean) =>
  page(
    `Connect ${view.clientName}`,
    c,
    `${consentHeader(view)}
<div class="card"><h2>New here?</h2><p>Create a Nod wallet with a passkey (Face ID, fingerprint or your device PIN). No seed phrase and no XLM: Nod pays the network fee.${c.network === 'Testnet' ? ' On testnet it starts with 10 USDC.' : ''}</p>
<label>Wallet name <input id="name" value="Personal" maxlength="40"></label>${inviteNeeded ? '<label>Invite code <input id="invite" autocomplete="off" required></label>' : ''}<p class="row"><button class="primary" id="create" data-testid="passkey-create">Create wallet</button></p></div>
<div class="card"><h2>Already have a wallet?</h2><p class="row"><button id="signin" data-testid="passkey-signin">Sign in with passkey</button></p></div>
<p id="status" class="muted" role="status"></p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(view.handle)}"><button name="decision" value="deny">Deny</button></form>`,
    `document.getElementById('signin').onclick=async e=>{const done=busy(e.target,'Waiting for passkey…');try{await signIn();location.reload()}catch(x){done();show('status',x.message)}};
document.getElementById('create').onclick=async e=>{const done=busy(e.target,'Creating wallet (about 15 s)…');try{const inv=document.getElementById('invite');await createWallet(document.getElementById('name').value||'Personal',inv?inv.value:undefined);location.reload()}catch(x){done();show('status',x.message)}};`,
  )

/** Expiry choices for a grant; "tomorrow 12:00 UTC" is the demo default. */
const expiryOptions = (nowMs: number) => {
  const tomorrow = new Date(nowMs)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  tomorrow.setUTCHours(12, 0, 0, 0)
  const choices: Array<[string, number]> = [
    ['1 hour', 3600],
    ['tomorrow 12:00 UTC', Math.round((tomorrow.getTime() - nowMs) / 1000)],
    ['7 days', 7 * 86400],
  ]
  return choices
    .map(([label, seconds], i) => `<option value="${seconds}"${i === 1 ? ' selected' : ''}>${escape(label)}</option>`)
    .join('')
}

/** Step 2: the grant ceremony. Allow → the server prepares the rule install, the passkey signs it, the form posts. */
export const consentGrantPage = (
  c: Chrome,
  view: ConsentView,
  wallet: Wallet,
  balance: bigint | null,
  nowMs: number,
  rpId: string,
) =>
  page(
    `Connect ${view.clientName}`,
    c,
    `${consentHeader(view)}
<div class="card"><dl><dt>Wallet</dt><dd>${escape(wallet.name)} <span class="muted">(Stellar ${escape(c.network)})</span><br><code>${escape(wallet.contract_id)}</code></dd>
<dt>Balance</dt><dd>${balance === null ? '<span class="muted">unavailable</span>' : escape(usdc(balance))}</dd></dl></div>
<form method="post" action="/authorize" id="grant">
<input type="hidden" name="handle" value="${escape(view.handle)}"><input type="hidden" name="pending_id"><input type="hidden" name="assertion"><input type="hidden" name="approve" value="">
<div class="card"><p>Allow <strong>${escape(view.clientName)}</strong> to spend up to
<input name="allowance" data-testid="allowance" value="5.00" inputmode="decimal" pattern="\\d{1,6}(\\.\\d{1,2})?" required> <strong>USDC</strong> total until
<select name="lifetime">${expiryOptions(nowMs)}</select>.</p>
<p><strong>Inside this allowance it pays on its own; anything past it needs your nod, every time.</strong> It comes to you as a link you approve with your passkey, for any amount. Your passkey now writes this allowance to your Stellar account; you can revoke it any time.</p></div>
<p id="status" class="muted" role="status"></p>
<p class="row"><button class="primary" id="allow" type="button" data-testid="consent-allow">Allow with passkey</button> <button name="decision" value="deny" formnovalidate>Deny</button></p>
</form>`,
    `const ctx=JSON.parse(document.getElementById('ctx').textContent);const f=document.getElementById('grant');
document.getElementById('allow').onclick=async e=>{if(!f.reportValidity())return;const done=busy(e.target,'Preparing…');
try{const p=await post('/oauth/grant/prepare',{handle:f.handle.value,allowance:f.allowance.value,lifetime_seconds:Number(f.lifetime.value)});
e.target.textContent='Waiting for passkey…';const a=await assertion(p.challenge,ctx.rpId,[ctx.credential]);
f.pending_id.value=p.pending_id;f.assertion.value=JSON.stringify(a);f.approve.value='1';
e.target.textContent='Writing the allowance to Stellar…';f.submit()}catch(x){done();show('status',x.message)}};`,
    { credential: wallet.passkey_credential_id, rpId },
  )

// Owner approval

export interface ApprovalView {
  readonly intent: PaymentIntent
  readonly status: PaymentIntent['status']
  readonly receipt: ReceiptRecord | undefined
  readonly signedIn: Wallet | undefined
  readonly connectionName: string | null
  readonly rpId: string
  readonly notice?: string
  /** For a recipient without a trustline: where they accept once you approved. */
  readonly claimUrl?: string
}

const intentFacts = (intent: PaymentIntent, connectionName: string | null) => `<dl>
<dt>To</dt><dd>${intent.recipient_name === null ? '<span class="muted">not a saved contact</span>' : `<strong>${escape(intent.recipient_name)}</strong>`}<br><code>${escape(intent.recipient_address)}</code></dd>
<dt>Amount</dt><dd><span class="amount">${escape(fromStroops(intent.amount))}</span> ${escape(intent.asset)}</dd>
<dt>Network</dt><dd>${escape(intent.network === 'stellar:pubnet' ? 'Stellar Mainnet' : 'Stellar Testnet')}</dd>
<dt>Network fee</dt><dd>up to ${escape(String(intent.fee_ceiling_xlm))} XLM <span class="muted">paid by Nod, never by you</span></dd>
<dt>Asked by</dt><dd>${escape(intent.requester)}${connectionName === null ? '' : ` <span class="muted">(${escape(connectionName)})</span>`}</dd>
${intent.reason === null ? '' : `<dt>Reason</dt><dd>“${escape(intent.reason)}”<br><span class="claim">What the AI app says; not verified.</span></dd>`}
${intent.resource === null ? '' : `<dt>Resource</dt><dd><code>${escape(intent.resource)}</code></dd>`}
<dt>Expires</dt><dd>${escape(intent.expires_at)}</dd><dt>Payment</dt><dd><code>${escape(intent.id)}</code></dd></dl>`

const receiptBlock = (receipt: ReceiptRecord) => `<div class="card"><h2 class="ok">Paid</h2><dl>
<dt>Transaction</dt><dd><a href="${escape(receipt.explorer_url)}" rel="noreferrer"><code>${escape(receipt.tx_hash)}</code></a></dd>
<dt>Ledger</dt><dd>${escape(String(receipt.ledger))}</dd><dt>Network fee</dt><dd>${escape(fromStroops(receipt.fee_stroops))} XLM, paid by ${receipt.fee_paid_by === 'relayer' ? 'Nod' : 'the payment facilitator'}</dd></dl></div>`

/** Opening this page has no side effect; only the passkey-signed POST changes anything. */
export const approvalPage = (c: Chrome, view: ApprovalView) => {
  const open = view.status === 'awaiting_approval'
  const waitingForRecipient = view.status === 'approved' && view.claimUrl !== undefined
  const title = open
    ? 'Approve this payment?'
    : waitingForRecipient
      ? `Approved: waiting for ${view.intent.recipient_name ?? 'the recipient'} to accept`
      : `Payment ${view.status.replace('_', ' ')}`
  const action = !open
    ? ''
    : view.signedIn === undefined
      ? `<div class="card"><p>Sign in with your passkey to approve.</p><p class="row"><button class="primary" id="signin">Sign in with passkey</button></p></div>`
      : `<p class="row"><button class="primary" id="approve" data-testid="approve">Approve with passkey</button></p>`
  return page(
    title,
    c,
    `<h1${open ? '' : ` data-testid="${view.status === 'confirmed' || waitingForRecipient ? 'approval-done' : `approval-${escape(view.status)}`}"`}>${escape(title)}</h1>${waitingForRecipient ? `<p class="card">Send this link to ${escape(view.intent.recipient_name ?? 'the recipient')}: <a href="${escape(view.claimUrl ?? '')}" data-testid="claim-link"><code>${escape(view.claimUrl ?? '')}</code></a>. Their acceptance and your payment land in one Stellar transaction.</p>` : ''}${view.notice === undefined ? '' : `<p class="card warn">${escape(view.notice)}</p>`}
${view.intent.failure !== null && open ? `<p class="card warn">Last attempt: ${escape(view.intent.failure)}</p>` : ''}
<div class="card">${intentFacts(view.intent, view.connectionName)}</div>
${view.receipt === undefined ? '' : receiptBlock(view.receipt)}${action}<p id="status" class="muted" role="status"></p>`,
    open
      ? `const ctx=JSON.parse(document.getElementById('ctx').textContent);
const si=document.getElementById('signin');if(si)si.onclick=async e=>{const done=busy(e.target,'Waiting for passkey…');try{await signIn();location.reload()}catch(x){done();show('status',x.message)}};
const ap=document.getElementById('approve');if(ap)ap.onclick=async e=>{const done=busy(e.target,'Preparing…');
try{const p=await post('/approve/'+ctx.id+'/prepare');e.target.textContent='Waiting for passkey…';
const a=await assertion(p.challenge,ctx.rpId,[ctx.credential]);e.target.textContent='Submitting (about 10 s)…';
await post('/approve/'+ctx.id,{assertion:a});location.reload()}catch(x){done();show('status',x.message)}};`
      : '',
    { id: view.intent.id, rpId: view.rpId, credential: view.signedIn?.passkey_credential_id ?? null },
  )
}

// Revoke confirmation

export const revokePage = (
  c: Chrome,
  input: {
    readonly clientName: string
    readonly connectionId: string
    readonly grant: SpendingGrant | undefined
    readonly connectionStatus: string
    readonly signedIn: Wallet | undefined
    readonly rpId: string
  },
) => {
  const removed = input.grant?.rule_status === 'removed'
  return page(
    `Revoke ${input.clientName}`,
    c,
    `<h1${removed ? ' data-testid="revoked"' : ''}>${removed ? `${escape(input.clientName)} is revoked` : `Revoke ${escape(input.clientName)}?`}</h1>
<div class="card"><dl><dt>AI app</dt><dd>${escape(input.clientName)} <span class="muted">${escape(input.connectionStatus)}</span></dd>
${input.grant === undefined ? '' : `<dt>Allowance</dt><dd>${escape(usdc(input.grant.total))}, spent ${escape(usdc(input.grant.spent))}</dd><dt>On Stellar</dt><dd>${input.grant.rule_status === 'removed' ? 'removed from your account' : input.grant.rule_status === 'removal_pending' ? 'still on your account until your passkey removes it' : 'on your account'}${input.grant.remove_tx === null || input.grant.remove_tx === undefined ? '' : `<br>${txLink(c, input.grant.remove_tx, 'rule-removal-tx')}`}</dd>${input.grant.sweep_tx === null || input.grant.sweep_tx === undefined ? '' : `<dt>Swept back</dt><dd>${txLink(c, input.grant.sweep_tx, 'pocket-sweep-tx')}</dd>`}<dt>Unspent</dt><dd>${escape(usdc(input.grant.pocket_balance))} <span class="muted">goes back to your wallet</span></dd>`}</dl></div>
${removed ? '' : input.signedIn === undefined ? `<div class="card"><p>Sign in with the wallet's passkey.</p><p class="row"><button class="primary" id="signin">Sign in with passkey</button></p></div>` : `<p>Nod stops paying for this AI app at once. Your passkey then removes the allowance from your Stellar account.</p><p class="row"><button class="primary" id="revoke" data-testid="revoke" data-connection="${escape(input.connectionId)}">Revoke with passkey</button></p>`}
<p id="status" class="muted" role="status"></p>`,
    removed
      ? ''
      : `const ctx=JSON.parse(document.getElementById('ctx').textContent);
const si=document.getElementById('signin');if(si)si.onclick=async e=>{const done=busy(e.target,'Waiting for passkey…');try{await signIn();location.reload()}catch(x){done();show('status',x.message)}};
const rv=document.getElementById('revoke');if(rv)rv.onclick=async e=>{const done=busy(e.target,'Revoking…');
try{const p=await post('/approve/revoke/'+ctx.id+'/prepare');e.target.textContent='Waiting for passkey…';
const a=await assertion(p.challenge,ctx.rpId,[ctx.credential]);e.target.textContent='Removing the allowance on Stellar…';
await post('/approve/revoke/'+ctx.id,{assertion:a});location.reload()}catch(x){done();show('status',x.message)}};`,
    { id: input.connectionId, rpId: input.rpId, credential: input.signedIn?.passkey_credential_id ?? null },
  )
}

// Claim link (CAP-73)

export const claimPage = (
  c: Chrome,
  input: {
    readonly intent: PaymentIntent
    readonly status: string
    readonly demo: boolean
    readonly recipientEntryXdr: string | null
    readonly receipt: ReceiptRecord | undefined
    readonly notice?: string
  },
) =>
  page(
    `Accept ${fromStroops(input.intent.amount)} USDC`,
    c,
    `<h1${input.receipt === undefined ? '' : ' data-testid="claim-done"'}>${input.receipt === undefined ? `Accept ${escape(fromStroops(input.intent.amount))} USDC` : 'USDC received'}</h1>
${input.notice === undefined ? '' : `<p class="card warn">${escape(input.notice)}</p>`}
<div class="card"><dl><dt>From</dt><dd>${escape(input.intent.requester)}</dd><dt>To</dt><dd><code>${escape(input.intent.recipient_address)}</code> <span class="muted">${escape(shortAddress(input.intent.recipient_address))}</span></dd>
<dt>Amount</dt><dd><span class="amount">${escape(fromStroops(input.intent.amount))}</span> USDC</dd><dt>Network</dt><dd>Stellar ${escape(c.network)}</dd></dl>
<p class="muted">Your account has no USDC trustline yet. Accepting signs one authorization: the trustline and the payment land together in one transaction.</p></div>
${input.receipt === undefined ? receiptPending(input) : receiptBlock(input.receipt)}<p id="status" class="muted" role="status"></p>`,
    input.receipt === undefined && input.recipientEntryXdr !== null
      ? `const ctx=JSON.parse(document.getElementById('ctx').textContent);
document.getElementById('accept').onclick=async e=>{const done=busy(e.target,'Signing…');try{let signed=null;
if(!ctx.demo){const w=window.freighterApi||window.stellarWallet;if(!w||!w.signAuthEntry)throw new Error('No browser wallet with signAuthEntry was found (Freighter supports it).');
const r=await w.signAuthEntry(ctx.entry,{networkPassphrase:ctx.passphrase});signed=r.signedAuthEntry||r}
e.target.textContent='Submitting…';await post('/claim/'+ctx.id+(ctx.demo?'?demo=1':''),{signed_entry:signed});location.reload()}catch(x){done();show('status',x.message)}};`
      : '',
    {
      id: input.intent.id,
      entry: input.recipientEntryXdr,
      demo: input.demo,
      // The wallet signs for the stage's network (the chain preset's passphrase), not always testnet's.
      passphrase: PRESETS[c.network === 'Mainnet' ? 'pubnet' : 'testnet'].passphrase,
    },
  )

const receiptPending = (input: {
  readonly demo: boolean
  readonly recipientEntryXdr: string | null
  readonly status: string
}) =>
  input.recipientEntryXdr === null
    ? `<div class="card"><p>This link is ${escape(input.status.replace('_', ' '))}.</p></div>`
    : `${input.demo ? '<p class="card warn"><strong>Demo wallet.</strong> Nod’s demo recipient key signs on the server instead of a browser wallet (Nod’s own demo contact).</p>' : ''}<p class="row"><button class="primary" id="accept" data-testid="claim-accept">${input.demo ? 'Accept with the demo wallet' : 'Accept with my wallet'}</button></p>`

// Payment request (/approve/request/<id>): what someone asks this wallet for. Read-only: paying goes through the AI
// app (request_pay) and, for anyone outside the payer's contacts, the approval page and the passkey.

export interface RequestPageView {
  readonly id: string
  readonly status: 'open' | 'paid' | 'declined' | 'expired'
  readonly amount: bigint
  readonly requesterAddress: string
  /** The viewer's contact name for the requester, or null. Never the requester's own wallet name. */
  readonly requesterName: string | null
  readonly payerAddress: string
  readonly payerName: string | null
  /** Who is looking: the payer, the requester, or someone else (or nobody signed in). */
  readonly viewer: 'payer' | 'requester' | 'other'
  readonly note: string | null
  readonly expiresAt: string
  readonly paymentId: string | null
  readonly paidTx: string | null
}

export const requestPage = (c: Chrome, view: RequestPageView) => {
  const requester =
    view.viewer === 'requester'
      ? 'You'
      : view.requesterName === null
        ? 'A Nod wallet you have not saved'
        : escape(view.requesterName)
  const payer = view.viewer === 'payer' ? 'You' : view.payerName === null ? 'The payer' : escape(view.payerName)
  const status =
    view.status === 'open'
      ? `Open until ${escape(view.expiresAt.slice(0, 16).replace('T', ' '))} UTC`
      : view.status === 'paid'
        ? `<span class="ok">Paid</span>${view.paidTx === null ? '' : `<br>${txLink(c, view.paidTx, 'request-paid-tx')}`}`
        : escape(view.status === 'declined' ? 'Declined' : 'Expired')
  const next =
    view.status !== 'open'
      ? ''
      : view.viewer === 'payer'
        ? `<div class="card"><p>To pay it, ask your AI app to pay request <code>${escape(view.id)}</code>. ${view.requesterName === null ? 'They are not in your contacts, so it will need your nod: your passkey approves the exact amount.' : 'It pays from the AI app’s allowance, or asks for your nod if it is bigger.'}</p></div>`
        : view.viewer === 'requester'
          ? `<div class="card"><p>Waiting for ${payer === 'The payer' ? 'the payer' : payer} to pay. Their AI app sees it in their Nod inbox.</p></div>`
          : `<div class="card"><p>Sign in to Nod with the payer's passkey to see what to do next.</p></div>`
  return page(
    'Payment request',
    c,
    `<h1 data-testid="request-title">${requester === 'You' ? 'You asked for' : `${requester} asks for`} ${escape(usdc(view.amount))}</h1>
<div class="card"><p class="amount" data-testid="request-amount">${escape(usdc(view.amount))}</p><dl>
<dt>From</dt><dd>${requester} · <code>${escape(shortAddress(view.requesterAddress))}</code></dd>
<dt>To pay</dt><dd>${payer} · <code>${escape(shortAddress(view.payerAddress))}</code></dd>
<dt>Status</dt><dd data-testid="request-status">${status}</dd>
${view.note === null ? '' : `<dt>Their note</dt><dd>“${escape(view.note)}” <span class="muted">(the requester’s words)</span></dd>`}
</dl></div>${next}`,
  )
}
