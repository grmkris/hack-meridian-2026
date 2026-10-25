import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { decodePaymentRequiredHeader } from '../../apps/seller/demo-deps.ts'
import { classicBalances, rpc } from './lib/chain.ts'
import {
  FACILITATORS,
  HORIZON_URL,
  NETWORK,
  SEEDS_FILE,
  SELLER_URL,
  SELLER_VARS,
  THIRD_PARTY_SELLER,
  USDC_SAC,
} from './lib/env.ts'
import { at, parseJson, str } from './lib/json.ts'
import { daysLeft, ledgerTime, readShared } from './lib/ttl.ts'
import { TARGETS } from './targets.ts'

/**
 * Demo-day health in one command and one table: both facilitators' /supported, the seller's 402 and paid MCP tool,
 * our /mcp (401 challenge, OAuth metadata, tools/list with a saved connection), relayer and treasury funds, and the
 * shared contracts' TTLs. Exit 1 when anything is red.
 *
 *   bun scripts/demo/probe.ts [--target testnet|local|stub] [--network testnet|pubnet] [--save]
 *
 * tools/list needs a token: `bun scripts/demo/rehearse.ts --target <t> --only s3` leaves its connection in
 * scripts/demo/.state/<target>.json (gitignored), and the probe refreshes it.
 */
const args = process.argv.slice(2)
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const chosen = TARGETS[flag('--target') ?? 'testnet']
if (chosen === undefined) throw new Error(`--target must be one of ${Object.keys(TARGETS).join(', ')}`)
const base = (process.env['HM_URL'] ?? chosen.base).replace(/\/$/u, '')
const seeds: unknown = existsSync(SEEDS_FILE) ? parseJson(readFileSync(SEEDS_FILE, 'utf8')) : undefined

type Level = 'ok' | 'warn' | 'red'
interface Row {
  readonly check: string
  readonly level: Level
  readonly detail: string
  readonly ms: number
}
const rows: Array<Row> = []

async function probe(check: string, run: () => Promise<{ level: Level; detail: string }>) {
  const started = performance.now()
  try {
    const { level, detail } = await run()
    rows.push({ check, level, detail, ms: Math.round(performance.now() - started) })
  } catch (error) {
    rows.push({
      check,
      level: 'red',
      detail: error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error),
      ms: Math.round(performance.now() - started),
    })
  }
}
const get = (url: string, init: RequestInit = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
const toolsList = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
const toolNames = (body: unknown): Array<string> => {
  const tools = at(body, 'result.tools')
  return Array.isArray(tools) ? tools.map(t => str(at(t, 'name'))).filter(n => n !== undefined) : []
}
const ozKey = () =>
  existsSync(SELLER_VARS)
    ? /^OZ_FACILITATOR_KEY=(.+)$/mu.exec(readFileSync(SELLER_VARS, 'utf8'))?.[1]?.trim()
    : undefined

// ---------------------------------------------------------------- facilitators
for (const [name, url] of Object.entries(FACILITATORS)) {
  await probe(`facilitator ${name} /supported`, async () => {
    if (url === undefined) return { level: 'warn', detail: `no ${name} facilitator on ${NETWORK}` }
    const key = name === 'oz' ? ozKey() : undefined
    if (name === 'oz' && key === undefined)
      return { level: 'warn', detail: `no OZ_FACILITATOR_KEY in ${SELLER_VARS.replace(/^.*\/apps\//u, 'apps/')}` }
    const response = await get(
      `${url}/supported`,
      key === undefined ? {} : { headers: { authorization: `Bearer ${key}` } },
    )
    const body: unknown = await response.json().catch(() => undefined)
    const kinds = at(body, 'kinds')
    const ours = Array.isArray(kinds) && kinds.some(k => at(k, 'network') === NETWORK && at(k, 'scheme') === 'exact')
    return {
      level: response.ok && ours ? 'ok' : 'red',
      detail: `${response.status}, exact on ${NETWORK}: ${ours ? 'yes' : 'NO'}`,
    }
  })
}

// ---------------------------------------------------------------- seller
await probe('seller GET /api/market-brief → 402', async () => {
  const response = await get(`${SELLER_URL}/api/market-brief`)
  const header = response.headers.get('payment-required')
  if (response.status !== 402 || header === null)
    return { level: 'red', detail: `${response.status}, PAYMENT-REQUIRED ${header === null ? 'missing' : 'present'}` }
  const required = decodePaymentRequiredHeader(header)
  const option = required.accepts[0]
  const right = option?.network === NETWORK && option.asset === USDC_SAC && option.amount === '1000000'
  return {
    level: right ? 'ok' : 'red',
    detail: `402, ${option?.amount} of ${option?.asset.slice(0, 6)}… on ${option?.network} → ${option?.payTo.slice(0, 6)}…`,
  }
})
await probe('seller /mcp tools/list', async () => {
  const response = await get(`${SELLER_URL}/mcp`, { method: 'POST', headers: mcpHeaders, body: toolsList })
  const names = toolNames(await response.json().catch(() => undefined))
  return {
    level: names.includes('market_brief') ? 'ok' : 'red',
    detail: `${response.status}, tools: ${names.join(', ') || '-'}`,
  }
})

await probe('third-party seller (stellar.org x402 demo) → 402', async () => {
  const response = await get(THIRD_PARTY_SELLER)
  const header = response.headers.get('payment-required')
  const option = header === null ? undefined : decodePaymentRequiredHeader(header).accepts[0]
  return {
    level: response.status === 402 && option?.network === NETWORK ? 'ok' : 'warn',
    detail: `${response.status}, ${option?.amount ?? '?'} of ${option?.asset.slice(0, 6) ?? '?'}… on ${option?.network ?? '?'}`,
  }
})

// ---------------------------------------------------------------- our service
await probe(`service ${chosen.name} /mcp without a token → 401`, async () => {
  const response = await get(`${base}/mcp`, { method: 'POST', headers: mcpHeaders, body: toolsList })
  const challenge = response.headers.get('www-authenticate') ?? ''
  return {
    level: response.status === 401 && challenge.includes('resource_metadata') ? 'ok' : 'red',
    detail: `${response.status} ${challenge.slice(0, 90)}`,
  }
})
await probe(`service /.well-known/oauth-authorization-server`, async () => {
  const response = await get(`${base}/.well-known/oauth-authorization-server`)
  const body: unknown = await response.json().catch(() => undefined)
  const dcr = str(at(body, 'registration_endpoint')) !== undefined
  const cimd = at(body, 'client_id_metadata_document_supported') === true
  return {
    level: response.ok && dcr ? 'ok' : 'red',
    detail: `${response.status}, DCR ${dcr ? 'yes' : 'no'}, CIMD ${cimd ? 'yes' : 'no'}`,
  }
})
await probe(`service /.well-known/oauth-protected-resource/mcp`, async () => {
  const response = await get(`${base}/.well-known/oauth-protected-resource/mcp`)
  const body: unknown = await response.json().catch(() => undefined)
  return {
    level: response.ok ? 'ok' : 'red',
    detail: `${response.status}, resource ${str(at(body, 'resource')) ?? '-'}`,
  }
})
await probe('service tools/list (saved connection)', async () => {
  const file = join(import.meta.dir, '.state', `${chosen.name}.json`)
  if (!existsSync(file))
    return { level: 'warn', detail: `no saved connection; run rehearse --target ${chosen.name} --only s3` }
  const saved: unknown = parseJson(readFileSync(file, 'utf8'))
  const refresh = str(at(saved, 'refresh_token'))
  const clientId = str(at(saved, 'client_id'))
  if (refresh === undefined || clientId === undefined)
    return { level: 'warn', detail: 'saved connection has no refresh token' }
  const token = await get(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }),
  })
  const tokens: unknown = await token.json().catch(() => undefined)
  const access = str(at(tokens, 'access_token'))
  const rotated = str(at(tokens, 'refresh_token'))
  if (access === undefined) return { level: 'red', detail: `refresh → ${token.status}` }
  if (rotated !== undefined)
    writeFileSync(file, `${JSON.stringify({ client_id: clientId, refresh_token: rotated })}\n`, { mode: 0o600 })
  const response = await get(`${base}/mcp`, {
    method: 'POST',
    headers: { ...mcpHeaders, authorization: `Bearer ${access}` },
    body: toolsList,
  })
  const names = toolNames(await response.json().catch(() => undefined))
  return {
    level: names.length > 0 ? 'ok' : 'red',
    detail: `${response.status}, ${names.length} tools: ${names.join(', ')}`,
  }
})
await probe('service /api/health', async () => {
  const response = await get(`${base}/api/health`)
  return { level: response.ok ? 'ok' : 'warn', detail: `${response.status} ${(await response.text()).slice(0, 100)}` }
})

// ---------------------------------------------------------------- funds
const health: unknown = await get(`${base}/api/health`)
  .then(response => (response.ok ? response.json() : undefined))
  .catch(() => undefined)
const healthRelayers = at(health, 'chain.relayers')
const relayers = Array.isArray(healthRelayers)
  ? healthRelayers.map(r => str(at(r, 'address'))).filter(a => a !== undefined)
  : []
if (relayers.length === 0) {
  const seeded = str(at(seeds, 'accounts.relayer.address'))
  if (seeded !== undefined) relayers.push(seeded)
}
const treasury = str(at(health, 'chain.treasury.address')) ?? str(at(seeds, 'accounts.treasury.address'))
if (relayers.length === 0)
  rows.push({ check: 'relayer XLM (≥ 500)', level: 'red', detail: 'no relayer from /api/health or seeds.json', ms: 0 })
for (const relayer of relayers)
  await probe(`relayer ${relayer.slice(0, 6)}… XLM (≥ 500)`, async () => {
    const response = await get(`${HORIZON_URL}/accounts/${relayer}`)
    const account: unknown = await response.json().catch(() => undefined)
    const b = await classicBalances(relayer)
    const xlm = Number(b?.xlm ?? '0')
    const sponsoring = Number(at(account, 'num_sponsoring') ?? 0)
    const spare = xlm - 500
    return {
      level: xlm >= 500 ? 'ok' : 'red',
      detail: `${xlm.toFixed(1)} XLM, ${sponsoring} sponsored entries (${(sponsoring * 0.5).toFixed(1)} XLM locked); ≈ ${Math.max(0, Math.floor(spare / 50))} connection-days at 50 XLM/day above the 500 floor`,
    }
  })
await probe('treasury USDC (≥ 50)', async () => {
  if (treasury === undefined) return { level: 'red', detail: 'no treasury from /api/health or seeds.json' }
  const b = await classicBalances(treasury)
  const usdc = Number(b?.usdc ?? '0')
  return {
    level: usdc >= 50 ? 'ok' : usdc >= 10 ? 'warn' : 'red',
    detail: `${usdc.toFixed(2)} USDC (${Math.floor(usdc / 10)} new wallets at 10), ${Number(b?.xlm ?? 0).toFixed(1)} XLM`,
  }
})
await probe('RPC latest ledger', async () => {
  const latest = await rpc.getLatestLedger()
  return { level: 'ok', detail: `ledger ${latest.sequence}, protocol ${latest.protocolVersion}` }
})

// ---------------------------------------------------------------- shared-contract TTLs
await probe('shared contracts TTL (≥ 7 days)', async () => {
  const { latest, entries } = await readShared()
  const worst = entries.reduce<{ name: string; days: number; ledger: number | undefined } | undefined>((acc, e) => {
    const days = e.liveUntil === undefined ? 0 : daysLeft(latest, e.liveUntil)
    return acc === undefined || days < acc.days ? { name: `${e.group} ${e.entry}`, days, ledger: e.liveUntil } : acc
  }, undefined)
  if (worst === undefined) return { level: 'warn', detail: 'no shared contracts listed for this network' }
  const short = entries
    .filter(e => e.liveUntil === undefined || daysLeft(latest, e.liveUntil) < 7)
    .map(e => `${e.group} ${e.entry}`)
  return {
    level: worst.days < 2 ? 'red' : worst.days < 7 ? 'red' : 'ok',
    detail: `shortest: ${worst.name} ${worst.days.toFixed(1)} days (ledger ${worst.ledger ?? 'archived'} ≈ ${worst.ledger === undefined ? '-' : ledgerTime(latest, worst.ledger)})${short.length > 0 ? `; under 7 days: ${short.join(', ')} → bun scripts/demo/ttl.ts --extend` : ''}`,
  }
})

// ---------------------------------------------------------------- table
const mark: Record<Level, string> = { ok: 'OK  ', warn: 'WARN', red: 'RED ' }
console.log(`probe ${new Date().toISOString()} · ${NETWORK} · service ${base} · seller ${SELLER_URL}\n`)
console.log('| status | check                                         |    ms | detail')
console.log('| ------ | --------------------------------------------- | ----: | ------')
for (const r of rows)
  console.log(`| ${mark[r.level]}   | ${r.check.padEnd(45)} | ${String(r.ms).padStart(5)} | ${r.detail}`)
const red = rows.filter(r => r.level === 'red').length
console.log(`\n${red === 0 ? 'all green' : `${red} red`} (${rows.filter(r => r.level === 'warn').length} warn)`)
if (args.includes('--save')) {
  const dir = join(import.meta.dir, '../../evidence/probe')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/gu, '-')}.json`)
  writeFileSync(
    file,
    `${JSON.stringify({ at: new Date().toISOString(), network: NETWORK, base, seller: SELLER_URL, rows }, null, 2)}\n`,
  )
  console.log(`saved ${file}`)
}
process.exitCode = red === 0 ? 0 : 1
