/**
 * S5 claims runner. Each step writes out/<step>.json and appends every tx it causes to out/txs.jsonl (kind, label,
 * hash) for the fee summary. Sellers must be running (src/seller.ts on :4051, src/mcp-seller.ts on :4052).
 *
 *   bun src/run.ts pocket    # claim 1: G(K) for S1's K with sponsored reserves
 *   bun src/run.ts http      # claim 2: exact pull 0.10 → x402.org purchase (HTTP)
 *   bun src/run.ts mcp       # claim 3: exact pull 0.10 → OZ Channels purchase (MCP)
 *   bun src/run.ts idem      # claim 6: same idempotency key twice
 *   bun src/run.ts chunk     # claim 4: one 1.00 pull, three 0.10 purchases
 *   bun src/run.ts drain     # set-up for claim 5: delegated payment to a person leaves 0.05 of the grant
 *   bun src/run.ts exhaust   # claim 5: $1.00 purchase > float + remaining: onchain refusal, then owner-lane routing
 *   bun src/run.ts revoke    # claim 7: owner removes the rule, pull refused, sweep, close the pocket
 *   bun src/run.ts fees      # claim 8: declared vs charged for every tx in out/txs.jsonl
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ACCOUNT, HTTP_SELLER_PORT, MCP_SELLER_PORT, MERCHANT, RULE_ID, conn, explorerTx, j, ms, owner, relayer, usdc } from './env'
import { txFee, xlm } from './fees'
import type { TxFee } from './fees'
import { IntentStore, counters, paidMcpCall, paidResourceFetch } from './intents'
import type { Intent } from './intents'
import { createSponsored, mergeIntoRelayer, payFromAccount, pocketInfo, pocketUsdc, policy, pull, sweep } from './pocket'
import { InvokeError, USDC, ed25519Signer, latestLedger, removeRule, tokenBalance } from './signer'

const OUT = join(import.meta.dir, '..', 'out')
const HTTP = `http://127.0.0.1:${HTTP_SELLER_PORT}`
const MCP = `http://127.0.0.1:${MCP_SELLER_PORT}/mcp`
const step = process.argv[2] ?? 'help'
const k = conn()
const evidence: Record<string, unknown> = { step, startedAt: new Date().toISOString() }

type Kind = 'pocket' | 'pull' | 'settlement' | 'delegated-pay' | 'owner' | 'sweep'
function recordTx(kind: Kind, label: string, hash: string | undefined) {
  if (!hash) return
  appendFileSync(join(OUT, 'txs.jsonl'), `${JSON.stringify({ kind, label, hash, step, at: new Date().toISOString() })}\n`)
  console.log(`  tx [${kind}] ${label}: ${explorerTx(hash)}`)
}
const save = () => writeFileSync(join(OUT, `${step}.json`), j({ ...evidence, finishedAt: new Date().toISOString() }, 2))
const stats = async (url: string) => (await fetch(url)).json() as Promise<Record<string, unknown>>
const policyView = async () =>
  policy().then(
    p => ({ limit: usdc(p.limit), spent: usdc(p.spent), remaining: usdc(p.remaining), history: p.history.map(h => `${usdc(h.amount)}@${h.ledger}`) }),
    e => ({ error: (e as Error).message.match(/Error\(Contract, #\d+\)/)?.[0] ?? (e as Error).message.slice(0, 160) }),
  )
const snapshot = async () => ({
  ledger: await latestLedger(),
  policy: await policyView(),
  pocketUsdc: usdc(await pocketUsdc(k).catch(() => 0n)),
  accountUsdc: usdc(await tokenBalance(relayer().publicKey(), ACCOUNT)),
})

async function feeOf(hash?: string) {
  if (!hash) return undefined
  const f = await txFee(hash)
  return { feeCharged: f.feeCharged, declared: f.declaredFee, resourceDeclared: f.declaredResourceFee, rent: f.rent, feeSource: f.feeSource, txSource: f.txSource, envelope: f.envelope, ledger: f.ledger }
}

/** One purchase summary with both fees, both ledgers and step timings. */
async function summarize(intent: Intent) {
  const [pullFee, settleFee] = await Promise.all([feeOf(intent.pull?.hash), feeOf(intent.settlement?.transaction)])
  recordTx('pull', `pull ${intent.pullAmount ? usdc(intent.pullAmount) : '?'} (${intent.id})`, intent.pull?.hash)
  recordTx('settlement', `x402 settle ${intent.price ? usdc(intent.price) : '?'} via ${intent.transport} (${intent.id})`, intent.settlement?.transaction)
  const t = intent.timings
  return {
    id: intent.id,
    key: intent.idempotencyKey,
    state: intent.state,
    price: intent.price && usdc(intent.price),
    floatBefore: intent.floatBefore && usdc(intent.floatBefore),
    pullAmount: intent.pullAmount && usdc(intent.pullAmount),
    pull: intent.pull && { hash: intent.pull.hash, explorer: intent.pull.explorer, ...pullFee, steps: intent.pull.timings },
    settlement: intent.settlement && { ...intent.settlement, explorer: intent.settlement.transaction ? explorerTx(intent.settlement.transaction) : undefined, ...settleFee },
    wallMs: {
      to402: t.firstResponse,
      pull: t.pulled !== undefined && t.termsParsed !== undefined ? t.pulled - t.termsParsed : 0,
      signAndSettle: t.paidResponse !== undefined && t.signed !== undefined ? t.paidResponse - (t.pulled ?? t.termsParsed ?? 0) : undefined,
      total: t.total,
      raw: t,
    },
    error: intent.error,
    content: intent.content,
  }
}

async function purchaseHttp(store: IntentStore, path: string, key: string, opts: Parameters<typeof paidResourceFetch>[3]) {
  const before = await snapshot()
  const r = await paidResourceFetch(store, `${HTTP}${path}`, key, opts)
  const after = await snapshot()
  const s = await summarize(r.intent)
  console.log(`  ${r.replayed ? 'REPLAY' : 'call'} ${key}: ${s.state} pull=${s.pull?.hash?.slice(0, 8) ?? '-'} settle=${s.settlement?.transaction?.slice(0, 8) ?? '-'} total=${s.wallMs.total} ms ${s.error ?? ''}`)
  return { replayed: r.replayed, before, after, purchase: s }
}

switch (step) {
  case 'pocket': {
    const rel = relayer()
    const before = await pocketInfo(k.publicKey())
    evidence.relayerBefore = await pocketInfo(rel.publicKey())
    evidence.pocketBefore = before
    if (before.exists && before.numSponsored === 0) {
      // S1 funded this G(K) with friendbot; return its USDC to the smart account, then recreate it the product way.
      const bal = await pocketUsdc(k)
      if (bal > 0n) {
        const s = await sweep(k, bal, ACCOUNT, `return S1 leftover ${usdc(bal)} G(K) → C`)
        recordTx('sweep', s.label, s.hash)
        evidence.returnS1Leftover = { amount: usdc(bal), hash: s.hash, feeCharged: s.feeCharged, timings: s.timings }
      }
      const m = await mergeIntoRelayer(k, 'merge friendbot-funded G(K) into the relayer')
      recordTx('pocket', m.label, m.hash)
      evidence.merge = m
    }
    if (!(await pocketInfo(k.publicKey())).exists) {
      const c = await createSponsored(k)
      recordTx('pocket', c.label, c.hash)
      evidence.create = c
    }
    evidence.pocketAfter = await pocketInfo(k.publicKey())
    evidence.relayerAfter = await pocketInfo(rel.publicKey())
    evidence.snapshot = await snapshot()
    console.log(j(evidence, 2))
    break
  }
  case 'http': {
    const store = new IntentStore()
    const sellerBefore = await stats(`${HTTP}/stats`)
    evidence.purchaseA = await purchaseHttp(store, '/paid/quote', `s5-http-${Date.now()}`, { conn: k, pull: 'exact' })
    evidence.seller = { before: sellerBefore, after: await stats(`${HTTP}/stats`) }
    evidence.counters = counters
    break
  }
  case 'mcp': {
    const store = new IntentStore()
    const sellerBefore = await stats(`http://127.0.0.1:${MCP_SELLER_PORT}/stats`)
    const before = await snapshot()
    const r = await paidMcpCall(store, MCP, 'paid_quote', { topic: 's5 purchase B' }, `s5-mcp-${Date.now()}`, { conn: k, pull: 'exact' })
    const after = await snapshot()
    const s = await summarize(r.intent)
    console.log(`  mcp: ${s.state} pull=${s.pull?.hash?.slice(0, 8)} settle=${s.settlement?.transaction?.slice(0, 8)} total=${s.wallMs.total} ms ${s.error ?? ''}`)
    evidence.purchaseB = { before, after, purchase: s }
    evidence.seller = { before: sellerBefore, after: await stats(`http://127.0.0.1:${MCP_SELLER_PORT}/stats`) }
    evidence.counters = counters
    break
  }
  case 'idem': {
    const store = new IntentStore()
    const key = `s5-idem-${Date.now()}`
    const sellerBefore = await stats(`${HTTP}/stats`)
    const first = await purchaseHttp(store, '/paid/quote', key, { conn: k, pull: 'shortfall' })
    const countersAfterFirst = { ...counters }
    const t0 = performance.now()
    const second = await purchaseHttp(store, '/paid/quote', key, { conn: k, pull: 'shortfall' })
    const secondMs = ms(t0)
    evidence.first = first
    evidence.second = { ...second, wallMs: secondMs, sameIntent: second.purchase.id === first.purchase.id, sameSettlement: second.purchase.settlement?.transaction === first.purchase.settlement?.transaction }
    evidence.counters = { afterFirst: countersAfterFirst, afterSecond: { ...counters } }
    let conflict: string | undefined
    try {
      await paidResourceFetch(store, `${HTTP}/paid/report`, key, { conn: k, pull: 'shortfall' })
    } catch (e) {
      conflict = (e as Error).message
    }
    evidence.sameKeyDifferentRequest = conflict
    evidence.seller = { before: sellerBefore, after: await stats(`${HTTP}/stats`) }
    console.log(j({ counters: evidence.counters, conflict }, 2))
    break
  }
  case 'chunk': {
    const store = new IntentStore()
    const sellerBefore = await stats(`${HTTP}/stats`)
    const runs = []
    for (const i of [1, 2, 3]) runs.push(await purchaseHttp(store, '/paid/quote', `s5-chunk-${Date.now()}-${i}`, { conn: k, pull: { chunk: USDC(1) } }))
    evidence.purchases = runs
    evidence.counters = counters
    evidence.seller = { before: sellerBefore, after: await stats(`${HTTP}/stats`) }
    break
  }
  case 'drain': {
    const p = await policy()
    const amount = p.remaining - USDC(0.05)
    evidence.before = await snapshot()
    const r = await payFromAccount(k, MERCHANT, amount, `delegated payment ${usdc(amount)} C → merchant (rule ${RULE_ID})`)
    recordTx('delegated-pay', r.label, r.hash)
    evidence.payment = { amount: usdc(amount), hash: r.hash, feeCharged: r.feeCharged, maxFee: r.maxFee, resourceFee: r.resourceFee, timings: r.timings, explorer: r.explorer }
    evidence.after = await snapshot()
    console.log(j(evidence, 2))
    break
  }
  case 'exhaust': {
    const store = new IntentStore()
    const s0 = await stats(`${HTTP}/stats`)
    const a = await purchaseHttp(store, '/paid/report', `s5-exhaust-onchain-${Date.now()}`, { conn: k, pull: 'shortfall', precheck: false })
    const s1 = await stats(`${HTTP}/stats`)
    const b = await purchaseHttp(store, '/paid/report', `s5-exhaust-precheck-${Date.now()}`, { conn: k, pull: 'shortfall', precheck: true })
    const s2 = await stats(`${HTTP}/stats`)
    evidence.onchainBackstop = { ...a, seller: { before: s0, after: s1 } }
    evidence.ownerLane = { ...b, seller: { before: s1, after: s2 } }
    evidence.counters = counters
    console.log(j({ a: a.purchase.error, b: b.purchase.error, sellerBefore: s0, sellerAfterA: s1, sellerAfterB: s2, counters }, 2))
    break
  }
  case 'revoke': {
    const rel = relayer()
    evidence.before = await snapshot()
    const rm = await removeRule(rel, ACCOUNT, ed25519Signer(owner(), 'owner'), RULE_ID)
    recordTx('owner', rm.label, rm.hash)
    evidence.remove = { hash: rm.hash, feeCharged: rm.feeCharged, timings: rm.timings, explorer: rm.explorer }
    evidence.policyAfterRemove = await policyView()
    try {
      await pull(k, USDC(0.1), 'pull 0.10 after revoke')
      evidence.pullAfterRevoke = 'UNEXPECTED SUCCESS'
    } catch (e) {
      evidence.pullAfterRevoke = e instanceof InvokeError ? { stage: e.stage, contractError: e.contractError, detail: e.detail.slice(0, 300) } : (e as Error).message
    }
    const left = await pocketUsdc(k)
    if (left > 0n) {
      const sw = await sweep(k, left)
      recordTx('sweep', sw.label, sw.hash)
      evidence.sweep = { amount: usdc(left), hash: sw.hash, feeCharged: sw.feeCharged, timings: sw.timings, explorer: sw.explorer }
    }
    const relBefore = await pocketInfo(rel.publicKey())
    const close = await mergeIntoRelayer(k)
    recordTx('pocket', close.label, close.hash)
    evidence.close = close
    evidence.relayerAroundClose = { before: relBefore, after: await pocketInfo(rel.publicKey()) }
    evidence.after = { ...(await snapshot()), pocket: await pocketInfo(k.publicKey()) }
    console.log(j(evidence, 2))
    break
  }
  case 'fees': {
    const path = join(OUT, 'txs.jsonl')
    const rows = existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { kind: Kind; label: string; hash: string; step: string }) : []
    const out: Array<TxFee & { kind: Kind; label: string; step: string }> = []
    for (const r of rows) out.push({ ...(await txFee(r.hash)), kind: r.kind, label: r.label, step: r.step })
    evidence.txs = out
    const lines = ['| kind | step | label | tx | declared (stroops) | charged (stroops) | charged XLM | rent XLM | paid by |', '| --- | --- | --- | --- | --: | --: | --: | --: | --- |']
    for (const t of out)
      lines.push(`| ${t.kind} | ${t.step} | ${t.label} | [\`${t.hash.slice(0, 8)}\`](${explorerTx(t.hash)}) | ${t.declaredFee.toLocaleString('en')} | ${t.feeCharged.toLocaleString('en')} | ${xlm(t.feeCharged)} | ${t.rent !== undefined ? xlm(t.rent) : '-'} | ${t.feeSource.slice(0, 6)}… |`)
    const kinds = [...new Set(out.map(t => t.kind))]
    const agg = kinds.map(kind => {
      const xs = out.filter(t => t.kind === kind)
      const c = xs.map(t => t.feeCharged)
      return { kind, n: xs.length, minCharged: Math.min(...c), maxCharged: Math.max(...c), sumCharged: c.reduce((a, b) => a + b, 0), sumDeclared: xs.reduce((a, t) => a + t.declaredFee, 0), sumRent: xs.reduce((a, t) => a + (t.rent ?? 0), 0) }
    })
    evidence.byKind = agg
    evidence.markdown = lines.join('\n')
    console.log(lines.join('\n'))
    console.log(j(agg, 2))
    break
  }
  default:
    console.log('steps: pocket http mcp idem chunk drain exhaust revoke fees')
    process.exit(0)
}
save()
