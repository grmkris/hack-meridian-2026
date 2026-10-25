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
@font-face{font-family:'Besley';font-style:normal;font-weight:700;font-display:swap;src:url(/fonts/besley-700.woff2) format('woff2')}
@font-face{font-family:'IBM Plex Sans';font-style:normal;font-weight:100 700;font-display:swap;src:url(/fonts/plex-sans.woff2) format('woff2')}
@font-face{font-family:'IBM Plex Mono';font-style:normal;font-weight:400;font-display:swap;src:url(/fonts/plex-mono-400.woff2) format('woff2')}
:root{color-scheme:light dark;--canvas:#f9f6f2;--paper:#fefdfc;--ink:#12161f;--muted:#5b6474;--line:#e7e1d8;--wash:#f2eee8;--accent:#29416f;--primary:#0b152c;--on-primary:#e6f0fa;--lamp:#f7c15f;--on-lamp:#1d1405;--nod:#995600;--nod-wash:#fdf0d5;--nod-line:#efd29b;--good:#1f6b43;--bad:#a8322a;--chevron:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5l5 5 5-5' fill='none' stroke='%2329416f' stroke-width='1.8'/%3E%3C/svg%3E");--display:'Besley',ui-serif,Georgia,serif;--sans:'IBM Plex Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;--code:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--canvas:#0b152c;--paper:#13213f;--ink:#e6f0fa;--muted:#b7c6d8;--line:#263b63;--wash:#0f1a33;--accent:#e6f0fa;--primary:#e6f0fa;--on-primary:#0b152c;--nod:#f7c15f;--nod-wash:#2b2614;--nod-line:#6b5523;--good:#7fd4a2;--bad:#ff9a8f;--chevron:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5l5 5 5-5' fill='none' stroke='%23e6f0fa' stroke-width='1.8'/%3E%3C/svg%3E")}}
*,*::before,*::after{box-sizing:border-box}
html{background:var(--canvas);-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent}
body{margin:0 auto;max-width:34rem;padding:clamp(.75rem,4vh,2.5rem) 1rem calc(2.5rem + env(safe-area-inset-bottom,0px));font:16px/1.5 var(--sans);color:var(--ink);background:var(--canvas);-webkit-font-smoothing:antialiased;font-synthesis:none}
.top{display:flex;align-items:center;justify-content:space-between;gap:.75rem;min-height:2.75rem;margin:0 0 1.25rem}
.mark{font:700 1.6rem/1 var(--display);letter-spacing:-.015em}
.net{font-size:.8rem;font-weight:600;line-height:1;padding:.4rem .7rem;border-radius:999px;box-shadow:inset 0 0 0 1px var(--line);color:var(--muted);white-space:nowrap}
.net-testnet{color:var(--ink)}.net-mainnet{color:var(--good)}
h1{font:700 clamp(1.65rem,1.3rem + 1.6vw,2.1rem)/1.15 var(--display);letter-spacing:-.015em;margin:0 0 .6rem;text-wrap:balance}
h2{font:600 1.05rem/1.3 var(--sans);margin:0 0 .4rem}
p{margin:0 0 .75rem;text-wrap:pretty}p:last-child{margin-bottom:0}
strong{font-weight:600}
.lead{color:var(--muted);margin:0 0 1.25rem}.lead strong{color:var(--ink)}
.card{background:var(--paper);border-radius:20px;padding:1.1rem 1.2rem;margin:0 0 1rem;box-shadow:0 0 0 1px var(--line),0 1px 2px rgb(18 22 31/.05)}
.warn{background:var(--nod-wash);box-shadow:0 0 0 1px var(--nod-line);border-radius:14px;padding:.8rem 1rem;margin:0 0 1rem}
.card .warn{margin:.75rem 0 0}
.muted{color:var(--muted);font-size:.9rem}.err{color:var(--bad)}.ok{color:var(--good)}
.eyebrow{font-size:.85rem;font-weight:600;color:var(--muted);margin:0 0 .5rem}
dl{display:grid;grid-template-columns:minmax(0,max-content) minmax(0,1fr);gap:.45rem 1rem;margin:0}dt{color:var(--muted);font-size:.9rem;padding-top:.08rem}dd{margin:0;min-width:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
code,.mono{font-family:var(--code);font-size:.84em;overflow-wrap:anywhere}
a{color:var(--accent);text-decoration-color:color-mix(in srgb,currentColor 40%,transparent);text-underline-offset:3px}
.amount{font:700 2rem/1.1 var(--display);letter-spacing:-.015em;font-variant-numeric:tabular-nums lining-nums}
button{font:600 1rem/1.2 var(--sans);min-height:3rem;padding:.7rem 1.3rem;border-radius:999px;border:1px solid var(--line);background:var(--paper);color:var(--ink);cursor:pointer;touch-action:manipulation;-webkit-user-select:none;user-select:none}
button.primary{background:var(--primary);border-color:var(--primary);color:var(--on-primary)}
button.nod{background:var(--lamp);border-color:var(--lamp);color:var(--on-lamp)}
button.quiet{background:transparent;border-color:transparent;color:var(--muted)}
button:active:not(:disabled){opacity:.85}button:disabled{opacity:.6;cursor:progress}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (hover:hover) and (pointer:fine){button:hover:not(:disabled){background:var(--wash)}button.primary:hover:not(:disabled){background:color-mix(in srgb,var(--primary) 86%,var(--canvas))}button.nod:hover:not(:disabled){background:color-mix(in srgb,var(--lamp) 88%,var(--ink))}a:hover{text-decoration-color:currentColor}}
@media (prefers-reduced-motion:no-preference){button{transition:transform 120ms cubic-bezier(.23,1,.32,1),background-color 120ms ease-out}button:active:not(:disabled){transform:scale(.97)}}
.row{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center}
.actions{display:flex;flex-direction:column;gap:.6rem;margin:0 0 1rem}.actions button,button.wide{width:100%}
@media (min-width:34rem){.actions{flex-direction:row;align-items:center}.actions button{width:auto}}
.thumb{position:sticky;bottom:0;z-index:1;margin:0 -1rem 1rem;padding:.75rem 1rem calc(.75rem + env(safe-area-inset-bottom,0px));background:linear-gradient(to top,var(--canvas) 72%,transparent)}
.thumb p{margin:0 0 .6rem}
input,select{font:inherit;font-size:max(16px,1em);min-height:3rem;width:100%;padding:.5rem .8rem;border-radius:12px;border:1px solid var(--line);background:var(--canvas);color:var(--ink)}
label{display:block;margin:.75rem 0;font-size:.95rem;font-weight:600}label input{display:block;margin-top:.35rem;font-weight:400}
.sentence{font-size:1.2rem;line-height:2.6rem;margin:0 0 .25rem}
.blank{display:inline-block;width:auto;min-height:0;margin:0 .1rem;padding:0 .15rem;border:0;border-bottom:2px solid var(--accent);border-radius:0;background:transparent;color:var(--ink);line-height:1.3}
input.blank{width:6ch;font:700 1.4rem/1.3 var(--display);text-align:center;font-variant-numeric:tabular-nums lining-nums}
@supports (field-sizing:content){input.blank{width:auto;field-sizing:content;min-width:3.5ch;padding:0 .3rem}}
select.blank{-webkit-appearance:none;appearance:none;padding-right:1.25rem;font-size:1.2rem;font-weight:600;background:var(--chevron) no-repeat right .15rem center/.75rem;cursor:pointer}
.blank:focus-visible{outline-offset:4px;border-radius:4px}
.nb{white-space:nowrap}.rule{font-weight:600;margin:.5rem 0 .4rem}
.wallet{margin-top:1rem;padding-top:.9rem;border-top:1px solid var(--line)}
.pay{container-type:inline-size}.pay .amount{display:block;font-size:min(3rem,13cqi);margin:0 0 .35rem}.unit{font:600 1.1rem/1 var(--sans);color:var(--muted);letter-spacing:0}
.to{font-size:1.1rem;margin:0 0 .4rem}
.addr{display:block;padding:.55rem .75rem;border-radius:12px;background:var(--wash);font-size:.8rem;line-height:1.45}
.ask{margin:1rem 0 0;padding:.1rem 0 .1rem .9rem;border-left:3px solid var(--line)}.ask blockquote{margin:.3rem 0 .2rem;font-style:italic;overflow-wrap:anywhere}.ask figcaption{font-size:.9rem;color:var(--muted)}.ask figcaption strong{color:var(--ink)}
.fee{margin:1rem 0 0;font-size:.95rem;color:var(--muted)}
.steps{margin:0 0 1rem;padding:0;list-style:none;counter-reset:step}.steps li{counter-increment:step;position:relative;padding:0 0 .75rem 2.4rem}.steps li::before{content:counter(step);position:absolute;left:0;top:-.05rem;display:grid;place-items:center;width:1.7rem;height:1.7rem;border-radius:50%;font-weight:600;font-size:.9rem;box-shadow:inset 0 0 0 1px var(--line);background:var(--paper)}.steps li.done::before{content:'✓';background:var(--good);color:var(--paper);box-shadow:none}
.more{padding:0}.more summary{display:flex;align-items:center;justify-content:space-between;min-height:3rem;padding:.6rem 1.2rem;font-weight:600;cursor:pointer;list-style:none;border-radius:20px}.more summary::-webkit-details-marker{display:none}.more summary::after{content:'';width:.75rem;height:.75rem;background:var(--chevron) no-repeat center/contain}.more[open] summary::after{transform:rotate(180deg)}.more dl{padding:0 1.2rem 1.1rem}
.claim{font-size:.8rem;color:var(--muted)}
</style>`

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

export const page = (title: string, c: Chrome, body: string, script = '', data?: unknown) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="referrer" content="no-referrer"><meta name="theme-color" media="(prefers-color-scheme: light)" content="#f9f6f2"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0b152c"><title>${escape(title)} · Nod</title>${STYLE}<body><header class="top"><span class="mark">nod</span><span class="net net-${c.network === 'Mainnet' ? 'mainnet' : 'testnet'}">Stellar ${escape(c.network)}</span></header><main>${body}</main>${data === undefined ? '' : jsonBlock('ctx', data)}${script === '' ? '' : `<script nonce="${c.nonce}">${PASSKEY_JS}${script}</script>`}</body></html>`

/** S4's headers (frame-deny, no-store) and a CSP that only runs this response's scripts. */
export const html = (c: Chrome, body: string, init: { status?: number; headers?: HeadersInit } = {}) => {
  const nonce = c.nonce
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set('X-Frame-Options', 'DENY')
  headers.set(
    'Content-Security-Policy',
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
  )
  headers.set('Cache-Control', 'no-store')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('X-Content-Type-Options', 'nosniff')
  return new Response(body, { status: init.status ?? 200, headers })
}

export const usdc = (stroops: bigint) => `${fromStroops(stroops)} USDC`

/** "12840502.50" → "12,840,502.50": the whole part grouped by thousands, for amounts a person reads. */
const grouped = (stroops: bigint) => {
  const [whole = '', fraction] = fromStroops(stroops).split('.')
  const thousands = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
  return fraction === undefined ? thousands : `${thousands}.${fraction}`
}
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
  return `<h1>Connect ${escape(view.clientName)} to Nod?</h1>
<p class="lead">${publisher} Access goes to <strong>${escape(view.redirectHost)}</strong>.</p>
${view.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>' : ''}`
}

/** Step 1 of /authorize when no owner is signed in: sign in with the passkey, or create a passkey wallet. */
export const consentSignInPage = (c: Chrome, view: ConsentView, inviteNeeded: boolean) =>
  page(
    `Connect ${view.clientName}`,
    c,
    `${consentHeader(view)}
<section class="card"><h2>New to Nod?</h2><p class="muted">Create a wallet with a passkey: Face ID, fingerprint or your device PIN. No seed phrase and no XLM; Nod pays the network fee.${c.network === 'Testnet' ? ' On testnet it starts with 10 USDC.' : ''} Next, you choose what ${escape(view.clientName)} may spend.</p>
<label>Wallet name <input id="name" value="Personal" maxlength="40" autocomplete="off"></label>${inviteNeeded ? '<label>Invite code <input id="invite" autocomplete="off" required></label>' : ''}<button class="primary wide" id="create" data-testid="passkey-create">Create wallet</button></section>
<section class="card"><h2>Already have a wallet?</h2><button class="wide" id="signin" data-testid="passkey-signin">Sign in with passkey</button></section>
<p id="status" class="muted" role="status"></p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(view.handle)}"><button class="quiet wide" name="decision" value="deny">Deny</button></form>`,
    `document.getElementById('signin').onclick=async e=>{const done=busy(e.target,'Waiting for passkey…');try{await signIn();location.reload()}catch(x){done();show('status',x.message)}};
document.getElementById('create').onclick=async e=>{const done=busy(e.target,'Creating wallet (about 15 s)…');try{const inv=document.getElementById('invite');await createWallet(document.getElementById('name').value||'Personal',inv?inv.value:undefined);location.reload()}catch(x){done();show('status',x.message)}};`,
  )

/** Expiry choices for a grant, worded to finish "… on its own until"; tomorrow 12:00 UTC is the demo default. */
const expiryOptions = (nowMs: number) => {
  const tomorrow = new Date(nowMs)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  tomorrow.setUTCHours(12, 0, 0, 0)
  const choices: Array<[string, number]> = [
    ['an hour from now', 3600],
    ['tomorrow, 12:00 UTC', Math.round((tomorrow.getTime() - nowMs) / 1000)],
    ['7 days from now', 7 * 86400],
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
<form method="post" action="/authorize" id="grant">
<input type="hidden" name="handle" value="${escape(view.handle)}"><input type="hidden" name="pending_id"><input type="hidden" name="assertion"><input type="hidden" name="approve" value="">
<section class="card" aria-labelledby="allowance-title"><h2 class="eyebrow" id="allowance-title">The allowance</h2>
<p class="sentence"><strong>${escape(view.clientName)}</strong> may spend up to <span class="nb"><input class="blank" name="allowance" data-testid="allowance" value="5.00" inputmode="decimal" pattern="\\d{1,6}(\\.\\d{1,2})?" required aria-label="Allowance in USDC" autocomplete="off"> USDC</span> on its own until <select class="blank" name="lifetime" aria-label="Allowance ends">${expiryOptions(nowMs)}</select>.</p>
<p class="rule">Larger payments need your passkey, every time.</p>
<p class="muted">Each one comes to you as a link to Nod’s own page, for any amount. Your passkey now writes this allowance to your Stellar account; you can revoke it any time.</p>
<dl class="wallet"><dt>Wallet</dt><dd>${escape(wallet.name)} · <code title="${escape(wallet.contract_id)}">${escape(shortAddress(wallet.contract_id))}</code></dd>
<dt>Balance</dt><dd>${balance === null ? '<span class="muted">unavailable</span>' : `${escape(grouped(balance))} USDC`}</dd></dl>
${balance === 0n ? `<p class="warn" data-testid="consent-empty-wallet">Your wallet holds 0 USDC; <a href="/" target="_blank" rel="noopener">add money</a> so ${escape(view.clientName)} can pay.</p>` : ''}</section>
<p id="status" class="muted" role="status"></p>
<div class="actions"><button class="primary" id="allow" type="button" data-testid="consent-allow">Allow with passkey</button><button name="decision" value="deny" formnovalidate>Deny</button></div>
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

const UTC_TIME = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
})

/** "2026-10-25T18:26:12.290Z" → "Sun 25 Oct, 18:26 UTC"; anything unparsable as it came. */
const utcTime = (iso: string) => {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? iso : `${UTC_TIME.format(ms)} UTC`
}

/** What the owner decides on, phone first: amount, recipient, who asked and why (their words), the fee. */
const paymentFacts = (intent: PaymentIntent) => `<section class="card pay" aria-label="Payment">
<p class="amount">${escape(grouped(intent.amount))}<span class="unit"> ${escape(intent.asset)}</span></p>
<p class="to">to ${intent.recipient_name === null ? 'an address that is not in your contacts' : `<strong>${escape(intent.recipient_name)}</strong>`}</p>
<code class="addr">${escape(intent.recipient_address)}</code>
<figure class="ask"><figcaption>Asked by <strong>${escape(intent.requester)}</strong></figcaption>${intent.reason === null ? '' : `<blockquote>“${escape(intent.reason)}”</blockquote><figcaption>The AI app’s own words; Nod has not checked them.</figcaption>`}</figure>
<p class="fee">Nod pays the network fee.</p></section>`

const paymentDetails = (
  intent: PaymentIntent,
  connectionName: string | null,
) => `<details class="card more"><summary>Details</summary><dl>
<dt>Network</dt><dd>${escape(intent.network === 'stellar:pubnet' ? 'Stellar Mainnet' : 'Stellar Testnet')}</dd>
<dt>Network fee</dt><dd>up to ${escape(String(intent.fee_ceiling_xlm))} XLM <span class="muted">paid by Nod, never by you</span></dd>
${connectionName === null ? '' : `<dt>AI app</dt><dd>${escape(connectionName)}</dd>`}
${intent.resource === null ? '' : `<dt>Resource</dt><dd><code>${escape(intent.resource)}</code></dd>`}
<dt>Expires</dt><dd>${escape(utcTime(intent.expires_at))}</dd><dt>Payment</dt><dd><code>${escape(intent.id)}</code></dd></dl></details>`

const receiptBlock = (receipt: ReceiptRecord) => `<section class="card"><h2 class="ok">Paid</h2><dl>
<dt>Transaction</dt><dd><a href="${escape(receipt.explorer_url)}" rel="noreferrer"><code>${escape(receipt.tx_hash)}</code></a></dd>
<dt>Ledger</dt><dd>${escape(String(receipt.ledger))}</dd><dt>Network fee</dt><dd>${escape(fromStroops(receipt.fee_stroops))} XLM, paid by ${receipt.fee_paid_by === 'relayer' ? 'Nod' : 'the payment facilitator'}</dd></dl></section>`

/** Opening this page has no side effect; only the passkey-signed POST changes anything. */
export const approvalPage = (c: Chrome, view: ApprovalView) => {
  const open = view.status === 'awaiting_approval'
  const waitingForRecipient = view.status === 'approved' && view.claimUrl !== undefined
  const recipient = escape(view.intent.recipient_name ?? 'the recipient')
  const title = open
    ? 'Approve this payment?'
    : waitingForRecipient
      ? `Approved: waiting for ${view.intent.recipient_name ?? 'the recipient'} to accept`
      : `Payment ${view.status.replace('_', ' ')}`
  const action = !open
    ? ''
    : view.signedIn === undefined
      ? `<div class="thumb"><p class="muted">Sign in with this wallet’s passkey to approve.</p><button class="primary wide" id="signin">Sign in with passkey</button></div>`
      : `<div class="thumb"><button class="nod wide" id="approve" data-testid="approve">Approve with passkey</button></div>`
  return page(
    title,
    c,
    `<h1${open ? '' : ` data-testid="${view.status === 'confirmed' || waitingForRecipient ? 'approval-done' : `approval-${escape(view.status)}`}"`}>${escape(title)}</h1>${waitingForRecipient ? `<p class="warn">Send this link to ${recipient}: <a href="${escape(view.claimUrl ?? '')}" data-testid="claim-link"><code>${escape(view.claimUrl ?? '')}</code></a>. When they accept, the trustline and your payment land in one Stellar transaction.</p>` : ''}
${paymentFacts(view.intent)}${action}<p id="status" class="muted" role="status"></p>
${open && view.notice !== undefined ? `<p class="warn">${escape(view.notice)}</p>` : ''}${view.intent.failure !== null && open ? `<p class="warn">Last attempt: ${escape(view.intent.failure)}</p>` : ''}
${view.receipt === undefined ? '' : receiptBlock(view.receipt)}${paymentDetails(view.intent, view.connectionName)}`,
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
  const stopped = input.connectionStatus !== 'active'
  const name = escape(input.clientName)
  return page(
    `Revoke ${input.clientName}`,
    c,
    `<h1${removed ? ' data-testid="revoked"' : ''}>${removed ? `${name} is revoked` : stopped ? `Remove ${name}’s allowance` : `Revoke ${name}?`}</h1>
<ol class="steps"><li class="${stopped ? 'done' : ''}"><strong>Nod stops signing for ${name}</strong> at once and sweeps its pocket back to your wallet.</li>
<li class="${removed ? 'done' : ''}"><strong>One passkey tap removes the allowance</strong> from your Stellar account.</li></ol>
<section class="card"><dl><dt>AI app</dt><dd>${name} <span class="muted">${escape(input.connectionStatus)}</span></dd>
${input.grant === undefined ? '' : `<dt>Allowance</dt><dd>${escape(usdc(input.grant.total))}, spent ${escape(usdc(input.grant.spent))}</dd><dt>On Stellar</dt><dd>${input.grant.rule_status === 'removed' ? 'removed from your account' : input.grant.rule_status === 'removal_pending' ? 'still on your account until your passkey removes it' : 'on your account'}${input.grant.remove_tx === null || input.grant.remove_tx === undefined ? '' : `<br>${txLink(c, input.grant.remove_tx, 'rule-removal-tx')}`}</dd>${input.grant.sweep_tx === null || input.grant.sweep_tx === undefined ? '' : `<dt>Swept back</dt><dd>${txLink(c, input.grant.sweep_tx, 'pocket-sweep-tx')}</dd>`}<dt>Unspent</dt><dd>${escape(usdc(input.grant.pocket_balance))} <span class="muted">goes back to your wallet</span></dd>`}</dl></section>
${removed ? '' : input.signedIn === undefined ? `<div class="thumb"><p class="muted">Sign in with the wallet’s passkey.</p><button class="primary wide" id="signin">Sign in with passkey</button></div>` : `<div class="thumb"><button class="primary wide" id="revoke" data-testid="revoke" data-connection="${escape(input.connectionId)}">${stopped ? 'Remove the allowance with passkey' : 'Revoke with passkey'}</button></div>`}
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
