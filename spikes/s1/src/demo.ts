/**
 * Replays S1 claims 1–5 against testnet from the keys in spikes/s1/.env (run `bun src/setup.ts` first).
 * Every step prints tx hash, fee charged, timings; the full log is written to out/demo-<time>.json.
 *
 *   bun src/demo.ts                    # full run, fresh account
 *   ACCOUNT_ID=C… bun src/demo.ts      # reuse an account (skips deploy + funding)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Keypair } from '@stellar/stellar-sdk'

import {
  InvokeError,
  LEDGERS_PER_DAY,
  USDC,
  USDC_SAC,
  addConnectionRule,
  addr,
  ed25519Signer,
  explorerContract,
  footprintTemplate,
  i128,
  invokeAs,
  latestLedger,
  readSpendingLimit,
  removeRule,
  str,
  tokenBalance,
  transferAs,
  u32,
  view,
  type TxReport,
} from './signer'

const env = (k: string) => {
  const v = process.env[k]
  if (!v) throw new Error(`${k} missing: run bun src/setup.ts`)
  return v
}
const sponsor = Keypair.fromSecret(env('SPONSOR_SECRET'))
const funder = Keypair.fromSecret(env('FUNDER_SECRET'))
const ownerKp = Keypair.fromSecret(env('OWNER_SECRET'))
const connKp = Keypair.fromSecret(env('CONN_SECRET'))
const merchant = Keypair.fromSecret(env('MERCHANT_SECRET')).publicKey()
// The connection key's own classic G account ("pocket"): delegated pulls land here (see setup.ts).
const pocket = connKp.publicKey()
const owner = ed25519Signer(ownerKp, 'owner')
const conn = ed25519Signer(connKp, 'conn')

const log: Array<Record<string, unknown>> = []
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))
const fmt = (n: bigint) => (Number(n) / 1e7).toFixed(7)

function record(step: string, data: Record<string, unknown>) {
  log.push({ step, at: new Date().toISOString(), ...data })
}
async function pass(step: string, f: () => Promise<TxReport>): Promise<TxReport> {
  const r = await f()
  console.log(
    `PASS  ${step}\n      ${r.hash} ledger=${r.ledger} feeCharged=${r.feeCharged} maxFee=${r.maxFee} resourceFee=${r.resourceFee} ${json(r.timings)} ${r.credentialTypes ?? ''}\n      ${r.explorer}`,
  )
  record(step, { expected: 'PASS', ok: true, ...r })
  return r
}
async function reject(step: string, f: () => Promise<TxReport>): Promise<InvokeError | undefined> {
  try {
    const r = await f()
    console.log(`!!!!  ${step}: expected a rejection but it PASSED ${r.hash}`)
    record(step, { expected: 'REJECT', ok: false, ...r })
  } catch (e) {
    if (!(e instanceof InvokeError)) throw e
    const extra = e as InvokeError & { simError?: string }
    console.log(
      `REJ   ${step}\n      stage=${e.stage} ${e.contractError ?? ''} ${e.report?.hash ? `hash=${e.report.hash} feeCharged=${e.report.feeCharged} ${e.report.explorer}` : ''}\n      ${e.detail.split('\n')[0]?.slice(0, 300)}`,
    )
    record(step, {
      expected: 'REJECT',
      ok: true,
      stage: e.stage,
      contractError: e.contractError,
      detail: e.detail.slice(0, 4000),
      simError: extra.simError?.slice(0, 4000),
      ...e.report,
    })
    return e
  }
}
async function spend(label: string, ruleId: number, account: string) {
  const d = await readSpendingLimit(sponsor.publicKey(), account, ruleId)
  const ledger = await latestLedger()
  console.log(
    `      policy(rule ${ruleId}) @${ledger}: limit=${fmt(d.spending_limit)} period=${d.period_ledgers} spent=${fmt(d.cached_total_spent)} history=${json(d.spending_history)}`,
  )
  record(`policy ${label}`, { ruleId, ledger, ...d })
  return d
}
async function waitForLedger(target: number) {
  for (;;) {
    const l = await latestLedger()
    if (l >= target) return l
    await Bun.sleep(2500)
  }
}

const started = Date.now()
let account = process.env.ACCOUNT_ID ?? ''
try {
  console.log(
    `sponsor=${sponsor.publicKey()} funder=${funder.publicKey()} owner=${ownerKp.publicKey()} conn(=pocket G)=${connKp.publicKey()} merchant=${merchant}`,
  )

  // ---- Claim 1: deploy with Ed25519 owner in rule 0, sponsor pays; fund via SAC transfer ----
  if (!account) {
    const { deployAccount } = await import('./signer')
    const d = await deployAccount(sponsor, owner)
    account = d.contractId
    console.log(
      `PASS  claim1 deploy → ${account}\n      ${d.hash} feeCharged=${d.feeCharged} ${json(d.timings)}\n      ${explorerContract(account)}`,
    )
    record('claim1 deploy', { ok: true, account, ...d })
    await pass('claim1 fund 28 USDC (funder G → C via SAC transfer)', () =>
      invokeAs(
        funder,
        funder.publicKey(),
        [],
        [],
        USDC_SAC,
        'transfer',
        [addr(funder.publicKey()), addr(account), i128(USDC(28))],
        { label: 'fund' },
      ),
    )
  }
  const rule0 = (await view(sponsor.publicKey(), account, 'get_context_rule', [u32(0)])) as Record<string, unknown>
  record('rule 0', { rule0 })
  console.log(`      rule0=${json(rule0)}`)
  console.log(`      balance C=${fmt(await tokenBalance(sponsor.publicKey(), account))} USDC`)

  // ---- Claim 2: owner adds CallContract(USDC) rule for conn, 5 USDC, window ≥ lifetime, ~1 day ----
  const now = await latestLedger()
  const lifetime = LEDGERS_PER_DAY
  const add = await addConnectionRule(sponsor, account, owner, {
    token: USDC_SAC,
    connection: conn,
    name: 'mcp-conn-1',
    spendingLimit: USDC(5),
    periodLedgers: lifetime + 720, // window ≥ lifetime (+1 h margin) so nothing ages out before valid_until
    validUntilLedger: now + lifetime,
  })
  console.log(
    `PASS  claim2 add_context_rule → rule id ${add.ruleId}\n      ${add.hash} feeCharged=${add.feeCharged} ${json(add.timings)}\n      ${add.explorer}`,
  )
  record('claim2 add_context_rule', { ok: true, ...add })
  const ruleId = add.ruleId
  const count = await view(sponsor.publicKey(), account, 'get_context_rules_count')
  const rule = await view(sponsor.publicKey(), account, 'get_context_rule', [u32(ruleId)])
  console.log(`      get_context_rules_count=${count} rule=${json(rule)}`)
  record('claim2 rule', { count, rule })
  await spend('before any spend', ruleId, account)

  // ---- Is the enforce-mode re-simulation required? Submit with the record-mode footprint. ----
  await reject('resim-check: conn 2 USDC with record-mode footprint only (no enforce re-sim)', () =>
    transferAs(sponsor, account, conn, ruleId, pocket, USDC(2), { skipEnforceSim: true }),
  )

  // ---- Claim 3: cumulative limit ----
  await pass('claim3 conn→pocket 2 USDC (cum 2)', () => transferAs(sponsor, account, conn, ruleId, pocket, USDC(2)))
  await spend('after 2', ruleId, account)
  const template = await footprintTemplate(sponsor, account, [conn], [ruleId], USDC_SAC, 'transfer', [
    addr(account),
    addr(pocket),
    i128(1n),
  ])
  await reject('claim3 conn→pocket 4 USDC (cum 6 > 5) — enforce simulation', () =>
    transferAs(sponsor, account, conn, ruleId, pocket, USDC(4)),
  )
  await reject('claim3 conn→pocket 4 USDC (cum 6 > 5) — forced onchain submission', () =>
    transferAs(sponsor, account, conn, ruleId, pocket, USDC(4), { forceOnchainOnReject: template }),
  )
  await spend('after rejected 4', ruleId, account)
  await pass('claim3 conn→pocket 2.5 USDC (cum 4.5)', () => transferAs(sponsor, account, conn, ruleId, pocket, USDC(2.5)))
  await spend('after 2.5', ruleId, account)
  await reject('claim3 conn→pocket 1 USDC (cum 5.5 > 5)', () => transferAs(sponsor, account, conn, ruleId, pocket, USDC(1)))
  await pass('claim3 boundary: conn 0.5 USDC (cum exactly 5.0)', () =>
    transferAs(sponsor, account, conn, ruleId, pocket, USDC(0.5)),
  )
  await reject('claim3 boundary: conn 1 stroop (cum 5.0000001)', () =>
    transferAs(sponsor, account, conn, ruleId, pocket, 1n),
  )
  const beforeOwner = await spend('after boundary', ruleId, account)

  // ---- Claim 5: owner lane does not consume the grant ----
  await pass('claim5 owner 20 USDC (rule 0)', () => transferAs(sponsor, account, owner, 0, merchant, USDC(20)))
  const afterOwner = await spend('after owner 20', ruleId, account)
  const unchanged = json(beforeOwner) === json(afterOwner)
  console.log(`${unchanged ? 'PASS' : 'FAIL'}  claim5 connection policy state unchanged by owner transfer`)
  record('claim5 unchanged', { ok: unchanged })

  // ---- Escalation negatives: the connection key cannot leave its lane ----
  await reject('neg: conn tries rule 0 (Default) for 1 USDC', () =>
    transferAs(sponsor, account, conn, 0, pocket, USDC(1)),
  )
  await reject('neg: conn tries an admin call (add_context_rule) under its rule', () =>
    invokeAs(sponsor, account, [conn], [ruleId], account, 'update_context_rule_name', [u32(ruleId), str('pwned')], {
      label: 'conn admin',
    }),
  )
  const approveUntil = (await latestLedger()) + 1000
  await reject('neg: conn tries USDC approve under its rule', () =>
    invokeAs(
      sponsor,
      account,
      [conn],
      [ruleId],
      USDC_SAC,
      'approve',
      [addr(account), addr(merchant), i128(USDC(1)), u32(approveUntil)],
      {
        label: 'conn approve',
      },
    ),
  )

  // ---- Claim 4a: rolling window + expiry on a short-lived rule ----
  const n2 = await latestLedger()
  const PERIOD = 15
  const short = await addConnectionRule(sponsor, account, owner, {
    token: USDC_SAC,
    connection: conn,
    name: 'short-lived',
    spendingLimit: USDC(1),
    periodLedgers: PERIOD,
    validUntilLedger: n2 + 60,
  })
  console.log(
    `PASS  claim4 add short rule id ${short.ruleId} valid_until=${n2 + 60} period=${PERIOD}\n      ${short.hash} ${short.explorer}`,
  )
  record('claim4 add short rule', { ok: true, validUntil: n2 + 60, period: PERIOD, ...short })
  const s1 = await pass('claim4 window: conn 1 USDC under short rule', () =>
    transferAs(sponsor, account, conn, short.ruleId, pocket, USDC(1)),
  )
  await spend('short after 1', short.ruleId, account)
  await reject('claim4 window: conn 0.1 USDC within window (cum 1.1 > 1)', () =>
    transferAs(sponsor, account, conn, short.ruleId, pocket, USDC(0.1)),
  )
  // Eviction rule per source: entries with ledger_sequence <= now - period roll off.
  const spentAt = s1.ledger!
  const edge = spentAt + PERIOD - 1
  await waitForLedger(edge)
  console.log(`      ledger ${await latestLedger()} (spent at ${spentAt}, period ${PERIOD})`)
  await reject(`claim4 window edge: 0.5 USDC at ≈ spentAt+${PERIOD - 1} (sim ledger = latest+1)`, () =>
    transferAs(sponsor, account, conn, short.ruleId, pocket, USDC(0.5)),
  ).catch(() => undefined)
  await waitForLedger(spentAt + PERIOD + 1)
  await pass('claim4 window: 0.5 USDC after the 1 USDC aged out', () =>
    transferAs(sponsor, account, conn, short.ruleId, pocket, USDC(0.5)),
  )
  await spend('short after aging', short.ruleId, account)
  console.log(`      waiting for valid_until ${n2 + 60} to pass…`)
  await waitForLedger(n2 + 61)
  await reject('claim4 expiry: conn 0.1 USDC after valid_until', () =>
    transferAs(sponsor, account, conn, short.ruleId, pocket, USDC(0.1)),
  )

  // ---- Claim 4b: revoke (remove rule) ----
  const revokeTemplate = await footprintTemplate(sponsor, account, [conn], [ruleId], USDC_SAC, 'transfer', [
    addr(account),
    addr(pocket),
    i128(0n),
  ]).catch(() => template)
  await pass(`claim4 owner removes rule ${ruleId}`, () => removeRule(sponsor, account, owner, ruleId))
  await reject('claim4 revoke: conn 0.1 USDC under removed rule', () =>
    transferAs(sponsor, account, conn, ruleId, pocket, USDC(0.1)),
  )
  await reject('claim4 revoke: conn 0.1 USDC under removed rule — forced onchain', () =>
    transferAs(sponsor, account, conn, ruleId, pocket, USDC(0.1), { forceOnchainOnReject: revokeTemplate }),
  )
  const after = await readSpendingLimit(sponsor.publicKey(), account, ruleId).catch(
    (e: Error) => `error: ${e.message.slice(0, 200)}`,
  )
  console.log(`      policy data after removal: ${json(after)}`)
  record('policy after removal', { after })

  // ---- Rule-id numbering after a removal: reused or monotonic? ----
  const countAfterRemove = await view(sponsor.publicKey(), account, 'get_context_rules_count')
  const again = await addConnectionRule(sponsor, account, owner, {
    token: USDC_SAC,
    connection: conn,
    name: 'mcp-conn-1-renewed',
    spendingLimit: USDC(1),
    periodLedgers: LEDGERS_PER_DAY + 720,
    validUntilLedger: (await latestLedger()) + LEDGERS_PER_DAY,
  })
  const countAfterAdd = await view(sponsor.publicKey(), account, 'get_context_rules_count')
  console.log(
    `PASS  rule numbering: count after removing rule ${ruleId} = ${countAfterRemove}; next add_context_rule → id ${again.ruleId}; count = ${countAfterAdd}\n      ${again.hash} feeCharged=${again.feeCharged} ${again.explorer}`,
  )
  record('rule numbering', { ok: true, countAfterRemove, newRuleId: again.ruleId, countAfterAdd, ...again })
  await pass(`renewed grant: conn→pocket 0.5 USDC under rule ${again.ruleId}`, () =>
    transferAs(sponsor, account, conn, again.ruleId, pocket, USDC(0.5)),
  )
  await spend('renewed after 0.5', again.ruleId, account)
  console.log(
    `      final balances: C=${fmt(await tokenBalance(sponsor.publicKey(), account))} merchant=${fmt(await tokenBalance(sponsor.publicKey(), merchant))} pocket=${fmt(await tokenBalance(sponsor.publicKey(), pocket))}`,
  )
} finally {
  mkdirSync(join(import.meta.dir, '..', 'out'), { recursive: true })
  const f = join(import.meta.dir, '..', 'out', `demo-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(
    f,
    JSON.stringify(
      { account, durationMs: Date.now() - started, log },
      (_k, x) => (typeof x === 'bigint' ? x.toString() : x),
      2,
    ),
  )
  console.log(`log → ${f}  (account ${account})`)
}
