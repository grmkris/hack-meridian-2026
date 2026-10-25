import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Stellar } from '../../apps/seller/demo-deps.ts'
import { perform, type Action } from './lib/actions.ts'
import { ownerBrowser, passkeySelfTest, type OwnerBrowser } from './lib/browser.ts'
import { classicBalances, sacBalances, sacTransfer, submit, txFacts, USDC, view, type TxFacts } from './lib/chain.ts'
import { ROOT, SEEDS_FILE, SELLER_URL, hasKey, key, usdc } from './lib/env.ts'
import { at, parseJson, str } from './lib/json.ts'
import {
  MemoryAuthProvider,
  connect,
  finishAuthorization,
  loopback,
  recordingFetch,
  startAuthorization,
  type WireEntry,
} from './lib/oauth.ts'
import { STEPS, receiptTx, statusOf, type CheckStatus, type Ctx, type ToolOutcome } from './steps.ts'
import { TARGETS } from './targets.ts'

/**
 * The demo, rehearsed headlessly: an OAuth MCP client (DCR + PKCE, loopback redirect) drives the nine steps of
 * docs/SPEC.md plus the claim link and revoke; a headless Chromium with a virtual passkey plays the owner on the
 * consent, approval, connections and claim pages. Writes evidence/demo/<utc>/run.json (every tool call and response,
 * tx hashes, explorer links) and screenshots, then prints a pass/fail table against acceptance tests 1–9.
 *
 *   bun scripts/demo/rehearse.ts                        against the S4 stub (default)
 *   bun scripts/demo/rehearse.ts --target testnet       against the deployed service (HM_URL overrides the origin)
 *   bun scripts/demo/rehearse.ts --target local         against `bun run dev`
 *   bun scripts/demo/rehearse.ts --only s4,s5           a subset (s1–s3 always run: they connect)
 *   bun scripts/demo/rehearse.ts --no-recycle           keep Bob's and Carol's USDC (default: back to the treasury)
 *   bun scripts/demo/rehearse.ts --passkey-selftest     prove the virtual authenticator on a local page
 */
const args = process.argv.slice(2)
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const startedAt = new Date()
const stamp = startedAt.toISOString().replace(/[:.]/gu, '-')
const dir = join(ROOT, 'evidence/demo', stamp)
mkdirSync(dir, { recursive: true })

if (args.includes('--passkey-selftest')) {
  const result = await passkeySelfTest(dir)
  writeFileSync(join(dir, 'passkey-selftest.json'), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}

const chosen = TARGETS[flag('--target') ?? 'stub']
if (chosen === undefined) throw new Error(`--target must be one of ${Object.keys(TARGETS).join(', ')}`)
const target = { ...chosen, base: (process.env['HM_URL'] ?? flag('--url') ?? chosen.base).replace(/\/$/u, '') }
const only = flag('--only')?.split(',')
const runId = stamp.slice(5, 19).replace(/[-T]/gu, '')
const mcpUrl = new URL(`${target.base}${target.mcpPath}`)
const password =
  target.passwordFile !== undefined && existsSync(target.passwordFile)
    ? /^DEV_PASSWORD=(.+)$/mu.exec(readFileSync(target.passwordFile, 'utf8'))?.[1]?.trim()
    : undefined
const seeds: unknown = existsSync(SEEDS_FILE) ? parseJson(readFileSync(SEEDS_FILE, 'utf8')) : undefined
const relayer = str(at(seeds, 'accounts.relayer.address'))
const POLICY = 'CABXBYJNZ7IUW4G3D6BND5YCAQF3ASSDMDAOKQQ63UYFSO7WUU2TIP5G'
const t0 = performance.now()
const ms = () => Math.round(performance.now() - t0)

// ---------------------------------------------------------------- evidence
interface Check {
  readonly step: string
  readonly test: number | null
  readonly status: CheckStatus
  readonly detail: string
}
interface Call {
  readonly step: string
  readonly t: number
  readonly ms: number
  readonly tool: string
  readonly arguments: Record<string, unknown>
  readonly ok: boolean
  readonly isError: boolean
  readonly structured: unknown
  readonly text: string
  readonly error?: string
}
interface TxRecord extends Partial<TxFacts> {
  readonly step: string
  readonly label: string
  readonly hash: string
  readonly explorer: string
  readonly expectedFeePayer: string
}
const checks: Array<Check> = []
const calls: Array<Call> = []
const txs: Array<TxRecord> = []
const wire: Array<WireEntry> = []
const browserLog: Array<string> = []
const notes: Array<string> = []
const stepResults: Array<{ id: string; title: string; status: 'pass' | 'fail' | 'skip'; ms: number; error?: string }> =
  []
let current = 'setup'

const record = (test: number | null, status: CheckStatus, detail: string) => {
  checks.push({ step: current, test, status, detail })
  console.log(
    `   ${status === 'pass' ? '✓' : status === 'fail' ? '✗' : status === 'ref' ? '→' : '·'} ${test === null ? '' : `[${test}] `}${detail}`,
  )
}

// ---------------------------------------------------------------- context
const owner: OwnerBrowser = await ownerBrowser(dir, line => browserLog.push(`${current} ${line}`))
const callback = loopback()
const provider = new MemoryAuthProvider(callback.redirect, target.clientName)
const fetchFn = recordingFetch(wire, t0)
let client: Awaited<ReturnType<typeof connect>> | undefined
let tools = new Set<string>()
const vars = new Map<string, string>()
const onchain = target.features.has('onchain')

const outcome = (result: unknown): ToolOutcome => {
  const content = at(result, 'content')
  const texts = Array.isArray(content) ? content.map(c => str(at(c, 'text'))).filter(t => t !== undefined) : []
  const structured = at(result, 'structuredContent')
  const data = structured ?? texts.map(parseJson).findLast(v => v !== undefined)
  return { ok: true, isError: at(result, 'isError') === true, data, text: texts.join('\n') }
}

const ctx: Ctx = {
  target,
  runId,
  sellerUrl: SELLER_URL,
  relayer,
  vars,
  tools: () => tools,
  connect: async () => {
    const authUrl = await startAuthorization(mcpUrl, provider, fetchFn)
    record(
      null,
      provider.client?.client_id !== undefined ? 'pass' : 'fail',
      `DCR client_id ${provider.client?.client_id}`,
    )
    vars.set('auth_url', authUrl.href)
    callback.reset()
    const redirected = callback.next()
    await ctx.browse(target.consent)
    const params = await Promise.race([
      redirected,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no OAuth redirect within 180 s')), 180_000)),
    ])
    record(null, params.get('state') === provider.expectedState ? 'pass' : 'fail', 'callback state matches')
    record(null, params.get('iss') === target.base ? 'pass' : 'fail', `callback iss ${params.get('iss')} (RFC 9207)`)
    const code = params.get('code')
    if (code === null) throw new Error(`no code in the redirect: ${params.get('error') ?? '?'}`)
    await finishAuthorization(mcpUrl, provider, fetchFn, code)
    record(null, provider.tokens()?.access_token !== undefined ? 'pass' : 'fail', 'access token issued (PKCE)')
    client = await connect(mcpUrl, provider, fetchFn)
    tools = new Set((await client.listTools()).tools.map(tool => tool.name))
    const passkeys = await owner.credentials()
    if (passkeys.length > 0) notes.push(`virtual passkeys: ${JSON.stringify(passkeys)}`)
  },
  call: async (tool, callArgs) => {
    const started = performance.now()
    const base = { step: current, t: ms(), tool, arguments: callArgs }
    if (client === undefined) throw new Error('not connected')
    if (!tools.has(tool)) {
      record(null, 'skip', `${tool} is not offered by ${target.name}`)
      const missing: ToolOutcome = { ok: false, isError: true, data: undefined, text: '', error: 'tool not offered' }
      calls.push({ ...base, ms: 0, ok: false, isError: true, structured: null, text: '', error: 'tool not offered' })
      return missing
    }
    try {
      const result = await client.callTool({ name: tool, arguments: callArgs }, undefined, { timeout: 120_000 })
      const out = outcome(result)
      calls.push({
        ...base,
        ms: Math.round(performance.now() - started),
        ok: true,
        isError: out.isError,
        structured: out.data ?? null,
        text: out.text,
      })
      console.log(
        `   ${tool} → ${out.isError ? 'isError ' : ''}${statusOf(out.data) ?? ''} (${Math.round(performance.now() - started)} ms)`,
      )
      return out
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      calls.push({
        ...base,
        ms: Math.round(performance.now() - started),
        ok: false,
        isError: true,
        structured: null,
        text: '',
        error: message,
      })
      console.log(`   ${tool} → threw: ${message.slice(0, 160)}`)
      return { ok: false, isError: true, data: undefined, text: '', error: message }
    }
  },
  browse: async (actions: ReadonlyArray<Action>) => {
    const lines = await perform(
      owner.page,
      actions,
      { ...Object.fromEntries(vars), base: target.base, allowance: target.allowance, password },
      name => owner.shot(name),
    )
    for (const line of lines) browserLog.push(`${current} ${line}`)
  },
  pageText: () => owner.page.locator('body').innerText(),
  check: (test, ok, detail) => record(test, ok ? 'pass' : 'fail', detail),
  skip: (test, detail) => record(test, 'skip', detail),
  ref: (test, detail) => record(test, 'ref', detail),
  tx: async (label, hash, feePayer) => {
    const facts = await txFacts(hash)
    txs.push({
      step: current,
      label,
      hash,
      explorer: `https://stellar.expert/explorer/testnet/tx/${hash}`,
      expectedFeePayer: feePayer,
      ...facts,
    })
    if (facts === undefined) record(9, 'fail', `${label} ${hash.slice(0, 8)}… not found on Horizon`)
    else if (feePayer === 'relayer')
      record(
        9,
        relayer !== undefined && facts.feeAccount === relayer ? 'pass' : 'fail',
        `${label}: fee ${facts.feeCharged} stroops paid by ${facts.feeAccount.slice(0, 6)}… (relayer ${relayer?.slice(0, 6) ?? '?'}…)`,
      )
    else if (feePayer === 'facilitator')
      record(
        9,
        facts.feeAccount !== relayer && !facts.feeAccount.startsWith('C') ? 'pass' : 'fail',
        `${label}: fee ${facts.feeCharged} stroops paid by the facilitator ${facts.feeAccount.slice(0, 6)}…`,
      )
    return facts
  },
  usdcOf: async address => (onchain && relayer !== undefined ? (await sacBalances(relayer, address)).usdc : undefined),
  xlmOf: async address => (onchain && relayer !== undefined ? (await sacBalances(relayer, address)).xlm : undefined),
  trustline: async address => (onchain ? (await classicBalances(address))?.trustline : undefined),
  fundWallet: async (contractId, toUsdc) => {
    if (relayer === undefined || !hasKey('TREASURY')) {
      notes.push('no TREASURY in scripts/demo/.env: wallet not topped up')
      return
    }
    const have = (await sacBalances(relayer, contractId)).usdc
    const want = BigInt(toUsdc) * 10_000_000n
    if (have >= want) {
      notes.push(`wallet holds ${usdc(have)} USDC, no top-up`)
      return
    }
    const sent = await sacTransfer(
      key('TREASURY', false),
      contractId,
      want - have,
      `treasury tops the wallet up to ${toUsdc} USDC`,
    )
    txs.push({
      step: current,
      label: 'treasury top-up (rehearsal only)',
      hash: sent.hash,
      explorer: `https://stellar.expert/explorer/testnet/tx/${sent.hash}`,
      expectedFeePayer: 'treasury',
    })
  },
  waitConfirmed: async (paymentId, timeoutMs = 90_000) => {
    const deadline = Date.now() + timeoutMs
    let last: unknown
    const seen: Array<string> = []
    while (Date.now() < deadline) {
      const out = await ctx.call('payment_status', { payment_id: paymentId })
      last = out.data
      const status = statusOf(out.data) ?? '?'
      if (seen.at(-1) !== status) seen.push(status)
      if (status === 'confirmed' && receiptTx(out.data) !== undefined) break
      if (['failed', 'expired'].includes(status) || !out.ok) break
      await new Promise(resolve => setTimeout(resolve, 2_500))
    }
    notes.push(`${paymentId}: ${seen.join(' → ')}`)
    return last
  },
  ruleLive: async (contractId, ruleId) => {
    if (relayer === undefined) return undefined
    try {
      await view(relayer, POLICY, 'get_spending_limit_data', [
        Stellar.xdr.ScVal.scvU32(ruleId),
        new Stellar.Address(contractId).toScVal(),
      ])
      return true
    } catch (error) {
      return /#3220|#3000|not installed/iu.test(error instanceof Error ? error.message : String(error))
        ? false
        : undefined
    }
  },
  note: text => notes.push(text),
}

// ---------------------------------------------------------------- run
console.log(`rehearsal ${runId} against ${target.name} ${mcpUrl.href}; evidence ${dir}`)
for (const step of STEPS) {
  current = step.id
  const always = ['s1', 's2', 's3'].includes(step.id)
  const missing = step.needs.filter(feature => !target.features.has(feature))
  if ((!always && only !== undefined && !only.includes(step.id)) || missing.length > 0) {
    stepResults.push({
      id: step.id,
      title: step.title,
      status: 'skip',
      ms: 0,
      error: missing.length > 0 ? `needs ${missing.join(', ')}` : 'not selected',
    })
    for (const test of step.tests)
      record(
        test,
        'skip',
        `${step.id} skipped on ${target.name}${missing.length > 0 ? ` (needs ${missing.join(', ')})` : ''}`,
      )
    continue
  }
  console.log(`\n== ${step.id} ${step.title}`)
  const started = performance.now()
  const failedBefore = checks.filter(c => c.status === 'fail').length
  try {
    await step.run(ctx)
    const failed = checks.filter(c => c.status === 'fail').length > failedBefore
    stepResults.push({
      id: step.id,
      title: step.title,
      status: failed ? 'fail' : 'pass',
      ms: Math.round(performance.now() - started),
    })
  } catch (error) {
    const message = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)
    record(step.tests[0] ?? null, 'fail', `${step.id} threw: ${message}`)
    stepResults.push({
      id: step.id,
      title: step.title,
      status: 'fail',
      ms: Math.round(performance.now() - started),
      error: message,
    })
    await owner.shot(`${step.id}-failure`).catch(() => undefined)
    if (step.id === 's1') break
  }
}

// ---------------------------------------------------------------- recycle: Bob's and Carol's USDC back to the treasury
if (onchain && !args.includes('--no-recycle') && hasKey('TREASURY')) {
  current = 'recycle'
  const treasury = key('TREASURY', false).publicKey()
  for (const role of ['BOB', 'CAROL'] as const) {
    if (!hasKey(role)) continue
    const account = key(role, false)
    const balances = await classicBalances(account.publicKey())
    const ops: Array<Stellar.xdr.Operation> = []
    if (balances?.usdc !== null && balances !== undefined && Number(balances.usdc) > 0)
      ops.push(Stellar.Operation.payment({ destination: treasury, asset: USDC, amount: balances.usdc }))
    if (role === 'CAROL' && balances?.trustline === true)
      ops.push(Stellar.Operation.changeTrust({ asset: USDC, limit: '0' }))
    if (ops.length > 0)
      await submit(account, ops, `recycle ${role} → treasury${role === 'CAROL' ? ', trustline removed' : ''}`).catch(
        (error: unknown) =>
          notes.push(`recycle ${role} failed: ${error instanceof Error ? error.message : String(error)}`),
      )
  }
}

await owner.close()
await callback.stop()

// ---------------------------------------------------------------- report
const acceptance = Object.fromEntries(
  [1, 2, 3, 4, 5, 6, 7, 8, 9].map(test => {
    const mine = checks.filter(c => c.test === test)
    const status = mine.some(c => c.status === 'fail')
      ? 'FAIL'
      : mine.some(c => c.status === 'pass')
        ? 'PASS'
        : mine.some(c => c.status === 'ref')
          ? 'REF'
          : 'N/A'
    return [test, { status, checks: mine.map(c => `${c.status} ${c.step}: ${c.detail}`) }]
  }),
)
const TITLES: Record<number, string> = {
  1: '0.10 x402 purchase settles and consumes the grant',
  2: 'above the remaining allowance → owner lane, not signed',
  3: 'forced over-limit transfer rejected onchain',
  4: '100 USDC needs the passkey; approval binds recipient + amount',
  5: 'repeating the same request does not pay twice',
  6: 'revoking blocks the next delegated payment',
  7: 'receipt only after confirmed settlement',
  8: 'G without trustline: trust + transfer in one invocation',
  9: 'relayer paid every fee; owner holds no XLM',
}
const run = {
  run_id: runId,
  target: target.name,
  base: target.base,
  mcp: mcpUrl.href,
  seller: SELLER_URL,
  relayer,
  started_at: startedAt.toISOString(),
  finished_at: new Date().toISOString(),
  oauth: { client_id: provider.client?.client_id ?? null, redirect: callback.redirect },
  tools: [...tools],
  steps: stepResults,
  acceptance,
  checks,
  calls,
  txs,
  wire,
  browser: browserLog,
  notes,
}
writeFileSync(
  join(dir, 'run.json'),
  `${JSON.stringify(run, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`,
)

console.log(`\n| step | status | ms     | title`)
console.log(`| ---- | ------ | -----: | -----`)
for (const s of stepResults)
  console.log(
    `| ${s.id.padEnd(4)} | ${s.status.padEnd(6)} | ${String(s.ms).padStart(6)} | ${s.title}${s.error ? ` (${s.error})` : ''}`,
  )
console.log(`\n| test | result | acceptance (docs/SPEC.md)`)
console.log(`| ---- | ------ | -------------------------`)
for (const test of [1, 2, 3, 4, 5, 6, 7, 8, 9])
  console.log(`| ${test}    | ${(acceptance[test]?.status ?? 'N/A').padEnd(6)} | ${TITLES[test]}`)
if (txs.length > 0) {
  console.log('\ntransactions:')
  for (const t of txs) console.log(`  ${t.label}: ${t.explorer}`)
}
console.log(`\nevidence → ${join(dir, 'run.json')}`)
process.exitCode = stepResults.some(s => s.status === 'fail') ? 1 : 0
