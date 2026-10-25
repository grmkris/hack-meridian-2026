import { Stellar } from '../../apps/seller/demo-deps.ts'
import {
  FUNDING,
  STROOPS,
  accountState,
  announce,
  classicOps,
  explorerAddress,
  keypair,
  publicKey,
  xlm,
  type Role,
} from './lib.ts'

/**
 * Funding step 1 when Kristjan funds relayer A alone: relayer A creates each other mainnet account with its table
 * amount (docs/mainnet-funding.md: relayer B 10, treasury 3, seller payTo 2, Bob 2, Carol 2 XLM) in one transaction of
 * `createAccount` operations, and keeps the rest for the router, Alice and fees. Accounts that exist are skipped.
 *
 *   bun scripts/mainnet/distribute.ts --dry-run
 *   HM26_MAINNET_GO=yes bun scripts/mainnet/distribute.ts
 */
const TARGETS: ReadonlyArray<Role> = ['relayerB', 'treasury', 'seller', 'bob', 'carol']
/** Relayer A keeps at least this after the transaction (router ≈ 2.5, Alice ≈ 0.2, pockets, fees). */
const KEEP = 20n * STROOPS

const source = await accountState(publicKey('relayerA'))
if (!source.exists) throw new Error(`relayer A ${source.address} is not funded`)
const missing: Array<{ role: Role; address: string; stroops: bigint }> = []
for (const role of TARGETS) {
  const s = await accountState(publicKey(role))
  if (s.exists) console.log(`  ${role} ${s.address} exists (${xlm(s.xlm)} XLM): skipped`)
  else missing.push({ role, address: s.address, stroops: BigInt(FUNDING[role].xlm) * STROOPS })
}
const total = missing.reduce((sum, m) => sum + m.stroops, 0n)
if (source.xlm - source.reserve - total < KEEP)
  throw new Error(`relayer A holds ${xlm(source.xlm)} XLM; sending ${xlm(total)} would leave less than ${xlm(KEEP)}`)

const mode = announce(
  'distribute from relayer A',
  missing.map(m => ({ what: `createAccount ${m.role} ${m.address}`, payer: 'relayer A', xlm: Number(xlm(m.stroops)) })),
)
if (missing.length === 0) process.exit(0)
const sent = await classicOps({
  label: `relayer A creates ${missing.map(m => m.role).join(', ')}`,
  source: keypair('relayerA'),
  ops: missing.map(m => Stellar.Operation.createAccount({ destination: m.address, startingBalance: xlm(m.stroops) })),
  submit: mode === 'submit',
})
if (sent !== undefined) {
  console.log(`  fee ${xlm(sent.feeCharged)} XLM, ledger ${sent.ledger}`)
  for (const role of ['relayerA', ...TARGETS] as const) {
    const s = await accountState(publicKey(role))
    console.log(`  ${role.padEnd(8)} ${xlm(s.xlm)} XLM ${explorerAddress(s.address)}`)
  }
}
