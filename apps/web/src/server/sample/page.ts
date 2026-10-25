import { type Chrome, escape } from '../pages.ts'
import { SAMPLE_AMOUNTS, SAMPLE_LIMITS } from './model.ts'

/**
 * GET /sample: one server-rendered page (escaped, nonce'd script, the owner pages' headers via `html`). The button
 * POSTs /sample/run; the script polls GET /sample/run/<id> every 2 s and draws each line with textContent only.
 */

const STYLE = `<style>
:root{color-scheme:light dark;--fg:#14171a;--muted:#5b6470;--line:#d8dde3;--card:#fff;--bg:#f5f7f9;--accent:#1f4fd8;--warn:#fff4d6;--warnline:#e5b638;--err:#b3261e;--ok:#146c2e}
@media (prefers-color-scheme:dark){:root{--fg:#e8ebee;--muted:#9aa3ad;--line:#2c333a;--card:#171b1f;--bg:#0f1215;--accent:#7aa2ff;--warn:#3a2f10;--warnline:#8a6d1c;--err:#ff8a80;--ok:#7bd88f}}
*{box-sizing:border-box}body{font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;max-width:44rem;margin:0 auto;padding:1.5rem 1rem 3rem;color:var(--fg);background:var(--bg)}
h1{font-size:1.45rem;line-height:1.25;margin:.5rem 0 .75rem}p{margin:.5rem 0}a{color:var(--accent)}
.brand{color:var(--muted);font-size:.85rem}.brand .mark{font-weight:750;font-size:1.15rem;color:var(--fg);letter-spacing:-.01em}.brand .net{font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1rem 1.1rem;margin:0 0 1rem}
.warn{background:var(--warn);border-color:var(--warnline)}.muted{color:var(--muted);font-size:.9em}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;word-break:break-all}
button{font:inherit;font-weight:600;padding:.7rem 1.2rem;border-radius:10px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;min-height:44px}
button:disabled{opacity:.55;cursor:default}
.row{display:flex;gap:.8rem;flex-wrap:wrap;align-items:center}
#log{list-style:none;padding:0;margin:1rem 0}
.line{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:10px;padding:.7rem .9rem;margin:0 0 .6rem}
.line .head{display:flex;gap:.6rem;align-items:baseline;flex-wrap:wrap}.line .n{font-variant-numeric:tabular-nums;color:var(--muted);min-width:1.4rem}
.line .t{font-weight:600;flex:1 1 16rem}.line .s{font-size:.78rem;font-weight:650;text-transform:uppercase;letter-spacing:.04em;padding:.1rem .45rem;border-radius:6px;border:1px solid currentColor}
.line .meta{display:flex;gap:.9rem;flex-wrap:wrap;font-size:.88rem;margin:.25rem 0 0}.line .amt{font-weight:650;font-variant-numeric:tabular-nums}
.line .tool{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.78rem;color:var(--muted)}
.line .d{margin:.3rem 0 0;font-size:.93rem;overflow-wrap:anywhere}.line .t,.card p{overflow-wrap:anywhere}.line .links{display:flex;gap:.8rem;flex-wrap:wrap;font-size:.88rem;margin:.3rem 0 0}
.ok,.paid,.nodded,.same_receipt,.revoked,.refused{border-left-color:var(--ok)}.ok .s,.paid .s,.nodded .s,.same_receipt .s,.revoked .s,.refused .s{color:var(--ok)}
.needs_nod,.left_pending{border-left-color:var(--warnline)}.needs_nod .s,.left_pending .s{color:var(--warnline)}
.failed{border-left-color:var(--err)}.failed .s{color:var(--err)}.skipped .s{color:var(--muted)}.running{border-left-color:var(--accent)}.running .s{color:var(--accent)}
</style>`

const SCRIPT = `
const btn=document.getElementById('start'),log=document.getElementById('log'),note=document.getElementById('note');
const LABEL={running:'running',ok:'done',paid:'paid',needs_nod:'needs your nod',nodded:'nodded, paid',same_receipt:'same receipt',left_pending:'needs your nod, left pending',skipped:'skipped',refused:'refused',revoked:'revoked',failed:'failed'};
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e};
function safe(url){try{const u=new URL(url,location.href);return u.origin===location.origin||u.href.startsWith('https://stellar.expert/')?u.href:null}catch{return null}}
function line(l){const li=el('li','line '+l.state);const head=el('div','head');
head.append(el('span','n',l.step==='0'?'·':l.step==='end'?'✓':l.step),el('span','t',l.title),el('span','s',LABEL[l.state]||l.state));li.append(head);
const meta=el('div','meta');if(l.amount)meta.append(el('span','amt',l.amount));if(l.fee)meta.append(el('span','fee',l.fee));if(l.tool)meta.append(el('span','tool',l.tool));if(meta.childNodes.length)li.append(meta);
li.append(el('p','d',l.detail));const links=el('div','links');
for(const k of l.links||[]){const href=safe(k.url);if(!href)continue;const a=el('a',null,k.label);a.href=href;a.rel='noreferrer';a.target='_blank';links.append(a)}
if(links.childNodes.length)li.append(links);return li}
function render(run){log.replaceChildren(...run.lines.map(line));
note.textContent=run.status==='queued'?'Queued; starting in a moment…':run.status==='running'?'Running on the server. This takes a few minutes on testnet.':run.status==='done'?'Finished.':'Stopped: '+(run.error||'unknown error')}
async function poll(id){try{const r=await fetch('/sample/run/'+encodeURIComponent(id),{cache:'no-store'});
if(r.ok){const run=await r.json();render(run);if(run.status==='done'||run.status==='failed'){btn.disabled=btn.dataset.off==='1';return}}}catch{}
setTimeout(()=>poll(id),2000)}
if(btn)btn.addEventListener('click',async()=>{btn.disabled=true;note.textContent='Starting…';
try{const r=await fetch('/sample/run',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});const j=await r.json().catch(()=>({}));
if(r.ok&&j.id){history.replaceState(null,'','#'+j.id);poll(j.id)}else if(j.current){note.textContent=j.error;history.replaceState(null,'','#'+j.current);poll(j.current)}
else{note.textContent=j.error||'Could not start a run.';btn.disabled=false}}catch(e){note.textContent='Could not reach Nod: '+e.message;btn.disabled=false}});
const id=location.hash.slice(1);if(/^sr_[0-9a-f]{24}$/.test(id)){if(btn)btn.disabled=true;poll(id)}
`

export const samplePage = (c: Chrome, view: { readonly unavailable: string | null; readonly origin: string }) => {
  const steps = [
    'reads the wallet: the balance and the allowance are two different numbers',
    `buys a market brief for ${SAMPLE_AMOUNTS.brief} USDC from a paid API over x402`,
    `pays Alice ${SAMPLE_AMOUNTS.alice} USDC on its own`,
    `asks for ${SAMPLE_AMOUNTS.dinner} USDC to Bob for dinner: more than the 2.90 left, so it needs your nod`,
    'the demo owner nods with its passkey and the agent gets the receipt',
    'repeats the dinner request: same receipt, nothing paid twice',
    `asks for ${SAMPLE_AMOUNTS.tooMuch} USDC with 2.90 left: it comes back to the owner instead of failing`,
    `sends Carol, who has never held USDC, ${SAMPLE_AMOUNTS.carol} USDC through a claim link (the run removes her trustline before and after, so every run onboards her for real)`,
    'the owner revokes the agent; its next payment is refused and the allowance is gone from Stellar',
  ]
  const button =
    view.unavailable === null
      ? '<button id="start" type="button">Run a sample agent</button>'
      : '<button id="start" type="button" disabled data-off="1">Run a sample agent</button>'
  const body = `
<h1>Watch an AI app spend from an allowance</h1>
<p>No Claude needed. Press the button and a sample agent runs Nod's demo on Stellar ${escape(c.network.toLowerCase())}, on our server, calling the same tools Claude calls over MCP. Every line below is a real transaction or a real answer from Nod.</p>
<div class="card warn"><p><strong>This is Nod's own demo wallet.</strong> Its owner is a software passkey that the Nod service holds, so the service can nod for the owner in this demo. A real Nod wallet belongs to your own passkey (Face ID, fingerprint), which never leaves your device: nothing above the allowance moves without it.</p></div>
<div class="card"><p>The sample agent gets an allowance of ${SAMPLE_AMOUNTS.allowance} USDC, then:</p><ol>${steps.map(text => `<li>${escape(text)}</li>`).join('')}</ol></div>
<div class="row">${button}<span id="note" class="muted">${escape(view.unavailable ?? 'Takes a few minutes on testnet.')}</span></div>
<ol id="log" aria-live="polite"></ol>
<div class="card muted"><p>Nod pays the network fee for every transaction, never the wallet. Each run installs a new allowance (the last step revokes it), and at today's testnet rent (over 200 times normal) a new allowance and its first payment cost Nod tens of XLM, so runs are limited: one at a time, ${SAMPLE_LIMITS.perHour} an hour, one per visitor every ${SAMPLE_LIMITS.perVisitorMs / 60_000} minutes. Amounts and recipients are fixed; nothing you send reaches the chain.</p>
<p>Try the real thing: add <code>${escape(view.origin)}/mcp</code> to Claude as a connector and create your own passkey wallet. <a href="/">About Nod</a></p></div>`
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Sample agent · Nod</title><meta name="description" content="Watch a sample AI agent pay from a Nod allowance on Stellar testnet, step by step."><link rel="icon" href="data:,">${STYLE}<body><p class="brand"><span class="mark">nod</span> · <span class="net">Stellar ${escape(c.network)}</span></p>${body}<script nonce="${c.nonce}">${SCRIPT}</script></body></html>`
}
