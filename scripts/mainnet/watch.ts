import { appendFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { Stellar } from '../../apps/seller/demo-deps.ts'

/**
 * The liveness watch, read-only: both stages' /api/health (release, payments switch, relayer XLM, treasury USDC), the
 * facilitators' /supported, and the TTL of the contracts Nod deployed on each network. One JSON line per round to
 * .local/watch/watch.jsonl; a line starting with ALERT for each floor crossed, and for a health check failing twice in
 * a row. Nothing is signed or sent.
 *
 *   bun scripts/mainnet/watch.ts                         one round, exit 1 on an alert
 *   bun scripts/mainnet/watch.ts --every 600             a round every 10 minutes, forever
 *   bun scripts/mainnet/watch.ts --every 600 --until-alert   …until the first alert (exit 1), for a background job
 *   bun scripts/mainnet/watch.ts --every 600 --until-new-alert   …until an alert the first round did not already show
 *
 * Floors (orchestrator, 25 Oct): testnet relayers ≥ 500 XLM each, treasury ≥ 60 USDC; mainnet relayer A ≥ 12 XLM,
 * relayer B ≥ 5 XLM, treasury may be 0; contract TTL ≥ 7 days.
 */
const ROOT = resolve(import.meta.dir, '../..')
const LOG_DIR = join(ROOT, '.local/watch')
const args = process.argv.slice(2)
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const every = Number(flag('--every') ?? '0')
const untilAlert = args.includes('--until-alert')
const untilNewAlert = args.includes('--until-new-alert')
/** An alert without its numbers, so "treasury holds 33.50" and "treasury holds 31.50" are the same known alert. */
const kindOf = (alert: string) => alert.replace(/[\d.]+/gu, '#')

const STAGES = {
  testnet: {
    origin: 'https://testnet.trynod.si',
    rpc: 'https://soroban-testnet.stellar.org',
    relayerFloors: [500, 500, 500, 500],
    treasuryFloor: 60,
    contracts: {
      'deposit router v2': 'CAFLFU5GH7QZ6KF3FBKRV7VW5XFYUKQPCFFTCPTKVEUG4TDT5B2ZOXGL',
      'onboard router': 'CCLFB4I4CNGWHHL53UO33CSWKKXJBANMDGOGL43J7RBT7SWK2H2BPGN4',
    },
  },
  mainnet: {
    origin: 'https://trynod.si',
    rpc: 'https://mainnet.sorobanrpc.com',
    relayerFloors: [12, 5],
    treasuryFloor: 0,
    contracts: {
      'deposit router v2': 'CBWDC7KRPOHSUIPADS6NHXHPYZ2KXHUZ7TONHBPVK7AKIWYXNLRFI6YX',
      'onboard router': 'CBWYFI6XWQI5C43GISIIUFXTJXBUI52QSNKKYC55GWMPLQRL2RAXT6TM',
    },
  },
} as const
const FACILITATORS = {
  'x402.org (testnet)': { url: 'https://www.x402.org/facilitator/supported', network: 'stellar:testnet' },
  'OpenZeppelin Channels (testnet)': {
    url: 'https://channels.openzeppelin.com/x402/testnet/supported',
    network: 'stellar:testnet',
  },
  'OpenZeppelin Channels (pubnet)': {
    url: 'https://channels.openzeppelin.com/x402/supported',
    network: 'stellar:pubnet',
  },
} as const
const FACILITATOR_NAMES = [
  'x402.org (testnet)',
  'OpenZeppelin Channels (testnet)',
  'OpenZeppelin Channels (pubnet)',
] as const satisfies ReadonlyArray<keyof typeof FACILITATORS>
const TTL_FLOOR_DAYS = 7
const LEDGER_SECONDS = 5

type Stage = keyof typeof STAGES
const failures: Record<Stage, number> = { testnet: 0, mainnet: 0 }

const get = (url: string) => fetch(url, { signal: AbortSignal.timeout(20_000) })
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const field = (value: unknown, ...path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>((at, key) => (isRecord(at) ? at[key] : undefined), value)
const stroops = (value: unknown) => (typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) / 1e7 : NaN)

async function health(stage: Stage, alerts: Array<string>) {
  const { origin, relayerFloors, treasuryFloor } = STAGES[stage]
  try {
    const response = await get(`${origin}/api/health`)
    const body: unknown = await response.json()
    if (!response.ok || field(body, 'ok') !== true) throw new Error(`HTTP ${response.status}`)
    failures[stage] = 0
    const relayersRaw = field(body, 'chain', 'relayers')
    const relayers = (Array.isArray(relayersRaw) ? relayersRaw : []).map(r => ({
      address: String(field(r, 'address')),
      xlm: stroops(field(r, 'xlm')),
    }))
    const treasury = stroops(field(body, 'chain', 'treasury', 'usdc'))
    const payments = field(body, 'chain', 'payments_enabled')
    relayers.forEach((relayer, index) => {
      const floor = relayerFloors[index] ?? relayerFloors.at(-1) ?? 0
      if (!(relayer.xlm >= floor))
        alerts.push(`${stage} relayer ${relayer.address.slice(0, 8)}… holds ${relayer.xlm.toFixed(1)} XLM (< ${floor})`)
    })
    if (!(treasury >= treasuryFloor))
      alerts.push(`${stage} treasury holds ${treasury.toFixed(2)} USDC (< ${treasuryFloor})`)
    if (payments !== true) alerts.push(`${stage} payments_enabled is ${String(payments)}`)
    return {
      ok: true,
      release: String(field(body, 'release')).slice(0, 7),
      payments,
      relayers: relayers.map(r => Math.round(r.xlm * 10) / 10),
      treasury_usdc: treasury,
    }
  } catch (error) {
    failures[stage] += 1
    const message = error instanceof Error ? error.message : String(error)
    if (failures[stage] >= 2) alerts.push(`${stage} /api/health failed ${failures[stage]} times in a row (${message})`)
    return { ok: false, error: message, failures: failures[stage] }
  }
}

async function facilitator(name: keyof typeof FACILITATORS, alerts: Array<string>) {
  const { url, network } = FACILITATORS[name]
  try {
    const response = await get(url)
    // OpenZeppelin Channels answers 401 without a key: reachable, which is what the watch asks.
    if (response.status === 401) return { status: 401 }
    const body: unknown = await response.json().catch(() => undefined)
    const kinds = field(body, 'kinds')
    const ours = Array.isArray(kinds) && kinds.some(k => field(k, 'network') === network)
    if (!response.ok || !ours)
      alerts.push(`facilitator ${name}: ${response.status}, ${network} ${ours ? 'listed' : 'missing'}`)
    return { status: response.status, network: ours }
  } catch (error) {
    alerts.push(`facilitator ${name} unreachable (${error instanceof Error ? error.message : String(error)})`)
    return { status: 0 }
  }
}

async function ttls(stage: Stage, alerts: Array<string>) {
  const { rpc, contracts } = STAGES[stage]
  const server = new Stellar.rpc.Server(rpc)
  const out: Record<string, number | null> = {}
  try {
    const latest = (await server.getLatestLedger()).sequence
    for (const [name, id] of Object.entries(contracts)) {
      const key = Stellar.xdr.LedgerKey.contractData(
        new Stellar.xdr.LedgerKeyContractData({
          contract: new Stellar.Address(id).toScAddress(),
          key: Stellar.xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: Stellar.xdr.ContractDataDurability.persistent(),
        }),
      )
      const entry = (await server.getLedgerEntries(key)).entries[0]
      const days =
        entry?.liveUntilLedgerSeq === undefined ? null : ((entry.liveUntilLedgerSeq - latest) * LEDGER_SECONDS) / 86_400
      out[name] = days === null ? null : Math.round(days * 10) / 10
      if (days === null || days < TTL_FLOOR_DAYS)
        alerts.push(
          `${stage} ${name} ${id.slice(0, 8)}… instance ${days === null ? 'not live' : `lives ${days.toFixed(1)} days`}`,
        )
    }
  } catch (error) {
    out['error'] = null
    alerts.push(`${stage} TTL read failed (${error instanceof Error ? error.message : String(error)})`)
  }
  return out
}

async function round() {
  const alerts: Array<string> = []
  const line = {
    at: new Date().toISOString(),
    testnet: await health('testnet', alerts),
    mainnet: await health('mainnet', alerts),
    facilitators: Object.fromEntries(
      await Promise.all(FACILITATOR_NAMES.map(async name => [name, await facilitator(name, alerts)] as const)),
    ),
    ttl_days: { testnet: await ttls('testnet', alerts), mainnet: await ttls('mainnet', alerts) },
    alerts,
  }
  mkdirSync(LOG_DIR, { recursive: true })
  appendFileSync(join(LOG_DIR, 'watch.jsonl'), `${JSON.stringify(line)}\n`)
  console.log(JSON.stringify(line))
  for (const alert of alerts) console.log(`ALERT ${line.at} ${alert}`)
  return alerts
}

let known: ReadonlySet<string> | undefined
for (;;) {
  const alerts = await round()
  if (every <= 0) process.exit(alerts.length > 0 ? 1 : 0)
  if (untilAlert && alerts.length > 0) process.exit(1)
  if (untilNewAlert) {
    if (known === undefined) known = new Set(alerts.map(kindOf))
    else if (alerts.some(alert => !known?.has(kindOf(alert)))) process.exit(1)
  }
  await new Promise(done => setTimeout(done, every * 1000))
}
