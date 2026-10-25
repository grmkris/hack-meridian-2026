#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { OAuthClientInformationMixed, OAuthTokens } from '../apps/seller/demo-deps.ts'
import { ROOT } from './demo/lib/env.ts'
import { at, parseJson, str } from './demo/lib/json.ts'
import { connect, MemoryAuthProvider } from './demo/lib/oauth.ts'
import { TARGETS } from './demo/targets.ts'

/**
 * MCP Events end to end against a stage, as a real OAuth MCP client (the agent of `scripts/agent.ts`, connected once
 * with its own virtual-passkey wallet; tokens in `.local/agents/`):
 *
 *   bun scripts/events-check.ts --target local|testnet [--name events] [--no-settle]
 *
 * events/list (six events, webhook + poll), events/poll heads, then a payment over the allowance (→ approval.needed)
 * and one inside it, executed (→ payment.settled), both seen through events/poll with Nod's notice fields. On testnet
 * the second payment moves 0.10 USDC (relayer pays the fee); `--no-settle` skips it. `--topup` also asks
 * wallet_topup_quote for a top-up from Base and waits for its topup.pending event (the local stage's 1Click simulator;
 * on mainnet a real quote, which moves nothing until someone pays it). Exit 1 on any failed check.
 */

const args = process.argv.slice(2)
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args.splice(index, 2)[1]
}
const settle = !args.includes('--no-settle')
const topup = args.includes('--topup')
const target = TARGETS[flag('--target') ?? 'local']
const name = flag('--name') ?? 'events'
if (target === undefined) throw new Error(`--target must be one of ${Object.keys(TARGETS).join(', ')}`)
const base = (process.env['HM_URL'] ?? target.base).replace(/\/$/u, '')
const mcpUrl = new URL(`${base}${target.mcpPath}`)
const stateFile = join(ROOT, '.local/agents', `${target.name}-${name}.json`)

interface State {
  readonly client: OAuthClientInformationMixed
  readonly tokens: OAuthTokens
  readonly wallet?: unknown
}

if (!existsSync(stateFile)) {
  console.error(`no ${stateFile}: connecting a new agent (its own passkey wallet) first`)
  const child = Bun.spawnSync(['bun', 'scripts/agent.ts', '--target', target.name, '--name', name, 'connect'], {
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  })
  if (child.exitCode !== 0) throw new Error('agent connect failed')
}
// SAFETY: scripts/agent.ts wrote the file; a hand-edited one fails at the first call instead.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const state = parseJson(readFileSync(stateFile, 'utf8')) as State
const provider = new MemoryAuthProvider('http://127.0.0.1/callback', `Nod agent (${name})`)
provider.saveClientInformation(state.client)
provider.saveTokens(state.tokens)
const client = await connect(mcpUrl, provider, fetch)
const tokens = provider.tokens()
if (tokens === undefined) throw new Error('no tokens')
writeFileSync(stateFile, JSON.stringify({ ...state, tokens }, null, 2))

const checks: Array<{ readonly ok: boolean; readonly what: string }> = []
const check = (ok: boolean, what: string) => {
  checks.push({ ok, what })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
}

let id = 0
const rpc = async (method: string, params: Record<string, unknown>) => {
  id += 1
  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  const body = parseJson(await response.text())
  if (at(body, 'error') !== undefined) throw new Error(`${method}: ${JSON.stringify(at(body, 'error'))}`)
  return at(body, 'result')
}

const call = async (tool: string, input: Record<string, unknown>) => {
  const result = await client.callTool({ name: tool, arguments: input }, undefined, { timeout: 120_000 })
  if (at(result, 'isError') === true) throw new Error(`${tool}: ${str(at(result, 'content.0.text')) ?? '?'}`)
  return at(result, 'structuredContent')
}

const list = await rpc('events/list', {})
const events = at(list, 'events')
const names = Array.isArray(events) ? events.map(event => str(at(event, 'name'))) : []
check(
  [
    'payment.received',
    'payment.settled',
    'approval.needed',
    'request.received',
    'request.answered',
    'allowance.changed',
  ].every(known => names.includes(known)),
  `events/list: ${names.join(', ')}`,
)
check(
  Array.isArray(events) &&
    events.every(event => {
      const delivery = at(event, 'delivery')
      return Array.isArray(delivery) && delivery.includes('webhook') && delivery.includes('poll')
    }),
  'every event offers webhook and poll',
)

const head = async (event: string) =>
  str(at(await rpc('events/poll', { name: event, arguments: {}, cursor: null }), 'cursor'))
const cursors = {
  approval: await head('approval.needed'),
  settled: await head('payment.settled'),
  topup: topup ? await head('topup.pending') : undefined,
}
check(
  cursors.approval !== undefined && /^\d{16}$/u.test(cursors.approval),
  `events/poll head ${cursors.approval ?? '?'}`,
)

const run = Date.now().toString(36)
const big = await call('payment_prepare', {
  recipient: target.recipients.alice,
  amount: '20',
  reason: 'events-check: over the allowance',
  idempotency_key: `events-check-big-${run}`,
})
const bigId = str(at(big, 'payment_id'))
check(
  bigId !== undefined && str(at(big, 'status')) === 'awaiting_approval',
  `payment_prepare 20 USDC → ${str(at(big, 'status')) ?? '?'}`,
)

let smallId: string | undefined
if (settle) {
  const small = await call('payment_prepare', {
    recipient: target.recipients.alice,
    amount: '0.1',
    reason: 'events-check: inside the allowance',
    idempotency_key: `events-check-small-${run}`,
  })
  smallId = str(at(small, 'payment_id'))
  if (smallId !== undefined)
    await call('payment_execute', { payment_id: smallId, idempotency_key: `events-check-exec-${run}` })
}

/** Poll an event from `cursor` until `match` shows up (60 s). */
const waitFor = async (event: string, cursor: string | undefined, match: (occurrence: unknown) => boolean) => {
  let from = cursor ?? null
  const until = Date.now() + 60_000
  while (Date.now() < until) {
    const page = await rpc('events/poll', { name: event, arguments: {}, cursor: from })
    const pageEvents = at(page, 'events')
    const found = (Array.isArray(pageEvents) ? pageEvents : []).find(match)
    if (found !== undefined) return found
    from = str(at(page, 'cursor')) ?? from
    await Bun.sleep(2_000)
  }
  return undefined
}

const notice = (occurrence: unknown, what: string) => {
  const url = str(at(occurrence, 'data.url')) ?? ''
  check(
    (str(at(occurrence, 'data.title'))?.length ?? 0) > 0 &&
      (str(at(occurrence, 'data.summary'))?.length ?? 0) > 0 &&
      /^https?:\/\//u.test(url) &&
      str(at(occurrence, 'data.network'))?.startsWith('stellar:') === true,
    `${what}: "${str(at(occurrence, 'data.title')) ?? '?'}" ${url}`,
  )
}

const approval = await waitFor(
  'approval.needed',
  cursors.approval,
  occurrence => str(at(occurrence, 'data.payment_id')) === bigId,
)
check(approval !== undefined, `approval.needed for ${bigId ?? '?'}`)
if (approval !== undefined) notice(approval, 'approval.needed')

if (settle) {
  const settled = await waitFor(
    'payment.settled',
    cursors.settled,
    occurrence => str(at(occurrence, 'data.payment_id')) === smallId,
  )
  check(
    settled !== undefined,
    `payment.settled for ${smallId ?? '?'} (${str(at(settled, 'data.status')) ?? 'not seen'})`,
  )
  if (settled !== undefined) notice(settled, 'payment.settled')
}

if (topup) {
  const quoted = await call('wallet_topup_quote', {
    origin_chain: 'base',
    asset: 'USDC',
    amount: '5',
    refund_address: '0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97',
    idempotency_key: `events-check-topup-${run}`,
  })
  const topupId = str(at(quoted, 'id'))
  check(
    topupId !== undefined && str(at(quoted, 'status')) === 'pending',
    `wallet_topup_quote 5 USDC on Base → ${str(at(quoted, 'pay_to')) ?? '?'}, about ${str(at(quoted, 'amount_out')) ?? '?'} USDC`,
  )
  const pending = await waitFor(
    'topup.pending',
    cursors.topup,
    occurrence => str(at(occurrence, 'data.topup_id')) === topupId,
  )
  check(pending !== undefined, `topup.pending for ${topupId ?? '?'}`)
  if (pending !== undefined) notice(pending, 'topup.pending')
}

await client.close()
const failed = checks.filter(entry => !entry.ok)
console.log(JSON.stringify({ target: target.name, base, checks: checks.length, failed: failed.length }))
process.exit(failed.length === 0 ? 0 : 1)
